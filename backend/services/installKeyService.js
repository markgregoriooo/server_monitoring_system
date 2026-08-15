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

// ─── Agent install keys (DB half) ───────────────────────────────────────────────
//
// The format + usability rules live in installKeyUtils.js (pure, tested). This file
// is the MySQL side: mint, list, revoke, and the enrollment-path lookup.
//
// ⚠️ An install key authorises ENROLLMENT ONLY. Revoking one must never touch
// agent_tokens — the servers it enrolled keep reporting on their own approved_token.
// See migrations/2026-08-15_agent_install_keys.sql for the full reasoning.

function err(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ─── Legacy .env fallback ───────────────────────────────────────────────────────
// AGENT_INSTALL_KEY still works, because a fresh database has no keys AND no admin
// (the schema seeds neither), so requiring the UI to mint the first key would
// deadlock a first-time install. It is checked only AFTER the table misses, so a
// managed key always wins, and its use is logged loudly enough to prompt removal.

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
 * Returns { ok: true, keyId } — keyId is null for the legacy .env key, which has no
 * row to attribute the enrollment to — or { ok: false, reason }.
 *
 * `reason` is one of unknown | revoked | expired, so the server log can say WHICH.
 * The HTTP response stays a single generic message: an installer operator who can
 * see "revoked" vs "unknown" learns whether a key exists, which is not their business.
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
    // A key that exists but is revoked/expired must NOT fall through to the legacy
    // comparison — it has been explicitly withdrawn, and silently accepting it
    // because .env happens to hold the same string would defeat the revoke button.
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
 * Record that a key enrolled an agent. Best-effort and deliberately not awaited by
 * the caller: the counters are for the admin's benefit, and failing to bump one must
 * never fail an enrollment that already succeeded.
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
    useCount: Number(r.use_count ?? 0),
    // Whether the install command can be shown again. False for keys minted before the
    // key_cipher column existed, or while no encryption key was configured — the UI
    // hides the button rather than offering one that would fail.
    canReveal: Boolean(r.key_cipher),
  };
}

const BASE_SELECT = `
  SELECT k.*, c.name AS created_by_name, r.name AS revoked_by_name
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
 * Mint a key. The plaintext is returned HERE and nowhere else, ever — the caller
 * hands it to the admin once and only the hash is kept.
 *
 * expiresInDays is optional; null/absent means the key never expires. A bounded
 * rollout key is the safer default habit, but forcing an expiry on an admin who just
 * wants to add one server would be friction for no gain, so it stays opt-in.
 */
export async function create({ label, expiresInDays = null, userId = null }) {
  const name = String(label ?? "").trim();
  if (!name) throw err(400, "A label is required — it is how you tell keys apart later.");
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

  // Both, and they answer different questions. The HASH is what enrollment matches on —
  // one indexed lookup, and one-way so a leaked dump reveals nothing. The CIPHER is what
  // lets an admin re-open the install command later, which a hash can never do.
  //
  // Encryption is best-effort: with no key configured this stays NULL and the key simply
  // isn't re-viewable. Refusing to mint a key over a missing optional convenience would
  // be the wrong trade — enrollment is the feature, re-display is the nicety.
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
 * The servers this key enrolled that are STILL REPORTING — i.e. what would go dark if
 * the key were revoked with revokeAgents.
 *
 * Scoped to `status = 'approved'` on purpose: a pending enrollment has nothing to cut
 * off, and an already-revoked one is not going to break twice. This is what the revoke
 * dialog lists, because an admin must see the blast radius by NAME before confirming —
 * a count alone tells you how much breaks but not whether the production box is in it.
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
 * Revoke a key. Soft — the row stays so the audit trail keeps "this key existed,
 * enrolled 4 servers, and was withdrawn by X on Y". Deleting it would erase exactly
 * the history the feature exists to provide.
 *
 * `revokeAgents` also cuts off every server this key enrolled: their agent tokens go to
 * 'revoked', so the next metric POST 403s and the agent deletes its own agent.conf and
 * exits (see go-agent/cmd/agent/main.go). This is the branch model — one key per office,
 * revoke the key and that office's servers stop reporting.
 *
 * ⚠️ It is a SEPARATE, opt-in flag rather than an automatic consequence. Both meanings
 * are legitimate — "stop issuing this key" and "de-authorise everything it let in" — and
 * they differ by a whole fleet's worth of monitoring. Making it automatic would mean an
 * admin can never tidy up an old rollout key without taking servers dark, so in practice
 * they would stop revoking keys at all, which defeats the feature. The route makes the
 * caller state which one it means, and the UI names the servers before it happens.
 *
 * The device rows, their logs and their InfluxDB history are all kept: a revoked machine
 * re-enrols onto the same device_id (agentService.register), so this is reversible by
 * installing again with a live key.
 *
 * Returns null when there is no such key. Idempotent — re-revoking is not an error, and
 * still cuts off any agent that has since enrolled.
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
      // 'revoked', not 'rejected': the device row survives, so the machine keeps its id
      // and history and can re-enrol later. validateToken requires 'approved', so the
      // agent's very next POST gets a 403 and it shuts itself down.
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
 * Decrypt a key back to plaintext so the admin can re-open its install command.
 *
 * Returns { key, label } or null when there is no such key; { unavailable: true } when
 * the row predates key_cipher or no encryption key is configured.
 *
 * ⚠️ The ONLY path that ever returns a key after creation. It is admin-gated and the
 * route audits every call — reading a credential back is precisely the kind of action an
 * audit trail exists for, and it is the difference between "the key is recoverable" and
 * "the key is recoverable and nobody knows who looked".
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
    // GCM authentication failed: the ciphertext was written under a DIFFERENT encryption
    // key (SECRET_ENC_KEY added or changed after this row was created), or the column was
    // altered. Not recoverable, and not a server fault — say so plainly.
    console.error(`[install-keys] cannot decrypt key #${keyId}:`, e.message);
    return { unavailable: true };
  }
}

/**
 * Hard-delete a key. Only a REVOKED key can be deleted — revoke first, then delete.
 *
 * Two steps rather than one on purpose: revoking is the safety-critical decision (it can
 * take servers down), and folding it into a destructive "delete" would put that decision
 * behind a button whose label says nothing about it.
 *
 * Any enrolments this key made keep working: `agent_tokens.install_key_id` is
 * ON DELETE SET NULL, so those servers simply become unattributed — exactly like the
 * ones enrolled before install keys existed. They can be re-filed under another key by
 * re-running the installer with `-ReEnroll`.
 *
 * ⚠️ This is the one operation that loses history — "this key existed, enrolled 4
 * servers, was revoked by X" goes with the row. The audit entry in `system_logs` is what
 * survives, which is why the route writes one.
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
