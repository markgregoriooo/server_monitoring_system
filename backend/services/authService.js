import db from "../config/mysql.js";
import jwt from "jsonwebtoken";
import permissionService from "./permissionService.js";
import policyService from "./policyService.js";
import { JWT_SECRET, JWT_SIGN_OPTS } from "../middleware/auth.js";
import { notFound } from "../utils/httpError.js";

const authService = {
  // Build + sign a JWT session for an already-resolved, ACTIVE user. The only
  // login path is Google (googleAuthService), which verifies identity + status
  // before calling this. Records last_login and writes an audit log row.
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
      // When this SESSION began, as opposed to when the current token was minted.
      // Carried unchanged across every sliding renewal so middleware/auth.js can cap
      // total session age — without it a renewed token looks brand new forever and
      // the sliding window has no ceiling. See maybeRenewToken.
      ist: Math.floor(Date.now() / 1000),
    };

    const token = jwt.sign(payload, JWT_SECRET, { ...JWT_SIGN_OPTS, expiresIn: "1h" });

    // Deliberately NOT in the signed payload. The token lives an hour, so a version
    // baked into it would still read "not accepted" for the rest of that hour after
    // the user accepts — the gate would refuse to go away. It rides on the user
    // OBJECT instead, which the client replaces the moment acceptance succeeds.
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

  // Record a DENIED sign-in attempt. issueSession above logs every SUCCESS, so
  // without this the trail only ever shows who got in — never who was turned
  // away (non-CSPC domain, unverified email, pending/rejected/disabled account,
  // failed token exchange), which is exactly what's worth reviewing on a campus
  // system. system_logs.user_id is nullable, so an attempt from an account we've
  // never seen still records, with the email preserved in the description.
  //
  // Callers treat this as best-effort: an audit-write failure must never turn a
  // clean "you're not allowed" into a 500.
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
      // Drives the acceptance gate. `policy_current` is what is in force NOW, so a
      // bumped POLICY_VERSION re-prompts every user at their next sign-in — which
      // is at most an hour away, since that is the JWT's lifetime.
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
