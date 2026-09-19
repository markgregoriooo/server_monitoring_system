#!/usr/bin/env bash
# ============================================================================
#  Run every stress test in sequence, with gaps  →  the demo script
# ----------------------------------------------------------------------------
#  One resource at a time, with a quiet gap between phases. The gaps are the point:
#  an alert only auto-resolves after ALERT_RECOVERY_SAMPLES (default 3) consecutive
#  normal readings, so without a pause the CPU alert would still be open while the
#  memory one fires and the Alerts page would show a pile-up rather than a sequence
#  of clean incidents.
#
#  Order is deliberate. CPU and memory first (fast to apply, fast to release), then
#  network (no alert, but it moves the chart), then disk last — it is the only one
#  that leaves something on the filesystem, so it goes where a Ctrl+C is least
#  likely to interrupt the cleanup.
#
#  Usage:
#    ./stress-all.sh                     # 3m per phase, 90s gaps  (~18 min total)
#    ./stress-all.sh -d 2m -g 60         # quicker pass
#    ./stress-all.sh --skip disk,net     # CPU and memory only
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")"
# shellcheck source=common.sh
. ./common.sh

PHASE="3m"
GAP="90"
SKIP=""
ASSUME_YES=0

usage() {
  cat <<EOF
Run all stress tests in sequence.

  -d DURATION   how long each phase runs      (default: 3m)
  -g SECONDS    quiet gap between phases      (default: 90)
  --skip LIST   comma-separated: cpu,mem,net,disk
  -y            don't ask for confirmation on any phase
  -h            this help

The gap must be at least 3 agent intervals (30s at the default -interval 10) or the
previous alert will still be open when the next phase starts.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -d) PHASE="${2:-}"; shift 2 ;;
    -g) GAP="${2:-}"; shift 2 ;;
    --skip) SKIP="${2:-}"; shift 2 ;;
    -y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option '$1' (try -h)" ;;
  esac
done

PHASE_SECS="$(parse_duration "$PHASE")" || die "Bad duration '$PHASE'."
GAP_SECS="$(parse_duration "$GAP")" || die "Bad gap '$GAP'."

skipped() {
  case ",${SKIP}," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

PHASES=()
skipped cpu  || PHASES+=("cpu")
skipped mem  || PHASES+=("mem")
skipped net  || PHASES+=("net")
skipped disk || PHASES+=("disk")
[ "${#PHASES[@]}" -gt 0 ] || die "Every phase skipped — nothing to do."

IV="$(agent_interval)"
MIN_GAP=$(( IV * 3 ))
TOTAL=$(( ${#PHASES[@]} * PHASE_SECS + (${#PHASES[@]} - 1) * GAP_SECS ))

hdr "Full stress sequence"
say "  phases       : ${PHASES[*]}"
say "  each runs    : $(human_secs "$PHASE_SECS")"
say "  gap between  : $(human_secs "$GAP_SECS")"
say "  total time   : about $(human_secs "$TOTAL")"
say "  agent posts  : every ${IV}s"
rule
say "Expected on the dashboard, in order:"
for p in "${PHASES[@]}"; do
  case "$p" in
    cpu)  say "  • cpu     → warning at 80, critical at 90, then auto-resolves in the gap" ;;
    mem)  say "  • mem     → warning at 80 (default target is 85%, below the critical rule)" ;;
    net)  say "  • network → the Network tile moves; ${DIM}no alert rule reads it${OFF}" ;;
    disk) say "  • disk    → warning at 80, then the ballast is deleted and it resolves" ;;
  esac
done
rule

if [ "$GAP_SECS" -lt "$MIN_GAP" ]; then
  warn "A ${GAP_SECS}s gap is shorter than 3 agent samples (${MIN_GAP}s)."
  warn "Alerts from one phase will still be open when the next starts."
fi

confirm "Run the full sequence (about $(human_secs "$TOTAL"))?"

# Each phase runs with -y regardless: the operator already confirmed the sequence,
# and stopping to ask again halfway through a 20-minute run defeats the point of a
# scripted demo. ASSUME_YES is exported so the child scripts see it too.
export ASSUME_YES=1

run_phase() {
  local name="$1"; shift
  printf '\n'
  hdr "Phase: ${name}"
  "$@"
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    warn "${name} exited with status ${rc} — continuing to the next phase."
  fi
  return 0
}

# A Ctrl+C during the sequence must not leave the disk ballast behind. Each script
# cleans up after itself on its own trap; this is the belt-and-braces pass for the
# case where the interrupt lands between phases.
on_int() {
  printf '\n'
  warn "Interrupted — cleaning up any leftovers."
  ./disk-stress.sh --clean >/dev/null 2>&1 || true
  exit 130
}
trap on_int INT TERM

FIRST=1
for p in "${PHASES[@]}"; do
  if [ "$FIRST" -eq 0 ]; then
    info "Quiet gap — letting the previous alert resolve…"
    countdown "$GAP_SECS" "resting"
  fi
  FIRST=0
  case "$p" in
    cpu)  run_phase "CPU"     ./cpu-stress.sh  -d "$PHASE_SECS" -y ;;
    mem)  run_phase "Memory"  ./mem-stress.sh  -d "$PHASE_SECS" -y ;;
    net)  run_phase "Network" ./net-stress.sh  -d "$PHASE_SECS" -y ;;
    disk) run_phase "Disk"    ./disk-stress.sh -d "$PHASE_SECS" -y ;;
  esac
done

printf '\n'
rule
ok "Sequence complete."
info "Give it $(( IV * 3 ))s more for the last alert to auto-resolve, then check:"
info "  Alerts page      — one incident per phase, acknowledged/resolved"
info "  History page     — the same events with actor = system"
info "  Analytics page   — forecasts, if you used disk-stress.sh --ramp"
./disk-stress.sh --clean >/dev/null 2>&1 || true
