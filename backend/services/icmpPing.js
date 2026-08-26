import { spawn } from "node:child_process";
import { logSafe } from "../utils/logSafe.js";
import { isValidIp } from "./snmpUtils.js";
import { pingArgs, parsePingOutput, pingDeadlineMs } from "./pingOutput.js";

// ─── ICMP ping — the fallback for routers that don't speak SNMP ────────────────
//
// The design doc (router-ups-monitoring.md §4) calls ICMP "the universal fallback"
// and "the one metric a no-SNMP router still gives". This is that module. It fills
// the three `router_metrics` fields the SNMP collector has always returned as null:
// `reachable`, `latency_ms`, `packet_loss_pct` — which writeNetworkMetrics has
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
  // null on a normal result; a string when ICMP could not be ATTEMPTED at all.
  probeError: null,
  reachable: false,
  latencyMs: null,
  packetLossPct: 100,
  minRttMs: null,
  maxRttMs: null,
  sent: 0,
  received: 0,
});

// A broken probe is a SYSTEMIC condition — it fails identically for every device on
// every poll — so warn once rather than once per router per minute. Reset by a restart,
// which is when someone has plausibly changed something.
let probeWarned = "";
function warnProbeBroken(reason) {
  if (probeWarned === reason) return;
  probeWarned = reason;
  console.error(
    `[ICMP] ${reason}. Router latency and packet loss CANNOT be measured — those metrics ` +
      "are now reported as null rather than 100% loss, so nothing is falsely alerted. " +
      "If this backend runs under systemd, check NoNewPrivileges (it blocks the " +
      "setuid/cap_net_raw that ping needs) — see ops/systemd/cspc-monitoring.service.",
  );
}

// Ping one host and return { probeError, reachable, latencyMs, packetLossPct, … }.
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
  if (!isValidIp(host)) return { ...DOWN, probeError: "invalid IP address" };

  const args = pingArgs({ platform: process.platform, host, count, timeoutMs });
  const deadline = pingDeadlineMs({ count, timeoutMs });

  const { stdout, stderr, spawnError } = await run(args, deadline);

  // ─── "The probe is broken" is NOT "the network is down" ─────────────────────
  //
  // Both used to return 100% packet loss, which is the most misleading answer this
  // module could give: you would be investigating an outage that does not exist,
  // using the tool that invented it. The two cases are distinguishable:
  //
  //   spawnError            no `ping` binary (ENOENT), or not executable by this
  //                         account (EACCES/EPERM). A Node-level code, so it is
  //                         reliable and — unlike ping's own messages — not localized.
  //
  //   ran, but said nothing `ping` that cannot open its socket (systemd's
  //                         NoNewPrivileges=true blocks the setuid/cap_net_raw it
  //                         needs; so does a container without CAP_NET_RAW) writes to
  //                         stderr and produces NO stdout. A host that is merely down
  //                         still prints a summary line containing numbers.
  //
  // ⚠️ Detected by the ABSENCE of digits in stdout, never by matching words in stderr.
  // `ping` is localized — the whole reason pingOutput.js reads numbers and `ms` rather
  // than English — so "Operation not permitted" is not a string to rely on. "stdout
  // carried no numbers at all" is true in every language.
  const producedNothing = !/\d/.test(stdout ?? "");
  const probeError = spawnError
    ? `ping could not be started (${spawnError})`
    : producedNothing && (stderr ?? "").trim()
      ? `ping ran but produced no output: ${logSafe((stderr ?? "").trim(), 120)}`
      : null;

  if (probeError) {
    warnProbeBroken(probeError);
    // packetLossPct null, NOT 100: nothing was measured, so there is no measurement to
    // report. A caller writing this as 100% loss would poison the history it is meant
    // to explain.
    return { ...DOWN, packetLossPct: null, probeError };
  }

  const r = parsePingOutput(stdout, count);
  return {
    probeError: null,
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
    } catch (err) {
      // No `ping` binary, or not executable by this account. Resolve, don't throw —
      // but say WHY, because this is a broken probe, not a dead network.
      return resolve({ stdout: "", stderr: "", spawnError: err?.code || String(err) });
    }

    let out = "";
    let errOut = "";
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
      finish({ stdout: out, stderr: errOut, spawnError: null });
    }, deadlineMs);

    child.stdout?.on("data", (d) => {
      out += d;
    });
    // stderr is drained but not parsed. `ping` writes its "unknown host" style
    // errors here, and those are simply a zero-reply run — already the right answer.
    // Draining matters anyway: an unread pipe fills and blocks the child.
    // stderr is now KEPT, not discarded. It is the only thing that distinguishes
    // "ping could not open a socket" from "the host did not answer" — see ping().
    child.stderr?.on("data", (d) => {
      if (errOut.length < 500) errOut += d;
    });

    // A non-zero exit is NOT an error here. Every platform exits non-zero when any
    // packet is lost, so treating it as a failure would discard the sample from
    // precisely the degraded links this module exists to measure.
    child.on("close", () => finish({ stdout: out, stderr: errOut, spawnError: null }));
    child.on("error", (err) =>
      finish({ stdout: out, stderr: errOut, spawnError: err?.code || String(err) }),
    );
  });
}

export default { ping };
