import "../config/env.js";
import client, { UPS_OID } from "./snmpClient.js";
import snmpPollerService from "./snmpPollerService.js";
import { upsOutputState, upsPowerKey, inRange, UPS_BOUNDS } from "./snmpUtils.js";
import { describeError } from "../utils/httpError.js";

/**
 * Fast UPS power watch.
 *
 * The full UPS poll reads everything and runs every SNMP_POLL_INTERVAL_MS (60s), so a
 * mains failure could wait up to a minute to be reported. This reads only two values,
 * output source and battery status (one GET), every UPS_POWER_CHECK_MS (5s). When they
 * differ from the last full poll, it runs that full poll right away (pollDeviceNow), so
 * the alerts, device log, InfluxDB point and broadcast are exactly the poller's.
 *
 * It does not judge reachability; that belongs to the ICMP sweep and the full poll
 * (reachabilitySweep.js).
 */

const CHECK_MS = Math.max(1000, Number(process.env.UPS_POWER_CHECK_MS) || 5000);
const ENABLED = (process.env.UPS_POWER_CHECK ?? "").trim().toLowerCase() !== "false";

// Short and no retries: a reply that takes longer than this is no use to a 5s check,
// and a dead UPS must not hold a tick open for the poller's full 5s x retries.
const GET_TIMEOUT_MS = Math.min(2000, CHECK_MS - 500);

const inFlight = new Set(); // UPS ids with a quick GET or a triggered full poll running

let timer = null;

async function checkOne(io, d) {
  const id = Number(d.id);
  if (inFlight.has(id)) return;

  // No baseline until the first full poll after a restart; that poll sets one.
  const live = snmpPollerService.getLiveUps(id);
  if (!live || live.status !== "Online") return;

  inFlight.add(id);
  let session;
  try {
    session = client.openSession({
      host: d.ip,
      community: d.community,
      port: d.snmpPort || 161,
      timeout: GET_TIMEOUT_MS,
      retries: 0,
    });
    const s = await client.get(session, [UPS_OID.upsOutputSource, UPS_OID.upsBatteryStatus]);
    const src = s[UPS_OID.upsOutputSource];
    const now = upsPowerKey(
      src == null ? null : upsOutputState(src),
      inRange(s[UPS_OID.upsBatteryStatus], ...UPS_BOUNDS.batteryStatus),
    );
    const before = upsPowerKey(live.outputState, live.batteryStatus);
    if (now === before) return;

    console.warn(`[UPS_WATCH] "${d.name}" (${d.ip}) power changed ${before} → ${now} — polling now`);
    client.closeSession(session);
    session = null;
    await snmpPollerService.pollDeviceNow(io, id);
  } catch (err) {
    // A timeout here is not an outage (see the header) — the ICMP sweep and the full
    // poll own that. Only a genuinely unexpected error is worth a line.
    if (!/timed? ?out/i.test(describeError(err))) {
      console.error(`[UPS_WATCH] "${d.name}" (${d.ip}) check failed:`, describeError(err));
    }
  } finally {
    client.closeSession(session);
    inFlight.delete(id);
  }
}

async function sweep(io) {
  try {
    const all = await snmpPollerService.loadDevices();
    const ups = all.filter((d) => d.type === "ups" && d.status === "online");
    // All at once: one UPS timing out must not delay the others' check.
    await Promise.all(ups.map((d) => checkOne(io, d)));
  } catch (err) {
    console.error("[UPS_WATCH] sweep error:", describeError(err));
  }
}

function init(io) {
  if (!ENABLED) {
    console.log("[UPS_WATCH] disabled (UPS_POWER_CHECK=false) — UPS power events wait for the full poll");
    return;
  }
  if (timer) return;
  timer = setInterval(() => sweep(io), CHECK_MS);
  console.log(`[UPS_WATCH] UPS power check every ${CHECK_MS}ms`);
}

export default { init };
