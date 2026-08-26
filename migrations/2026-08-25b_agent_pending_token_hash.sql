-- Stop storing the agent's PENDING token in readable form.
--
-- ⚠️ Run 2026-08-25_agent_token_hash.sql first. This is its second half, and without it
-- that migration's protection is largely undone — see below.
--
-- ── WHY THIS MATTERS MORE THAN IT LOOKS ──────────────────────────────────────────────
--
-- The earlier migration hashed `approved_token` so that a stolen database dump would
-- yield nothing usable. It did not finish the job, because `agent_tokens.token` — the
-- short "pending" token issued at registration — was still plaintext, and that token can
-- be exchanged for the real credential:
--
--     POST /api/agents/status  { "pending_token": "<48 hex chars>" }
--       → { "status": "approved", "approved_token": "AGT-…" }
--
-- Three things make that worse than the "claim ticket" it looks like, all verified
-- against the running system rather than assumed:
--
--   1. It keeps working AFTER approval. `getStatusByPendingToken` decrypts
--      `approved_token_cipher` on every call, so the exchange is repeatable forever —
--      not a one-time collection.
--   2. `POST /api/agents/status` has NO authentication and NO rate limiter (only
--      /register carried `enrollLimiter`).
--   3. So the pending token is not lower-value than the permanent one. It is the
--      permanent one, one unauthenticated HTTP call away.
--
-- Net effect: the unencrypted `mysqldump` that `ops/db-backup` writes to removable media
-- contained, for every server, a plaintext string convertible into that server's live
-- metric-posting credential. Hashing `approved_token` alone did not close that.
--
-- ── WHY HASHING IT IS NOW POSSIBLE, WHEN IT WASN'T BEFORE ───────────────────────────
--
-- The reason this was deferred is that `register()` handed the SAME pending token back
-- to a returning machine, and you cannot hand back a hash. That constraint dissolves by
-- changing one thing: **issue a FRESH pending token on every registration.**
--
-- Nothing depends on it being stable. The agent holds it only in memory for the duration
-- of `registration.Run` (agent/internal/registration/register.go) and discards it once it
-- has the AGT- token — it is never written to agent.conf. So a returning machine simply
-- uses whichever token it was just given.
--
-- Recovery is unaffected, and is still gated where it should be: a machine that lost its
-- agent.conf must call /register, which requires a valid `AIK-` install key. The install
-- key is the authorisation to re-collect; the pending token is just the ticket for that
-- one exchange. The ADOPT workflow (moving a server onto another branch's key) goes
-- through the same call and is likewise unaffected.
--
-- SHA-256 for the same reason as everywhere else here: the value is 24 bytes of CSPRNG
-- output, so there is no dictionary for a slow hash to defend against, and the lookup
-- must stay a single indexed comparison. `installKeyUtils.hashKey` is reused.
--
-- ⚠️ ONE-TIME EFFECT: any enrolment currently sitting PENDING will stop being able to
-- poll, because the plaintext it holds no longer matches. Re-run the installer on that
-- machine. Approved agents are COMPLETELY unaffected — they authenticate with the AGT-
-- token and never touch this column again.

-- ── ON THE NAME ─────────────────────────────────────────────────────────────────────
-- `pending_token_hash`, not `token_hash`. Beside `approved_token_hash`, a bare
-- `token_hash` reads as "the token" versus "the approved token" — implying the first is
-- the generic, lesser one. That is precisely the misreading that got this credential
-- underrated in the first place. The two names should look like what they are: two halves
-- of one lifecycle. It also matches the vocabulary everything else already uses —
-- `pendingToken` in agentService, `getStatusByPendingToken`, and `pending_token` in the
-- JSON the Go agent actually sends.
--
-- ⚠️ If you applied an earlier draft of this file that created `token_hash`, run:
--     ALTER TABLE `agent_tokens` CHANGE `token_hash` `pending_token_hash` char(64) DEFAULT NULL;
--     ALTER TABLE `agent_tokens` DROP INDEX `uq_agent_tokens_token_hash`,
--       ADD UNIQUE INDEX `uq_agent_tokens_pending_hash` (`pending_token_hash`);

ALTER TABLE `agent_tokens`
  ADD COLUMN `pending_token_hash` char(64) DEFAULT NULL
    COMMENT 'SHA-256 hex of the pending enrollment token — the lookup path for POST /agents/status'
    AFTER `token`,
  ADD UNIQUE INDEX `uq_agent_tokens_pending_hash` (`pending_token_hash`);

-- Backfill before dropping, so a pending agent mid-approval keeps working across the
-- migration itself. MariaDB/MySQL SHA2(x, 256) is byte-identical to Node's
-- crypto.createHash("sha256").digest("hex") — the same contract
-- tests/agentTokenHash.test.js pins for the approved token.
UPDATE `agent_tokens`
   SET `pending_token_hash` = SHA2(`token`, 256)
 WHERE `token` IS NOT NULL AND `token` <> '';

-- The readable copy stops existing. Its UNIQUE index goes with the column.
ALTER TABLE `agent_tokens` DROP COLUMN `token`;

-- After this, `agent_tokens` holds NO readable credential at all:
--   pending_token_hash     SHA-256   — pending token, lookup only
--   approved_token_hash    SHA-256   — permanent token, lookup only
--   approved_token_cipher  AES-GCM   — permanent token, recoverable only with the key
--                                      in backend/.env, which is not in the database
--                                      and not in the backup
