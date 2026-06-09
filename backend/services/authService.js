import db from "../config/mysql.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import permissionService from "./permissionService.js";
import { JWT_SECRET } from "../middleware/auth.js";

const authService = {
  // login
  async login({ email, password, ip = null, userAgent = null }) {
    if (!email || !password) {
      throw new Error("Email and password are required.");
    }

    // Get user from DB (login identifier is email, normalized lowercase)
    const [rows] = await db.query(
      `SELECT * FROM users WHERE email = ?  LIMIT 1`,
      [email.trim().toLowerCase()],
    );

    if (rows.length === 0) {
      throw new Error("Invalid email or password.");
    }

    const user = rows[0];

    if (!user.hash_password) {
      throw new Error("User password not set in database.");
    }

    // compare pass — verify BEFORE revealing anything account-specific so an
    // attacker can't enumerate which emails are disabled accounts (F-06).
    const valid = await bcrypt.compare(password, user.hash_password);

    if (!valid) {
      throw new Error("Invalid email or password.");
    }

    // check account status (only after a correct password)
    if (user.status === "inactive") {
      throw new Error("Your account has been disabled.");
    }

    // get permissions from role
    const permissions = await permissionService.getPermissionsByRole(user.role);

    // create payload
    const payload = {
      id: user.user_id,
      name: user.name,
      username: user.username,
      email: user.email,
      role: user.role,
      profile_image: user.profile_image,
      permissions: permissions ?? [],
      tv: user.token_version ?? 0,   // F-02: session-revocation version
    };

    // generate token
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "1h" });

    // Update last_login + write audit log
    await db.query(`UPDATE users SET last_login = NOW() WHERE user_id = ?`, [
      user.user_id,
    ]);
    await db.query(
      `INSERT INTO system_logs
         (user_id, module, action, description, ip_address, user_agent, log_level, created_at)
       VALUES (?, 'auth', 'login', ?, ?, ?, 'info', NOW())`,
      [user.user_id, `User ${user.username} logged in`, ip, userAgent],
    );

    return {
      token,
      user: {
        ...payload,
        permissions,
      },
    };
  },

  // GET CURRENT USER (for /me route)
  async getMe(userId) {
    const [rows] = await db.query(
      `SELECT user_id, name, username, email, role, status,
              profile_image, avatar, last_login, created_at
       FROM users WHERE user_id = ? LIMIT 1`,
      [userId],
    );

    if (rows.length === 0) {
      throw new Error("User not found.");
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
    };
  },
  async logout(userId, { ip = null, userAgent = null } = {}) {
    // Verify user still exists before logging
    const [rows] = await db.query(
      `SELECT user_id, username FROM users WHERE user_id = ? LIMIT 1`,
      [userId],
    );

    if (rows.length === 0) {
      throw new Error("User not found.");
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
