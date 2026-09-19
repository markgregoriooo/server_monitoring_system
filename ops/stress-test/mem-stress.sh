#!/usr/bin/env bash
# ============================================================================
#  Memory stress  →  moves `mem_percent` on the dashboard
# ----------------------------------------------------------------------------
#  Seeded global rules this crosses:  mem >= 80 warning,  mem >= 95 critical
#
#  ⚠  THE ONE TEST THAT CAN TAKE THE VM DOWN. Past a certain point the kernel OOM
#  killer picks a victim by score, and the biggest processes on a monitoring VM are
#  often sshd, the agent, or the very database you are watching. If it kills the
#  agent, the dashboard raises "server offline" instead of "memory critical" — a
#  different alert, a worse demo, and a VM you may have to reboot from the console.
#  Hence the default target of 85% (warning band) and the refusal to go past 90%
#  without -y.
#
#  Usage:
#    ./mem-stress.sh                 # ~85% used for 3 minutes → warning
#    ./mem-stress.sh -p 96 -y -d 2m  # cross the critical rule, deliberately
#    ./mem-stress.sh -m 1024         # allocate exactly 1 GB
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")"
# shellcheck source=common.sh
. ./common.sh

DURATION="3m"
TARGET_PCT=85
ABS_MB=""
ASSUME_YES=0

usage() {
  cat <<EOF
Memory stress — drives mem_percent up so the mem alert rules fire.

  -d DURATION   how long to hold it: 90, 90s, 5m, 1h   (default: 3m)
  -p PERCENT    fill until TOTAL memory used reaches this  (default: 85)
  -m MB         allocate exactly this many MB (overrides -p)
  -y            don't ask for confirmation (required above 90%)
  -h            this help

Safety: always leaves a reserve free so the OOM killer stays out of it.
EOF
}

while getopts ":d:p:m:yh" opt; do
  case "$opt" in
    d) DURATION="$OPTARG" ;;
    p) TARGET_PCT="$OPTARG" ;;
    m) ABS_MB="$OPTARG" ;;
    y) ASSUME_YES=1 ;;
    h) usage; exit 0 ;;
    \?) die "Unknown option -$OPTARG (try -h)" ;;
    :)  die "-$OPTARG needs a value" ;;
  esac
done

SECS="$(parse_duration "$DURATION")" || die "Bad duration '$DURATION'."
[ "$SECS" -gt 0 ] || die "Duration must be greater than zero."
case "$TARGET_PCT" in ''|*[!0-9]*) die "Percent must be a whole number." ;; esac

[ -r /proc/meminfo ] || die "No /proc/meminfo — this script is Linux-only."

meminfo_kb() { awk -v k="$1" '$1 == k":" { print $2; exit }' /proc/meminfo; }

TOTAL_KB="$(meminfo_kb MemTotal)"
AVAIL_KB="$(meminfo_kb MemAvailable)"
[ -n "$TOTAL_KB" ] || die "Could not read MemTotal."
# Very old kernels (<3.14) have no MemAvailable; MemFree is a poor but usable stand-in.
[ -n "$AVAIL_KB" ] || AVAIL_KB="$(meminfo_kb MemFree)"

TOTAL_MB=$(( TOTAL_KB / 1024 ))
AVAIL_MB=$(( AVAIL_KB / 1024 ))
USED_MB=$(( TOTAL_MB - AVAIL_MB ))
USED_PCT=$(( USED_MB * 100 / TOTAL_MB ))

# Never allocate into the last slice of RAM. 5% of total, floored at 256 MB: enough
# for sshd to accept a login and the agent to keep POSTing while the test runs.
RESERVE_MB=$(( TOTAL_MB / 20 ))
[ "$RESERVE_MB" -lt 256 ] && RESERVE_MB=256

if [ -n "$ABS_MB" ]; then
  case "$ABS_MB" in ''|*[!0-9]*) die "-m needs a whole number of MB." ;; esac
  WANT_MB="$ABS_MB"
else
  { [ "$TARGET_PCT" -ge 1 ] && [ "$TARGET_PCT" -le 99 ]; } || die "Percent must be 1-99."
  if [ "$TARGET_PCT" -le "$USED_PCT" ]; then
    die "Memory is already at ${USED_PCT}% — target ${TARGET_PCT}% needs no allocation."
  fi
  WANT_MB=$(( TOTAL_MB * TARGET_PCT / 100 - USED_MB ))
fi

MAX_SAFE_MB=$(( AVAIL_MB - RESERVE_MB ))
[ "$MAX_SAFE_MB" -lt 1 ] && die "Only ${AVAIL_MB} MB available — not enough headroom to test safely."

ALLOC_MB="$WANT_MB"
CLAMPED=0
if [ "$ALLOC_MB" -gt "$MAX_SAFE_MB" ]; then
  ALLOC_MB="$MAX_SAFE_MB"
  CLAMPED=1
fi
[ "$ALLOC_MB" -ge 1 ] || die "Nothing to allocate."

PROJECTED_PCT=$(( (USED_MB + ALLOC_MB) * 100 / TOTAL_MB ))

hdr "Memory stress"
say "  total          : ${TOTAL_MB} MB"
say "  currently used : ${USED_MB} MB (${USED_PCT}%)"
say "  will allocate  : ${ALLOC_MB} MB"
say "  reserve kept   : ${RESERVE_MB} MB free"
say "  projected      : ~${PROJECTED_PCT}% used"
say "  duration       : $(human_secs "$SECS")"
if   [ "$PROJECTED_PCT" -ge 95 ]; then say "  expected alert : ${RED}mem CRITICAL${OFF} (rule: >= 95)"
elif [ "$PROJECTED_PCT" -ge 80 ]; then say "  expected alert : ${YEL}mem WARNING${OFF} (rule: >= 80)"
else say "  expected alert : ${DIM}none — below the 80% warning rule${OFF}"
fi
[ "$CLAMPED" -eq 1 ] && warn "Asked for ${WANT_MB} MB, clamped to ${ALLOC_MB} MB to keep ${RESERVE_MB} MB free."
sample_note "$SECS"
rule

if [ "$PROJECTED_PCT" -gt 90 ]; then
  warn "Above 90% the OOM killer may kill sshd, the agent, or MySQL."
  warn "If it kills the agent you get a SERVER OFFLINE alert, not a memory one."
  [ "$ASSUME_YES" = "1" ] || die "Refusing above 90% without -y. Re-run with -y if you mean it."
fi

confirm "Allocate ${ALLOC_MB} MB for $(human_secs "$SECS")?"

SHM_FILE=""
cleanup() {
  printf '\n'
  info "Releasing memory…"
  kill_workers
  [ -n "$SHM_FILE" ] && rm -f "$SHM_FILE" 2>/dev/null
  ok "Memory released."
}
trap 'cleanup; exit 130' INT TERM
trap 'cleanup' EXIT

# ─── Allocation method, in order of preference ───────────────────────────────
# python3  — exact, unprivileged, and the pages are TOUCHED so they are resident
#            rather than merely promised. An untouched allocation moves nothing:
#            Linux hands out address space lazily and the agent reports resident
#            memory, so a malloc nobody writes to is invisible on the dashboard.
# stress-ng— if it happens to be installed, it does the same job.
# /dev/shm — tmpfs, so a file there IS memory. Works with no interpreter at all.
#            Capped by the tmpfs size (usually 50% of RAM), which is why it is last.
if have python3; then
  METHOD="python3"
elif have stress-ng; then
  METHOD="stress-ng"
elif [ -d /dev/shm ] && [ -w /dev/shm ]; then
  METHOD="shm"
else
  die "Need python3, stress-ng, or a writable /dev/shm. Install python3: sudo apt install -y python3"
fi

say "Method: ${METHOD}"
say "Watch: Server Metrics → your VM, or the Dashboard memory tile."
rule

case "$METHOD" in
  python3)
    python3 "$(dirname "$0")/hold-memory.py" "$ALLOC_MB" "$SECS" &
    STRESS_PIDS+=($!)
    ;;
  stress-ng)
    stress-ng --vm 1 --vm-bytes "${ALLOC_MB}M" --vm-keep --timeout "${SECS}s" >/dev/null 2>&1 &
    STRESS_PIDS+=($!)
    ;;
  shm)
    SHM_AVAIL_MB="$(df -Pm /dev/shm 2>/dev/null | awk 'NR == 2 { print $4 }')"
    if [ -n "$SHM_AVAIL_MB" ] && [ "$ALLOC_MB" -gt "$SHM_AVAIL_MB" ]; then
      warn "/dev/shm holds only ${SHM_AVAIL_MB} MB (tmpfs is usually capped at half of RAM)."
      warn "Allocating ${SHM_AVAIL_MB} MB instead. To raise it: sudo mount -o remount,size=90% /dev/shm"
      ALLOC_MB="$SHM_AVAIL_MB"
    fi
    SHM_FILE="/dev/shm/cspc-stress.$$"
    dd if=/dev/zero of="$SHM_FILE" bs=1M count="$ALLOC_MB" status=none 2>/dev/null &
    STRESS_PIDS+=($!)
    ;;
esac

countdown "$SECS" "holding ${ALLOC_MB} MB"
kill_workers
[ -n "$SHM_FILE" ] && rm -f "$SHM_FILE" 2>/dev/null
ok "Done — memory released after $(human_secs "$SECS")."
info "The open alert auto-resolves once 3 consecutive normal samples have landed."
