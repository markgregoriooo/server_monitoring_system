import db from "../config/mysql.js";
import jwt from "jsonwebtoken";
import permissionService from "./permissionService.js";
import policyService from "./policyService.js";
import { JWT_SECRET, JWT_SIGN_OPTS } from "../middleware/auth.js";
import { notFound } from "../utils/httpError.js";

const authService = {
  // Sign a JWT session for an active user. Only called by googleAuthService after it
  // has checked identity and status. Records last_login and an audit row.
  async issueSession(user, { ip = null, userAgent = null } = {}) {
    const permissions = await permissionService.getPermissionsByRole(user.role);

    const payload = {
      id: user.user_id,
      name: user.name,
      username: user.username,
      email: user.email,
      role: user.role,
      profile_image: user.profile_image,
      permissions: permissions ?? [],
      tv: user.token_version ?? 0,   // F-02: session-revocation version
      // When the session started (not when this token was issued). Kept across renewals
      // so middleware/auth.js can cap the total session age.
      ist: Math.floor(Date.now() / 1000),
    };

    const token = jwt.sign(payload, JWT_SECRET, { ...JWT_SIGN_OPTS, expiresIn: "1h" });

    // Not in the token: a token lasts an hour, so the old version would keep the gate
    // up after the user accepts. It is on the user object, which the client replaces
    // as soon as acceptance succeeds.
    const policy = await policyService.getAcceptance(user.user_id);

    await db.query(`UPDATE users SET last_login = NOW() WHERE user_id = ?`, [user.user_id]);
    await db.query(
      `INSERT INTO system_logs
         (user_id, module, action, description, ip_address, user_agent, log_level, created_at)
       VALUES (?, 'auth', 'login', ?, ?, ?, 'info', NOW())`,
      [user.user_id, `User ${user.username} logged in via Google`, ip, userAgent],
    );

    return { token, user: { ...payload, permissions, ...policy } };
  },

  // Record a denied sign-in (other domain, unverified email, pending/rejected/disabled
  // account, failed code exchange), so the audit log shows who was turned away and
  // not just who got in. user_id may be NULL; the email goes in the description.
  // Callers treat it as best-effort.
  async recordSignInDenied({
    email = null,
    reason = "denied",
    userId = null,
    ip = null,
    userAgent = null,
  } = {}) {
    await db.query(
      `INSERT INTO system_logs
         (user_id, module, action, description, ip_address, user_agent, log_level, created_at)
       VALUES (?, 'auth', 'login_denied', ?, ?, ?, 'warning', NOW())`,
      [
        userId,
        `Google sign-in denied (${reason}) for ${email ?? "unknown account"}`,
        ip,
        userAgent,
      ],
    );
    return true;
  },

  // GET CURRENT USER (for /me route)
  async getMe(userId) {
    const [rows] = await db.query(
      `SELECT user_id, name, username, email, role, status,
              profile_image, avatar, last_login, created_at,
              policy_version, policy_accepted_at
       FROM users WHERE user_id = ? LIMIT 1`,
      [userId],
    );

    if (rows.length === 0) {
      throw notFound("User not found.");
    }

    const user = rows[0];

    const permissions = await permissionService.getPermissionsByRole(user.role);

    return {
      id: user.user_id,
      name: user.name,
      username: user.username,
      email: user.email,
      role: user.role,
      status: user.status,
      profile_image: user.profile_image,
      avatar: user.avatar,
      last_login: user.last_login,
      created_at: user.created_at,
      permissions,
      // Drives the acceptance gate. `policy_current` is the version in force now, so
      // bumping POLICY_VERSION asks everyone again at their next sign-in.
      policy_version: user.policy_version ?? null,
      policy_accepted_at: user.policy_accepted_at ?? null,
      policy_current: policyService.POLICY_VERSION,
    };
  },
  async logout(userId, { ip = null, userAgent = null } = {}) {
    // Verify user still exists before logging
    const [rows] = await db.query(
      `SELECT user_id, username FROM users WHERE user_id = ? LIMIT 1`,
      [userId],
    );

    if (rows.length === 0) {
      throw notFound("User not found.");
    }

    const user = rows[0];

    // F-02: invalidate the current token so the JWT can't be reused after logout.
    await db.query(
      "UPDATE users SET token_version = token_version + 1 WHERE user_id = ?",
      [userId],
    );

    // Record logout in system_logs for audit trail
    await db.query(
      `INSERT INTO system_logs
       (user_id, module, action, description, ip_address, user_agent, log_level, created_at)
     VALUES (?, 'auth', 'logout', ?, ?, ?, 'info', NOW())`,
      [user.user_id, `User ${user.username} logged out`, ip, userAgent],
    );

    return true;
  },
};

export default authService;
