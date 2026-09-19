#!/usr/bin/env bash
# ============================================================================
#  Network I/O stress  →  moves `net_bytes_sent` / `net_bytes_recv`
# ----------------------------------------------------------------------------
#  ⚠  NO ALERT RULE READS THESE. There is no seeded rule for server network
#  throughput — link_util / link_errors belong to ROUTER interfaces (SNMP and
#  MikroTik), not to an agent-reported server. So this test moves the Network tile
#  on Server Metrics and the network series in a server report; it will not raise a
#  notification. That is the system working as designed, not a broken test.
#
#  Defaults to LOOPBACK, which still counts: the agent reads gopsutil
#  IOCounters(false) — the sum across every interface, `lo` included — so traffic
#  that never leaves the VM moves both counters, and moves them twice, once as sent
#  and once as received. No switch port, no uplink, nobody else's bandwidth.
#
#  Usage:
#    ./net-stress.sh                       # loopback, flat out, 3 minutes
#    ./net-stress.sh -d 5m -r 50           # pace it at ~50 MB/s
#    ./net-stress.sh --target 192.168.100.40:5201   # real traffic (iperf3 server)
# ============================================================================
set -uo pipefail
cd "$(dirname "$0")"
# shellcheck source=common.sh
. ./common.sh

DURATION="3m"
RATE_MB=0
TARGET=""
ASSUME_YES=0

usage() {
  cat <<EOF
Network stress — drives net_bytes_sent / net_bytes_recv up.

  -d DURATION      how long to run: 90, 90s, 5m, 1h   (default: 3m)
  -r MB_PER_SEC    pace the traffic (0 = flat out)    (default: 0)
  --target H:PORT  send to a real iperf3 server instead of loopback
  -y               don't ask for confirmation
  -h               this help

Loopback is the default on purpose — it produces the same counter movement with no
effect on anyone else's network. Use --target only against a host you own.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -d) DURATION="${2:-}"; shift 2 ;;
    -r) RATE_MB="${2:-}"; shift 2 ;;
    --target) TARGET="${2:-}"; shift 2 ;;
    -y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option '$1' (try -h)" ;;
  esac
done

SECS="$(parse_duration "$DURATION")" || die "Bad duration '$DURATION'."
[ "$SECS" -gt 0 ] || die "Duration must be greater than zero."
case "$RATE_MB" in ''|*[!0-9]*) die "-r must be a whole number of MB/s (0 for unlimited)." ;; esac

# ─── Remote target ───────────────────────────────────────────────────────────
if [ -n "$TARGET" ]; then
  case "$TARGET" in
    *:*) HOST="${TARGET%%:*}"; PORT="${TARGET##*:}" ;;
    *) die "--target needs HOST:PORT, e.g. 192.168.100.40:5201" ;;
  esac
  case "$PORT" in ''|*[!0-9]*) die "Port must be a number." ;; esac
  have iperf3 || die "--target needs iperf3 on this VM and an 'iperf3 -s' running on ${HOST}."

  hdr "Network stress — REMOTE"
  say "  target     : ${HOST}:${PORT}"
  say "  duration   : $(human_secs "$SECS")"
  say "  rate       : $( [ "$RATE_MB" = "0" ] && echo 'unlimited' || echo "${RATE_MB} MB/s" )"
  warn "This puts REAL traffic on the campus network. Only do this against a host you own,"
  warn "and not during class hours on a shared uplink."
  sample_note "$SECS"
  rule
  confirm "Send real traffic to ${HOST}:${PORT}?"

  IPERF_ARGS=(-c "$HOST" -p "$PORT" -t "$SECS")
  [ "$RATE_MB" != "0" ] && IPERF_ARGS+=(-b "${RATE_MB}M")
  iperf3 "${IPERF_ARGS[@]}"
  ok "Done."
  exit 0
fi

# ─── Loopback ────────────────────────────────────────────────────────────────
if have python3; then
  METHOD="python3"
elif have iperf3; then
  METHOD="iperf3"
elif have nc; then
  METHOD="nc"
else
  die "Need python3, iperf3 or nc. Install python3: sudo apt install -y python3"
fi

hdr "Network stress — loopback"
say "  interface  : lo (127.0.0.1)"
say "  method     : ${METHOD}"
say "  duration   : $(human_secs "$SECS")"
say "  rate       : $( [ "$RATE_MB" = "0" ] && echo 'unlimited' || echo "${RATE_MB} MB/s" )"
say "  moves      : net_bytes_sent AND net_bytes_recv (both ends are this host)"
say "  alert      : ${DIM}none — no seeded rule reads server network throughput${OFF}"
sample_note "$SECS"
rule
confirm "Start?"

cleanup() {
  printf '\n'
  info "Stopping traffic…"
  kill_workers
  ok "Network idle again."
}
trap 'cleanup; exit 130' INT TERM
trap 'kill_workers' EXIT

say "Watch: Server Metrics → your VM → the Network tile (bytes/s, derived from the counters)."
rule

case "$METHOD" in
  python3)
    python3 "$(dirname "$0")/blast-loopback.py" "$SECS" "$RATE_MB"
    ;;

  iperf3)
    # One server, one client, both on loopback. The server is ours, on an unused
    # high port, and is torn down with the script.
    PORT=5399
    iperf3 -s -1 -p "$PORT" -B 127.0.0.1 >/dev/null 2>&1 &
    STRESS_PIDS+=($!)
    sleep 1
    IPERF_ARGS=(-c 127.0.0.1 -p "$PORT" -t "$SECS")
    [ "$RATE_MB" != "0" ] && IPERF_ARGS+=(-b "${RATE_MB}M")
    iperf3 "${IPERF_ARGS[@]}"
    kill_workers
    ;;

  nc)
    # Last resort: nc's flags differ between the OpenBSD, traditional and busybox
    # builds, so this uses only the two every build agrees on (-l and -p is NOT
    # portable; `nc -l PORT` is). Rate limiting is not available on this path.
    [ "$RATE_MB" != "0" ] && warn "The nc fallback cannot pace traffic — ignoring -r."
    PORT=5399
    nc -l "$PORT" >/dev/null 2>&1 &
    STRESS_PIDS+=($!)
    sleep 1
    timeout "${SECS}s" dd if=/dev/zero bs=256k status=none 2>/dev/null | nc 127.0.0.1 "$PORT" &
    STRESS_PIDS+=($!)
    countdown "$SECS" "blasting loopback"
    kill_workers
    ;;
esac

ok "Done — network idle after $(human_secs "$SECS")."
info "The counters are cumulative; the dashboard derives the rate, so the tile falls back to idle on its own."
