import { queryClient, bucket } from "../config/influx.js";
import notificationService from "./notificationService.js";
import alertsService from "./alertsService.js";
import { describeError } from "../utils/httpError.js";

// ─── ESP32 liveness ─────────────────────────
// The ESP32 sends `sensorData` every ~3s and has no devices row, so the server
// offline sweep cannot see it. Without this a dead sensor looks like a calm room.
// Critical, because it is the only source of temperature, smoke and humidity, and
// critical is what gets emailed by default. Room-level (device_id NULL);
// auto-resolves on the next reading.

const ALERT_TYPE = "esp32_offline";

// ~10 missed readings. Mirrors the servers' OFFLINE_AFTER_SEC (30s) so both device
// classes go offline on a comparable timescale.
const OFFLINE_AFTER_MS = (Number(process.env.ESP32_OFFLINE_AFTER_SEC) || 30) * 1000;

let _io = null;
let lastSeen = null; // ms epoch of the last accepted sensorData
let online = null; // null = not yet determined (pre-seed); then true | false

function isStale(now = Date.now()) {
  return lastSeen == null || now - lastSeen > OFFLINE_AFTER_MS;
}

export function getStatus() {
  return {
    online: online === true,
    lastSeen: lastSeen == null ? null : new Date(lastSeen).toISOString(),
    offlineAfterSec: Math.round(OFFLINE_AFTER_MS / 1000),
  };
}

// Raise the offline alert. Shared by the live change and the startup path, so an
// "offline" in the UI always has a matching alert. raiseAlert de-dups open alerts,
// so repeated restarts do not flood.
async function raiseOfflineAlert(lastIso) {
  await notificationService.raiseAlert({
    deviceId: null, // room-level: the ESP32 has no `devices` row
    type: ALERT_TYPE,
    severity: "critical",
    title: "Environment sensor offline",
    message:
      "The ESP32 stopped reporting — temperature, humidity and smoke are no longer being monitored." +
      (lastIso ? ` Last reading ${lastIso}.` : ""),
  });
}

// The only place `online` changes once liveness is established. Alerts fire on the
// TRANSITION, never per-sweep, so a device that stays dead raises exactly one alert.
async function setOnline(next) {
  if (next === online) return;
  const prev = online;
  online = next;

  if (_io) _io.emit("esp32Status", getStatus());

  try {
    if (next === false && prev === true) {
      await raiseOfflineAlert(lastSeen ? new Date(lastSeen).toISOString() : null);
    } else if (next === true && prev === false) {
      // Recovered: close the open offline incident (no-op when none is open).
      await alertsService.autoResolveMetric(null, ALERT_TYPE);
    }
  } catch (err) {
    console.error("[ESP32] status alert error:", describeError(err));
  }
}

// Called by sensorHandler on every accepted reading — data is the heartbeat. A socket
// that is connected but silent is still a broken sensor, so connection alone doesn't count.
export function markSeen() {
  lastSeen = Date.now();
  if (online !== true) void setOnline(true);
}

// A disconnect is quicker evidence than waiting for the timeout, but only if no
// other device socket is still connected.
export function markDisconnected(io, socketId) {
  const room = io?.sockets?.adapter?.rooms?.get("devices");
  const remaining = room ? [...room].filter((id) => id !== socketId).length : 0;
  if (remaining === 0 && online === true) void setOnline(false);
}

// Runs on a timer from server.js. Only ever flips online → offline; recovery is driven
// by markSeen so it happens the instant data returns rather than up to a sweep late.
export function sweep() {
  if (online === true && isStale()) void setOnline(false);
}

// Set `lastSeen` from the newest point in InfluxDB so liveness survives a restart:
//   • fresh data → online; a later stop raises the alert
//   • stale data → offline, and raise the alert (the room is unmonitored now)
//   • no data    → offline without an alert (new install, nothing ever reported)
// If a live reading arrives while the query runs, it wins and the query result is
// ignored; otherwise the sensor would be set offline right after coming online.
export async function seed() {
  const startedAt = Date.now();
  const flux = `
    from(bucket: "${bucket}")
      |> range(start: -7d)
      |> filter(fn: (r) => r._measurement == "sensor_environment")
      |> filter(fn: (r) => r._field == "temperature")
      |> last()
      |> keep(columns: ["_time"])
  `;

  let seen = null;
  try {
    seen = await new Promise((resolve, reject) => {
      let ts = null;
      queryClient.queryRows(flux, {
        next(row, tableMeta) {
          const t = Date.parse(tableMeta.toObject(row)._time);
          if (!Number.isNaN(t) && (ts == null || t > ts)) ts = t;
        },
        error: reject,
        complete: () => resolve(ts),
      });
    });
  } catch (err) {
    // No Influx / empty bucket: treat the sensor as unproven rather than failing boot.
    console.error("[ESP32] liveness seed failed:", describeError(err));
    seen = null;
  }

  // A reading arrived while the query was running — live beats historical, discard this.
  if (lastSeen != null && lastSeen >= startedAt) {
    console.log("[ESP32] liveness seed discarded — a live reading arrived first");
    return;
  }

  lastSeen = seen;
  online = !isStale();
  console.log(
    `[ESP32] liveness seeded → ${online ? "online" : "offline"}` +
      `${lastSeen ? ` (last reading ${new Date(lastSeen).toISOString()})` : " (no recent readings)"}`,
  );
  if (_io) _io.emit("esp32Status", getStatus());

  // Stale but previously reporting = a genuine, ongoing outage that started before this
  // process did. Record it, so "offline" in the UI always has a matching alert.
  if (!online && seen != null) {
    try {
      await raiseOfflineAlert(new Date(seen).toISOString());
    } catch (err) {
      console.error("[ESP32] seed alert error:", describeError(err));
    }
  }
}

export function init(io) {
  _io = io;
  return seed();
}

export default { init, seed, sweep, markSeen, markDisconnected, getStatus };
