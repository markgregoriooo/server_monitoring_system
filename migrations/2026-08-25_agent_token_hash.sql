-- Stop storing the agent's permanent token in readable form.
--
-- agent_tokens.approved_token held the AGT- token as plain text, and the nightly database
-- dump is copied offsite (ops/db-backup, ops/offsite-backup). Install keys were already
-- hashed plus encrypted; this does the same for agent tokens.
--
-- ── Two columns replace one ────────────────────────────
--
-- approved_token_hash    lookup on every metric POST. SHA-256 (installKeyUtils.hashKey):
--                        the token is 192 random bits, so a slow hash adds nothing, and
--                        the lookup must use one unique index.
--
-- approved_token_cipher  AES-256-GCM copy, for giving the token to the agent again. The
--                        agent only enrolls when it has no usable agent.conf, and
--                        register() then hands back its token. That covers recovering a
--                        lost agent.conf and moving a server to another install key.
--                        With only a hash, the agent would loop on "approved but token
--                        missing; retrying".
--
-- The key (SECRET_ENC_KEY, falling back to MIKROTIK_ENC_KEY) is in backend/.env, not in
-- the database or the backup.
--
-- ── Check before running ────────────────────────────────────────────────────
--
--   SELECT COUNT(*) FROM agent_tokens
--    WHERE status = 'approved' AND approved_token IS NOT NULL AND approved_token <> '';
--
-- Those agents keep working: the backfill below hashes the stored values, and each agent
-- already has its token. What they lose is re-delivery (no cipher), so if one later loses
-- agent.conf it must be re-enrolled with an install key (it keeps its device id, logs and
-- history). Approvals after this migration get a cipher. On the database this was written
-- against the count was 0.

ALTER TABLE `agent_tokens`
  ADD COLUMN `approved_token_hash` char(64) DEFAULT NULL
    COMMENT 'SHA-256 hex of the AGT- token — the lookup path for every metric POST'
    AFTER `approved_token`,
  ADD COLUMN `approved_token_cipher` varchar(255) DEFAULT NULL
    COMMENT 'AES-256-GCM of the token, for re-delivery to an agent that lost agent.conf. NULL = not recoverable'
    AFTER `approved_token_hash`,
  ADD UNIQUE INDEX `uq_agent_tokens_approved_hash` (`approved_token_hash`);

-- Fill the hash before dropping the old column, so approved agents keep working. MySQL's
-- SHA2(x, 256) gives the same lowercase hex as Node's
-- crypto.createHash("sha256").digest("hex") (installKeyUtils.hashKey);
-- tests/agentTokenHash.test.js reads this file and checks they match.
--
-- Works on MySQL 5.6+ and MariaDB 10.x (applied on MariaDB). Keep semicolons out of the
-- COMMENT strings above; some clients split statements on ';'.
UPDATE `agent_tokens`
   SET `approved_token_hash` = SHA2(`approved_token`, 256)
 WHERE `approved_token` IS NOT NULL
   AND `approved_token` <> '';

-- And now the point of the exercise: the readable copy stops existing.
ALTER TABLE `agent_tokens` DROP COLUMN `approved_token`;

-- ── Still plaintext after this ───────────────────────────────────────────
-- agent_tokens.token (the pending token) is unchanged here; see
-- 2026-08-25b_agent_pending_token_hash.sql.
