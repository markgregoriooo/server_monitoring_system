#!/usr/bin/env bash
# ============================================================================
#  Shared helpers for the CSPC-ICTU stress-test scripts.
#  Sourced, never run directly.
# ============================================================================

# EPOCHREALTIME and printf both render the decimal separator per LOCALE. On a VM
# set to a comma-decimal locale (de_DE, fr_FR, es_ES...) "1690000000,012345" makes
# ${EPOCHREALTIME/./} a no-op and every duty-cycle calculation silently wrong —
# the CPU worker would spin at 100% no matter what -l asked for. Pinning C is the
# whole fix, and it costs nothing.
export LC_ALL=C

RED=''; YEL=''; GRN=''; DIM=''; BOLD=''; OFF=''
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'
  DIM=$'\033[2m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
fi

say()  { printf '%s\n' "$*"; }
info() { printf '%s\n' "${DIM}$*${OFF}"; }
ok()   { printf '%s\n' "${GRN}$*${OFF}"; }
warn() { printf '%s\n' "${YEL}⚠  $*${OFF}" >&2; }
die()  { printf '%s\n' "${RED}✖  $*${OFF}" >&2; exit 1; }

rule() { printf '%s\n' "${DIM}────────────────────────────────────────────────────────────${OFF}"; }

hdr() {
  rule
  printf '%s\n' "${BOLD}$*${OFF}"
  rule
}

# ─── Duration parsing ────────────────────────────────────────────────────────
# Accepts a bare number of seconds, or a 30s / 5m / 1h suffix. Returns seconds.
parse_duration() {
  local v="$1" n unit
  [ -n "$v" ] || { echo 0; return 1; }
  n="${v%[smh]}"
  unit="${v#"$n"}"
  case "$n" in
    ''|*[!0-9]*) return 1 ;;
  esac
  case "$unit" in
    ''|s) echo "$n" ;;
    m)    echo $(( n * 60 )) ;;
    h)    echo $(( n * 3600 )) ;;
    *)    return 1 ;;
  esac
}

human_secs() {
  local s="$1"
  if   [ "$s" -ge 3600 ]; then printf '%dh%02dm' $(( s / 3600 )) $(( (s % 3600) / 60 ))
  elif [ "$s" -ge 60 ];   then printf '%dm%02ds' $(( s / 60 )) $(( s % 60 ))
  else printf '%ds' "$s"
  fi
}

# ─── Confirmation ────────────────────────────────────────────────────────────
# ASSUME_YES=1 (or -y on any script) skips the prompt. A non-interactive shell
# with no -y refuses rather than hanging forever waiting on a tty that is not there.
confirm() {
  local prompt="$1"
  [ "${ASSUME_YES:-0}" = "1" ] && return 0
  if [ ! -t 0 ]; then
    die "No tty to confirm on. Re-run with -y if you meant to do this unattended."
  fi
  printf '%s [y/N] ' "$prompt"
  local reply=''
  read -r reply
  case "$reply" in
    y|Y|yes|YES) return 0 ;;
    *) say "Aborted."; exit 0 ;;
  esac
}

have() { command -v "$1" >/dev/null 2>&1; }

# ─── Microsecond clock, fork-free ────────────────────────────────────────────
# $EPOCHREALTIME is bash 5.0+ and costs no process. `date +%s%N` forks, and a fork
# inside a busy loop measures the fork, not the work — which is why the duty-cycle
# path refuses to use it and falls back to running flat out instead.
BASH5=0
if [ -n "${EPOCHREALTIME:-}" ]; then BASH5=1; fi

# ─── Where the agent is, and how often it posts ──────────────────────────────
# Read purely to TELL THE OPERATOR how many samples a run will produce. A stress
# test that is shorter than one post interval moves nothing on the dashboard, and
# that failure looks exactly like broken alerting.
agent_interval() {
  local conf
  for conf in /etc/cspc-agent/agent.conf /opt/cspc-agent/agent.conf \
              "$HOME/.cspc-agent/agent.conf" ./agent.conf; do
    if [ -r "$conf" ]; then
      local v
      v="$(grep -E '^[[:space:]]*INTERVAL=' "$conf" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"'"'"' \r')"
      case "$v" in
        ''|*[!0-9]*) : ;;
        *) [ "$v" -gt 0 ] && { echo "$v"; return 0; } ;;
      esac
    fi
  done
  echo 10   # the agent's own default (agent/internal/config/config.go)
}

# Print what a run of N seconds means in agent samples, and whether that is enough
# for the alert to fire and then auto-resolve.
sample_note() {
  local secs="$1" iv samples
  iv="$(agent_interval)"
  samples=$(( secs / iv ))
  info "Agent posts every ${iv}s → this run spans about ${samples} sample(s)."
  if [ "$samples" -lt 3 ]; then
    warn "Fewer than 3 samples. Run it longer, or the breach may not survive a single poll."
  fi
  info "Recovery needs ALERT_RECOVERY_SAMPLES (default 3) normal readings ≈ $(( iv * 3 ))s after it stops."
}

# ─── Child cleanup ───────────────────────────────────────────────────────────
# Every script that spawns workers installs this. Kills the process GROUP, because
# a worker that forked (dd, python) leaves grandchildren that outlive a plain
# `kill $pids` and go on consuming the resource after the script has reported done.
STRESS_PIDS=()
kill_workers() {
  local pid
  for pid in "${STRESS_PIDS[@]:-}"; do
    [ -n "$pid" ] || continue
    kill -TERM "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  STRESS_PIDS=()
}

# A countdown that still lets trap handlers run promptly: sleeps in 1s slices
# instead of one long sleep, so Ctrl+C is acted on immediately rather than at the
# end of the run.
countdown() {
  local secs="$1" label="${2:-running}" i
  for (( i = secs; i > 0; i-- )); do
    printf '\r  %s… %s remaining   ' "$label" "$(human_secs "$i")"
    sleep 1
  done
  printf '\r%*s\r' 60 ''
}
