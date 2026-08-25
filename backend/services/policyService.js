import db from "../config/mysql.js";
import { audit } from "./auditService.js";
import { notFound } from "../utils/httpError.js";

/**
 * Privacy Notice & Terms of Use acceptance.
 *
 * The document itself lives in the frontend (pages/legal/PrivacyTerms.tsx) — it is
 * prose, and git history is its version trail. This service owns the two things
 * that must be server-side to mean anything: the CURRENT version, and the record
 * of who accepted it.
 *
 * Why the version is a constant here and not a column: the acceptance gate has to
 * compare "what you accepted" against "what is in force", and the second half has
 * to come from somewhere the user cannot influence. A row in a table an admin can
 * edit would let the gate be silenced by accident.
 */

// Bump this whenever the notice's SUBSTANCE changes — new data collected, a new
// recipient, a different retention period. Every user is then prompted once more,
// because their stored policy_version no longer matches. Do NOT bump it for typo
// fixes: a re-prompt that says nothing new trains people to click through.
// Date-based so "which text did they agree to" is answerable from the git log.
const POLICY_VERSION = "2026-08-11";

const policyService = {
  POLICY_VERSION,

  /** What the user last accepted + what is currently in force. */
  async getAcceptance(userId) {
    const [rows] = await db.query(
      `SELECT policy_version, policy_accepted_at FROM users WHERE user_id = ? LIMIT 1`,
      [userId],
    );
    const row = rows[0] ?? {};
    return {
      policy_version: row.policy_version ?? null,
      policy_accepted_at: row.policy_accepted_at ?? null,
      policy_current: POLICY_VERSION,
    };
  },

  /**
   * Record acceptance of the version currently in force.
   *
   * The version written is ALWAYS the server's constant, never a value from the
   * request body — a client that could name its own version could claim to have
   * accepted a document that was never shown to it.
   *
   * Unlike most audit writes in this codebase, this one is NOT best-effort: the
   * audit row IS the evidence. If it cannot be written we would be storing
   * "accepted" with nothing to back it up, so the whole thing is one transaction
   * and a failure leaves the user un-accepted and re-prompted.
   */
  async accept(userId, { ip = null, userAgent = null } = {}) {
    const [rows] = await db.query(
      `SELECT user_id, username FROM users WHERE user_id = ? LIMIT 1`,
      [userId],
    );
    if (rows.length === 0) throw notFound("User not found.");
    const user = rows[0];

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(
        `UPDATE users SET policy_version = ?, policy_accepted_at = NOW() WHERE user_id = ?`,
        [POLICY_VERSION, userId],
      );

      await conn.query(
        `INSERT INTO system_logs
           (user_id, module, action, description, ip_address, user_agent, log_level, created_at)
         VALUES (?, 'auth', 'policy_accepted', ?, ?, ?, 'info', NOW())`,
        [
          userId,
          `User ${user.username} accepted the Privacy Notice & Terms of Use (version ${POLICY_VERSION})`,
          ip,
          userAgent,
        ],
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    return { policy_version: POLICY_VERSION, policy_current: POLICY_VERSION };
  },

  /**
   * Clear every stored acceptance — forces the whole organisation to re-accept on
   * their next page load. Not exposed over HTTP on purpose; it is here so a future
   * migration that bumps POLICY_VERSION has a documented way to reset alongside it.
   */
  async resetAll() {
    const [res] = await db.query(
      `UPDATE users SET policy_version = NULL, policy_accepted_at = NULL
        WHERE policy_version IS NOT NULL`,
    );
    await audit({
      module: "auth",
      action: "policy_reset",
      description: `Cleared ${res.affectedRows} policy acceptance(s) — all users will be re-prompted`,
      level: "warning",
    });
    return res.affectedRows;
  },
};

export default policyService;
