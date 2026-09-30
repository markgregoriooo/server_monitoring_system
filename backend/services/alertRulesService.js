import db from "../config/mysql.js";
// Validation vocabulary + the rule gate — pure, so tests reach it with no MySQL.
import { cleanRule, ruleError, COMPARISONS, SEVERITIES, scopeConflictError } from "./alertRuleValidation.js";

// ─── Configurable alert thresholds (alert_rules) ────────────────────────────────
// Scope (see the alert_rules table in v13_cspc-ictu-monitoring-system.sql):
//   * device_id = NULL  → global default (every server / the room)
//   * device_id = <id>  → per-device override
// getEffectiveRules() returns the device's rules if it has any, else the global ones.
// No matching active rule = no alert. v13 seeds the global defaults.
//
// metric_name must match the trigger sites:
//   server:      'cpu', 'mem', 'disk'   (agentService.checkThresholds)
//   environment: 'temperature', 'gas', 'humidity'  (sensorHandler, device_id NULL)

const SEV_RANK = { normal: 0, info: 1, warning: 2, critical: 3 };

// ─── In-memory cache ────────────────────────────────────────────────────────────
// Rules are read on every metric POST and sensor reading, so active rules are
// cached and reloaded on startup and after every change.
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

// Active rules for (deviceId, metricName [, interfaceName]). The first level that
// has rules wins; levels are not merged:
//   1. this device + this port   (only link_util / link_errors)
//   2. this device, any port
//   3. global default
// Empty array = no rule = no alert.
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

// Hysteresis: a value must drop back past the threshold by 5% of it before the
// band clears, so a value sitting at the boundary does not flap. Repeated
// notifications are also limited by the DB cooldown.
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

// New severity band for a metric. Going up is immediate; going down waits until
// the value clears the previous threshold by the margin. Returns { band, rule };
// `rule` (for alerts.alert_rule_id) is set only when escalating.
function nextBand(rules, value, prevBand = "normal") {
  const breach = worstBreach(rules, value);
  const target = breach ? breach.severity : "normal";
  if (SEV_RANK[target] >= SEV_RANK[prevBand]) return { band: target, rule: breach };
  const prevRule = rules.find((r) => r.severity === prevBand);
  if (prevRule && !clears(prevRule, value)) return { band: prevBand, rule: null }; // hold
  return { band: target, rule: breach };
}

// Room-level (global) thresholds in the shape the ESP32 expects in "envConfig", so
// its LED, buzzer and status match the dashboard. Fields with no rule are left out
// and the firmware keeps its compiled default.
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
// Validation is in ./alertRuleValidation.js (no imports, so it is unit-tested).
// See audits/code-complexity-report-2026-08-25.md (C-01).
const clean = cleanRule;
const err = ruleError;

// ─── Severity order check ─────────────────────────────────────────────────────
// The rule itself is alertRuleValidation.severityOrderError; this finds the rules
// to compare against. Scope uses `<=>` (null-safe) because a global rule has
// device_id NULL, and `NULL = NULL` is never true.
async function siblingsInScope(deviceId, interfaceName, metricName, excludeId = 0) {
  const [rows] = await db.query(
    `SELECT alert_rule_id, severity, threshold_value, comparison, is_active
       FROM alert_rules
      WHERE device_id <=> ? AND interface_name <=> ? AND metric_name = ?
        AND alert_rule_id <> ?`,
    [deviceId ?? null, interfaceName ?? null, metricName, Number(excludeId) || 0],
  );
  return rows;
}

/**
 * Throw 400 if the rule conflicts with the others in its scope — either a second rule at
 * the same severity, or a break in the info < warning < critical ladder.
 */
async function assertSeverityOrder(row, excludeId = 0) {
  const siblings = await siblingsInScope(row.device_id, row.interface_name, row.metric_name, excludeId);
  const reason = scopeConflictError(row, siblings);
  if (reason) throw err(400, reason);
}

// Only these three fields can break the order. A change that touches none of them
// (such as pausing a rule) skips the check, so an admin can still pause rules in a
// scope that is already inconsistent.
const LADDER_FIELDS = ["threshold_value", "comparison", "severity"];
const touchesLadder = (f) => LADDER_FIELDS.some((k) => f[k] !== undefined);

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
  // Before the INSERT, not after: a rejected rule must leave no row behind.
  await assertSeverityOrder(f);
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
    // The unique index (2026-08-26_alert_rule_scope_uniqueness.sql) catches what the
    // check above misses, e.g. two admins saving at once. Turn the driver's index-name
    // error into the same message the check gives.
    if (e.code === "ER_DUP_ENTRY")
      throw err(400, "A rule already exists for this metric at this severity and scope. Edit that rule instead of adding a second one.");
    throw e;
  }
  await reload();
  return getById(ins.insertId);
}

async function update(id, data, userId = null) {
  // Needed so clean() can validate the MERGED row (e.g. naming a port on a rule whose
  // device_id isn't in this payload). Also gives a proper 404 before any write.
  const [[current]] = await db.query(
    `SELECT device_id, interface_name, metric_name, threshold_value, comparison, severity
       FROM alert_rules WHERE alert_rule_id = ?`,
    [Number(id)],
  );
  if (!current) throw err(404, "Alert rule not found.");

  const f = clean(data, { partial: true, existing: current });
  if (Object.keys(f).length === 0) throw err(400, "No valid fields to update.");

  // Validate the rule as it will be after the patch, since severity and comparison
  // may only be on the existing row.
  if (touchesLadder(f)) {
    await assertSeverityOrder(
      {
        device_id: f.device_id !== undefined ? f.device_id : current.device_id,
        interface_name: f.interface_name !== undefined ? f.interface_name : current.interface_name,
        metric_name: f.metric_name !== undefined ? f.metric_name : current.metric_name,
        threshold_value: f.threshold_value !== undefined ? f.threshold_value : current.threshold_value,
        comparison: f.comparison !== undefined ? f.comparison : current.comparison,
        severity: f.severity !== undefined ? f.severity : current.severity,
      },
      id, // exclude self, or a rule would always collide with its own stored value
    );
  }
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
    // The unique index (2026-08-26_alert_rule_scope_uniqueness.sql) catches what the
    // check above misses, e.g. two admins saving at once. Turn the driver's index-name
    // error into the same message the check gives.
    if (e.code === "ER_DUP_ENTRY")
      throw err(400, "A rule already exists for this metric at this severity and scope. Edit that rule instead of adding a second one.");
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
