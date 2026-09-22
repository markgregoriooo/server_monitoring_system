import "../config/env.js";
import db from "../config/mysql.js";
import { ping } from "./icmpPing.js";
import { describeError } from "../utils/httpError.js";
import agentService from "./agentService.js";
import snmpPollerService from "./snmpPollerService.js";
import mikrotikPollerService from "./mikrotikPollerService.js";

/**
 * FAST offline detection — the missing half of `pollDeviceNow`.
 *
 * Registering a device gives an immediate answer because the admin's click IS the
 * trigger: we know the exact moment to go and look. Going offline has no trigger, so
 * something has to notice an ABSENCE, and until this existed the only things noticing
 * were the full polls:
 *
 *     servers    heartbeat window (3 missed posts, ≥30s) + a 15s sweep  → 30-45s
 *     routers    the next SNMP walk                                     → up to 60s
 *     UPS        the next SNMP walk                                     → up to 60s
 *     MikroTik   the next RouterOS API poll                             → up to 30s
 *
 * Those cadences are set by what the full poll COSTS — an SNMP walk of every interface,
 * a RouterOS login. But "is it still there?" is a far cheaper question than "what are
 * its metrics?", and separating the two is the whole idea here: one ICMP echo, every
 * few seconds, for every device at once.
 *
 * ── Three rules keep this safe ───────────────────────────────────────────────────
 *
 * 1. DOWN-ONLY. A failed ping can mark a device offline; a successful one marks nothing
 *    online. Recovery stays with the real poll, which is the only thing that can say a
 *    router is answering SNMP again rather than merely answering ICMP. A fast path that
 *    could also mark UP would fight the poller for ownership of the status column.
 *
 * 2. NEVER ACT ON A DEVICE WE HAVE NOT SEEN ANSWER. Plenty of equipment drops ICMP by
 *    policy while answering SNMP perfectly, and marking that offline every 5 seconds
 *    would be worse than the delay this removes. A device only becomes eligible once
 *    this sweep has seen it reply at least once (`everAnswered`). Unknown means do
 *    nothing — so the failure mode of a fresh start is the OLD behaviour, not a false
 *    alarm. The cost is that a device which is already down when the backend starts is
 *    detected by the normal poll, once, and is eligible from then on.
 *
 * 3. CONFIRM BEFORE FLIPPING. One lost echo is not an outage — it is a lost echo. A
 *    device must fail `FAST_OFFLINE_FAILS` consecutive sweeps (default 2) before it is
 *    flipped, which at a 5s cadence still beats every full poll by a wide margin while
 *    being immune to a single dropped packet.
 *
 * The transition itself is NOT reimplemented here. Each poller already owns a
 * `setReachable()` that writes the device row, the device log, the socket event and the
 * real alert, and `agentService` owns the equivalent for servers. This sweep only
 * decides WHEN to call them, so an offline raised at 5 seconds is indistinguishable from
 * one raised by the poller at 60 — same log line, same alert, same severity.
 */

const SWEEP_MS = Math.max(1000, Number(process.env.FAST_OFFLINE_CHECK_MS) || 5000);
const PING_TIMEOUT_MS = Math.max(200, Number(process.env.FAST_OFFLINE_PING_TIMEOUT_MS) || 1000);
const FAILS_BEFORE_DOWN = Math.max(1, Number(process.env.FAST_OFFLINE_FAILS) || 2);
const ENABLED = (process.env.FAST_OFFLINE_CHECK ?? "").trim().toLowerCase() !== "false";

// Device ids this sweep has seen reply to ICMP at least once. In memory on purpose:
// the question it answers is "does this device answer ping AT ALL", and a restart
// re-learning that over one sweep is cheaper than a column that can go stale against
// a device whose firewall policy changed months ago.
const everAnswered = new Set();

// Consecutive failed sweeps per device id. Cleared by any reply.
const failures = new Map();

let timer = null;
let running = false;

// Only devices that are currently ONLINE can transition to offline, so the ones already
// marked offline are not worth an echo. Maintenance is excluded for the same reason the
// offline sweep excludes it: the server is down on purpose and nobody wants the page.
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

// Route the flip to whoever owns this device type's status, so the alert, the device log
// and the socket event are byte-for-byte what the slow path would have produced.
async function markOffline(io, d) {
  if (d.type === "server") {
    const rows = await agentService.markOfflineByIds([d.id]);
    await agentService.announceOffline(io, rows);
    return;
  }
  if (d.type === "mikrotik") {
    await mikrotikPollerService.setReachable(io, d, false, "MikroTik unreachable — no ICMP reply");
    return;
  }
  await snmpPollerService.setReachable(io, { ...d, pingOnly: true }, false);
}

async function sweep(io) {
  if (running) return;
  running = true;
  try {
    const devices = await loadCandidates();
    if (devices.length === 0) return;

    // One echo each, all at once. Sequential would make the sweep's duration a function
    // of how many devices are DOWN (each one costing a full timeout), which is precisely
    // when it needs to be quick.
    const results = await Promise.all(
      devices.map(async (d) => ({ d, r: await ping(d.ip, { count: 1, timeoutMs: PING_TIMEOUT_MS }) })),
    );

    for (const { d, r } of results) {
      const id = Number(d.id);

      // probeError = `ping` itself could not run (missing binary, no permission). That is
      // a broken PROBE, not a down device — icmpPing already warns once — and treating it
      // as an outage would take the whole fleet offline at once.
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

      failures.delete(id);
      try {
        await markOffline(io, d);
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
