import { spawn } from "node:child_process";
import { logSafe } from "../utils/logSafe.js";
import { isValidIp } from "./snmpUtils.js";
import { pingArgs, parsePingOutput, pingDeadlineMs } from "./pingOutput.js";

// ─── ICMP ping ────────────────
// Fills router_metrics' reachable, latency_ms and packet_loss_pct.
//
//   • Ping-only routers (no community): ping is the whole sample. The only way to
//     monitor ISP equipment that does not answer SNMP.
//   • SNMP routers: ping runs next to the SNMP walk and adds latency/loss, which
//     SNMP cannot show (it either answers or times out).
//
// Parsing is in pingOutput.js (tested); this file runs the process.

const PING_COUNT = Math.max(1, Number(process.env.PING_COUNT) || 3);
const PING_TIMEOUT_MS = Math.max(100, Number(process.env.PING_TIMEOUT_MS) || 2000);

// Unreachable result: loss is 100%, latency stays null (writing 0 would pull the
// average latency down when the link is at its worst).
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

// A broken ping fails the same way for every device, so warn once per process.
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
// Never throws or rejects: 100% loss is a measurement and gets written like any
// other. (collectRouter() throws instead, because a failed SNMP walk has no partial
// sample.)
export async function ping(host, { count = PING_COUNT, timeoutMs = PING_TIMEOUT_MS } = {}) {
  // The IP is validated at registration and ping is spawned without a shell, but an
  // invalid value would make ping try DNS and hang, so refuse it.
  if (!isValidIp(host)) return { ...DOWN, probeError: "invalid IP address" };

  const args = pingArgs({ platform: process.platform, host, count, timeoutMs });
  const deadline = pingDeadlineMs({ count, timeoutMs });

  const { stdout, stderr, spawnError } = await run(args, deadline);

  // ─── "Ping is broken" is not "the network is down" ─────────────────────
  // Both used to show as 100% loss. They can be told apart:
  //
  //   spawnError            no `ping` binary (ENOENT) or not allowed to run it
  //                         (EACCES/EPERM). A Node error code, so not localized.
  //
  //   ran, but said nothing ping without socket permission (systemd
  //                         NoNewPrivileges=true, a container without CAP_NET_RAW)
  //                         prints nothing to stdout; a down host still prints a
  //                         summary with numbers.
  //
  // Detected by the absence of digits in stdout, not by stderr text, because ping's
  // messages are localized.
  const producedNothing = !/\d/.test(stdout ?? "");
  const probeError = spawnError
    ? `ping could not be started (${spawnError})`
    : producedNothing && (stderr ?? "").trim()
      ? `ping ran but produced no output: ${logSafe((stderr ?? "").trim(), 120)}`
      : null;

  if (probeError) {
    warnProbeBroken(probeError);
    // packetLossPct null, not 100: nothing was measured.
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

// Spawn `ping` and resolve to its stdout, or null if it could not run. Resolves once,
// whichever of exit/error/timeout comes first.
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

    // Kill a hung ping. The poller only skips overlapping ticks, so a stuck child would
    // stall every later poll.
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
    // stderr is collected (an unread pipe would block the child) and kept, since it
    // helps tell "ping could not open a socket" from "the host did not answer".
    child.stderr?.on("data", (d) => {
      if (errOut.length < 500) errOut += d;
    });

    // A non-zero exit is not an error: ping exits non-zero whenever any packet is lost.
    child.on("close", () => finish({ stdout: out, stderr: errOut, spawnError: null }));
    child.on("error", (err) =>
      finish({ stdout: out, stderr: errOut, spawnError: err?.code || String(err) }),
    );
  });
}

export default { ping };
