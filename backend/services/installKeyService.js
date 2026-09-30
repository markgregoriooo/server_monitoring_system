import crypto from "node:crypto";
import db from "../config/mysql.js";
import secretCrypto from "./secretCrypto.js";
import {
  generateKey,
  hashKey,
  prefixOf,
  looksLikeKey,
  keyRejection,
  keyStatus,
} from "./installKeyUtils.js";

// ─── Agent install keys (database side) ───────────────────────────────────────────────
// Format and usability rules are in installKeyUtils.js (tested). This file creates,
// lists and revokes keys and does the enrollment lookup. A key only allows
// enrollment; revoking it does not affect enrolled servers unless revokeAgents is
// set. See migrations/2026-08-15_agent_install_keys.sql.

function err(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ─── Legacy .env fallback ───────────────────────────────────────────────────────
// AGENT_INSTALL_KEY still works, because a fresh database has no keys and no admin
// to create one. It is only checked after the table has no match, so a managed key
// always wins, and each use is logged as a warning.

export function legacyEnvKey() {
  return (process.env.AGENT_INSTALL_KEY ?? "").trim();
}

/** Whether the deprecated .env key is still configured. Not surfaced in the UI — the
 *  console warning on each use is the reminder. Kept for a startup check or a diagnostic. */
export function legacyEnvKeyActive() {
  return legacyEnvKey().length > 0;
}

// Constant-time compare, kept from the original routes/agents.js implementation.
// Lengths are compared first because timingSafeEqual throws on a length mismatch.
function matchesLegacyKey(provided) {
  const expected = legacyEnvKey();
  if (!expected || typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── Enrollment lookup (the hot path) ───────────────────────────────────────────

/**
 * Resolve a key presented at enrollment.
 *
 * Returns { ok: true, keyId } (keyId is null for the legacy .env key) or
 * { ok: false, reason }. `reason` is unknown | revoked | expired, for the server
 * log; the HTTP response stays generic.
 */
export async function resolveKey(provided) {
  if (looksLikeKey(provided)) {
    const [[row]] = await db.query(
      `SELECT install_key_id, revoked_at, expires_at
         FROM agent_install_keys
        WHERE key_hash = ?
        LIMIT 1`,
      [hashKey(provided)],
    );
    const rejection = keyRejection(row);
    if (!rejection) return { ok: true, keyId: row.install_key_id };
    // A revoked or expired key must not fall through to the .env comparison, or a
    // matching .env value would undo the revoke.
    if (row) return { ok: false, reason: rejection };
  }

  if (matchesLegacyKey(provided)) {
    console.warn(
      "[install-keys] enrollment used the legacy AGENT_INSTALL_KEY from .env — " +
        "create a managed key in Server Metrics and remove the .env value.",
    );
    return { ok: true, keyId: null, legacy: true };
  }

  return { ok: false, reason: "unknown" };
}

/**
 * Record that a key enrolled an agent. Not awaited by the caller: a failed counter
 * update must not fail an enrollment that already succeeded.
 */
export function noteUsed(keyId) {
  if (keyId == null) return;
  db.query(
    `UPDATE agent_install_keys
        SET use_count = use_count + 1, last_used_at = NOW()
      WHERE install_key_id = ?`,
    [keyId],
  ).catch((e) => console.error("[install-keys] usage bump failed:", e.message));
}

// ─── Admin CRUD ─────────────────────────────────────────────────────────────────

function toClient(r, now = new Date()) {
  const iso = (v) => (v instanceof Date ? v.toISOString() : v);
  return {
    id: r.install_key_id,
    label: r.label,
    // The plaintext is gone; this is all the UI can show of the key itself.
    keyPrefix: r.key_prefix,
    status: keyStatus(r, now), // active | revoked | expired
    createdBy: r.created_by ?? null,
    createdByName: r.created_by_name ?? null,
    revokedByName: r.revoked_by_name ?? null,
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
    revokedAt: iso(r.revoked_at),
    lastUsedAt: iso(r.last_used_at),
    // Servers enrolled with this key that STILL EXIST — derived per read (see BASE_SELECT).
    // This is what the UI labels "Enrolled", and it falls when a server is removed.
    enrolledCount: Number(r.enrolled_count ?? 0),
    // Total times this key was used. Only goes up, so it is not what "Enrolled" shows.
    useCount: Number(r.use_count ?? 0),
    // Whether the install command can be shown again. False for keys created before
    // key_cipher existed or while no encryption key was configured.
    canReveal: Boolean(r.key_cipher),
  };
}

// `enrolled_count` is counted from agent_tokens on every read, not taken from
// use_count (which never goes down, so it kept counting removed servers). Deleting
// a server cascades to its token. status='approved' matches what enrolledServers()
// lists in the revoke dialog. Uses idx_agent_tokens_install_key.
const BASE_SELECT = `
  SELECT k.*, c.name AS created_by_name, r.name AS revoked_by_name,
         (SELECT COUNT(*)
            FROM agent_tokens t
           WHERE t.install_key_id = k.install_key_id
             AND t.status = 'approved') AS enrolled_count
    FROM agent_install_keys k
    LEFT JOIN users c ON c.user_id = k.created_by
    LEFT JOIN users r ON r.user_id = k.revoked_by`;

// Newest first, but usable keys ahead of dead ones — the list exists to answer
// "what do I paste into the installer right now", and that answer should be on top.
export async function list() {
  const [rows] = await db.query(
    `${BASE_SELECT}
      ORDER BY (k.revoked_at IS NOT NULL), k.created_at DESC`,
  );
  const now = new Date();
  return rows.map((r) => toClient(r, now));
}

/**
 * Create a key. The plaintext is returned only here, once; only the hash is kept.
 * expiresInDays is optional; null means it never expires.
 */
export async function create({ label, expiresInDays = null, userId = null }) {
  // The label is optional; the dashboard names keys by prefix and dates. The column
  // is NOT NULL and the audit log refers to keys by label, so a default is stored.
  const name = String(label ?? "").trim() || `Issued ${new Date().toISOString().slice(0, 10)}`;
  if (name.length > 100) throw err(400, "Label must be 100 characters or fewer.");

  let expiresAt = null;
  if (expiresInDays != null && expiresInDays !== "") {
    const days = Number(expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw err(400, "Expiry must be a whole number of days between 1 and 3650.");
    }
    expiresAt = new Date(Date.now() + days * 86_400_000);
  }

  const key = generateKey();

  // The hash is what enrollment looks up (one indexed query, one-way). The encrypted
  // copy lets an admin reopen the install command later. With no encryption key
  // configured the cipher is NULL and the key just cannot be shown again.
  let cipher = null;
  try {
    if (secretCrypto.isConfigured()) cipher = secretCrypto.encrypt(key);
    else console.warn("[install-keys] no SECRET_ENC_KEY/MIKROTIK_ENC_KEY — key will not be re-viewable");
  } catch (e) {
    console.error("[install-keys] could not encrypt key for re-display:", e.message);
  }

  const [ins] = await db.query(
    `INSERT INTO agent_install_keys (key_hash, key_cipher, key_prefix, label, expires_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [hashKey(key), cipher, prefixOf(key), name, expiresAt, userId],
  );

  const [[row]] = await db.query(`${BASE_SELECT} WHERE k.install_key_id = ?`, [ins.insertId]);
  return { key, record: toClient(row) };
}

/**
 * Servers this key enrolled that are still reporting, i.e. what stops if the key
 * is revoked with revokeAgents. Only status 'approved': pending ones have nothing
 * to cut off, revoked ones are already off. Listed by name in the revoke dialog.
 */
export async function enrolledServers(id) {
  const keyId = Number(id);
  if (!Number.isInteger(keyId)) throw err(400, "Invalid key id.");
  const [rows] = await db.query(
    `SELECT d.device_id AS id,
            COALESCE(NULLIF(d.display_name, ''), d.device_name) AS name,
            d.ip_address AS ip, d.status
       FROM agent_tokens t
       JOIN devices d ON d.device_id = t.device_id
      WHERE t.install_key_id = ? AND t.status = 'approved'
      ORDER BY d.device_name`,
    [keyId],
  );
  return rows;
}

/**
 * Revoke a key. The row is kept so the audit history stays ("this key enrolled 4
 * servers and was revoked by X").
 *
 * `revokeAgents` also revokes every server this key enrolled: their next metric
 * POST gets 403 and the agent removes its agent.conf and exits
 * (agent/cmd/agent/main.go). One key per office means revoking it stops that
 * office's servers. It is a separate flag so an admin can retire an old key
 * without taking servers offline.
 *
 * Devices, logs and InfluxDB history are kept; reinstalling with a valid key puts
 * the machine back on the same device_id.
 *
 * Returns null when there is no such key. Revoking again is not an error and still
 * revokes any agent enrolled since.
 */
export async function revoke(id, userId = null, { revokeAgents = false } = {}) {
  const keyId = Number(id);
  if (!Number.isInteger(keyId)) throw err(400, "Invalid key id.");

  const [[existing]] = await db.query(
    `SELECT install_key_id, label, revoked_at FROM agent_install_keys WHERE install_key_id = ?`,
    [keyId],
  );
  if (!existing) return null;

  if (existing.revoked_at == null) {
    await db.query(
      `UPDATE agent_install_keys SET revoked_at = NOW(), revoked_by = ? WHERE install_key_id = ?`,
      [userId, keyId],
    );
  }

  // Read the affected servers BEFORE flipping their tokens — afterwards they no longer
  // match `status = 'approved'` and the caller would have nothing to report or broadcast.
  let cutOff = [];
  if (revokeAgents) {
    cutOff = await enrolledServers(keyId);
    if (cutOff.length) {
      const ids = cutOff.map((s) => s.id);
      const marks = ids.map(() => "?").join(",");
      // 'revoked', not 'rejected': the device row stays, so the machine keeps its id and
      // history. validateToken needs 'approved', so the agent's next POST gets 403.
      await db.query(
        `UPDATE agent_tokens SET status = 'revoked' WHERE install_key_id = ? AND status = 'approved'`,
        [keyId],
      );
      // The server is no longer reporting and never will on this token — leaving it
      // 'online' would show a dead host as healthy on any page reading devices.status.
      await db.query(
        `UPDATE devices SET status = 'offline', updated_at = NOW() WHERE device_id IN (${marks})`,
        ids,
      );
    }
  }

  const [[row]] = await db.query(`${BASE_SELECT} WHERE k.install_key_id = ?`, [keyId]);
  return { ...toClient(row), cutOff };
}

/**
 * Decrypt a key so the admin can reopen its install command.
 *
 * Returns { key, label }, null when there is no such key, or { unavailable: true }
 * when the row has no cipher or no encryption key is configured. The only way to
 * see a key after creation; admin-only and audited by the route.
 */
export async function reveal(id) {
  const keyId = Number(id);
  if (!Number.isInteger(keyId)) throw err(400, "Invalid key id.");

  const [[row]] = await db.query(
    `SELECT label, key_prefix, key_cipher, revoked_at
       FROM agent_install_keys WHERE install_key_id = ?`,
    [keyId],
  );
  if (!row) return null;
  if (!row.key_cipher || !secretCrypto.isConfigured()) return { unavailable: true };

  try {
    return {
      key: secretCrypto.decrypt(row.key_cipher),
      label: row.label,
      revoked: row.revoked_at != null,
    };
  } catch (e) {
    // GCM authentication failed: the row was encrypted with a different key
    // (SECRET_ENC_KEY changed) or the column was altered. Not recoverable.
    console.error(`[install-keys] cannot decrypt key #${keyId}:`, e.message);
    return { unavailable: true };
  }
}

/**
 * Permanently delete a key. Only a revoked key can be deleted, so the risky step
 * (revoking) is never hidden behind "delete".
 *
 * Servers it enrolled keep working: agent_tokens.install_key_id is ON DELETE SET
 * NULL, so they just become unattributed. They can be re-filed under another key
 * with the installer's `-ReEnroll`. The route writes an audit entry, since the row
 * itself is gone.
 *
 * Returns null when there is no such key, or { blocked: true } when it is still active.
 */
export async function remove(id) {
  const keyId = Number(id);
  if (!Number.isInteger(keyId)) throw err(400, "Invalid key id.");

  const [[row]] = await db.query(
    `SELECT install_key_id, label, key_prefix, use_count, revoked_at
       FROM agent_install_keys WHERE install_key_id = ?`,
    [keyId],
  );
  if (!row) return null;
  if (row.revoked_at == null) return { blocked: true };

  await db.query(`DELETE FROM agent_install_keys WHERE install_key_id = ?`, [keyId]);
  return { label: row.label, keyPrefix: row.key_prefix, useCount: Number(row.use_count ?? 0) };
}

export default {
  resolveKey,
  noteUsed,
  list,
  create,
  revoke,
  reveal,
  remove,
  enrolledServers,
  legacyEnvKeyActive,
};
