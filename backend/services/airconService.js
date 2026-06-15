import db from "../config/mysql.js";

// ─── ESP32 channel map (in-memory, refreshed on every device connect) ─────────
// Shape: [{ channel: 1, gpio: 25 }, { channel: 2, gpio: 33 }, ...]
let esp32ChannelMap = [];

function setChannelMap(channels) {
  esp32ChannelMap = Array.isArray(channels) ? channels : [];
}

function getChannelMap() {
  return esp32ChannelMap;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatUptime(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 1)  return "just now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

async function getAll() {
  const [units] = await db.query(`
    SELECT
      d.device_id       AS id,
      d.device_name     AS name,
      s.ir_channel,
      s.mode,
      s.set_temperature AS setTemp,
      s.fan_mode        AS fanMode,
      s.is_on           AS enabled,
      s.last_trigger,
      s.updated_at
    FROM devices d
    JOIN aircon_state s ON d.device_id = s.device_id
    WHERE d.device_type = 'aircon'
    ORDER BY s.ir_channel
  `);

  const now = Date.now();
  const aircons = units.map(u => ({
    ...u,
    enabled: Boolean(u.enabled),
    uptime: u.enabled && u.updated_at
      ? formatUptime(now - new Date(u.updated_at).getTime())
      : "offline",
  }));

  const logs = {};
  for (const ac of aircons) {
    const [rows] = await db.query(`
      SELECT
        DATE_FORMAT(created_at, '%h:%i %p') AS time,
        action,
        reason
      FROM aircon_logs
      WHERE device_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `, [ac.id]);
    logs[ac.id] = rows;
  }

  return { aircons, logs };
}

async function getChannelConfig() {
  const [rows] = await db.query(`
    SELECT s.ir_channel, s.is_on AS enabled
    FROM aircon_state s
    JOIN devices d ON d.device_id = s.device_id
    WHERE d.device_type = 'aircon'
    ORDER BY s.ir_channel
  `);
  return {
    channels: rows.map(r => ({ channel: r.ir_channel, enabled: Boolean(r.enabled) })),
  };
}

async function addUnit({ name, ir_channel, userId, userName }) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const [devResult] = await conn.query(`
      INSERT INTO devices (ip_address, device_name, device_type, status, location)
      VALUES ('N/A', ?, 'aircon', 'online', 'Server Room')
    `, [name]);
    const deviceId = devResult.insertId;

    await conn.query(`
      INSERT INTO aircon_state
        (device_id, ir_channel, mode, set_temperature, fan_mode, is_on, last_trigger)
      VALUES (?, ?, 'cool', 24, 'auto', 1, NULL)
    `, [deviceId, ir_channel]);

    await conn.query(`
      INSERT INTO aircon_logs (device_id, user_id, action, reason, trigger_type)
      VALUES (?, ?, 'Unit registered', ?, 'manual')
    `, [deviceId, userId, `Added by ${userName}`]);

    await conn.commit();
    return { deviceId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function removeUnit(id) {
  const [result] = await db.query(`
    DELETE FROM devices WHERE device_id = ? AND device_type = 'aircon'
  `, [id]);
  return result.affectedRows > 0;
}

async function toggle(id, userId, userName) {
  // F-01: flip atomically in SQL so concurrent toggles can't race on a stale read.
  // The DB serializes the row update; we then read back the authoritative result.
  const [result] = await db.query(`
    UPDATE aircon_state
    SET is_on = IF(is_on = 1, 0, 1),
        last_trigger = 'manual',
        triggered_by_user_id = ?,
        updated_at = NOW()
    WHERE device_id = ?
  `, [userId, id]);
  if (result.affectedRows === 0) return null;   // unit not found

  const [[current]] = await db.query(
    "SELECT is_on, ir_channel FROM aircon_state WHERE device_id = ?", [id]
  );
  const newState = current.is_on ? 1 : 0;

  // Keep the devices row's status in sync with the unit's power so the devices
  // table reflects reality (was previously stuck 'online' forever after register).
  await db.query(
    "UPDATE devices SET status = ?, updated_at = NOW() WHERE device_id = ?",
    [newState ? "online" : "offline", id],
  );

  const action = newState ? "Manually turned ON" : "Manually turned OFF";
  await db.query(`
    INSERT INTO aircon_logs (device_id, user_id, action, reason, trigger_type)
    VALUES (?, ?, ?, ?, 'manual')
  `, [id, userId, action, `By ${userName}`]);

  return {
    enabled:    Boolean(newState),
    ir_channel: current.ir_channel,
    entry: {
      time:   new Date().toLocaleTimeString("en-PH"),
      action,
      reason: `By ${userName}`,
    },
  };
}

async function setMode(id, mode, userId, userName) {
  await db.query(`
    UPDATE aircon_state SET mode = ?, updated_at = NOW() WHERE device_id = ?
  `, [mode, id]);

  const action = `Mode changed to ${mode}`;
  await db.query(`
    INSERT INTO aircon_logs (device_id, user_id, action, reason, trigger_type)
    VALUES (?, ?, ?, ?, 'manual')
  `, [id, userId, action, `By ${userName}`]);

  return {
    entry: { time: new Date().toLocaleTimeString("en-PH"), action, reason: `By ${userName}` },
  };
}

async function setTemp(id, temp, userId, userName) {
  await db.query(`
    UPDATE aircon_state SET set_temperature = ?, updated_at = NOW() WHERE device_id = ?
  `, [temp, id]);

  const action = `Target temp set to ${temp}°C`;
  await db.query(`
    INSERT INTO aircon_logs (device_id, user_id, action, reason, trigger_type)
    VALUES (?, ?, ?, ?, 'manual')
  `, [id, userId, action, `By ${userName}`]);

  return {
    entry: { time: new Date().toLocaleTimeString("en-PH"), action, reason: `By ${userName}` },
  };
}

// Map IR zone → set_temperature the ESP32 commanded
const ZONE_TEMP = { 0: 28, 1: 26, 2: 24, 3: 22, 4: 20 };

async function applyAutoIR({ zone, label }) {
  const setTemp = ZONE_TEMP[zone] ?? null;
  if (setTemp === null) return;

  // Auto IR only RE-TARGETS the set temperature of units that are currently ON;
  // it must never switch a unit's power. A unit a user manually turned OFF stays
  // off when IR fires (on/off is manual-only). Returns the affected ids so the
  // dashboard updates exactly those units and leaves off units untouched.
  const [onUnits] = await db.query(`
    SELECT s.device_id
    FROM aircon_state s
    JOIN devices d ON d.device_id = s.device_id
    WHERE d.device_type = 'aircon' AND s.is_on = 1
  `);
  if (onUnits.length === 0) return; // nothing running → nothing to adjust (no emit)

  const ids = onUnits.map(u => u.device_id);
  const placeholders = ids.map(() => "?").join(",");
  await db.query(`
    UPDATE aircon_state
    SET set_temperature      = ?,
        last_trigger         = 'auto',
        triggered_by_user_id = NULL,
        updated_at           = NOW()
    WHERE device_id IN (${placeholders})
  `, [setTemp, ...ids]);

  const action = `Auto IR fired: ${label} (${setTemp}°C)`;
  for (const id of ids) {
    await db.query(`
      INSERT INTO aircon_logs (device_id, user_id, action, reason, trigger_type)
      VALUES (?, NULL, ?, 'Temperature zone change', 'auto')
    `, [id, action]);
  }

  return { setTemp, action, deviceIds: ids };
}

// ─── Auto-cooling IR zone thresholds (configurable; pushed to the ESP32) ─────────
// The firmware's getIRZone() switches the AC setting when the room temperature crosses
// these boundaries. The TARGET temp per zone is fixed (tied to the captured raw IR codes
// in the firmware) — only the BOUNDARIES (when IR fires) are configurable. One global
// row (a single server room / one ESP32). Pushed live via the "acConfig" socket event.
const IR_CFG_DEFAULTS = { coldBelow: 22, normalMax: 24, acceptableMax: 27, nearCritMax: 29 };

function irCfgErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function irConfigToClient(r) {
  return {
    coldBelow: Number(r.cold_below),
    normalMax: Number(r.normal_max),
    acceptableMax: Number(r.acceptable_max),
    nearCritMax: Number(r.near_crit_max),
    updatedBy: r.updated_by ?? null,
    updatedByName: r.updated_by_name ?? null,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
  };
}

async function getIRConfig() {
  const [[row]] = await db.query(`
    SELECT c.cold_below, c.normal_max, c.acceptable_max, c.near_crit_max,
           c.updated_by, c.updated_at, u.name AS updated_by_name
    FROM aircon_ir_config c
    LEFT JOIN users u ON u.user_id = c.updated_by
    WHERE c.id = 1
  `);
  if (!row) return { ...IR_CFG_DEFAULTS, updatedBy: null, updatedByName: null, updatedAt: null };
  return irConfigToClient(row);
}

async function saveIRConfig(data, userId = null) {
  const cur = await getIRConfig();
  const num = (v, fallback) => {
    if (v === undefined || v === null || v === "") return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) throw irCfgErr(400, "Thresholds must be numbers.");
    return n;
  };
  const next = {
    coldBelow: num(data.coldBelow, cur.coldBelow),
    normalMax: num(data.normalMax, cur.normalMax),
    acceptableMax: num(data.acceptableMax, cur.acceptableMax),
    nearCritMax: num(data.nearCritMax, cur.nearCritMax),
  };
  // Boundaries must strictly ascend or zones overlap / become unreachable.
  if (!(next.coldBelow < next.normalMax && next.normalMax < next.acceptableMax && next.acceptableMax < next.nearCritMax)) {
    throw irCfgErr(400, "Thresholds must increase: Too Cold < Normal < Acceptable < Near Critical.");
  }
  for (const v of Object.values(next)) {
    if (v < 10 || v > 40) throw irCfgErr(400, "Thresholds must be between 10°C and 40°C.");
  }
  await db.query(`
    INSERT INTO aircon_ir_config (id, cold_below, normal_max, acceptable_max, near_crit_max, updated_by)
    VALUES (1, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      cold_below = VALUES(cold_below), normal_max = VALUES(normal_max),
      acceptable_max = VALUES(acceptable_max), near_crit_max = VALUES(near_crit_max),
      updated_by = VALUES(updated_by)
  `, [next.coldBelow, next.normalMax, next.acceptableMax, next.nearCritMax, userId]);
  return getIRConfig();
}

// The shape the ESP32 consumes via the "acConfig" socket event (boundaries only).
async function getDeviceIRConfig() {
  const c = await getIRConfig();
  return {
    coldBelow: c.coldBelow,
    normalMax: c.normalMax,
    acceptableMax: c.acceptableMax,
    nearCritMax: c.nearCritMax,
  };
}

const airconService = {
  getAll, getChannelConfig,
  addUnit, removeUnit,
  toggle, setMode, setTemp,
  applyAutoIR,
  setChannelMap, getChannelMap,
  getIRConfig, saveIRConfig, getDeviceIRConfig,
};

export default airconService;
