import db from "../config/mysql.js";
import bcrypt from "bcryptjs";

const userService = {
  
  // GET ALL USERS
  async getAllUsers() {
    const [rows] =
      await db.query(` SELECT user_id AS id, name, username, email, role, status,
      profile_image,
      created_at,
      updated_at,
      last_login
      FROM users ORDER BY user_id DESC
    `);
    return rows.map(({ hash_password, ...user }) => user);
  },

  // GET USER BY ID
  async getUserById(id) {
    const [rows] = await db.query("SELECT * FROM users WHERE user_id = ?", [
      id,
    ]);

    if (rows.length === 0) return null;

    const { hash_password, ...user } = rows[0];
    return user;
  },

  // CREATE USER -admin
  async createUser(data) {
    const { name, username, email, password, role, status = "active" } = data;

    if (!name || !username || !email || !password || !role) {
      throw new Error(
        "Name, username, email, password, and role are required.",
      );
    }

    const validRoles = ["admin", "it_staff"];
    if (!validRoles.includes(role)) {
      throw new Error("Invalid role.");
    }

    // check duplicate email
    const [existing] = await db.query(
      "SELECT user_id FROM users WHERE email = ?",
      [email],
    );

    if (existing.length > 0) {
      throw new Error("Email already exists.");
    }

    // hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // avatar
    const avatar = name
      .split(" ")
      .map((w) => w[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);

    const profileImage = null;

    const [result] = await db.query(
      `INSERT INTO users 
    (name, username, email, hash_password, role, status, profile_image, avatar, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        name,
        username,
        email,
        hashedPassword,
        role,
        status,
        profileImage,
        avatar,
      ],
    );

    // fetch full user AFTER insert
    const [rows] = await db.query(
      "SELECT user_id AS id, name, username, email, role, status, profile_image, avatar FROM users WHERE user_id = ?",
      [result.insertId],
    );

    return {
      user: rows[0],
    };
  },

  // UPDATE USER -admin
  async updateUser(id, data) {
    const { name, username, email, role, status } = data;

    // update user
    await db.query(
      `UPDATE users SET name = ?, username = ?, email = ?, role = ?, status = ?, 
      updated_at = NOW()
      WHERE user_id = ?`,
      [name, username, email, role, status, id],
    );

    // get updated user
    const [rows] = await db.query(
      `SELECT user_id AS id, name, username, email, role, status,
      created_at,
      updated_at,
      last_login
     FROM users
     WHERE user_id = ?`,
      [id],
    );

    return rows[0];
  },

  // RESET PASSWORD -admin
  async resetPassword(id, password) {
    if (!password || password.length < 6) {
      throw new Error("Password must be at least 6 characters.");
    }

    // check user exists
    const [rows] = await db.query(
      "SELECT user_id FROM users WHERE user_id = ?",
      [id],
    );

    if (rows.length === 0) {
      throw new Error("User not found.");
    }

    // hash new password
    const hashedPassword = await bcrypt.hash(password, 10);

    // update password
    await db.query(
      `UPDATE users
     SET
       hash_password = ?,
       updated_at = NOW()
     WHERE user_id = ?`,
      [hashedPassword, id],
    );

    return true;
  },

  // UPDATE USER STATUS -admin
  async updateUserStatus(id, status) {
    const validStatuses = ["active", "inactive"];

    if (!validStatuses.includes(status)) {
      throw new Error("Invalid status.");
    }

    await db.query(
      `UPDATE users
     SET
       status = ?,
       updated_at = NOW()
     WHERE user_id = ?`,
      [status, id],
    );

    const [rows] = await db.query(
      `SELECT
        user_id AS id,
        name,
        username,
        email,
        role,
        status
     FROM users
     WHERE user_id = ?`,
      [id],
    );

    return rows[0];
  },

  // DELETE USER -admin
  async deleteUser(id, currentUserId) {
    if (!id || isNaN(id)) {
      throw new Error("Invalid user ID.");
    }

    if (id === currentUserId) {
      throw new Error("Cannot delete your own account.");
    }

    const [rows] = await db.query(
      "SELECT user_id FROM users WHERE user_id = ?",
      [id],
    );

    if (rows.length === 0) {
      throw new Error("User not found.");
    }

    return await db.query("DELETE FROM users WHERE user_id = ?", [id]);
  },

  // UPDATE OWN PROFILE
  async updateOwnProfile(userId, data) {
    const { name, username, email, profile_image } = data;

    // check user exists
    const [rows] = await db.query("SELECT * FROM users WHERE user_id = ?", [
      userId,
    ]);

    if (rows.length === 0) {
      throw new Error("User not found.");
    }

    const user = rows[0];

    let profileImage = user.profile_image;

    // if user uploaded new image
    if (data.profile_image) {
      profileImage = data.profile_image;
    }

    let avatar =  user.avatar;

     if (!profileImage && data.name) {
    avatar = data.name
      .trim()
      .split(" ")
      .map((w) => w[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  }

    // validations
    if (name !== undefined && !name.trim()) {
      throw new Error("Name cannot be empty.");
    }

    if (username !== undefined && !username.trim()) {
      throw new Error("Username cannot be empty.");
    }

    // username uniqueness
    if (username && username !== user.username) {
      const [existingUsername] = await db.query(
        "SELECT user_id FROM users WHERE username = ? AND user_id != ?",
        [username, userId],
      );

      if (existingUsername.length > 0) {
        throw new Error("Username already taken.");
      }
    }

    // email uniqueness
    if (email && email !== user.email) {
      const [existingEmail] = await db.query(
        "SELECT user_id FROM users WHERE email = ? AND user_id != ?",
        [email, userId],
      );

      if (existingEmail.length > 0) {
        throw new Error("Email already exists.");
      }
    }

    // update profile
    await db.query(
      `UPDATE users
       SET
         name = ?,
         username = ?,
         email = ?,
         profile_image = ?,
         avatar = ?,
         updated_at = NOW()
       WHERE user_id = ?`,
      [
        name?.trim() ?? user.name,
        username?.trim() ?? user.username,
        email?.trim() ?? user.email,
        profileImage,
        avatar,
        userId,
      ],
    );

    // fetch updated user
    const [updatedRows] = await db.query(
      `SELECT
          user_id AS id,
          name,
          username,
          email,
          role,
          status,
          profile_image,
          avatar,
          created_at,
          updated_at,
          last_login
       FROM users
       WHERE user_id = ?`,
      [userId],
    );

    return updatedRows[0];
  },

  // CHANGE OWN PASSWORD
  async changeOwnPassword(userId, currentPassword, newPassword) {
    if (!currentPassword || !newPassword) {
      throw new Error("Current password and new password are required.");
    }

    if (newPassword.length < 6) {
      throw new Error("New password must be at least 6 characters.");
    }

    // get user
    const [rows] = await db.query("SELECT * FROM users WHERE user_id = ?", [
      userId,
    ]);

    if (rows.length === 0) {
      throw new Error("User not found.");
    }

    const user = rows[0];

    // verify current password
    const validPassword = await bcrypt.compare(
      currentPassword,
      user.hash_password,
    );

    if (!validPassword) {
      throw new Error("Current password is incorrect.");
    }

    // hash new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);

    // update password
    await db.query(
      `UPDATE users
       SET
         hash_password = ?,
         updated_at = NOW()
       WHERE user_id = ?`,
      [hashedPassword, userId],
    );

    return true;
  },
};

export default userService;
