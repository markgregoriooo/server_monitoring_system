-- Dashboard-managed agent install keys.
--
-- ⚠️ Already folded into v13_cspc-ictu-monitoring-system.sql. Run this ONLY against a
-- database created before 2026-08-15; a fresh import of v13 already has the table and
-- re-running it fails with "Table already exists".
--
-- WHY: AGENT_INSTALL_KEY lived in backend/.env — a live bearer credential that only
-- someone with shell access could change, with no expiry, no revocation, and no record
-- of who issued it or what enrolled with it. Moving it into a table makes it an
-- administered object: an admin mints one per rollout, labels it, and revokes it when
-- the rollout is done or the key leaks.
--
-- A key also OWNS the servers it enrolled: agent_tokens.install_key_id records which
-- key let each machine in, so revoking a key can (at the admin's choice) cut those
-- servers off too. That is the branch model — one key per office, revoke the key and
-- that office's servers stop reporting. See installKeyService.revoke({ revokeAgents }).
--
-- ⚠️ The two credentials still have separate lifecycles, and cutting agents off is an
-- EXPLICIT second action, never an implicit side effect: the install key is used once at
-- enrollment, while agent_tokens.approved_token is what an agent posts metrics with
-- forever after. The revoke UI lists exactly which servers would stop before doing it,
-- because monitoring going dark unannounced is the failure this whole system exists to
-- prevent. Per-server revocation without touching a key is DELETE /api/servers/:id.
--
-- The plaintext key is NEVER stored. Only its SHA-256 hash (for lookup) and a short
-- prefix (so the UI can name a key nobody can read any more). SHA-256 rather than
-- bcrypt on purpose: these are 24 random bytes, so there is no dictionary to slow an
-- attacker down with, and a fast hash lets the enrollment path find the row with one
-- indexed lookup instead of scanning every key and comparing each in turn.

CREATE TABLE `agent_install_keys` (
  `install_key_id` int(11) NOT NULL,
  `key_hash` char(64) NOT NULL COMMENT 'SHA-256 hex of the plaintext key — the key itself is never stored',
  `key_prefix` varchar(16) NOT NULL COMMENT 'Leading chars, shown in the UI to identify a key that can no longer be read',
  `label` varchar(100) NOT NULL,
  `created_by` int(11) DEFAULT NULL,
  `revoked_by` int(11) DEFAULT NULL,
  `expires_at` timestamp NULL DEFAULT NULL COMMENT 'NULL = never expires',
  `revoked_at` timestamp NULL DEFAULT NULL COMMENT 'NULL = still valid',
  `last_used_at` timestamp NULL DEFAULT NULL,
  `use_count` int(11) NOT NULL DEFAULT 0 COMMENT 'How many agents enrolled with this key',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

ALTER TABLE `agent_install_keys`
  ADD PRIMARY KEY (`install_key_id`),
  ADD UNIQUE KEY `uq_install_key_hash` (`key_hash`),
  ADD KEY `idx_install_key_created_by` (`created_by`),
  ADD KEY `idx_install_key_revoked_by` (`revoked_by`);

ALTER TABLE `agent_install_keys`
  MODIFY `install_key_id` int(11) NOT NULL AUTO_INCREMENT;

-- SET NULL, not CASCADE: deleting the admin who issued a key must not delete the key
-- (that would revoke enrollment for a whole branch as a side effect of an HR change)
-- and must not erase the record that the key existed. Matches alert_rules.updated_by.
ALTER TABLE `agent_install_keys`
  ADD CONSTRAINT `fk_install_keys_created_by` FOREIGN KEY (`created_by`)
    REFERENCES `users` (`user_id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_install_keys_revoked_by` FOREIGN KEY (`revoked_by`)
    REFERENCES `users` (`user_id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Which key enrolled this agent. NULL = enrolled before this feature, or via the legacy
-- .env key (which has no row). Those agents are unaffected by any key revoke, because
-- there is no key they can be attributed to.
--
-- SET NULL rather than CASCADE: install keys are never hard-deleted (revoke is soft), but
-- if one ever were, the ENROLLMENT must survive it — deleting a key row must not delete
-- the record of the servers it authorised.
ALTER TABLE `agent_tokens`
  ADD COLUMN `install_key_id` int(11) DEFAULT NULL COMMENT 'Which install key enrolled this agent; NULL = legacy/.env enrollment' AFTER `device_id`,
  ADD KEY `idx_agent_tokens_install_key` (`install_key_id`),
  ADD CONSTRAINT `fk_agent_tokens_install_key` FOREIGN KEY (`install_key_id`)
    REFERENCES `agent_install_keys` (`install_key_id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- 'revoked' = this agent's authorisation was withdrawn wholesale, by revoking the install
-- key it enrolled with. Distinct from 'rejected', which means an admin declined a NEW
-- enrollment (and which agentService.reject implements by deleting the device outright).
-- A revoked row is KEPT so the device, its logs and its history survive, and so the same
-- machine can re-enrol onto the same device_id instead of forking its time-series.
ALTER TABLE `agent_tokens`
  MODIFY `status` enum('pending','approved','rejected','revoked') DEFAULT NULL;
