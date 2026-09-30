-- Deleting a user must not delete what they did.
--
-- Also included in v13_cspc-ictu-monitoring-system.sql. Only run this on a database
-- created before 2026-08-16.
--
-- Two foreign keys were ON DELETE CASCADE:
--
--   alerts.acknowledged_by  -> deleting a user deleted every alert they acknowledged
--                              (and the per-user feed rows for them).
--   system_logs.user_id     -> and their whole audit trail, including policy acceptance
--                              records. The Privacy Notice promises 365 days
--                              (SYSTEM_LOG_RETENTION_DAYS).
--
-- SET NULL keeps the row and drops the name. Both columns are nullable and every reader
-- already handles null. Same as alerts.resolved_by, alert_rules.updated_by and
-- aircon_ir_config.updated_by.

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
