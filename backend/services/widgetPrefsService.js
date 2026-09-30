import db from "../config/mysql.js";

// Per-user PiP widget layout (widget_prefs). No row = the default layout. The allowed
// tile ids are listed here (the server cannot import the frontend catalog); keep in
// sync with frontend/src/pip/tiles/catalog.tsx. Cleaned on every write and read.

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

// Tile ids for one device ("ups.device:7", "network.device:3", "server.device:12") are
// checked by shape. Not checked against `devices`: the frontend shows an unknown id as
// "Unavailable", and a lookup would cost a query per read. `[1-9]\d*` rules out
// leading zeros so "07" and "7" cannot both appear. Must match DEVICE_TILE_RE in
// catalog.tsx.
const DEVICE_TILE_RE = /^(ups|network|server)\.device:[1-9]\d{0,9}$/;

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
