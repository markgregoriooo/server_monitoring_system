import db from "../config/mysql.js";

// Append a user/admin action to `system_logs` — the audit trail the History page
// reads (alongside aircon_logs, alerts and device_logs). Best-effort BY DESIGN:
// an audit-write failure must never break the action that triggered it, so every
// error is swallowed + logged here rather than propagated to the caller.
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
    console.error("[audit] failed to record action:", err.message);
  }
}

// Pull { ip, userAgent } off an Express request for an audit row.
export function clientInfo(req) {
  return { ip: req?.ip ?? null, userAgent: req?.get?.("user-agent") ?? null };
}

export default { audit, clientInfo };
