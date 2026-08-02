import db from "../config/mysql.js";

// ─── Configurable alert thresholds (alert_rules) ────────────────────────────────
// Replaces the old hardcoded 80/90 (server) and firmware-mirrored env thresholds.
//
// Scope model (see migrations/2026-06-14_alert_rules.sql):
//   * device_id = NULL  → GLOBAL default rule (every server / the room)
//   * device_id = <id>  → PER-SERVER override
//   getEffectiveRules() returns the device-specific rules if any exist, else global.
//
// Fallback model: RULES-ONLY. A metric with no matching active rule raises nothing
// (worstBreach → null → band "normal"). The migration seeds the global defaults so
// this never means a silent system out of the box.
//
// metric_name convention (must match the trigger sites):
//   server:      'cpu', 'mem', 'disk'   (agentService.checkThresholds)
//   environment: 'temperature', 'gas', 'humidity'  (sensorHandler, device_id NULL)

const COMPARISONS = [">", "<", ">=", "<="]; // '=' intentionally unsupported in v1 (no useful hysteresis)
const SEVERITIES = ["info", "warning", "critical"];
const SEV_RANK = { normal: 0, info: 1, warning: 2, critical: 3 };

// ─── In-memory cache ────────────────────────────────────────────────────────────
// Rules are read on every metric POST (~10s per host) + every sensor reading, so we
// cache all active rules and reload only when they change (startup + any mutation).
let _cache = null; // Map<"<deviceId|g>:<metric>", rule[]> | null when not yet loaded

// Cache key. `interface_name` is only ever set for per-port metrics (link_util /
// link_errors); everything else keys with an empty interface segment.
const cacheKey = (deviceId, ifaceName, metricName) =>
  `${deviceId ?? "g"}|${ifaceName ?? ""}:${metricName}`;

async function reload() {
  const [rows] = await db.query(
    `SELECT alert_rule_id, device_id, interface_name, metric_name, threshold_value, comparison, severity
       FROM alert_rules
      WHERE is_active = 1`,
  );
  const m = new Map();
  for (const r of rows) {
    const key = cacheKey(r.device_id, r.interface_name, r.metric_name);
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(r);
  }
  _cache = m;
  return m;
}

async function ensureLoaded() {
  if (!_cache) await reload();
}

// Active rules that apply to (deviceId, metricName [, interfaceName]), most specific
// first. The FIRST level that matches wins outright — levels are not merged, which
// matches how the per-device vs global fallback already behaved.
//
//   1. this device + this port   ← only for per-port metrics (link_util / link_errors)
//   2. this device, any port
//   3. global default
//
// Empty array = no rule = silent (rules-only model).
async function getEffectiveRules(deviceId, metricName, interfaceName = null) {
  await ensureLoaded();
  if (deviceId != null && interfaceName) {
    const ifKey = cacheKey(deviceId, interfaceName, metricName);
    if (_cache.has(ifKey)) return _cache.get(ifKey);
  }
  if (deviceId != null) {
    const dKey = cacheKey(deviceId, null, metricName);
    if (_cache.has(dKey)) return _cache.get(dKey);
  }
  return _cache.get(cacheKey(null, null, metricName)) ?? [];
}

// ─── Evaluation ─────────────────────────────────────────────────────────────────
function compare(value, op, threshold) {
  switch (op) {
    case ">":  return value > threshold;
    case ">=": return value >= threshold;
    case "<":  return value < threshold;
    case "<=": return value <= threshold;
    default:   return false;
  }
}

// The highest-severity rule whose comparison the value satisfies (or null).
function worstBreach(rules, value) {
  let worst = null;
  for (const r of rules) {
    if (compare(value, r.comparison, Number(r.threshold_value))) {
      if (!worst || SEV_RANK[r.severity] > SEV_RANK[worst.severity]) worst = r;
    }
  }
  return worst;
}

// Hysteresis: a value must fall back past a rule's threshold by this fraction (on the
// safe side) before that band clears. Unit-agnostic (5% of the threshold) so it works
// for cpu %, temperature °C and gas ppm alike. Stops device_logs churn when a value
// flaps at a boundary; notification spam is separately handled by the DB cooldown.
const HYST_FRACTION = 0.05;
function clears(rule, value) {
  const t = Number(rule.threshold_value);
  const margin = Math.abs(t) * HYST_FRACTION;
  switch (rule.comparison) {
    case ">":
    case ">=": return value < t - margin;
    case "<":
    case "<=": return value > t + margin;
    default:   return true;
  }
}

// Decide a metric's new severity band, hysteresis-aware. Escalations apply instantly;
// de-escalations are held until the value clears the previous band's threshold by the
// margin. Returns { band, rule } — `rule` is the breached rule (for stamping
// alerts.alert_rule_id) and is non-null only when escalating.
function nextBand(rules, value, prevBand = "normal") {
  const breach = worstBreach(rules, value);
  const target = breach ? breach.severity : "normal";
  if (SEV_RANK[target] >= SEV_RANK[prevBand]) return { band: target, rule: breach };
  const prevRule = rules.find((r) => r.severity === prevBand);
  if (prevRule && !clears(prevRule, value)) return { band: prevBand, rule: null }; // hold
  return { band: target, rule: breach };
}

// Room-level (global, device_id NULL) thresholds in the shape the ESP32 firmware
// consumes via the "envConfig" socket event. This is what keeps the device's LED +
// buzzer + reported status in sync with the dashboard's alert thresholds. Null
// (no rule) fields are omitted so the firmware keeps its compiled default for them.
async function getRoomThresholds() {
  await ensureLoaded();
  const pick = (metric, severity) => {
    const r = (_cache.get(cacheKey(null, null, metric)) ?? []).find((x) => x.severity === severity);
    return r ? Number(r.threshold_value) : null;
  };
  const out = {
    tempWarn: pick("temperature", "warning"),
    tempCrit: pick("temperature", "critical"),
    gasWarn: pick("gas", "warning"),
    gasCrit: pick("gas", "critical"),
    humWarn: pick("humidity", "warning"),
    humCrit: pick("humidity", "critical"),
  };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

// ─── CRUD (admin-only routes) ───────────────────────────────────────────────────
function err(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Validate + normalize an incoming rule. `partial` allows missing fields (PUT patch).
// `existing` is the current row on a PATCH, so cross-field validation can reason about
// the MERGED result rather than only what the caller happened to send.
function clean(data, { partial = false, existing = null } = {}) {
  const out = {};

  if (data.deviceId !== undefined) {
    out.device_id =
      data.deviceId === null || data.deviceId === "" ? null : Number(data.deviceId);
    if (out.device_id !== null && !Number.isInteger(out.device_id))
      throw err(400, "deviceId must be an integer or null (null = global default).");
  } else if (!partial) {
    out.device_id = null; // omitted on create = global default
  }

  // Optional per-port scope. Only meaningful alongside a device — a global rule can't
  // name a port, because ports only exist in the context of one router.
  if (data.interfaceName !== undefined) {
    const raw = data.interfaceName;
    const name = raw === null || raw === "" ? null : String(raw).trim();
    if (name && name.length > 50) throw err(400, "interfaceName must be 50 characters or fewer.");
    out.interface_name = name || null;
  } else if (!partial) {
    out.interface_name = null;
  }

  if (data.metricName !== undefined) {
    const m = String(data.metricName ?? "").trim().toLowerCase();
    if (!m || m.length > 50) throw err(400, "metricName is required (max 50 chars).");
    out.metric_name = m;
  } else if (!partial) {
    throw err(400, "metricName is required.");
  }

  if (data.thresholdValue !== undefined) {
    const v = Number(data.thresholdValue);
    if (!Number.isFinite(v)) throw err(400, "thresholdValue must be a number.");
    out.threshold_value = v;
  } else if (!partial) {
    throw err(400, "thresholdValue is required.");
  }

  if (data.comparison !== undefined) {
    if (!COMPARISONS.includes(data.comparison))
      throw err(400, `comparison must be one of: ${COMPARISONS.join(" ")}`);
    out.comparison = data.comparison;
  } else if (!partial) {
    throw err(400, "comparison is required.");
  }

  if (data.severity !== undefined) {
    if (!SEVERITIES.includes(data.severity))
      throw err(400, `severity must be one of: ${SEVERITIES.join(", ")}`);
    out.severity = data.severity;
  } else if (!partial) {
    throw err(400, "severity is required.");
  }

  if (data.isActive !== undefined) out.is_active = data.isActive ? 1 : 0;
  else if (!partial) out.is_active = 1;

  // A port-scoped rule is meaningless without the device that owns the port. Checked
  // against the merged view so a PATCH that sets only one of the two still validates.
  const finalDevice = out.device_id !== undefined ? out.device_id : existing?.device_id ?? null;
  const finalIface = out.interface_name !== undefined ? out.interface_name : existing?.interface_name ?? null;
  if (finalIface && finalDevice == null) {
    throw err(400, "A port-scoped rule needs a device — pick the router the port belongs to.");
  }

  return out;
}

// snake_case row → camelCase client shape (mirrors the device list / notifications style).
function toClient(r) {
  return {
    id: r.alert_rule_id,
    deviceId: r.device_id,
    deviceName: r.device_name ?? null,
    interfaceName: r.interface_name ?? null, // null = whole device
    metricName: r.metric_name,
    thresholdValue: Number(r.threshold_value),
    comparison: r.comparison,
    severity: r.severity,
    isActive: Boolean(r.is_active),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
    // Accountability: who last created/edited this rule (NULL = seeded system default).
    updatedBy: r.updated_by ?? null,
    updatedByName: r.updated_by_name ?? null,
  };
}

async function list() {
  const [rows] = await db.query(
    `SELECT r.*, d.device_name, u.name AS updated_by_name
       FROM alert_rules r
       LEFT JOIN devices d ON d.device_id = r.device_id
       LEFT JOIN users u   ON u.user_id   = r.updated_by
      ORDER BY (r.device_id IS NOT NULL), r.device_id, r.metric_name,
               FIELD(r.severity, 'critical','warning','info')`,
  );
  return rows.map(toClient);
}

async function getById(id) {
  const [[row]] = await db.query(
    `SELECT r.*, d.device_name, u.name AS updated_by_name FROM alert_rules r
       LEFT JOIN devices d ON d.device_id = r.device_id
       LEFT JOIN users u   ON u.user_id   = r.updated_by
      WHERE r.alert_rule_id = ?`,
    [Number(id)],
  );
  return row ? toClient(row) : null;
}

async function create(data, userId = null) {
  const f = clean(data, { partial: false });
  let ins;
  try {
    [ins] = await db.query(
      `INSERT INTO alert_rules (device_id, interface_name, metric_name, threshold_value, comparison, severity, is_active, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [f.device_id, f.interface_name ?? null, f.metric_name, f.threshold_value, f.comparison, f.severity, f.is_active, userId],
    );
  } catch (e) {
    if (e.code === "ER_NO_REFERENCED_ROW_2" || e.code === "ER_NO_REFERENCED_ROW")
      throw err(400, "deviceId does not match an existing device.");
    throw e;
  }
  await reload();
  return getById(ins.insertId);
}

async function update(id, data, userId = null) {
  // Needed so clean() can validate the MERGED row (e.g. naming a port on a rule whose
  // device_id isn't in this payload). Also gives a proper 404 before any write.
  const [[current]] = await db.query(
    `SELECT device_id, interface_name FROM alert_rules WHERE alert_rule_id = ?`,
    [Number(id)],
  );
  if (!current) throw err(404, "Alert rule not found.");

  const f = clean(data, { partial: true, existing: current });
  if (Object.keys(f).length === 0) throw err(400, "No valid fields to update.");
  // Stamp the acting admin + bump updated_at on every edit (incl. activate/pause toggle).
  const sets = Object.keys(f).map((k) => `${k} = ?`).join(", ");
  let res;
  try {
    [res] = await db.query(
      `UPDATE alert_rules SET ${sets}, updated_by = ?, updated_at = NOW() WHERE alert_rule_id = ?`,
      [...Object.values(f), userId, Number(id)],
    );
  } catch (e) {
    if (e.code === "ER_NO_REFERENCED_ROW_2" || e.code === "ER_NO_REFERENCED_ROW")
      throw err(400, "deviceId does not match an existing device.");
    throw e;
  }
  if (res.affectedRows === 0) throw err(404, "Alert rule not found.");
  await reload();
  return getById(id);
}

async function remove(id) {
  const [res] = await db.query(`DELETE FROM alert_rules WHERE alert_rule_id = ?`, [Number(id)]);
  if (res.affectedRows === 0) throw err(404, "Alert rule not found.");
  await reload();
  return true;
}

export default {
  reload,
  getEffectiveRules,
  getRoomThresholds,
  worstBreach,
  nextBand,
  SEV_RANK,
  list,
  getById,
  create,
  update,
  remove,
};
