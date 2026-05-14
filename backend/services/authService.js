import db from "../config/mysql.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import permissionService from "./permissionService.js";
import { JWT_SECRET } from "../middleware/auth.js";

const authService = {
  // login
  async login({ username, password }) {
    if (!username || !password) {
      throw new Error("Username and password are required.");
    }

    // Get user from DB
    const [rows] = await db.query(
      `SELECT * FROM users WHERE username = ?  LIMIT 1`,
      [username],
    );

    if (rows.length === 0) {
      throw new Error("Invalid username or password.");
    }

    const user = rows[0];

    if (!user.hash_password) {
      throw new Error("User password not set in database.");
    }

    // check account status
    if (user.status === "inactive") {
      throw new Error("Your account has been disabled.");
    }

    // compare pass
    const valid = await bcrypt.compare(password, user.hash_password);

    if (!valid) {
      throw new Error("Invalid username or password.");
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
    };

    // generate token
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "1h" });

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
      `SELECT user_id, name, username, email, role, status
       FROM users WHERE user_id = ?`,
      [userId],
    );

    if (rows.length === 0) {
      throw new Error("User not found.");
    }

    const user = rows[0];

    const permissions = await permissionService.getPermissionsByRole(user.role);

    return {
      ...user,
      permissions,
    };
  },
};

export default authService;
