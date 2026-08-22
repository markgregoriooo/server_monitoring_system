// ─── PURE helpers for the ICMP-ping path ──────────────────────────────────────
//
// DELIBERATELY IMPORT-FREE — no child_process, no config, no dotenv — so
// `backend/tests/` can exercise the parsing with nothing running and no packets
// sent. Same contract as snmpUtils.js / serverMetricUtils.js / linkAlertPolicy.js:
// icmpPing.js does the spawning and imports every rule from here, so the behaviour
// under test is the behaviour in production.
//
// ─── Why we shell out to the OS `ping` at all ─────────────────────────────────
//
// ICMP has no unprivileged socket API in Node. The alternative (`net-ping`, raw
// sockets) needs Administrator on Windows and root/CAP_NET_RAW on Linux, which
// would mean running the whole backend elevated — a far worse trade than parsing
// text, on a box that also holds JWT_SECRET and every device credential. The OS
// `ping` binary is already setuid/capability-granted on every platform we target,
// so this works as an ordinary user everywhere.
//
// ─── Why the parser reads NUMBERS and never WORDS ─────────────────────────────
//
// `ping` is localized. A Windows box installed in German prints `Zeit=15ms`, in
// Spanish `tiempo=15ms`; the summary block's "Average"/"Lost" labels translate too.
// Matching any of those words would produce a parser that works on the developer's
// machine and silently reports 100% packet loss on a differently-localized server
// — the worst possible failure, because "no reply" is indistinguishable from a
// genuinely dead device.
//
// So we key on the three things that do NOT translate:
//   • the literal unit `ms`
//   • the `=` / `<` before the number (`time=15ms`, `time<1ms`)
//   • the target's address appearing on a per-reply line
// and we COUNT the reply lines rather than reading a localized "Received = N".
// Loss is then derived from a count we chose ourselves, so it needs no parsing.

// A per-reply RTT token: `=15ms`, `<1ms`, `= 14.7 ms`, `=14,7 ms` (decimal comma).
const RTT = /[=<]\s*(\d+(?:[.,]\d+)?)\s*ms/i;
// Any IPv4 dotted quad, or an IPv6 hex-and-colon run. Only used to tell a per-reply
// line apart from a summary line — not for validation.
const ADDR = /\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,}/i;

// Is this line one host's answer to one echo request?
//
// A reply line carries BOTH the responder's address and an RTT; every summary line
// carries at most one of the two. That single rule separates them on every platform
// without knowing a word of the language:
//
//   Windows  "Reply from 8.8.8.8: bytes=32 time=15ms TTL=117"     addr + rtt → reply
//            "    Minimum = 14ms, Maximum = 16ms, Average = 15ms"  rtt only   → summary
//            "Ping statistics for 8.8.8.8:"                        addr only  → summary
//   Linux    "64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=14.7 ms"        → reply
//            "rtt min/avg/max/mdev = 14.7/15.2/16.1/0.5 ms"        rtt only   → summary
//            "4 packets transmitted, 4 received, 0% packet loss, time 3005ms" → summary
//
// It also rejects the failure replies that DO name an address — Windows'
// "Reply from 10.0.0.1: Destination host unreachable." is an intermediate router
// reporting it cannot forward, not the target answering, and has no RTT. Counting
// it as a reply would report a dead host as up.
export function isReplyLine(line) {
  const s = String(line ?? "");
  return ADDR.test(s) && RTT.test(s);
}

// Every per-reply RTT in the output, in milliseconds, in order.
// `time<1ms` (Windows' sub-millisecond case) is read as its bound, 1 — rounding it
// to 0 would claim a precision the tool explicitly declined to give.
export function rttSamples(stdout) {
  const out = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!isReplyLine(line)) continue;
    const m = line.match(RTT);
    if (!m) continue;
    const n = Number(m[1].replace(",", ".")); // decimal-comma locales
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

// Parse one `ping` run into the shape the poller writes to InfluxDB.
//
// `sent` is the count WE asked for, never a number scraped from the output: we
// chose it, so parsing it back would be a way to be wrong about a fact we already
// know. Loss therefore survives a completely unparseable stdout as 100% — which is
// the correct reading, since no reply line was seen.
//
// Returns null RTTs (not 0) when nothing answered: 0 ms is a measurement, absent is
// not, and writing 0 would drag a latency chart's average toward zero exactly when
// the link is worst. Mirrors inRange()'s reasoning in snmpUtils.js.
export function parsePingOutput(stdout, sent) {
  const total = Number.isInteger(sent) && sent > 0 ? sent : 0;
  const samples = rttSamples(stdout);
  // Never let a duplicate/late reply push received above what we sent — a negative
  // loss would be written to InfluxDB and graphed.
  const received = total > 0 ? Math.min(samples.length, total) : samples.length;
  const lossPct = total > 0 ? ((total - received) / total) * 100 : 100;

  return {
    sent: total,
    received,
    packetLossPct: Math.round(lossPct * 10) / 10,
    // The average is computed here rather than read from the summary block, which
    // is both localized and absent when every packet is lost.
    avgRttMs: samples.length ? round1(samples.reduce((a, b) => a + b, 0) / samples.length) : null,
    minRttMs: samples.length ? round1(Math.min(...samples)) : null,
    maxRttMs: samples.length ? round1(Math.max(...samples)) : null,
    reachable: received > 0,
  };
}

const round1 = (n) => Math.round(n * 10) / 10;

// Build the argv for one `ping` run. Returned as an ARRAY and spawned without a
// shell, so a hostile device name could never reach a command line — though the
// caller also restricts `host` to a validated IP.
//
// The flags differ per platform in ways that are easy to get subtly wrong:
//   -n / -c   packet count   (Windows spells it -n; POSIX -c)
//   -n        on POSIX this is "numeric output, no reverse DNS" — a different flag
//             that happens to share a letter. We pass it to skip a PTR lookup that
//             can add seconds per poll on a LAN with no reverse zone.
//   -w / -W   timeout, and the UNITS ARE NOT THE SAME:
//               Windows -w  milliseconds, per reply
//               Linux   -W  SECONDS, per reply   ← passing ms here waits ~2000 s
//               macOS   -W  milliseconds, per reply
//             Linux's iputils accepts a fractional second, so a sub-second timeout
//             still works there.
export function pingArgs({ platform, host, count = 3, timeoutMs = 2000 }) {
  const n = Math.max(1, Math.trunc(count));
  const ms = Math.max(100, Math.trunc(timeoutMs));
  if (platform === "win32") {
    return ["-n", String(n), "-w", String(ms), host];
  }
  if (platform === "darwin") {
    return ["-n", "-c", String(n), "-W", String(ms), host];
  }
  // linux and other POSIX
  return ["-n", "-c", String(n), "-W", String(ms / 1000), host];
}

// How long to let the process run before killing it. One `ping` sleeps ~1 s between
// packets, so the floor is (count - 1) intervals plus the last reply's timeout, and
// we add a margin for process start-up. Without this a wedged `ping` would hold the
// poll cycle open indefinitely — the poller's own guard only skips OVERLAPPING
// ticks, it does not cancel a running one.
export function pingDeadlineMs({ count = 3, timeoutMs = 2000, intervalMs = 1000 }) {
  return Math.max(1, Math.trunc(count) - 1) * intervalMs + timeoutMs + 2000;
}
