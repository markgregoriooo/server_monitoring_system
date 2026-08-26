-- Stop storing the agent's permanent bearer token in readable form.
--
-- `agent_tokens.approved_token` held the live `AGT-…` credential verbatim, and
-- validateToken compared strings. Meanwhile `agent_install_keys` — the same class of
-- credential, one table over — has stored a SHA-256 hash since it was introduced, plus an
-- AES-256-GCM copy for the one case that needs the original back. The two were
-- inconsistent, and the plaintext side was the one that mattered more: an agent token is
-- permanent, never expires, and authorises metric ingestion for a server.
--
-- WHY THIS IS NOT A THEORETICAL "if someone reads the database".
-- `ops/db-backup/dump-mysql.sh` writes a full mysqldump of this database into BACKUP_DIR,
-- and `ops/offsite-backup/sync-offsite.sh` rclone-copies that whole folder to Backblaze
-- (excluding only .last_offsite_sync, *.log and *.tmp). So every agent credential was
-- already leaving the building nightly, in a file on cloud storage. That is precisely the
-- reasoning 2026-08-15b_install_key_reveal.sql gives for encrypting `key_cipher`; agent
-- tokens simply never got the same treatment.
--
-- ── TWO COLUMNS REPLACE ONE, BECAUSE THERE WERE TWO JOBS ────────────────────────────
--
-- `approved_token_hash`  — the LOOKUP path, checked on every metric POST. SHA-256, not
--   bcrypt, for the argument installKeyUtils.js already makes and which `hashKey` is
--   REUSED for here rather than re-implemented: the token is `AGT-` + 24 CSPRNG bytes =
--   192 bits of randomness, so there is no dictionary to slow an attacker down with, while
--   a deliberately slow hash would force the hottest query in the system (every agent,
--   every 10 s) to scan the table instead of hitting one unique index.
--
-- `approved_token_cipher` — an AES-256-GCM copy, for RE-DELIVERY. A hash answers "is this
--   the token?" and can never answer "what was the token?", and this system genuinely has
--   to answer the second one more than once. `agent/cmd/agent/main.go` runs enrollment only
--   when `config.Load` FAILS, so every call to /api/agents/register comes from a machine
--   with no usable agent.conf; `register()` answers by handing back the SAME pending token,
--   which the agent exchanges for its approved token at /api/agents/status. That one path
--   carries both the "restore wiped agent.conf" recovery AND the documented ADOPT workflow
--   (move a server onto another branch's install key by re-running the installer). Storing
--   only a hash would break both, and break them quietly — the agent's
--   `approved but token missing; retrying` branch loops forever rather than failing.
--
-- The key is SECRET_ENC_KEY (falling back to MIKROTIK_ENC_KEY) in backend/.env, which is
-- neither in the database nor in the backup. A stolen dump now yields a hash and a
-- ciphertext, and authenticates nothing.
--
-- ── ⚠️ CHECK THIS BEFORE RUNNING ────────────────────────────────────────────────────
--
--   SELECT COUNT(*) FROM agent_tokens
--    WHERE status = 'approved' AND approved_token IS NOT NULL AND approved_token <> '';
--
-- Whatever that returns, those agents KEEP WORKING: the backfill below hashes what is
-- already stored, so hash lookup matches from the first request, and each agent already
-- holds its own token in agent.conf. No re-enrollment, no agent update, no restart.
--
-- What they lose is RE-DELIVERY — they predate the cipher column, so nothing can hand
-- them their token a second time. If one of those machines later loses agent.conf it must
-- be re-enrolled with an install key (it keeps its device id, its logs and its InfluxDB
-- history — `register()` re-arms the same row). Every approval made AFTER this migration
-- gets a cipher and full re-delivery.
--
-- On the database this was written against that count was 0 — a single `revoked` row and
-- no live credentials — so nothing was lost at all.

ALTER TABLE `agent_tokens`
  ADD COLUMN `approved_token_hash` char(64) DEFAULT NULL
    COMMENT 'SHA-256 hex of the AGT- token — the lookup path for every metric POST'
    AFTER `approved_token`,
  ADD COLUMN `approved_token_cipher` varchar(255) DEFAULT NULL
    COMMENT 'AES-256-GCM of the token, for re-delivery to an agent that lost agent.conf. NULL = not recoverable'
    AFTER `approved_token_hash`,
  ADD UNIQUE INDEX `uq_agent_tokens_approved_hash` (`approved_token_hash`);

-- Backfill the lookup hash BEFORE dropping the source column — this is what keeps any
-- already-approved agent authenticating without being touched. MySQL's SHA2(x, 256)
-- returns lowercase hex, byte-for-byte identical to Node's
-- crypto.createHash("sha256").digest("hex"), which is what installKeyUtils.hashKey
-- returns and what the backend looks up with. tests/agentTokenHash.test.js parses THIS
-- FILE and fails if the two ever drift apart.
--
-- SHA2()/CHAR(64)/unique index are all standard on MySQL 5.6+ AND MariaDB 10.x — this
-- was applied against MariaDB. Note for whoever runs it: keep semicolons OUT of the
-- COMMENT strings above, or a client that splits statements on ';' will cut them in half.
UPDATE `agent_tokens`
   SET `approved_token_hash` = SHA2(`approved_token`, 256)
 WHERE `approved_token` IS NOT NULL
   AND `approved_token` <> '';

-- And now the point of the exercise: the readable copy stops existing.
ALTER TABLE `agent_tokens` DROP COLUMN `approved_token`;

-- ── STILL PLAINTEXT AFTER THIS, AND KNOWN ───────────────────────────────────────────
-- `agent_tokens.token` (the short pending token) is unchanged. It is a lower-value,
-- pre-approval credential, but while an enrollment sits PENDING in a dump it could be
-- raced against the real agent to collect that server's token the moment an admin
-- approves. Hashing it would stop `register()` handing the same pending token back to a
-- returning machine, which is the recovery path described above — so it needs the agent
-- side reworked with it, and belongs in its own change.
