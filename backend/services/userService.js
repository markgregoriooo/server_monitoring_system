import db from "../config/mysql.js";
import bcrypt from "bcryptjs";

// ─── Last-admin invariant (best practice) ─────────────────────────────────────
// The system must always retain at least one ACTIVE admin. These helpers back the
// server-side guard so removing/disabling/demoting the final admin is rejected even
// via a direct API call (the UI button-hiding is only a convenience on top).

// Count active admins OTHER than `excludeId`.
async function countOtherActiveAdmins(excludeId) {
  const [[row]] = await db.query(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active' AND user_id <> ?",
    [excludeId],
  );
  return Number(row?.n ?? 0);
}

function lastAdminError() {
  const err = new Error("Cannot remove the last active administrator. Assign another admin first.");
  err.status = 400;
  return err;
}

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

  // ── Google auth / registration-approval support ─────────────────────────────

  // Raw row by email (includes status / google_sub) — used by the Google login
  // path to decide: log in (active) vs pending vs rejected vs disabled.
  async findByEmail(email) {
    const [rows] = await db.query("SELECT * FROM users WHERE email = ? LIMIT 1", [
      String(email).trim().toLowerCase(),
    ]);
    return rows[0] ?? null;
  },

  // Raw row by Google account id (the `sub` claim). PREFERRED over findByEmail:
  // `sub` is immutable, while an email is a mutable alias that ICTU can rename.
  async findByGoogleSub(googleSub) {
    if (!googleSub) return null;
    const [rows] = await db.query("SELECT * FROM users WHERE google_sub = ? LIMIT 1", [googleSub]);
    return rows[0] ?? null;
  },

  // Refresh the profile facts Google owns, on every sign-in. Without this they
  // freeze at registration: lh3.googleusercontent.com photo URLs rotate (so
  // avatars quietly 404 over months) and a name change never reaches the UI.
  //
  // `email` is only passed when the user was matched by google_sub AND Google's
  // address differs — i.e. a genuine rename of an existing account. It is skipped
  // if another row already holds that address, since users.email is UNIQUE and a
  // duplicate-key error here would turn a valid login into a 500.
  async syncGoogleProfile(userId, { name, picture = null, email = null } = {}) {
    let nextEmail = null;
    if (email) {
      const [[taken]] = await db.query(
        "SELECT user_id FROM users WHERE email = ? AND user_id <> ? LIMIT 1",
        [email, userId],
      );
      if (taken) {
        console.warn(
          `[USERS] refusing to move email ${email} to user ${userId}: already held by user ${taken.user_id}`,
        );
      } else {
        nextEmail = email;
      }
    }

    // COALESCE keeps the stored value when Google sends nothing for a field, so a
    // missing picture never blanks an avatar the user already has.
    await db.query(
      `UPDATE users
          SET name          = COALESCE(?, name),
              profile_image = COALESCE(?, profile_image),
              email         = COALESCE(?, email),
              updated_at    = NOW()
        WHERE user_id = ?`,
      [name || null, picture, nextEmail, userId],
    );

    return { name, picture, email: nextEmail };
  },

  // Create a PENDING registration from a verified Google profile (no password).
  // role is a placeholder until an admin approves and assigns the real one.
  async registerGoogleUser({ email, googleSub, name, picture = null }) {
    const normEmail = String(email).trim().toLowerCase();

    // username from the email local-part, sanitized + de-duplicated.
    const base =
      (normEmail.split("@")[0] || "user").replace(/[^a-z0-9._-]/gi, "").slice(0, 40) || "user";
    let username = base;
    for (let i = 1; ; i++) {
      const [[dup]] = await db.query("SELECT user_id FROM users WHERE username = ? LIMIT 1", [
        username,
      ]);
      if (!dup) break;
      username = `${base}${i}`;
    }

    const avatar =
      (name || "")
        .trim()
        .split(/\s+/)
        .map((w) => w[0])
        .join("")
        .toUpperCase()
        .slice(0, 2) || "U";

    const [result] = await db.query(
      `INSERT INTO users
         (name, username, email, google_sub, auth_provider, role, status, profile_image, avatar, created_at)
       VALUES (?, ?, ?, ?, 'google', 'it_staff', 'pending', ?, ?, NOW())`,
      [name, username, normEmail, googleSub, picture, avatar],
    );

    const [[row]] = await db.query(
      `SELECT user_id AS id, name, username, email, role, status, profile_image, avatar
         FROM users WHERE user_id = ?`,
      [result.insertId],
    );
    return row;
  },

  // Link a Google account id to an existing user (e.g. the bootstrapped admin).
  async linkGoogleSub(userId, googleSub) {
    await db.query("UPDATE users SET google_sub = ? WHERE user_id = ?", [googleSub, userId]);
  },

  // Admin: list accounts awaiting approval.
  async listPending() {
    const [rows] = await db.query(
      `SELECT user_id AS id, name, username, email, role, profile_image, avatar, created_at
         FROM users WHERE status = 'pending' ORDER BY created_at DESC`,
    );
    return rows;
  },

  // Admin: approve a pending registration and assign its role.
  async approveUser(id, role) {
    const validRoles = ["admin", "it_staff"];
    if (!validRoles.includes(role)) throw new Error("Invalid role.");

    const [[user]] = await db.query("SELECT status FROM users WHERE user_id = ? LIMIT 1", [id]);
    if (!user) throw new Error("User not found.");
    if (user.status !== "pending") throw new Error("User is not awaiting approval.");

    await db.query("UPDATE users SET status = 'active', role = ?, updated_at = NOW() WHERE user_id = ?", [
      role,
      id,
    ]);

    const [[row]] = await db.query(
      "SELECT user_id AS id, name, username, email, role, status FROM users WHERE user_id = ?",
      [id],
    );
    return row;
  },

  // Admin: reject a pending registration. The row is KEPT (status='rejected') for
  // the audit trail and blocks future sign-in. To undo, set the account back to
  // 'active' from User Management (the Enable action / the edit modal) — deleting
  // the row is not required, and would throw the audit trail away with it.
  async rejectUser(id) {
    const [[user]] = await db.query("SELECT status FROM users WHERE user_id = ? LIMIT 1", [id]);
    if (!user) throw new Error("User not found.");
    if (user.status !== "pending") throw new Error("User is not awaiting approval.");

    await db.query("UPDATE users SET status = 'rejected', updated_at = NOW() WHERE user_id = ?", [id]);
    return true;
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

  // UPDATE USER -admin — username / role / status only.
  //
  // `name` and `email` are deliberately NOT updatable: Google owns them and
  // syncGoogleProfile() rewrites them on the user's next sign-in, so an admin's edit
  // would silently revert. Email is also the identity key the Google login matches on.
  // They are passed through COALESCE below purely so a caller omitting them can never
  // blank the columns (the previous version wrote every field unconditionally, so a
  // missing `name` would have stored NULL).
  async updateUser(id, data) {
    const { username, role, status } = data;

    const validRoles    = ["admin", "it_staff"];
    const validStatuses = ["pending", "active", "inactive", "rejected"];

    if (role !== undefined && !validRoles.includes(role)) {
      throw new Error("Invalid role.");
    }
    if (status !== undefined && !validStatuses.includes(status)) {
      throw new Error("Invalid status.");
    }
    if (username !== undefined && !String(username).trim()) {
      throw new Error("Username cannot be empty.");
    }

    const nextUsername = username === undefined ? null : String(username).trim();

    // username uniqueness (admins can rename users, so the same guard applies here)
    if (nextUsername) {
      const [[taken]] = await db.query(
        "SELECT user_id FROM users WHERE username = ? AND user_id != ? LIMIT 1",
        [nextUsername, id],
      );
      if (taken) throw new Error("Username already taken.");
    }

    // F-02: a role downgrade or disable must invalidate the user's existing token.
    const [[before]] = await db.query(
      "SELECT role, status FROM users WHERE user_id = ?",
      [id],
    );

    // Best practice: never let an edit demote or disable the LAST active admin.
    const wasActiveAdmin = before?.role === "admin" && before?.status === "active";
    const willBeActiveAdmin =
      (role ?? before?.role) === "admin" && (status ?? before?.status) === "active";
    if (wasActiveAdmin && !willBeActiveAdmin && (await countOtherActiveAdmins(id)) === 0) {
      throw lastAdminError();
    }

    const mustRevoke =
      (role !== undefined && role !== before?.role) ||
      (status === "inactive" && before?.status !== "inactive");

    // update user
    await db.query(
      `UPDATE users SET
         username = COALESCE(?, username),
         role     = COALESCE(?, role),
         status   = COALESCE(?, status),
         token_version = token_version + ?,
         updated_at = NOW()
       WHERE user_id = ?`,
      [nextUsername, role ?? null, status ?? null, mustRevoke ? 1 : 0, id],
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

  // UPDATE USER STATUS -admin
  async updateUserStatus(id, status, currentUserId) {
    const validStatuses = ["active", "inactive"];

    if (!validStatuses.includes(status)) {
      throw new Error("Invalid status.");
    }

    if (status === "inactive") {
      if (currentUserId !== undefined && id === currentUserId) {
        const err = new Error("Cannot disable your own account.");
        err.status = 400;
        throw err;
      }
      // Never disable the last active admin.
      const [[target]] = await db.query(
        "SELECT role, status FROM users WHERE user_id = ?",
        [id],
      );
      if (
        target?.role === "admin" &&
        target?.status === "active" &&
        (await countOtherActiveAdmins(id)) === 0
      ) {
        throw lastAdminError();
      }
    }

    // F-02: disabling an account revokes its live token immediately.
    await db.query(
      `UPDATE users
     SET
       status = ?,
       token_version = token_version + IF(? = 'inactive', 1, 0),
       updated_at = NOW()
     WHERE user_id = ?`,
      [status, status, id],
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
      "SELECT role, status FROM users WHERE user_id = ?",
      [id],
    );

    if (rows.length === 0) {
      throw new Error("User not found.");
    }

    // Never delete the last active admin — the system would be left with no admins.
    const target = rows[0];
    if (
      target.role === "admin" &&
      target.status === "active" &&
      (await countOtherActiveAdmins(id)) === 0
    ) {
      throw lastAdminError();
    }

    return await db.query("DELETE FROM users WHERE user_id = ?", [id]);
  },

  // UPDATE OWN PROFILE — USERNAME ONLY.
  //
  // name / email / profile_image are owned by GOOGLE. googleAuthService calls
  // syncGoogleProfile() on every sign-in, so anything written here would be
  // overwritten at the next login — the change would appear to "work", then
  // silently revert. email is also the account's identity key, so letting a user
  // edit it could point their row at someone else's address entirely.
  // `username` is ours alone and Google never touches it.
  async updateOwnProfile(userId, { username }) {
    const [rows] = await db.query("SELECT * FROM users WHERE user_id = ?", [
      userId,
    ]);

    if (rows.length === 0) {
      throw new Error("User not found.");
    }

    const user = rows[0];

    if (username === undefined || !String(username).trim()) {
      throw new Error("Username cannot be empty.");
    }

    const nextUsername = String(username).trim();

    // username uniqueness
    if (nextUsername !== user.username) {
      const [existingUsername] = await db.query(
        "SELECT user_id FROM users WHERE username = ? AND user_id != ?",
        [nextUsername, userId],
      );

      if (existingUsername.length > 0) {
        throw new Error("Username already taken.");
      }
    }

    await db.query(
      `UPDATE users SET username = ?, updated_at = NOW() WHERE user_id = ?`,
      [nextUsername, userId],
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

    // update password — F-02: a password change invalidates older tokens. The
    // client must re-authenticate after this call (the current token is revoked too).
    await db.query(
      `UPDATE users
       SET
         hash_password = ?,
         token_version = token_version + 1,
         updated_at = NOW()
       WHERE user_id = ?`,
      [hashedPassword, userId],
    );

    return true;
  },
};

export default userService;
