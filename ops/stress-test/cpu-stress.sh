#!/usr/bin/env bash
# ============================================================================
#  CPU stress  →  moves `cpu_percent` on the dashboard
# ----------------------------------------------------------------------------
#  Seeded global rules this crosses:  cpu >= 80 warning,  cpu >= 90 critical
#
#  Spawns one busy-loop worker per core. No packages required — the loop is pure
#  bash arithmetic, so this runs on a minimal VM with no compiler, no stress-ng
#  and no network access to install either.
#
#  Usage:
#    ./cpu-stress.sh                 # all cores, flat out, 3 minutes
#    ./cpu-stress.sh -d 5m -w 2      # 2 workers for 5 minutes
#    ./cpu-stress.sh -l 85           # ~85% total, to sit between the two rules
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")"
# shellcheck source=common.sh
. ./common.sh

DURATION="3m"
WORKERS=""
LOAD=100
ASSUME_YES=0

usage() {
  cat <<EOF
CPU stress — drives cpu_percent up so the cpu alert rules fire.

  -d DURATION   how long to run: 90, 90s, 5m, 1h   (default: 3m)
  -w WORKERS    number of busy loops               (default: one per core)
  -l PERCENT    target load 1-100 per worker       (default: 100)
  -y            don't ask for confirmation
  -h            this help

Examples:
  ./cpu-stress.sh -d 4m            all cores flat out → critical (>=90)
  ./cpu-stress.sh -l 85 -d 4m      hold ~85% → warning only (>=80, <90)
EOF
}

while getopts ":d:w:l:yh" opt; do
  case "$opt" in
    d) DURATION="$OPTARG" ;;
    w) WORKERS="$OPTARG" ;;
    l) LOAD="$OPTARG" ;;
    y) ASSUME_YES=1 ;;
    h) usage; exit 0 ;;
    \?) die "Unknown option -$OPTARG (try -h)" ;;
    :)  die "-$OPTARG needs a value" ;;
  esac
done

SECS="$(parse_duration "$DURATION")" || die "Bad duration '$DURATION' — use 90, 90s, 5m or 1h."
[ "$SECS" -gt 0 ] || die "Duration must be greater than zero."

CORES="$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)"
[ -n "$WORKERS" ] || WORKERS="$CORES"
case "$WORKERS" in ''|*[!0-9]*) die "Workers must be a whole number." ;; esac
[ "$WORKERS" -gt 0 ] || die "Workers must be at least 1."

case "$LOAD" in ''|*[!0-9]*) die "Load must be a whole number 1-100." ;; esac
{ [ "$LOAD" -ge 1 ] && [ "$LOAD" -le 100 ]; } || die "Load must be between 1 and 100."

# A duty cycle needs a sub-millisecond clock that does NOT fork. Without bash 5 the
# honest options are "measure the fork instead of the work" or "run flat out"; this
# picks the second and says so, rather than quietly producing a load nobody asked for.
if [ "$LOAD" -lt 100 ] && [ "$BASH5" -eq 0 ]; then
  warn "bash ${BASH_VERSION%%.*} has no \$EPOCHREALTIME — cannot pace a duty cycle."
  warn "Running flat out instead. Use -w to lower the load: -w $(( CORES / 2 )) ≈ 50%."
  LOAD=100
fi

EST_TOTAL=$(( WORKERS * LOAD / (CORES > 0 ? CORES : 1) ))

hdr "CPU stress"
say "  workers        : ${WORKERS} (host has ${CORES} core(s))"
say "  load per worker: ${LOAD}%"
say "  duration       : $(human_secs "$SECS")"
say "  expected total : ~${EST_TOTAL}% of host CPU"
if   [ "$EST_TOTAL" -ge 90 ]; then say "  expected alert : ${RED}cpu CRITICAL${OFF} (rule: >= 90)"
elif [ "$EST_TOTAL" -ge 80 ]; then say "  expected alert : ${YEL}cpu WARNING${OFF} (rule: >= 80)"
else say "  expected alert : ${DIM}none — below the 80% warning rule${OFF}"
fi
sample_note "$SECS"
rule

confirm "Start?"

# ─── Worker ──────────────────────────────────────────────────────────────────
# Flat out: the tightest loop bash has. `:` is a builtin, so no process is created
# per iteration — the loop is the load.
#
# Duty-cycled: busy for (period × load%), then sleep the remainder. The period is
# 100ms, short enough that the average over any one agent sample (>=1s) is smooth,
# long enough that `sleep` overhead stays small relative to the slice.
PERIOD_US=100000
BUSY_US=$(( PERIOD_US * LOAD / 100 ))
IDLE_S="$(awk -v us=$(( PERIOD_US - BUSY_US )) 'BEGIN { printf "%.4f", us / 1000000 }')"

worker_full() {
  local end="$1"
  while :; do
    # Checking the clock every iteration would dominate a loop this tight, so the
    # deadline is tested every 20000 turns instead — about 10ms of real work.
    local i=0
    while [ "$i" -lt 20000 ]; do i=$(( i + 1 )); done
    [ "${EPOCHSECONDS:-$(date +%s)}" -ge "$end" ] && return 0
  done
}

worker_duty() {
  local end="$1" t0 now
  while :; do
    [ "${EPOCHSECONDS:-$(date +%s)}" -ge "$end" ] && return 0
    t0=${EPOCHREALTIME/./}
    while :; do
      now=${EPOCHREALTIME/./}
      [ $(( now - t0 )) -ge "$BUSY_US" ] && break
    done
    sleep "$IDLE_S"
  done
}

END_AT=$(( ${EPOCHSECONDS:-$(date +%s)} + SECS ))

cleanup() {
  printf '\n'
  info "Stopping workers…"
  kill_workers
  ok "CPU load released. Expect the alert to auto-resolve after ~3 normal samples."
}
trap 'cleanup; exit 130' INT TERM
trap 'kill_workers' EXIT

say "Starting ${WORKERS} worker(s)…"
for (( w = 0; w < WORKERS; w++ )); do
  if [ "$LOAD" -ge 100 ]; then worker_full "$END_AT" & else worker_duty "$END_AT" & fi
  STRESS_PIDS+=($!)
done

info "PIDs: ${STRESS_PIDS[*]}"
say "Watch: Server Metrics → your VM, or the Dashboard CPU tile."
rule
countdown "$SECS" "loading CPU"

kill_workers
ok "Done — CPU released after $(human_secs "$SECS")."
info "The open alert auto-resolves once 3 consecutive normal samples have landed."
