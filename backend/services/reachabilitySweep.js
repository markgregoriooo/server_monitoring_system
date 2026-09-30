import "../config/env.js";
import db from "../config/mysql.js";
import { ping } from "./icmpPing.js";
import { describeError } from "../utils/httpError.js";
import agentService from "./agentService.js";
import snmpPollerService from "./snmpPollerService.js";
import mikrotikPollerService from "./mikrotikPollerService.js";

/**
 * Fast offline detection.
 *
 * Without it, going offline was only noticed by the full polls:
 *
 *     servers    heartbeat window + sweep                               → 30-45s
 *     routers    the next SNMP walk                                     → up to 60s
 *     UPS        the next SNMP walk                                     → up to 60s
 *     MikroTik   the next RouterOS API poll                             → up to 30s
 *
 * "Is it still there?" is much cheaper than a full poll, so this sends one ping to
 * every online device every few seconds.
 *
 * Three rules:
 * 1. Down only. A failed ping can mark a device offline; a reply never marks it
 *    online. Recovery is left to the full poll, which owns the status.
 * 2. Only devices seen answering ping before. Some equipment blocks ICMP but
 *    answers SNMP. A device becomes eligible once it has replied at least once
 *    (`everAnswered`), so after a restart the worst case is the old behaviour.
 * 3. Confirm first. A device must miss FAST_OFFLINE_FAILS sweeps in a row (default
 *    2) before it is flipped, so one lost packet is not an outage.
 *
 * The change itself goes through each poller's setReachable() (or agentService for
 * servers), so the alert and log are the same as a poller-raised one.
 */

const SWEEP_MS = Math.max(1000, Number(process.env.FAST_OFFLINE_CHECK_MS) || 5000);
const PING_TIMEOUT_MS = Math.max(200, Number(process.env.FAST_OFFLINE_PING_TIMEOUT_MS) || 1000);
const FAILS_BEFORE_DOWN = Math.max(1, Number(process.env.FAST_OFFLINE_FAILS) || 2);
const ENABLED = (process.env.FAST_OFFLINE_CHECK ?? "").trim().toLowerCase() !== "false";

// Devices seen answering ping at least once. In memory; relearned in one sweep
// after a restart.
const everAnswered = new Set();

// Consecutive failed sweeps per device id. Cleared by any reply.
const failures = new Map();

let timer = null;
let running = false;

// Only online devices can go offline, so offline ones are skipped. Servers in
// maintenance are skipped too.
async function loadCandidates() {
  const [rows] = await db.query(
    `SELECT d.device_id AS id,
            COALESCE(NULLIF(d.display_name, ''), d.device_name) AS name,
            d.device_type AS type,
            d.ip_address  AS ip,
            d.status
       FROM devices d
      WHERE d.status = 'online'
        AND d.device_type IN ('server','router','ups','mikrotik')
        AND d.ip_address IS NOT NULL
        AND d.ip_address <> ''`,
  );
  return rows;
}

// Hand the change to whoever owns this device type's status, so the alert, log and
// socket event are the same as from the slow path. Returns false when the owner
// declines, e.g. a server whose agent is still reporting (see
// agentService.markOfflineByIds).
async function markOffline(io, d) {
  if (d.type === "server") {
    const rows = await agentService.markOfflineByIds([d.id]);
    await agentService.announceOffline(io, rows);
    return rows.length > 0;
  }
  if (d.type === "mikrotik") {
    await mikrotikPollerService.setReachable(io, d, false, "MikroTik unreachable — no ICMP reply");
    return true;
  }
  await snmpPollerService.setReachable(io, { ...d, pingOnly: true }, false);
  return true;
}

async function sweep(io) {
  if (running) return;
  running = true;
  try {
    const devices = await loadCandidates();
    if (devices.length === 0) return;

    // Ping all at once; one at a time would make the sweep slowest exactly when many
    // devices are down.
    const results = await Promise.all(
      devices.map(async (d) => ({ d, r: await ping(d.ip, { count: 1, timeoutMs: PING_TIMEOUT_MS }) })),
    );

    for (const { d, r } of results) {
      const id = Number(d.id);

      // probeError = ping itself could not run (missing binary, no permission). That is not
      // a down device, and treating it as one would take every device offline at once.
      if (r.probeError) continue;

      if (r.reachable) {
        everAnswered.add(id);
        failures.delete(id);
        continue;
      }

      if (!everAnswered.has(id)) continue; // rule 2 — never seen it answer, stay out of it

      const n = (failures.get(id) ?? 0) + 1;
      failures.set(id, n);
      if (n < FAILS_BEFORE_DOWN) continue;

      try {
        // Only reset the streak on a real flip. A server whose agent is still posting is
        // declined; keeping its count lets the flip land the moment it also goes quiet.
        if (!(await markOffline(io, d))) continue;
        failures.delete(id);
        console.warn(
          `[FAST_OFFLINE] ${d.type} "${d.name}" (${d.ip}) — ${n} missed ICMP replies, marked offline`,
        );
      } catch (err) {
        console.error(`[FAST_OFFLINE] could not mark ${d.type} ${d.id} offline:`, describeError(err));
      }
    }
  } catch (err) {
    console.error("[FAST_OFFLINE] sweep error:", describeError(err));
  } finally {
    running = false;
  }
}

function init(io) {
  if (!ENABLED) {
    console.log("[FAST_OFFLINE] disabled (FAST_OFFLINE_CHECK=false) — offline detection falls back to the full polls");
    return;
  }
  if (timer) return;
  timer = setInterval(() => sweep(io), SWEEP_MS);
  console.log(
    `[FAST_OFFLINE] ICMP reachability sweep every ${SWEEP_MS}ms ` +
      `(${FAILS_BEFORE_DOWN} consecutive misses before offline, ${PING_TIMEOUT_MS}ms timeout)`,
  );
}

// Exposed for a targeted check right after something is known to have changed.
async function checkNow(io) {
  await sweep(io);
}

export default { init, checkNow };
