-- Stop storing the agent's pending token in readable form.
--
-- Run 2026-08-25_agent_token_hash.sql first; this completes it.
--
-- ── Why it matters ──────────────────────────────────────────────
--
-- The pending token can be exchanged for the permanent one:
--
--     POST /api/agents/status  { "pending_token": "<48 hex chars>" }
--       → { "status": "approved", "approved_token": "AGT-…" }
--
-- That works repeatedly after approval and needs no login, so a plaintext pending token
-- in the database dump was as good as the permanent token.
--
-- ── Why it can be hashed now ───────────────────────────
--
-- register() used to hand the same pending token back to a returning machine, which a
-- hash cannot do. Now it issues a fresh pending token on every registration. Nothing
-- depends on the old one: the agent only keeps it in memory during registration.Run and
-- never writes it to agent.conf. Recovery still requires a valid AIK- install key.
-- SHA-256 (installKeyUtils.hashKey), as for the other tokens.
--
-- One-time effect: an enrollment that is pending right now can no longer poll; re-run the
-- installer on that machine. Approved agents are not affected.

-- ── On the name ─────────────────────────────────────────────────────────────────────
-- `pending_token_hash`, matching `approved_token_hash` and the names the code and the Go
-- agent already use (pendingToken, getStatusByPendingToken, pending_token).
--
-- If you applied an earlier draft that created `token_hash`, run:
--     ALTER TABLE `agent_tokens` CHANGE `token_hash` `pending_token_hash` char(64) DEFAULT NULL;
--     ALTER TABLE `agent_tokens` DROP INDEX `uq_agent_tokens_token_hash`,
--       ADD UNIQUE INDEX `uq_agent_tokens_pending_hash` (`pending_token_hash`);

ALTER TABLE `agent_tokens`
  ADD COLUMN `pending_token_hash` char(64) DEFAULT NULL
    COMMENT 'SHA-256 hex of the pending enrollment token — the lookup path for POST /agents/status'
    AFTER `token`,
  ADD UNIQUE INDEX `uq_agent_tokens_pending_hash` (`pending_token_hash`);

-- Fill before dropping, so an agent mid-approval keeps working. SHA2(x, 256) matches
-- Node's crypto.createHash("sha256").digest("hex"), as tests/agentTokenHash.test.js checks
-- for the approved token.
UPDATE `agent_tokens`
   SET `pending_token_hash` = SHA2(`token`, 256)
 WHERE `token` IS NOT NULL AND `token` <> '';

-- The readable copy stops existing. Its UNIQUE index goes with the column.
ALTER TABLE `agent_tokens` DROP COLUMN `token`;

-- After this, `agent_tokens` holds no readable credential:
--   pending_token_hash     SHA-256   — pending token, lookup only
--   approved_token_hash    SHA-256   — permanent token, lookup only
--   approved_token_cipher  AES-GCM   — permanent token, only readable with the key
--                                      in backend/.env (not in the database or backup)
