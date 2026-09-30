-- Let an admin reopen an install key's install command after leaving the page.
--
-- Run this if you already applied 2026-08-15_agent_install_keys.sql. It is also in
-- v13_cspc-ictu-monitoring-system.sql.
--
-- A hash cannot give the key back, so showing the command again needs a reversible
-- copy. Encrypted, not plaintext, because the nightly database dump is copied offsite.
-- The key (SECRET_ENC_KEY, falling back to MIKROTIK_ENC_KEY) is in backend/.env, not in
-- the database or the backup.
--
-- `key_hash` is still used for lookup (one indexed query).
--
-- NULL = a key created before this change or while no encryption key was set. It still
-- works for enrollment; it just cannot be shown again, and the UI hides the button.

ALTER TABLE `agent_install_keys`
  ADD COLUMN `key_cipher` varchar(255) DEFAULT NULL
    COMMENT 'AES-256-GCM of the plaintext key, for re-displaying the install command; NULL = not recoverable'
    AFTER `key_hash`;
