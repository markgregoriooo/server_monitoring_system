import crypto from "node:crypto";

// ─── Agent install-key format + usability rules (PURE) ──────────────────────────
//
// Imports nothing but node:crypto — no mysql, no influx, no .env — so backend/tests
// can exercise every rule with nothing running. Same contract as serverMetricUtils /
// historyRange / linkAlertPolicy / envPersistPolicy.
//
// An install key is the credential a Go agent presents ONCE, at enrollment
// (POST /api/agents/register). It is NOT the credential it posts metrics with — that is
// agent_tokens.approved_token, minted at approval. The enrolment records which key let
// it in (agent_tokens.install_key_id), so revoking a key can optionally de-authorise
// those servers too; that is a separate, opt-in step rather than an automatic
// consequence. See installKeyService.revoke and migrations/2026-08-15_agent_install_keys.sql.

// `AIK-` mirrors the `AGT-` prefix on approved agent tokens, so a credential's purpose
// is readable at a glance in a log line, a shell history or a support screenshot.
export const KEY_PREFIX = "AIK-";

// 24 random bytes = 192 bits, the same width as the approved agent token
// (agentService.approve). Far past guessable; the enrollment route is rate-limited
// anyway, but the entropy is what actually makes brute force irrelevant.
export const KEY_BYTES = 24;

// How much of the key the UI keeps in order to name it later. The plaintext is shown
// once and never again, so without this a list of keys would be a list of blanks.
// Short enough to leak nothing useful (12 of 52 chars).
export const DISPLAY_PREFIX_LEN = 12;

/** A fresh key. Returned to the admin exactly once — only its hash is persisted. */
export function generateKey() {
  return KEY_PREFIX + crypto.randomBytes(KEY_BYTES).toString("hex");
}

/**
 * SHA-256 hex of a key, for storage and for the enrollment lookup.
 *
 * NOT bcrypt/argon2, and that is deliberate. Those are slow ON PURPOSE to make
 * guessing a human-chosen password expensive. This value is 192 bits of CSPRNG output
 * — there is no dictionary to attack and nothing to slow down — while a slow hash
 * would force the enrollment path to read every key row and compare them one at a
 * time, because you cannot index a salted hash. SHA-256 keeps it to a single indexed
 * lookup and loses nothing.
 */
export function hashKey(key) {
  return crypto.createHash("sha256").update(String(key ?? ""), "utf8").digest("hex");
}

/** The stored display fragment for a key. */
export function prefixOf(key) {
  return String(key ?? "").slice(0, DISPLAY_PREFIX_LEN);
}

/** Shape check before touching the database — a malformed key can never match a row. */
export function looksLikeKey(v) {
  return typeof v === "string" && new RegExp(`^${KEY_PREFIX}[0-9a-f]{${KEY_BYTES * 2}}$`).test(v);
}

/**
 * Why a key cannot be used right now, or null when it can.
 *
 * Returns a REASON rather than a boolean so the enrollment log can say which of the
 * three states applied. "Invalid install key" covering revoked, expired and never-
 * existed alike is exactly the ambiguity that makes a failed rollout undebuggable —
 * the installer's operator sees one message, but the admin reading the server log
 * needs to know whether to un-revoke, extend, or issue a new key.
 */
export function keyRejection(row, now = new Date()) {
  if (!row) return "unknown";
  if (row.revoked_at != null) return "revoked";
  if (row.expires_at != null && new Date(row.expires_at).getTime() <= now.getTime()) return "expired";
  return null;
}

/** Convenience inverse of keyRejection, for call sites that only need yes/no. */
export function isUsable(row, now = new Date()) {
  return keyRejection(row, now) === null;
}

/** Lifecycle state for the admin list. Mirrors keyRejection, plus the healthy case. */
export function keyStatus(row, now = new Date()) {
  return keyRejection(row, now) ?? "active";
}

export default {
  KEY_PREFIX,
  KEY_BYTES,
  DISPLAY_PREFIX_LEN,
  generateKey,
  hashKey,
  prefixOf,
  looksLikeKey,
  keyRejection,
  isUsable,
  keyStatus,
};
