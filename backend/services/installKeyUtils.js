import crypto from "node:crypto";

// ─── Agent install-key format and usability rules ──────────────────────────
// Only imports node:crypto, so backend/tests can run it. An install key is used once,
// at enrollment (POST /api/agents/register); metrics are sent with the agent token
// issued at approval. agent_tokens.install_key_id records which key enrolled each
// server. See installKeyService.revoke and migrations/2026-08-15_agent_install_keys.sql.

// `AIK-` mirrors the `AGT-` prefix on approved agent tokens, so a credential's purpose
// is readable at a glance in a log line, a shell history or a support screenshot.
export const KEY_PREFIX = "AIK-";

// 24 random bytes (192 bits), the same size as the agent token. Cannot be guessed.
export const KEY_BYTES = 24;

// How much of the key is kept to identify it in the list (12 of 52 characters);
// the full key is only shown once.
export const DISPLAY_PREFIX_LEN = 12;

/** A fresh key. Returned to the admin exactly once — only its hash is persisted. */
export function generateKey() {
  return KEY_PREFIX + crypto.randomBytes(KEY_BYTES).toString("hex");
}

/**
 * SHA-256 hex of a key, for storage and lookup. Not bcrypt: the key is 192 random
 * bits, so there is nothing for a slow hash to protect, and a salted hash could not
 * be looked up with an index.
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
 * Why a key cannot be used right now, or null when it can. Returns the reason
 * (unknown / revoked / expired) so the server log tells the admin whether to
 * un-revoke, extend or issue a new key.
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
