import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isReplyLine,
  rttSamples,
  parsePingOutput,
  pingArgs,
  pingDeadlineMs,
} from "../services/pingOutput.js";

// Tests for the ping output parser. No packets are sent. Run: cd backend && npm test
// The fixtures are real `ping` output, including localized versions.

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WINDOWS_OK = `
Pinging 10.233.200.18 with 32 bytes of data:
Reply from 10.233.200.18: bytes=32 time=15ms TTL=117
Reply from 10.233.200.18: bytes=32 time=14ms TTL=117
Reply from 10.233.200.18: bytes=32 time=16ms TTL=117

Ping statistics for 10.233.200.18:
    Packets: Sent = 3, Received = 3, Lost = 0 (0% loss),
Approximate round trip times in milli-seconds:
    Minimum = 14ms, Maximum = 16ms, Average = 15ms
`;

const LINUX_OK = `
PING 10.233.200.18 (10.233.200.18) 56(84) bytes of data.
64 bytes from 10.233.200.18: icmp_seq=1 ttl=117 time=14.7 ms
64 bytes from 10.233.200.18: icmp_seq=2 ttl=117 time=15.2 ms
64 bytes from 10.233.200.18: icmp_seq=3 ttl=117 time=16.1 ms

--- 10.233.200.18 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 2003ms
rtt min/avg/max/mdev = 14.700/15.333/16.100/0.573 ms
`;

const WINDOWS_TIMEOUT = `
Pinging 10.233.200.18 with 32 bytes of data:
Request timed out.
Request timed out.
Request timed out.

Ping statistics for 10.233.200.18:
    Packets: Sent = 3, Received = 0, Lost = 3 (100% loss),
`;

// The case that makes counting reply lines subtle: an intermediate ROUTER answers,
// naming itself, and the target never does.
const WINDOWS_HOST_UNREACHABLE = `
Pinging 10.233.200.18 with 32 bytes of data:
Reply from 10.0.0.1: Destination host unreachable.
Reply from 10.0.0.1: Destination host unreachable.
Reply from 10.0.0.1: Destination host unreachable.

Ping statistics for 10.233.200.18:
    Packets: Sent = 3, Received = 0, Lost = 3 (100% loss),
`;

// German Windows. Nothing an English-only parser keys on survives here.
const WINDOWS_DE = `
Ping wird ausgeführt für 10.233.200.18 mit 32 Bytes Daten:
Antwort von 10.233.200.18: Bytes=32 Zeit=15ms TTL=117
Antwort von 10.233.200.18: Bytes=32 Zeit=14ms TTL=117
Antwort von 10.233.200.18: Bytes=32 Zeit=16ms TTL=117

Ping-Statistik für 10.233.200.18:
    Pakete: Gesendet = 3, Empfangen = 3, Verloren = 0 (0% Verlust),
`;

// French, which prints a SPACE before the unit and a decimal comma.
const LINUX_FR = `
PING 10.233.200.18 (10.233.200.18) 56(84) octets de données.
64 octets de 10.233.200.18 : icmp_seq=1 ttl=117 temps=14,7 ms
64 octets de 10.233.200.18 : icmp_seq=2 ttl=117 temps=15,3 ms

--- statistiques ping 10.233.200.18 ---
2 paquets transmis, 2 reçus, 0% packet loss, temps 1002ms
`;

// ─── isReplyLine — the one rule the whole parser rests on ─────────────────────

test("a reply line carries both an address and an RTT", () => {
  assert.equal(isReplyLine("Reply from 8.8.8.8: bytes=32 time=15ms TTL=117"), true);
  assert.equal(isReplyLine("64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=14.7 ms"), true);
});

test("summary lines carry at most one of the two, so none of them count", () => {
  // RTTs but no address — Windows' average block and Linux's rtt line.
  assert.equal(isReplyLine("    Minimum = 14ms, Maximum = 16ms, Average = 15ms"), false);
  assert.equal(isReplyLine("rtt min/avg/max/mdev = 14.7/15.2/16.1/0.5 ms"), false);
  // An address but no RTT.
  assert.equal(isReplyLine("Ping statistics for 8.8.8.8:"), false);
  assert.equal(isReplyLine("--- 8.8.8.8 ping statistics ---"), false);
  // Linux's `time 3005ms` is the total elapsed time, not a reply, and has no address,
  // so it must not be read as a 3-second latency.
  assert.equal(isReplyLine("3 packets transmitted, 3 received, 0% packet loss, time 2003ms"), false);
});

// ─── The happy paths ──────────────────────────────────────────────────────────

test("windows: three replies parse to zero loss and the mean RTT", () => {
  const r = parsePingOutput(WINDOWS_OK, 3);
  assert.equal(r.reachable, true);
  assert.equal(r.received, 3);
  assert.equal(r.packetLossPct, 0);
  assert.equal(r.avgRttMs, 15); // (15+14+16)/3
  assert.equal(r.minRttMs, 14);
  assert.equal(r.maxRttMs, 16);
});

test("linux: fractional RTTs parse, and the average is ours not the tool's", () => {
  const r = parsePingOutput(LINUX_OK, 3);
  assert.equal(r.reachable, true);
  assert.equal(r.packetLossPct, 0);
  // (14.7 + 15.2 + 16.1) / 3 = 15.333… → 15.3. The tool's own summary says 15.333;
  // we round to one decimal because a latency chart does not plot micro-seconds.
  assert.equal(r.avgRttMs, 15.3);
});

// ─── Localization — the failure this parser exists to prevent ─────────────────

test("german windows parses identically to english", () => {
  const de = parsePingOutput(WINDOWS_DE, 3);
  const en = parsePingOutput(WINDOWS_OK, 3);
  assert.deepEqual(de, en);
});

test("a decimal comma is a decimal point, not a thousands separator", () => {
  const r = parsePingOutput(LINUX_FR, 2);
  assert.equal(r.received, 2);
  assert.equal(r.avgRttMs, 15); // (14.7 + 15.3) / 2 — NOT 147 and 153
  assert.equal(r.minRttMs, 14.7);
});

// ─── Loss, and the shapes that must not read as success ───────────────────────

test("total loss is reachable:false with a null latency, not a zero one", () => {
  const r = parsePingOutput(WINDOWS_TIMEOUT, 3);
  assert.equal(r.reachable, false);
  assert.equal(r.received, 0);
  assert.equal(r.packetLossPct, 100);
  // 0 ms would be a measurement. There wasn't one — and averaging a fabricated 0
  // into a latency chart would make the worst moments look like the best.
  assert.equal(r.avgRttMs, null);
  assert.equal(r.minRttMs, null);
  assert.equal(r.maxRttMs, null);
});

test("a router's 'destination host unreachable' is not the target replying", () => {
  // Three lines that each name an address and start with the word Reply. Counting
  // them would report a dead device as up with 0% loss.
  const r = parsePingOutput(WINDOWS_HOST_UNREACHABLE, 3);
  assert.equal(r.reachable, false);
  assert.equal(r.packetLossPct, 100);
});

test("partial loss is measured, not rounded away to up or down", () => {
  const oneOfThree = `
Reply from 10.233.200.18: bytes=32 time=15ms TTL=117
Request timed out.
Request timed out.
`;
  const r = parsePingOutput(oneOfThree, 3);
  assert.equal(r.reachable, true); // something answered — the device is alive
  assert.equal(r.received, 1);
  assert.equal(r.packetLossPct, 66.7); // …but two thirds of packets are gone
  assert.equal(r.avgRttMs, 15);
});

test("unparseable output reads as 100% loss, never as success", () => {
  // A killed process, an empty pipe, a shape no one anticipated: with no reply line
  // the honest answer is that nothing came back.
  for (const junk of ["", null, undefined, "ping: unknown host", "\n\n"]) {
    const r = parsePingOutput(junk, 3);
    assert.equal(r.reachable, false, `junk=${JSON.stringify(junk)}`);
    assert.equal(r.packetLossPct, 100);
  }
});

test("more replies than we sent cannot produce negative loss", () => {
  // Duplicates (a broadcast reply, a device answering twice) would otherwise make
  // received > sent and write a negative packet_loss_pct to InfluxDB.
  const dupes = `
Reply from 10.233.200.18: bytes=32 time=15ms TTL=117
Reply from 10.233.200.18: bytes=32 time=15ms TTL=117
Reply from 10.233.200.18: bytes=32 time=15ms TTL=117
`;
  const r = parsePingOutput(dupes, 2);
  assert.equal(r.received, 2);
  assert.equal(r.packetLossPct, 0);
});

test("sub-millisecond replies read as their bound, not as zero", () => {
  // Windows prints `time<1ms` on a LAN. Reading it as 0 would claim a precision the
  // tool explicitly declined to give.
  const r = parsePingOutput("Reply from 192.168.1.1: bytes=32 time<1ms TTL=64", 1);
  assert.equal(r.reachable, true);
  assert.equal(r.avgRttMs, 1);
});

// ─── Argument building — where the units bite ─────────────────────────────────

test("windows counts with -n and takes a millisecond timeout", () => {
  assert.deepEqual(pingArgs({ platform: "win32", host: "10.0.0.1", count: 3, timeoutMs: 2000 }), [
    "-n", "3", "-w", "2000", "10.0.0.1",
  ]);
});

test("linux -W is SECONDS — passing milliseconds would wait ~2000s per packet", () => {
  assert.deepEqual(pingArgs({ platform: "linux", host: "10.0.0.1", count: 3, timeoutMs: 2000 }), [
    "-n", "-c", "3", "-W", "2", "10.0.0.1",
  ]);
});

test("macos -W is milliseconds, unlike linux's identically-spelled flag", () => {
  assert.deepEqual(pingArgs({ platform: "darwin", host: "10.0.0.1", count: 3, timeoutMs: 2000 }), [
    "-n", "-c", "3", "-W", "2000", "10.0.0.1",
  ]);
});

test("the host is always the last argument and is never interpolated", () => {
  // argv is an array and spawn() runs without a shell, so even this reaches `ping`
  // as one opaque argument. (icmpPing.js also rejects a non-IP before spawning.)
  const args = pingArgs({ platform: "linux", host: "10.0.0.1; rm -rf /", count: 1 });
  assert.equal(args[args.length - 1], "10.0.0.1; rm -rf /");
});

// ─── The deadline ─────────────────────────────────────────────────────────────

test("the deadline covers the inter-packet gaps, not just one timeout", () => {
  // 3 packets = 2 one-second gaps + the last reply's 2 s timeout + 2 s of margin.
  // Sizing it at the timeout alone would kill a healthy 3-packet run every time.
  assert.equal(pingDeadlineMs({ count: 3, timeoutMs: 2000, intervalMs: 1000 }), 6000);
});

test("a single-packet run still gets a positive deadline", () => {
  assert.ok(pingDeadlineMs({ count: 1, timeoutMs: 2000, intervalMs: 1000 }) > 2000);
});
