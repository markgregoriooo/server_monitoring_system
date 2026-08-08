import db from "../config/mysql.js";

// Per-user PiP widget layout (widget_prefs). A missing row = the default layout.
// The canonical tile-id allow-list lives here (the server can't import the frontend
// catalog) — KEEP IN SYNC with frontend/src/pip/tiles/catalog.tsx. We sanitize on
// every write AND read, so a stale/hand-edited layout can never inject unknown ids.

const ALLOWED_TILES = new Set([
  "env.temp",
  "env.humidity",
  "env.gas",
  "servers.summary",
  "servers.list",
  "ups.summary",
  "network.summary",
  "alerts.count",
  "alerts.latest",
  "ups.list",
  "network.list",
  "aircon.summary",
  "meta.clock",
]);

// PARAMETERISED tile ids pin one device — "ups.device:7", "network.device:3" — so they
// can't live in the literal set above. They are validated by SHAPE instead.
//
// Deliberately no existence check against `devices`: the frontend already renders an
// unknown id as "Unavailable" (the same forward-compatible behaviour every unknown id
// has had), so a decommissioned device degrades on its own. Validating here would mean
// a DB round-trip on every layout read AND a rule that silently deletes a user's tile
// the moment a device is briefly absent. Shape-checking is enough to keep junk out.
// `[1-9]\d*` — no leading zeros, so "ups.device:07" can't sneak in as a SECOND distinct
// string for device 7 and defeat the dedupe below. Bounded length keeps it away from
// unsafe-integer territory. Must stay in step with catalog.tsx's DEVICE_TILE_RE.
const DEVICE_TILE_RE = /^(ups|network)\.device:[1-9]\d{0,9}$/;

function isAllowedTile(id) {
  return ALLOWED_TILES.has(id) || DEVICE_TILE_RE.test(id);
}

// Must match frontend catalog DEFAULT_LAYOUT.
const DEFAULT_LAYOUT = ["env.temp", "env.humidity", "env.gas", "alerts.count", "servers.list", "alerts.latest"];
const MAX_TILES = 16;

// Drop non-strings + unknown ids, dedupe, cap length. Returns null if not an array.
function sanitize(layout) {
  if (!Array.isArray(layout)) return null;
  const seen = new Set();
  const out = [];
  for (const id of layout) {
    if (typeof id !== "string" || !isAllowedTile(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_TILES) break;
  }
  return out;
}

// mysql2 may hand back a JSON column as an object or a string depending on version.
function parseStored(raw) {
  if (raw == null) return null;
  let val = raw;
  if (typeof raw === "string") {
    try {
      val = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const tiles = Array.isArray(val) ? val : val?.tiles;
  return sanitize(tiles ?? []);
}

async function getLayout(userId) {
  const [[row]] = await db.query(`SELECT layout_json FROM widget_prefs WHERE user_id = ?`, [userId]);
  const tiles = row ? parseStored(row.layout_json) : null;
  return { tiles: tiles ?? [...DEFAULT_LAYOUT] };
}

async function saveLayout(userId, layout) {
  const tiles = sanitize(layout);
  if (tiles == null) {
    const err = new Error("layout must be an array of tile ids");
    err.status = 400;
    throw err;
  }
  await db.query(
    `INSERT INTO widget_prefs (user_id, layout_json)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE layout_json = VALUES(layout_json)`,
    [userId, JSON.stringify({ tiles })],
  );
  return { tiles };
}

export default { getLayout, saveLayout, DEFAULT_LAYOUT, ALLOWED_TILES };
