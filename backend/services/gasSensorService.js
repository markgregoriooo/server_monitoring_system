import db from "../config/mysql.js";
import { describeError } from "../utils/httpError.js";

/**
 * MQ-2 gas sensors: which channels exist, which are wired and what each is called.
 *
 * Like the IR channels, the device reports its pins and the database records which
 * ones actually have a sensor and where it points. `enabled` is a safety setting:
 * an unwired pin reads noise that could trigger the smoke alarm, so a channel is
 * ignored until an admin enables it. The label tells people where in the room the
 * smoke is. Migration: `2026-09-17_gas_sensors.sql`.
 */

// Matches the firmware's MQ2_PINS[] length. Only bounds what a request may send,
// so a typo cannot create channel 99.
const MAX_CHANNEL = 8;

// Cached in memory and reloaded on startup and after each change, since it is read
// on every 3s reading.
let cache = [];

/**
 * Channel → GPIO as reported by the ESP32 on every connect (`gasSensorMap`). The pins
 * are defined in the firmware; the UI shows them so staff know where to wire a
 * sensor. Empty until the ESP32 has connected once.
 */
let pinMap = [];

export async function setPinMap(sensors) {
  pinMap = (Array.isArray(sensors) ? sensors : [])
    .map((s) => ({ channel: Number(s?.channel), gpio: Number(s?.gpio) }))
    .filter((s) => Number.isInteger(s.channel) && Number.isInteger(s.gpio));

  // Also saved to the database so the pins can be shown before the sensor is online
  // and after a restart. The device's report on connect always overrides it.
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
 * What the ESP32 needs: which channels to read. Same shape as
 * airconService.getChannelConfig (booleans indexed by channel-1), so the firmware
 * reuses the `irConfig` parser.
 */
export async function getDeviceConfig() {
  if (cache.length === 0) await reload();
  const max = cache.reduce((m, r) => Math.max(m, r.channel), 0);
  const enabled = Array.from({ length: max }, (_, i) =>
    cache.some((r) => r.channel === i + 1 && r.enabled)
  );
  return { enabled };
}

/** Update one channel. Both fields are optional; COALESCE keeps an omitted field as it was. */
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
