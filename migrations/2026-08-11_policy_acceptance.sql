-- Privacy Notice & Terms of Use acceptance (RA 10173 / Data Privacy Act of 2012).
--
-- ⚠️ Already folded into v13_cspc-ictu-monitoring-system.sql. Run this ONLY against a
-- database created before 2026-08-11; a fresh import of v13 already has both columns
-- and re-running it fails with "Duplicate column name".
--
-- Two columns rather than a separate acceptances table: `system_logs` already
-- records ip_address + user_agent per row, so writing an audit entry on every
-- acceptance gives the full history (who / which version / when / from where)
-- without a second table to join. These columns hold the CURRENT state, which is
-- all the login gate needs to decide whether to prompt.
--
-- policy_version is the version string the user last accepted. NULL = never
-- accepted, which is the state every existing account starts in — so everyone,
-- including accounts created before this migration, sees the gate once. Bumping
-- POLICY_VERSION in backend/services/policyService.js re-prompts everyone.

ALTER TABLE `users`
  ADD COLUMN `policy_version`     VARCHAR(20) DEFAULT NULL AFTER `token_version`,
  ADD COLUMN `policy_accepted_at` TIMESTAMP   NULL DEFAULT NULL AFTER `policy_version`;
