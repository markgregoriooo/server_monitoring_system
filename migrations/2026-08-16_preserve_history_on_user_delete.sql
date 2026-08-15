-- Deleting a user must not delete what they did.
--
-- ⚠️ Also folded into v13_cspc-ictu-monitoring-system.sql. Run this ONLY on a database
-- created before 2026-08-16.
--
-- Two foreign keys were ON DELETE CASCADE:
--
--   alerts.acknowledged_by  -> removing a user DELETED EVERY ALERT THEY EVER ACKNOWLEDGED.
--       Not their name on it — the incident row itself, and via its own cascade the whole
--       per-user feed for it. Acknowledging an alert is the act of taking responsibility
--       for it, so this erased exactly the incidents someone had handled while leaving
--       the ones nobody touched. Staff turnover would quietly hollow out the history.
--
--   system_logs.user_id     -> and their entire audit trail with them, including the
--       policy-acceptance evidence rows that policyService writes in a transaction
--       precisely BECAUSE they are evidence. The Privacy Notice commits to a 365-day
--       retention for this table (SYSTEM_LOG_RETENTION_DAYS); a cascade meant the real
--       retention was "until the account is deleted", which is not what was promised.
--
-- SET NULL keeps the row and drops the attribution. Both columns are already nullable,
-- and every reader already handles a null: alertsService LEFT JOINs users for the
-- acknowledger's name, and system_logs.user_id is documented as "null = system action".
--
-- This matches the treatment the newer columns already got — alerts.resolved_by,
-- alert_rules.updated_by and aircon_ir_config.updated_by are all SET NULL. The two fixed
-- here are the older ones that predate that decision.

ALTER TABLE `alerts`
  DROP FOREIGN KEY `fk_alerts_users1`;
ALTER TABLE `alerts`
  ADD CONSTRAINT `fk_alerts_users1` FOREIGN KEY (`acknowledged_by`)
    REFERENCES `users` (`user_id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `system_logs`
  DROP FOREIGN KEY `fk_system_logs_users`;
ALTER TABLE `system_logs`
  ADD CONSTRAINT `fk_system_logs_users` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`user_id`) ON DELETE SET NULL ON UPDATE CASCADE;
