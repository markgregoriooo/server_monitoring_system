import db from "../config/mysql.js";

// ─── Activity / audit history ─────────────────────────────────────────
// The History page's timeline, merged from four log tables:
//
//   system_logs  — user actions (login/logout, admin changes)
//   aircon_logs  — AC control: manual (user) or auto (IR zone change)
//   alerts       — every alert raised and its lifecycle
//   device_logs  — agent/server lifecycle and threshold crossings
//
// Each row gets an actor:
//   admin  — a user with role 'admin'
//   staff  — a user with role 'it_staff'
//   system — no user (alerts, auto IR, agents, sweeps)
//
// Numbers (days, paging) are clamped integers before being inlined; every other
// filter is a bound `?` parameter.

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// system_logs.module values + our two synthetic alert categories.
const CATEGORIES = new Set([
  "auth", "users", "alerts", "environment", "aircon", "devices", "reports", "network", "backups", "system",
]);
const SEVERITIES = new Set(["critical", "warning", "info"]);
const ACTOR_TYPES = new Set(["admin", "staff", "system"]);

// Resolve the time window from opts: a custom YYYY-MM-DD range (strictly validated
// → safe to inline) takes precedence, else a clamped "last N days".
function resolveWindow(opts = {}) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  let start = String(opts.start ?? "");
  let end = String(opts.end ?? "");
  if (re.test(start) && re.test(end)) {
    if (start > end) [start, end] = [end, start]; // tolerate reversed range
    return { mode: "range", start, end };
  }
  return { mode: "days", days: clampInt(opts.days, 1, 365, 30) };
}

// Time-window condition for one subquery's timestamp column. Both branches use
// only pre-validated values (clamped int / YYYY-MM-DD regex), so inlining is safe.
function timeCond(col, win) {
  if (win.mode === "range") {
    return `${col} >= '${win.start} 00:00:00' AND ${col} <= '${win.end} 23:59:59'`;
  }
  return `${col} >= (NOW() - INTERVAL ${win.days} DAY)`;
}

// The four-source UNION ALL. The window is pushed into each subquery so the union
// stays small and uses each table's created_at/recorded_at index.
function unionSql(win) {
  return `
    SELECT CONCAT('sys-', sl.system_log_id) AS id, 'system_logs' AS source,
           COALESCE(sl.module, 'system') AS category, sl.created_at AS ts,
           sl.user_id AS actor_user_id, u.name AS actor_name, u.role AS actor_role,
           CASE sl.log_level WHEN 'error' THEN 'critical'
                             WHEN 'warning' THEN 'warning' ELSE 'info' END AS severity,
           sl.action AS action, sl.description AS message, NULL AS device_name
      FROM system_logs sl
      LEFT JOIN users u ON u.user_id = sl.user_id
     WHERE ${timeCond("sl.created_at", win)}

    UNION ALL

    SELECT CONCAT('ac-', al.id), 'aircon_logs', 'aircon', al.created_at,
           al.user_id, u.name, u.role, 'info',
           al.action,
           CONCAT(al.action, IF(al.reason IS NULL OR al.reason = '', '', CONCAT(' — ', al.reason))),
           d.device_name
      FROM aircon_logs al
      LEFT JOIN users u ON u.user_id = al.user_id
      LEFT JOIN devices d ON d.device_id = al.device_id
     WHERE ${timeCond("al.created_at", win)}

    UNION ALL

    SELECT CONCAT('alert-', a.alert_id), 'alerts',
           CASE WHEN a.type IN ('temperature', 'gas', 'humidity') THEN 'environment' ELSE 'alerts' END,
           a.created_at, NULL, NULL, NULL, a.severity, a.type, a.message, d.device_name
      FROM alerts a
      LEFT JOIN devices d ON d.device_id = a.device_id
     WHERE ${timeCond("a.created_at", win)}

    UNION ALL

    SELECT CONCAT('dev-', dl.device_log_id), 'device_logs', 'devices', dl.recorded_at,
           NULL, NULL, NULL,
           CASE dl.log_level WHEN 'critical' THEN 'critical' WHEN 'error' THEN 'critical'
                             WHEN 'warning' THEN 'warning' ELSE 'info' END,
           'device_event', dl.message, d.device_name
      FROM device_logs dl
      LEFT JOIN devices d ON d.device_id = dl.device_id
     WHERE ${timeCond("dl.recorded_at", win)}
  `;
}

function buildWhere({ category, severity, actorType, userId, search }) {
  const clauses = [];
  const params = [];

  if (category && CATEGORIES.has(category)) {
    clauses.push("h.category = ?");
    params.push(category);
  }
  if (severity && SEVERITIES.has(severity)) {
    clauses.push("h.severity = ?");
    params.push(severity);
  }
  if (actorType && ACTOR_TYPES.has(actorType)) {
    if (actorType === "system") clauses.push("h.actor_user_id IS NULL");
    else if (actorType === "admin") clauses.push("h.actor_role = 'admin'");
    else clauses.push("h.actor_role = 'it_staff'");
  }
  // Filter to a specific person's actions (audit "what did user X do").
  const uid = parseInt(userId, 10);
  if (Number.isFinite(uid)) {
    clauses.push("h.actor_user_id = ?");
    params.push(uid);
  }
  // Escape LIKE wildcards so `_` and `%` in a search are literal ("server_01" should
  // not match "server-01"). Backslash first. Capped at 120 characters because each
  // term is matched against four columns with a leading wildcard (no index).
  const term = String(search ?? "").trim().slice(0, 120);
  if (term) {
    const like = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    clauses.push(
      "(h.message LIKE ? OR h.action LIKE ? OR h.device_name LIKE ? OR h.actor_name LIKE ?)",
    );
    params.push(like, like, like, like);
  }

  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

function actorType(row) {
  if (row.actor_user_id == null) return "system";
  return row.actor_role === "admin" ? "admin" : "staff";
}

function toClient(row) {
  return {
    id: row.id,
    source: row.source,
    category: row.category,
    timestamp: row.ts, // mysql2 returns a Date → serialized as ISO in JSON
    actorType: actorType(row),
    actorName: row.actor_user_id == null ? "System" : row.actor_name || `User ${row.actor_user_id}`,
    severity: row.severity,
    action: row.action,
    message: row.message,
    device: row.device_name ?? null,
  };
}

// Paginated, filtered timeline + a window summary (counts by severity + actor).
async function getHistory(opts = {}) {
  const win = resolveWindow(opts);
  const pageSize = clampInt(opts.pageSize, 1, 200, 50);
  const page = clampInt(opts.page, 1, 100000, 1);
  const offset = (page - 1) * pageSize;

  const union = unionSql(win);
  const where = buildWhere(opts);

  // One grouped scan → totals + the stat-tile breakdowns (SUM of a boolean is a count).
  const [[s]] = await db.query(
    `SELECT
        COUNT(*) AS total,
        SUM(h.severity = 'critical') AS critical,
        SUM(h.severity = 'warning')  AS warning,
        SUM(h.severity = 'info')     AS info,
        SUM(h.actor_user_id IS NULL) AS system_count,
        SUM(h.actor_role = 'admin')  AS admin_count,
        SUM(h.actor_role = 'it_staff') AS staff_count
       FROM ( ${union} ) h
       ${where.sql}`,
    where.params,
  );

  const [rows] = await db.query(
    `SELECT id, source, category, ts, actor_user_id, actor_name, actor_role,
            severity, action, message, device_name
       FROM ( ${union} ) h
       ${where.sql}
       ORDER BY ts DESC
       LIMIT ${pageSize} OFFSET ${offset}`,
    where.params,
  );

  return {
    events: rows.map(toClient),
    total: Number(s?.total ?? 0),
    page,
    pageSize,
    days: win.mode === "days" ? win.days : null,
    start: win.mode === "range" ? win.start : null,
    end: win.mode === "range" ? win.end : null,
    summary: {
      critical: Number(s?.critical ?? 0),
      warning: Number(s?.warning ?? 0),
      info: Number(s?.info ?? 0),
      system: Number(s?.system_count ?? 0),
      admin: Number(s?.admin_count ?? 0),
      staff: Number(s?.staff_count ?? 0),
    },
  };
}

// Users who appear as an actor in the history (for the per-user filter). Only
// system_logs and aircon_logs have actors.
async function getActors() {
  const [rows] = await db.query(
    `SELECT u.user_id AS id, u.name, u.role
       FROM users u
      WHERE u.user_id IN (
        SELECT user_id FROM system_logs WHERE user_id IS NOT NULL
        UNION
        SELECT user_id FROM aircon_logs WHERE user_id IS NOT NULL
      )
      ORDER BY u.name`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, role: r.role }));
}

export default { getHistory, getActors };
