import db from "../config/mysql.js";
// A throw without a status became a 500, so "Email already exists." reached the user
// as "Server error". See audits/error-handling-report-2026-08-25.md (E-04).
import { badRequest, notFound, conflict } from "../utils/httpError.js";
import { PREF_DEFAULTS } from "./notificationService.js";

// ─── Role & status values ───────────────────────────────────────────────
// The two status lists are different on purpose (see below).
// See audits/code-duplication-report-2026-08-25.md (R-15).

/** Every role a user row may hold. */
export const ROLES = Object.freeze(["admin", "it_staff"]);

/** Every state a user row may hold. */
export const USER_STATUSES = Object.freeze(["pending", "active", "inactive", "rejected"]);

/**
 * The statuses an admin can switch between. `pending` and `rejected` only come from
 * approving or rejecting a registration.
 */
export const TOGGLEABLE_STATUSES = Object.freeze(["active", "inactive"]);

// ─── Keep at least one active admin ─────────────────────────────────────
// Removing, disabling or demoting the last admin is refused on the server, even
// through a direct API call (the UI hiding the button is only a convenience).

// Count active admins other than `excludeId`.
// ─── The last-admin check, done atomically ────────────────────────────────────────
// Two admins demoting or deleting each other at the same moment could both see "one
// other admin exists" and leave zero admins, which can only be fixed in MySQL.
// `FOR UPDATE` locks the remaining admin rows, so the second transaction waits for the
// first and then sees the real count. Callers pass their own connection so the check
// and the write are one transaction.
async function assertNotLastAdmin(conn, excludeId) {
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS n FROM users
      WHERE role = 'admin' AND status = 'active' AND user_id <> ?
      FOR UPDATE`,
    [excludeId],
  );
  if (Number(row?.n ?? 0) === 0) throw lastAdminError();
}

// Run `fn` inside a transaction, rolling back on any throw. Keeps the three callers
// below from each hand-rolling begin/commit/rollback and forgetting a release.
async function inTransaction(fn) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      /* the connection is already broken; the original error is what matters */
    }
    throw err;
  } finally {
    conn.release();
  }
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

  // Refresh the profile fields Google owns on every sign-in (photo URLs change, names
  // change). `email` is only passed when the user was matched by google_sub and Google's
  // address changed (a real rename). It is skipped if another row already has that
  // address, since users.email is UNIQUE.
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

    // Save this account's notification preferences now instead of relying on a fallback,
    // so email stays off until the person turns it on (a later change to the fallback
    // cannot subscribe them). Best-effort: the fallback matches this row, so losing it
    // changes nothing, and a registration should not fail over it.
    try {
      await db.query(
        `INSERT INTO notification_prefs (user_id, email_enabled, popup_enabled)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE user_id = user_id`,
        [
          result.insertId,
          PREF_DEFAULTS.emailEnabled ? 1 : 0,
          PREF_DEFAULTS.popupEnabled ? 1 : 0,
        ],
      );
    } catch (err) {
      console.warn(
        `[users] could not seed notification_prefs for user ${result.insertId}: ` +
          `${err?.code || err?.message || err} — falling back to PREF_DEFAULTS (email off)`,
      );
    }

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
    if (!ROLES.includes(role)) throw badRequest("Invalid role.");

    const [[user]] = await db.query("SELECT status FROM users WHERE user_id = ? LIMIT 1", [id]);
    if (!user) throw notFound("User not found.");
    if (user.status !== "pending") throw conflict("User is not awaiting approval.");

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

  // Admin: reject a pending registration. The row is kept (status='rejected') for the
  // audit trail and blocks sign-in. To undo, set the account back to 'active' in User
  // Management.
  async rejectUser(id) {
    const [[user]] = await db.query("SELECT status FROM users WHERE user_id = ? LIMIT 1", [id]);
    if (!user) throw notFound("User not found.");
    if (user.status !== "pending") throw conflict("User is not awaiting approval.");

    await db.query("UPDATE users SET status = 'rejected', updated_at = NOW() WHERE user_id = ?", [id]);
    return true;
  },

  // createUser and changeOwnPassword were removed on 2026-08-25: sign-in is Google-only,
  // so nothing reads users.hash_password (all NULL). bcryptjs went with them.
  // See audits/auth-flow-security-2026-08-25.md (AF-03).

  // Admin update of a user: username, role and status only. Name and email come from
  // Google and are re-synced at sign-in; COALESCE keeps an omitted field unchanged.
  async updateUser(id, data) {
    const { username, role, status } = data;

    if (role !== undefined && !ROLES.includes(role)) {
      throw badRequest("Invalid role.");
    }
    if (status !== undefined && !USER_STATUSES.includes(status)) {
      throw badRequest("Invalid status.");
    }
    if (username !== undefined && !String(username).trim()) {
      throw badRequest("Username cannot be empty.");
    }

    const nextUsername = username === undefined ? null : String(username).trim();

    // username uniqueness (admins can rename users, so the same guard applies here)
    if (nextUsername) {
      const [[taken]] = await db.query(
        "SELECT user_id FROM users WHERE username = ? AND user_id != ? LIMIT 1",
        [nextUsername, id],
      );
      if (taken) throw conflict("Username already taken.");
    }

    // F-02: a role downgrade or disable must invalidate the user's existing token.
    const [[before]] = await db.query(
      "SELECT role, status FROM users WHERE user_id = ?",
      [id],
    );

    // Never let an edit demote or disable the LAST active admin.
    const wasActiveAdmin = before?.role === "admin" && before?.status === "active";
    const willBeActiveAdmin =
      (role ?? before?.role) === "admin" && (status ?? before?.status) === "active";

    const mustRevoke =
      (role !== undefined && role !== before?.role) ||
      (status === "inactive" && before?.status !== "inactive");

    // Guard and write in ONE transaction — two admins demoting each other at the same
    // moment would otherwise both pass a separate count and leave zero admins.
    await inTransaction(async (conn) => {
      if (wasActiveAdmin && !willBeActiveAdmin) await assertNotLastAdmin(conn, id);
      await conn.query(
        `UPDATE users SET
           username = COALESCE(?, username),
           role     = COALESCE(?, role),
           status   = COALESCE(?, status),
           token_version = token_version + ?,
           updated_at = NOW()
         WHERE user_id = ?`,
        [nextUsername, role ?? null, status ?? null, mustRevoke ? 1 : 0, id],
      );
    });

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
    // TOGGLEABLE_STATUSES, not USER_STATUSES: this endpoint flips an existing account
    // on or off. Moving one INTO pending/rejected is the approval flow's job.
    if (!TOGGLEABLE_STATUSES.includes(status)) {
      throw badRequest("Invalid status.");
    }

    let needsLastAdminGuard = false;
    if (status === "inactive") {
      if (currentUserId !== undefined && id === currentUserId) {
        const err = new Error("Cannot disable your own account.");
        err.status = 400;
        throw err;
      }
      // Checked inside the transaction below, not here — see assertNotLastAdmin.
      needsLastAdminGuard = true;
    }

    // Disabling an account revokes its token right away. The last-admin check and the
    // write are one transaction.
    await inTransaction(async (conn) => {
      if (needsLastAdminGuard) {
        const [[target]] = await conn.query(
          "SELECT role, status FROM users WHERE user_id = ?",
          [id],
        );
        if (target?.role === "admin" && target?.status === "active") {
          await assertNotLastAdmin(conn, id);
        }
      }
      await conn.query(
        `UPDATE users
            SET status = ?,
                token_version = token_version + IF(? = 'inactive', 1, 0),
                updated_at = NOW()
          WHERE user_id = ?`,
        [status, status, id],
      );
    });

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
      throw badRequest("Invalid user ID.");
    }

    if (id === currentUserId) {
      throw conflict("Cannot delete your own account.");
    }

    const [rows] = await db.query(
      "SELECT role, status FROM users WHERE user_id = ?",
      [id],
    );

    if (rows.length === 0) {
      throw notFound("User not found.");
    }

    // Never delete the last active admin. The check and the delete are one transaction.
    // See assertNotLastAdmin.
    const target = rows[0];
    return await inTransaction(async (conn) => {
      if (target.role === "admin" && target.status === "active") {
        await assertNotLastAdmin(conn, id);
      }
      return await conn.query("DELETE FROM users WHERE user_id = ?", [id]);
    });
  },

  // Update own profile: username only. Name, email and photo come from Google and are
  // overwritten at every sign-in; email is also how the account is matched.
  async updateOwnProfile(userId, { username }) {
    const [rows] = await db.query("SELECT * FROM users WHERE user_id = ?", [
      userId,
    ]);

    if (rows.length === 0) {
      throw notFound("User not found.");
    }

    const user = rows[0];

    if (username === undefined || !String(username).trim()) {
      throw badRequest("Username cannot be empty.");
    }

    const nextUsername = String(username).trim();

    // username uniqueness
    if (nextUsername !== user.username) {
      const [existingUsername] = await db.query(
        "SELECT user_id FROM users WHERE username = ? AND user_id != ?",
        [nextUsername, userId],
      );

      if (existingUsername.length > 0) {
        throw conflict("Username already taken.");
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
};

export default userService;
