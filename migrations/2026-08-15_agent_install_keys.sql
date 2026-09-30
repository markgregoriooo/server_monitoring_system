-- Agent install keys managed from the dashboard.
--
-- Already included in v13_cspc-ictu-monitoring-system.sql. Only run this on a database
-- created before 2026-08-15 (on v13 it fails with "Table already exists").
--
-- AGENT_INSTALL_KEY used to be one value in backend/.env, with no expiry, no revocation
-- and no record of who used it. Now an admin creates a key per rollout and revokes it
-- when done.
--
-- agent_tokens.install_key_id records which key enrolled each server, so revoking a key
-- can also cut those servers off, if the admin chooses (one key per office). See
-- installKeyService.revoke({ revokeAgents }). That is always a separate, explicit choice,
-- and the UI lists the affected servers first. To remove one server without touching a
-- key, use DELETE /api/servers/:id.
--
-- Only the key's SHA-256 hash (for lookup) and a short prefix (for display) are stored,
-- never the key. SHA-256, not bcrypt: the key is 24 random bytes, so a slow hash adds
-- nothing, and a fast one allows a single indexed lookup.

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

-- SET NULL, not CASCADE: deleting the admin who created a key must not delete the key.
-- Same as alert_rules.updated_by.
ALTER TABLE `agent_install_keys`
  ADD CONSTRAINT `fk_install_keys_created_by` FOREIGN KEY (`created_by`)
    REFERENCES `users` (`user_id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_install_keys_revoked_by` FOREIGN KEY (`revoked_by`)
    REFERENCES `users` (`user_id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Which key enrolled this agent. NULL = enrolled before this feature or with the .env
-- key; such agents are not affected by revoking a key. SET NULL rather than CASCADE, so
-- deleting a key never deletes the record of what it enrolled.
ALTER TABLE `agent_tokens`
  ADD COLUMN `install_key_id` int(11) DEFAULT NULL COMMENT 'Which install key enrolled this agent; NULL = legacy/.env enrollment' AFTER `device_id`,
  ADD KEY `idx_agent_tokens_install_key` (`install_key_id`),
  ADD CONSTRAINT `fk_agent_tokens_install_key` FOREIGN KEY (`install_key_id`)
    REFERENCES `agent_install_keys` (`install_key_id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- 'revoked' = the agent's authorisation was withdrawn by revoking its install key.
-- Different from 'rejected' (an admin declined a new enrollment; the device is deleted).
-- A revoked row is kept, so the device keeps its logs and history and can re-enroll on
-- the same device_id.
ALTER TABLE `agent_tokens`
  MODIFY `status` enum('pending','approved','rejected','revoked') DEFAULT NULL;
