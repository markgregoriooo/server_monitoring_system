#!/usr/bin/env bash
# ============================================================================
#  Disk stress  →  moves `disk_percent` and the per-volume series
# ----------------------------------------------------------------------------
#  Seeded global rules this crosses:  disk >= 80 warning,  disk >= 90 critical
#  Alerts use the worst volume, not just the root (agentService.checkThresholds).
#
#  This fills disk space; it does not measure throughput. The agent reports usage
#  (disk_used_gb, disk_percent, per volume), not IOPS or MB/s. `--io` makes the fill
#  do real writes (seen as CPU iowait), but the metric that moves is percent used.
#
#  Be careful: a full root filesystem can break logging, apt, journald and even
#  sshd. So this always leaves free space, refuses tmpfs, refuses >90% without -y,
#  and deletes the ballast file on any exit, including Ctrl+C.
#
#  Usage:
#    ./disk-stress.sh                      # fill to 85% for 3 minutes, then clean up
#    ./disk-stress.sh -p 92 -y             # cross the critical rule
#    ./disk-stress.sh --ramp 30m -p 88     # grow slowly, giving Analytics a trend to fit
#    ./disk-stress.sh --clean              # remove ballast left by a kill -9
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")"
# shellcheck source=common.sh
. ./common.sh

TARGET_DIR="/var/tmp/cspc-stress"
TARGET_PCT=85
DURATION="3m"
RAMP=""
USE_IO=0
DO_CLEAN=0
MIN_FREE_MB=1024
ASSUME_YES=0

usage() {
  cat <<EOF
Disk stress — drives disk_percent up so the disk alert rules fire.

  -t DIR         where to write the ballast file  (default: /var/tmp/cspc-stress)
  -p PERCENT     fill the volume to this percent  (default: 85)
  -d DURATION    how long to hold it once full    (default: 3m)
  --ramp TIME    grow gradually over TIME instead of filling at once (e.g. 30m)
  --io           write real data with dd instead of reserving with fallocate
  --clean        delete any ballast file and exit
  --min-free MB  never leave less than this free  (default: 1024)
  -y             don't ask for confirmation (required above 90%)
  -h             this help

--ramp is for the Analytics page: a disk that climbs steadily over half an hour gives
the linear regression something to fit, so the disk-full ETA becomes a real forecast
instead of "Stable". A single instant fill is one step, which the R² gate rejects.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -t) TARGET_DIR="${2:-}"; shift 2 ;;
    -p) TARGET_PCT="${2:-}"; shift 2 ;;
    -d) DURATION="${2:-}"; shift 2 ;;
    --ramp) RAMP="${2:-}"; shift 2 ;;
    --min-free) MIN_FREE_MB="${2:-}"; shift 2 ;;
    --io) USE_IO=1; shift ;;
    --clean) DO_CLEAN=1; shift ;;
    -y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option '$1' (try -h)" ;;
  esac
done

BALLAST="${TARGET_DIR}/ballast.bin"

# ─── --clean ─────────────────────────────────────────────────────────────────
# The cleanup trap cannot run after kill -9 or a power-off; this removes the leftover
# ballast file.
if [ "$DO_CLEAN" = "1" ]; then
  if [ -f "$BALLAST" ]; then
    SZ="$(du -m "$BALLAST" 2>/dev/null | cut -f1)"
    rm -f "$BALLAST" && ok "Removed ${BALLAST} (${SZ:-?} MB)."
    rmdir "$TARGET_DIR" 2>/dev/null || true
  else
    info "No ballast file at ${BALLAST} — nothing to clean."
  fi
  exit 0
fi

SECS="$(parse_duration "$DURATION")" || die "Bad duration '$DURATION'."
RAMP_SECS=0
if [ -n "$RAMP" ]; then
  RAMP_SECS="$(parse_duration "$RAMP")" || die "Bad ramp '$RAMP'."
  [ "$RAMP_SECS" -ge 60 ] || die "A ramp shorter than a minute is just an instant fill."
fi
case "$TARGET_PCT" in ''|*[!0-9]*) die "Percent must be a whole number." ;; esac
case "$MIN_FREE_MB" in ''|*[!0-9]*) die "--min-free must be a whole number of MB." ;; esac

mkdir -p "$TARGET_DIR" 2>/dev/null || die "Cannot create ${TARGET_DIR} — check permissions."
[ -w "$TARGET_DIR" ] || die "${TARGET_DIR} is not writable."

# ─── Refuse a memory-backed filesystem ───────────────────────────────────────
# /tmp, /dev/shm and /run are often tmpfs, which fills RAM, not disk. The agent skips
# tmpfs volumes (collector.pseudoFS), so the disk chart would not move.
FSTYPE="$(stat -f -c %T "$TARGET_DIR" 2>/dev/null || echo unknown)"
case "$FSTYPE" in
  tmpfs|ramfs)
    die "${TARGET_DIR} is ${FSTYPE} — that is RAM, not disk. The agent ignores it. Use -t /var/tmp/cspc-stress."
    ;;
esac

read -r FS_TOTAL FS_USED FS_AVAIL MOUNT <<EOF
$(df -PB1 "$TARGET_DIR" | awk 'NR == 2 { print $2, $3, $4, $6 }')
EOF
[ -n "${FS_TOTAL:-}" ] || die "Could not read df for ${TARGET_DIR}."

CUR_PCT=$(( FS_USED * 100 / FS_TOTAL ))
TOTAL_MB=$(( FS_TOTAL / 1048576 ))
AVAIL_MB=$(( FS_AVAIL / 1048576 ))

{ [ "$TARGET_PCT" -ge 1 ] && [ "$TARGET_PCT" -le 99 ]; } || die "Percent must be 1-99."
if [ "$TARGET_PCT" -le "$CUR_PCT" ]; then
  die "${MOUNT} is already ${CUR_PCT}% full — target ${TARGET_PCT}% needs no ballast."
fi

NEED_MB=$(( (FS_TOTAL / 100 * TARGET_PCT - FS_USED) / 1048576 ))
[ "$NEED_MB" -ge 1 ] || die "Nothing to write."

# Never write into the last of the free space, whatever the percentage asks for.
MAX_MB=$(( AVAIL_MB - MIN_FREE_MB ))
[ "$MAX_MB" -ge 1 ] || die "Only ${AVAIL_MB} MB free on ${MOUNT}; --min-free is ${MIN_FREE_MB} MB. Nothing safe to write."

WRITE_MB="$NEED_MB"
CLAMPED=0
if [ "$WRITE_MB" -gt "$MAX_MB" ]; then
  WRITE_MB="$MAX_MB"
  CLAMPED=1
fi
PROJECTED_PCT=$(( (FS_USED + WRITE_MB * 1048576) * 100 / FS_TOTAL ))

hdr "Disk stress"
say "  target dir     : ${TARGET_DIR}"
say "  volume         : ${MOUNT} (${FSTYPE}, ${TOTAL_MB} MB total)"
say "  currently used : ${CUR_PCT}%   free: ${AVAIL_MB} MB"
say "  will write     : ${WRITE_MB} MB $( [ "$USE_IO" = "1" ] && echo '(real writes, dd)' || echo '(reserved, fallocate)' )"
say "  projected      : ~${PROJECTED_PCT}% used"
say "  free afterwards: $(( AVAIL_MB - WRITE_MB )) MB"
if [ "$RAMP_SECS" -gt 0 ]; then
  say "  mode           : ramp over $(human_secs "$RAMP_SECS"), then hold $(human_secs "$SECS")"
else
  say "  mode           : fill at once, hold $(human_secs "$SECS")"
fi
if   [ "$PROJECTED_PCT" -ge 90 ]; then say "  expected alert : ${RED}disk CRITICAL${OFF} (rule: >= 90)"
elif [ "$PROJECTED_PCT" -ge 80 ]; then say "  expected alert : ${YEL}disk WARNING${OFF} (rule: >= 80)"
else say "  expected alert : ${DIM}none — below the 80% warning rule${OFF}"
fi
[ "$CLAMPED" -eq 1 ] && warn "Asked for ${NEED_MB} MB, clamped to ${WRITE_MB} MB to keep ${MIN_FREE_MB} MB free."
sample_note $(( SECS + RAMP_SECS ))
rule

if [ "$PROJECTED_PCT" -gt 90 ]; then
  warn "Above 90% on ${MOUNT}. If this is the root filesystem, logging and package"
  warn "operations can start failing before the disk is actually full."
  [ "$ASSUME_YES" = "1" ] || die "Refusing above 90% without -y. Re-run with -y if you mean it."
fi

confirm "Write ${WRITE_MB} MB to ${BALLAST}?"

cleanup() {
  printf '\n'
  info "Removing ballast…"
  rm -f "$BALLAST" 2>/dev/null
  rmdir "$TARGET_DIR" 2>/dev/null || true
  ok "Disk space released."
}
trap 'cleanup; exit 130' INT TERM
trap 'cleanup' EXIT

# ─── Grow the ballast to N MB ────────────────────────────────────────────────
# fallocate reserves space instantly without writing, which is all the usage metric
# needs. dd really writes (slower, but gives the iowait --io asks for). If fallocate is
# not supported (some overlayfs or network mounts), fall back to dd.
grow_to() {
  local mb="$1"
  if [ "$USE_IO" = "0" ] && have fallocate; then
    if fallocate -l "${mb}M" "$BALLAST" 2>/dev/null; then return 0; fi
    warn "fallocate not supported on ${FSTYPE} — falling back to dd."
    USE_IO=1
  fi
  local have_mb=0
  [ -f "$BALLAST" ] && have_mb="$(du -m "$BALLAST" 2>/dev/null | cut -f1)"
  local add=$(( mb - have_mb ))
  [ "$add" -gt 0 ] || return 0
  dd if=/dev/zero bs=1M count="$add" status=none >> "$BALLAST" 2>/dev/null
}

say "Watch: Server Metrics → your VM → the disk tile, or Analytics → disk forecast."
rule

if [ "$RAMP_SECS" -gt 0 ]; then
  # One step every 30s, so several agent samples land on the way up for the regression.
  STEP_EVERY=30
  STEPS=$(( RAMP_SECS / STEP_EVERY ))
  [ "$STEPS" -lt 2 ] && STEPS=2
  say "Ramping to ${WRITE_MB} MB in ${STEPS} steps, one every ${STEP_EVERY}s…"
  for (( s = 1; s <= STEPS; s++ )); do
    SLICE_MB=$(( WRITE_MB * s / STEPS ))
    grow_to "$SLICE_MB"
    NOW_PCT="$(df -P "$TARGET_DIR" | awk 'NR == 2 { print $5 }')"
    printf '  step %d/%d — ballast %d MB, volume now %s\n' "$s" "$STEPS" "$SLICE_MB" "$NOW_PCT"
    [ "$s" -lt "$STEPS" ] && sleep "$STEP_EVERY"
  done
  ok "Ramp complete."
else
  say "Writing ${WRITE_MB} MB…"
  grow_to "$WRITE_MB"
  NOW_PCT="$(df -P "$TARGET_DIR" | awk 'NR == 2 { print $5 }')"
  ok "Ballast in place — ${MOUNT} is now ${NOW_PCT} full."
fi

countdown "$SECS" "holding ${WRITE_MB} MB"
cleanup
trap - EXIT INT TERM
ok "Done — disk released."
info "The open alert auto-resolves once 3 consecutive normal samples have landed."
