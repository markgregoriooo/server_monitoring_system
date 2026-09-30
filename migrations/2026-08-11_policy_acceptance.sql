-- Privacy Notice & Terms of Use acceptance (RA 10173 / Data Privacy Act of 2012).
--
-- Already included in v13_cspc-ictu-monitoring-system.sql. Only run this on a database
-- created before 2026-08-11 (on v13 it fails with "Duplicate column name").
--
-- Two columns hold the current state; the history (who, which version, when, from
-- where) is in system_logs, written on every acceptance. policy_version is the version
-- last accepted; NULL = never, so every existing account sees the gate once. Bumping
-- POLICY_VERSION in backend/services/policyService.js asks everyone again.

ALTER TABLE `users`
  ADD COLUMN `policy_version`     VARCHAR(20) DEFAULT NULL AFTER `token_version`,
  ADD COLUMN `policy_accepted_at` TIMESTAMP   NULL DEFAULT NULL AFTER `policy_version`;
