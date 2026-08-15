-- Let an admin re-open an install key's install command after leaving the page.
--
-- ⚠️ Run this if you already applied 2026-08-15_agent_install_keys.sql. It is also folded
-- into v13_cspc-ictu-monitoring-system.sql, so a fresh import already has the column.
--
-- WHY A SECOND COLUMN INSTEAD OF READING THE HASH: a hash is one-way by construction, so
-- `key_hash` can answer "is this the key?" and can never answer "what was the key?".
-- Showing the command again needs the original back, which needs reversible storage.
--
-- WHY ENCRYPTED AND NOT PLAINTEXT: the key is a credential. `ops/db-backup` writes a
-- nightly mysqldump onto the same drive the NDJSON backups live on, and the offsite
-- rclone job syncs that drive to cloud storage — so a plaintext column would put every
-- install key into a file that leaves the building. Encrypted, a dump on its own is
-- useless: the key material is SECRET_ENC_KEY (falling back to MIKROTIK_ENC_KEY) in
-- backend/.env, which is neither in the database nor in the backup.
--
-- `key_hash` STAYS and remains the lookup path. Enrollment matches one indexed hash;
-- decrypting every row to compare would turn an O(1) lookup into a scan.
--
-- NULL = a key minted before this change, or one created while no encryption key was
-- configured. Those still enrol perfectly well — they simply cannot be shown again, and
-- the UI hides the button rather than offering one that fails.

ALTER TABLE `agent_install_keys`
  ADD COLUMN `key_cipher` varchar(255) DEFAULT NULL
    COMMENT 'AES-256-GCM of the plaintext key, for re-displaying the install command; NULL = not recoverable'
    AFTER `key_hash`;
