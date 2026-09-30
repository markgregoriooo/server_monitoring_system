// ─── Helpers for the ICMP ping path ──────────────────────────────────────
// No imports, so backend/tests can check the parsing without sending packets.
// icmpPing.js runs the process and uses these rules.
//
// We run the OS `ping` because raw ICMP sockets in Node (net-ping) need
// Administrator/root, and running the backend elevated is a worse trade.
//
// `ping` output is localized (German prints `Zeit=15ms`), so the parser never
// matches words. It only uses what does not translate:
//   • the unit `ms`
//   • the `=` / `<` before the number (`time=15ms`, `time<1ms`)
//   • the target's address on each reply line
// and it counts reply lines itself instead of reading a "Received = N" label.

// A per-reply RTT token: `=15ms`, `<1ms`, `= 14.7 ms`, `=14,7 ms` (decimal comma).
const RTT = /[=<]\s*(\d+(?:[.,]\d+)?)\s*ms/i;
// Any IPv4 dotted quad, or an IPv6 hex-and-colon run. Only used to tell a per-reply
// line apart from a summary line — not for validation.
const ADDR = /\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,}/i;

// Is this line a reply to one echo request? A reply line has both an address and a
// time; summary lines have at most one of them:
//
//   Windows  "Reply from 8.8.8.8: bytes=32 time=15ms TTL=117"     addr + rtt → reply
//            "    Minimum = 14ms, Maximum = 16ms, Average = 15ms"  rtt only   → summary
//            "Ping statistics for 8.8.8.8:"                        addr only  → summary
//   Linux    "64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=14.7 ms"        → reply
//            "rtt min/avg/max/mdev = 14.7/15.2/16.1/0.5 ms"        rtt only   → summary
//            "4 packets transmitted, 4 received, 0% packet loss, time 3005ms" → summary
//
// This also rejects Windows' "Reply from 10.0.0.1: Destination host unreachable."
// (another router replying, with no time), which must not count as the host being up.
export function isReplyLine(line) {
  const s = String(line ?? "");
  return ADDR.test(s) && RTT.test(s);
}

// Every reply's round-trip time in ms, in order. `time<1ms` (Windows) is read as 1.
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
// `sent` is the count we asked for, not parsed from the output, so unreadable output
// still gives 100% loss (no reply lines were seen). Times are null, not 0, when
// nothing answered: 0 would pull the average latency down.
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

// Build the argv for one `ping` run. An array, spawned without a shell, and `host`
// is already a validated IP.
//
// Platform flags:
//   -n / -c   packet count (Windows -n, POSIX -c)
//   -n        on POSIX means "numeric output" (no reverse DNS lookup, which can
//             add seconds per poll)
//   -w / -W   timeout, in different units:
//               Windows -w  milliseconds, per reply
//               Linux   -W  seconds, per reply (passing ms would wait ~2000 s)
//               macOS   -W  milliseconds, per reply
//             Linux accepts fractional seconds.
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

// How long to let ping run before killing it: about 1s between packets, plus the
// last reply's timeout and some start-up margin. The poller does not cancel a
// running poll, so a stuck ping would hold it forever.
export function pingDeadlineMs({ count = 3, timeoutMs = 2000, intervalMs = 1000 }) {
  return Math.max(1, Math.trunc(count) - 1) * intervalMs + timeoutMs + 2000;
}
