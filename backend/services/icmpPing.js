import { spawn } from "node:child_process";
import { isValidIp } from "./snmpUtils.js";
import { pingArgs, parsePingOutput, pingDeadlineMs } from "./pingOutput.js";

// ─── ICMP ping — the fallback for routers that don't speak SNMP ────────────────
//
// The design doc (router-ups-monitoring.md §4) calls ICMP "the universal fallback"
// and "the one metric a no-SNMP router still gives". This is that module. It fills
// the three `router_metrics` fields the SNMP collector has always returned as null:
// `reachable`, `latency_ms`, `packet_loss_pct` — which networkMetricsHandler has
// been ready to write since it was first built.
//
// Two callers, two different jobs:
//
//   • PING-ONLY routers (no community string) — ICMP is the whole sample. Up/down,
//     latency, loss; no interfaces, no uptime, no traffic. This is the only way to
//     monitor ISP-owned CPE, which is locked down and will not answer SNMP.
//
//   • SNMP routers — ICMP runs ALONGSIDE the SNMP walk and adds latency/loss to it.
//     Those two say something SNMP cannot: SNMP answers or it doesn't, so a link
//     that is up but dropping 40% of packets reads as perfectly healthy right up
//     until the poll finally times out and the device flips to a flat Offline.
//
// All parsing lives in the pure pingOutput.js (and is tested there). This file is
// only the process handling.

const PING_COUNT = Math.max(1, Number(process.env.PING_COUNT) || 3);
const PING_TIMEOUT_MS = Math.max(100, Number(process.env.PING_TIMEOUT_MS) || 2000);

// The unreachable result. Latency/loss stay null vs 100 respectively: no packet came
// back, so loss IS 100%, but latency was never measured and writing 0 would pull a
// latency chart's average down exactly when the link is at its worst.
const DOWN = Object.freeze({
  reachable: false,
  latencyMs: null,
  packetLossPct: 100,
  minRttMs: null,
  maxRttMs: null,
  sent: 0,
  received: 0,
});

// Ping one host and return { reachable, latencyMs, packetLossPct, … }.
//
// NEVER THROWS and never rejects. Total packet loss is a legitimate measurement,
// not an error — the caller writes it to InfluxDB the same as any other reading,
// and a router that has been 100%-lost for an hour is exactly the history you want
// to look at afterwards. Contrast collectRouter(), which throws on an SNMP
// transport failure because there is no partial SNMP sample to report.
export async function ping(host, { count = PING_COUNT, timeoutMs = PING_TIMEOUT_MS } = {}) {
  // Defence in depth. Registration already validates the IP (snmpUtils.isValidIp)
  // and we spawn an argv ARRAY with no shell, so there is no command line to inject
  // into — but a value that reached here unvalidated would at best make `ping` treat
  // it as a hostname and hang on DNS, so refuse it outright.
  if (!isValidIp(host)) return { ...DOWN };

  const args = pingArgs({ platform: process.platform, host, count, timeoutMs });
  const deadline = pingDeadlineMs({ count, timeoutMs });

  const stdout = await run(args, deadline);
  if (stdout == null) return { ...DOWN };

  const r = parsePingOutput(stdout, count);
  return {
    reachable: r.reachable,
    latencyMs: r.avgRttMs,
    packetLossPct: r.packetLossPct,
    minRttMs: r.minRttMs,
    maxRttMs: r.maxRttMs,
    sent: r.sent,
    received: r.received,
  };
}

// Spawn `ping`, collect stdout, and resolve to it — or to null if the process could
// not be run at all. Resolves ONCE regardless of which of exit/error/timeout fires
// first (all three can, in any order).
function run(args, deadlineMs) {
  return new Promise((resolve) => {
    let child;
    try {
      // windowsHide keeps a console window from flashing when the backend runs as a
      // service or from a GUI-launched shell.
      child = spawn("ping", args, { windowsHide: true });
    } catch {
      return resolve(null); // no `ping` binary — resolve, don't throw
    }

    let out = "";
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };

    // Kill a wedged ping. The poller's `polling` guard only SKIPS an overlapping
    // tick — it never cancels one in flight — so without this a hung child would
    // stall every later poll of every device, and the dashboard would freeze rather
    // than show anything as offline.
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      // Parse whatever arrived before the kill: a partial run still carries real
      // replies, and reading them is strictly better than discarding the sample.
      finish(out);
    }, deadlineMs);

    child.stdout?.on("data", (d) => {
      out += d;
    });
    // stderr is drained but not parsed. `ping` writes its "unknown host" style
    // errors here, and those are simply a zero-reply run — already the right answer.
    // Draining matters anyway: an unread pipe fills and blocks the child.
    child.stderr?.on("data", () => {});

    // A non-zero exit is NOT an error here. Every platform exits non-zero when any
    // packet is lost, so treating it as a failure would discard the sample from
    // precisely the degraded links this module exists to measure.
    child.on("close", () => finish(out));
    child.on("error", () => finish(null)); // ENOENT etc.
  });
}

export default { ping };
