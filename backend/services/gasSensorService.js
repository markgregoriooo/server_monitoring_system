import db from "../config/mysql.js";
import { describeError } from "../utils/httpError.js";

/**
 * MQ-2 gas sensors as MANAGED DATA — which channels exist, which are wired, and what each
 * one is called.
 *
 * The same split the IR channel pool uses, and for the same reason: the DEVICE knows which
 * pins it has, the DATABASE knows which of them somebody actually soldered a sensor to and
 * where that sensor is pointing. Neither can answer the other's question, and baking either
 * into the firmware means a reflash to add a sensor.
 *
 * ⚠️ `enabled` is a safety gate, not a display preference. An ADC pin with nothing attached
 * FLOATS — it does not read zero, it reads noise, and noise pushed through the MQ-2 curve is
 * a believable ppm that can trip the smoke alarm. A channel stays silent until an admin
 * asserts the hardware is there.
 *
 * The label is the point of the feature. Two MQ-2s are only worth having if they are apart
 * (the alarm is `max()` across them — coverage logic, not redundancy), and once they are
 * apart "MQ2-2 is critical" does not tell anyone which end of the room to run to.
 *
 * Migration: `2026-09-17_gas_sensors.sql`.
 */

// Mirrors the firmware's MQ2_PINS[] length. Not a database constraint — the cap is the
// ESP32's ADC1 budget, and a second board would raise it without a schema change — but a
// bound on what this service will accept from a request, so a typo cannot create channel 99.
const MAX_CHANNEL = 8;

// In-memory copy, reloaded on startup and after every mutation. Read on EVERY ESP32 reading
// (3s) to resolve labels for alerts and to decide which channels count — a per-reading
// SELECT would put the gas path in front of the same 10-connection pool the pollers and the
// dashboard share, for data that changes a few times a year.
let cache = [];

/**
 * Channel -> GPIO, as REPORTED BY THE DEVICE on every connect (`gasSensorMap`).
 *
 * Not stored and not configured: the pin numbers live in the firmware's MQ2_PINS[], and a
 * second copy in the database is a copy that goes stale the day somebody re-pins the board.
 * Held in memory exactly like airconService's IR channel map, for exactly the same reason —
 * a staff member about to wire sensor 3 has to be told WHICH PIN, on screen, without opening
 * the sketch.
 *
 * Empty until the ESP32 has connected once this process, which the UI reports honestly
 * rather than guessing.
 */
let pinMap = [];

export async function setPinMap(sensors) {
  pinMap = (Array.isArray(sensors) ? sensors : [])
    .map((s) => ({ channel: Number(s?.channel), gpio: Number(s?.gpio) }))
    .filter((s) => Number.isInteger(s.channel) && Number.isInteger(s.gpio));

  // REMEMBERED, not just held. The dialog that needs these is the one somebody opens
  // BEFORE wiring a sensor, and an in-memory-only map showed "GPIO — sensor offline"
  // exactly then — and went blank again on every backend restart. Writing it through means
  // the last thing the device said survives both. The device still wins on every connect,
  // so this is a cache of its answer rather than a second source of truth.
  for (const p of pinMap) {
    try {
      await db.query(`UPDATE gas_sensors SET gpio = ? WHERE channel = ?`, [p.gpio, p.channel]);
    } catch (err) {
      // Never fatal: knowing the pin is a convenience, and failing the device's connect
      // over it would cost the readings themselves.
      console.error("[GAS] could not store pin map:", describeError(err));
    }
  }
  return pinMap;
}

export function getPinMap() {
  return pinMap;
}

// Live map first (this process has heard from the device), else the remembered column.
function gpioFor(channel, stored) {
  return pinMap.find((p) => p.channel === Number(channel))?.gpio ?? (stored ?? null);
}

export function cached() {
  return cache;
}

/** Channel → label, falling back to the technical name so nothing renders blank. */
export function labelFor(channel) {
  const row = cache.find((r) => r.channel === Number(channel));
  const label = row?.locationLabel?.trim();
  return label || `MQ2-${channel}`;
}

/** The channels an admin says are physically wired. Used to gate ingest and alerting. */
export function enabledChannels() {
  return cache.filter((r) => r.enabled).map((r) => r.channel);
}

function toClient(r) {
  return {
    channel: Number(r.channel),
    locationLabel: r.location_label ?? null,
    // What the UI and the alert text should actually print.
    label: (r.location_label ?? "").trim() || `MQ2-${r.channel}`,
    enabled: Boolean(r.enabled),
    // Which pin to solder this one to. null until the ESP32 has connected and said.
    gpio: gpioFor(r.channel, r.gpio == null ? null : Number(r.gpio)),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
    updatedByName: r.updated_by_name ?? null,
  };
}

export async function reload() {
  const [rows] = await db.query(
    `SELECT g.channel, g.gpio, g.location_label, g.enabled, g.updated_at, u.username AS updated_by_name
       FROM gas_sensors g
       LEFT JOIN users u ON u.user_id = g.updated_by
      ORDER BY g.channel`
  );
  cache = rows.map(toClient);
  return cache;
}

export async function list() {
  return reload();
}

/**
 * The payload the ESP32 needs: which channels to read at all. Deliberately the same shape as
 * airconService.getChannelConfig's — one array of booleans indexed by channel-1 — because the
 * firmware already parses that for `irConfig` and a second shape would be a second parser.
 */
export async function getDeviceConfig() {
  if (cache.length === 0) await reload();
  const max = cache.reduce((m, r) => Math.max(m, r.channel), 0);
  const enabled = Array.from({ length: max }, (_, i) =>
    cache.some((r) => r.channel === i + 1 && r.enabled)
  );
  return { enabled };
}

/**
 * Update one channel. Both fields optional so the UI can rename without touching the wiring
 * flag and vice versa — COALESCE rather than a plain SET, matching userService.updateUser,
 * so an omitted field can never blank a column.
 */
export async function update(channel, { locationLabel, enabled }, userId = null) {
  const ch = Number(channel);
  if (!Number.isInteger(ch) || ch < 1 || ch > MAX_CHANNEL) {
    const err = new Error(`channel must be 1-${MAX_CHANNEL}`);
    err.status = 400;
    throw err;
  }
  // "" is a deliberate CLEAR (back to MQ2-<n>); undefined means "don't touch".
  const label =
    locationLabel === undefined ? null : String(locationLabel).trim().slice(0, 100) || null;
  const clearing = locationLabel !== undefined && label === null;

  const [res] = await db.query(
    `UPDATE gas_sensors
        SET location_label = ${clearing ? "NULL" : "COALESCE(?, location_label)"},
            enabled        = COALESCE(?, enabled),
            updated_by     = ?
      WHERE channel = ?`,
    clearing
      ? [enabled === undefined ? null : enabled ? 1 : 0, userId, ch]
      : [label, enabled === undefined ? null : enabled ? 1 : 0, userId, ch]
  );
  if (res.affectedRows === 0) {
    const err = new Error(`no such gas sensor channel: ${ch}`);
    err.status = 404;
    throw err;
  }
  await reload();
  return cache.find((r) => r.channel === ch) ?? null;
}

/** Load the cache at startup. Never throws — a failed read must not stop the backend booting;
 *  an empty cache degrades to "no channel is enabled", which is silent rather than wrong. */
export async function init() {
  try {
    await reload();
    console.log(
      `[GAS] ${cache.filter((r) => r.enabled).length}/${cache.length} sensor channel(s) enabled.`
    );
  } catch (err) {
    console.error("[GAS] could not load sensor config:", describeError(err));
  }
}

export default {
  init, reload, list, update, getDeviceConfig, cached, labelFor, enabledChannels,
  setPinMap, getPinMap,
};
