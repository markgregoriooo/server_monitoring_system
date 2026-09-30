import db from "../config/mysql.js";
import { describeError } from "../utils/httpError.js";

// Add a user/admin action to `system_logs`, the audit trail on the History page.
// Best-effort: a failed audit write is logged but never breaks the action.
//
//  module      one of the system_logs.module ENUM values:
//              auth | aircon | users | alerts | reports | devices | network
//  level       system_logs.log_level ENUM: info | warning | error
//  userId      the acting user (null = system / automated)
export async function audit({
  userId = null,
  module,
  action,
  description,
  level = "info",
  ip = null,
  userAgent = null,
}) {
  try {
    await db.query(
      `INSERT INTO system_logs
         (user_id, module, action, description, ip_address, user_agent, log_level, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [userId, module, action, description, ip, userAgent, level],
    );
  } catch (err) {
    console.error("[audit] failed to record action:", describeError(err));
  }
}

// Pull { ip, userAgent } off an Express request for an audit row.
export function clientInfo(req) {
  return { ip: req?.ip ?? null, userAgent: req?.get?.("user-agent") ?? null };
}

// Delete audit rows older than `days`. system_logs holds IP addresses and user
// agents, and the Privacy Notice promises a retention period. The default is longer
// than for alerts and reports, since audit logs are needed long after an incident.
// Unlike audit(), errors reach the caller (server.js logs them).
export async function purgeOld(days) {
  const keep = Number(days);
  if (!Number.isFinite(keep) || keep <= 0) return 0;
  const [res] = await db.query(
    `DELETE FROM system_logs WHERE created_at < (NOW() - INTERVAL ? DAY)`,
    [keep],
  );
  return res.affectedRows ?? 0;
}

export default { audit, clientInfo, purgeOld };
