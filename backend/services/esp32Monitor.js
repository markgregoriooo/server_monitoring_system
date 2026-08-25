import { queryClient, bucket } from "../config/influx.js";
import notificationService from "./notificationService.js";
import alertsService from "./alertsService.js";
import { describeError } from "../utils/httpError.js";

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

// Raising the offline alert. Shared by the live transition and the restart path so an
// "offline" shown in the UI is ALWAYS backed by a real row in `alerts` — a banner with
// no bell entry and nothing on the Alerts page reads as broken alerting.
// raiseAlert's de-dup is scoped to OPEN alerts, so calling this again while one is
// already open (e.g. the backend restarts repeatedly) is a no-op rather than a flood.
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
// backend restart:
//   • data is fresh   → online, and a LATER stop raises the alert (restart-proof)
//   • data is stale   → offline, AND we raise the alert: the room really is unmonitored
//     right now, so it belongs on the bell and the Alerts page. (De-dup is scoped to
//     open alerts, so a restart loop doesn't flood.)
//   • no data at all  → offline silently. Nothing has ever reported, so there is no
//     outage to report — this is a fresh install or a dev box with no hardware.
//
// The query is awaited, so a live reading can land WHILE it is in flight. That live
// reading is strictly better evidence than anything historical, so it wins and the seed
// result is discarded. Without this guard the seed clobbered `lastSeen` and forced the
// sensor Offline moments after it had correctly come Online — and because that
// assignment bypassed setOnline(), it did so with NO alert: a banner saying "offline"
// with nothing behind it on the bell or the Alerts page.
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
