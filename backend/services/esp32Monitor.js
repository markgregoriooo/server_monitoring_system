import { queryClient, bucket } from "../config/influx.js";
import notificationService from "./notificationService.js";
import alertsService from "./alertsService.js";

// ─── ESP32 liveness (the environment sensor's heartbeat) ─────────────────────────
// The ESP32 pushes `sensorData` every ~3s. Nothing else proves it is alive, and it is
// NOT a `devices` row, so the Go-agent offline sweep (which works off
// devices.last_seen) can't cover it. Without this, a dead sensor and a stable room
// look identical on the dashboard: the last reading just sits there, green, forever.
//
// Severity is `critical` (server offline is only `warning`) on purpose: a server going
// down is one host among many, but the ESP32 is the ONLY source of temperature / smoke
// / humidity — losing it blinds the room entirely, which is the thing this system
// exists to watch. `critical` is also the default NOTIFY_EMAIL_MIN_SEVERITY, so a
// blind spot actually reaches someone instead of only bumping the bell.
//
// The alert is room-level (`device_id = NULL`), matching how sensorHandler raises
// temperature/gas/humidity, and it auto-resolves the moment a reading arrives.

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

// The only place `online` changes after seeding. Alerts fire on the TRANSITION, never
// per-sweep, so a device that stays dead raises exactly one alert.
async function setOnline(next) {
  if (next === online) return;
  const prev = online;
  online = next;

  if (_io) _io.emit("esp32Status", getStatus());

  try {
    if (next === false && prev === true) {
      await notificationService.raiseAlert({
        deviceId: null, // room-level: the ESP32 has no `devices` row
        type: ALERT_TYPE,
        severity: "critical",
        title: "Environment sensor offline",
        message:
          "The ESP32 stopped reporting — temperature, humidity and smoke are no longer being monitored.",
      });
    } else if (next === true && prev === false) {
      // Recovered: close the open offline incident (no-op when none is open).
      await alertsService.autoResolveMetric(null, ALERT_TYPE);
    }
  } catch (err) {
    console.error("[ESP32] status alert error:", err.message);
  }
}

// Called by sensorHandler on every accepted reading — data is the heartbeat. A socket
// that is connected but silent is still a broken sensor, so connection alone doesn't count.
export function markSeen() {
  lastSeen = Date.now();
  if (online !== true) void setOnline(true);
}

// An explicit disconnect is faster evidence than waiting out the staleness window, but
// only when NO device socket remains — several ESP32s may share the "devices" room, and
// one dropping doesn't blind the room.
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

// Seed `lastSeen` from the newest point already in InfluxDB so liveness survives a
// backend restart. Deliberately assigns `online` directly instead of going through
// setOnline, so seeding never alerts:
//   • data is fresh  → online, and a LATER stop raises the alert (restart-proof)
//   • data is stale  → offline silently. You aren't paged about a sensor that was
//     already dead before this process started (and a dev box with no hardware
//     attached stays quiet), while the UI still correctly shows Offline.
export async function seed() {
  const flux = `
    from(bucket: "${bucket}")
      |> range(start: -7d)
      |> filter(fn: (r) => r._measurement == "sensor_environment")
      |> filter(fn: (r) => r._field == "temperature")
      |> last()
      |> keep(columns: ["_time"])
  `;

  try {
    const seen = await new Promise((resolve, reject) => {
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
    lastSeen = seen;
  } catch (err) {
    // No Influx / empty bucket: treat the sensor as unproven rather than failing boot.
    console.error("[ESP32] liveness seed failed:", err.message);
    lastSeen = null;
  }

  online = !isStale();
  console.log(
    `[ESP32] liveness seeded → ${online ? "online" : "offline"}` +
      `${lastSeen ? ` (last reading ${new Date(lastSeen).toISOString()})` : " (no recent readings)"}`,
  );
  if (_io) _io.emit("esp32Status", getStatus());
}

export function init(io) {
  _io = io;
  return seed();
}

export default { init, seed, sweep, markSeen, markDisconnected, getStatus };
