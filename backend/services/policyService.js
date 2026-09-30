import db from "../config/mysql.js";
import { audit } from "./auditService.js";
import { notFound } from "../utils/httpError.js";

/**
 * Privacy Notice & Terms of Use acceptance.
 *
 * The text is in the frontend (pages/legal/PrivacyTerms.tsx). This service holds the
 * current version and the record of who accepted it. The version is a constant, not
 * a table row, so the gate cannot be switched off by editing data.
 */

// Bump this when the notice's content changes (new data collected, new recipient,
// different retention). Everyone is then asked again. Do not bump it for typo
// fixes. Date-based so the matching text can be found in git.
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
   * Record acceptance of the current version. The version always comes from the
   * server, never from the request. The audit row is the evidence, so unlike other
   * audit writes this one is not best-effort: both writes are one transaction, and a
   * failure leaves the user un-accepted.
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
   * Clear every stored acceptance so everyone accepts again at their next page load.
   * Not exposed over HTTP; for a future migration that bumps POLICY_VERSION.
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
