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

// Delete audit rows older than `days`. Alerts, reports and backups have all had a
// retention purge since they were built; system_logs did not, so it grew without
// limit — and it is the table that holds ip_address and user_agent, i.e. the most
// personal data in the schema. Keeping it forever contradicts both the Data
// Privacy Act's storage-limitation principle and the retention period the Privacy
// Notice commits to. Default is deliberately LONGER than the alert/report windows:
// an audit trail is the thing you go looking for months after an incident.
//
// Not best-effort like audit() above — the caller (server.js) logs failures. A
// purge that silently does nothing is worse than one that reports it couldn't run.
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
