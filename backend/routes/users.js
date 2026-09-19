import express from "express";
import asyncHandler from "../utils/asyncHandler.js";
import userService from "../services/userService.js";
import emailService from "../services/emailService.js";
import { audit, clientInfo } from "../services/auditService.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";

const router = express.Router();

// Get all users
router.get(
  "/",
  authMiddleware,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const users = await userService.getAllUsers();

    res.json({ users });
  }),
);

// Logged-in user updates own profile — USERNAME ONLY.
// Name, email and profile photo are owned by Google: googleAuthService re-syncs them
// from the ID token on every sign-in, so accepting edits here would silently discard
// them at the next login. The multipart/photo-upload path was removed with them.
router.patch("/me", authMiddleware, asyncHandler(async (req, res) => {
    const updatedUser = await userService.updateOwnProfile(req.user.id, {
      username: req.body?.username,
    });

    res.json({
      success: true,
      message: "Profile updated successfully",
      data: updatedUser,
    });
  }),
);

// ─── No password endpoints ────────────────────────────────────────────────────
//
// `PATCH /users/me/password` and the password half of `POST /users` were removed on
// 2026-08-25. They were DEAD auth code: sign-in has been Google-only since the
// password login was deleted, so nothing reads `users.hash_password` and no password
// set here could ever authenticate anyone.
//
// It was not merely unused, it was broken — every account is a Google account, so
// `hash_password` is NULL, and `bcrypt.compare(input, null)` THROWS
// ("Illegal arguments: string, object"). The endpoint answered 500 for every user who
// could reach it. Nothing in the frontend called it; the UI had already gone.
//
// Removed rather than left alone because a live authentication endpoint nobody uses,
// nobody tests and nobody looks at is exactly where a real vulnerability survives.
// `bcryptjs` went with it. See audits/auth-flow-security-2026-08-25.md — AF-03.

// Admin: list registrations awaiting approval.
// MUST be declared before "/:id" so "pending" isn't captured as an :id param.
router.get(
  "/pending",
  authMiddleware,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    res.json({ pending: await userService.listPending() });
  }),
);

// GET single user
router.get(
  "/:id",
  authMiddleware,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const user = await userService.getUserById(parseInt(req.params.id));

    if (!user) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    res.json({ user });
  }),
);

// `POST /users` (admin-created account with a password) was removed with the password
// endpoints above — same reason: the password it demanded could never authenticate
// anyone. Accounts arrive by Google self-registration and are approved below; the very
// first admin is promoted by hand (deployment-guide.md §4.3).

// Update user
router.patch(
  "/:id",
  authMiddleware,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    // console.log(req.body);
    const updatedUser = await userService.updateUser(
      parseInt(req.params.id),
      req.body,
    );

    await audit({
      userId: req.user.id,
      module: "users",
      action: "update_user",
      description: `Updated user ${updatedUser.name} (role=${updatedUser.role}, status=${updatedUser.status})`,
      ...clientInfo(req),
    });

    res.json({
      message: "User updated successfully",
      user: updatedUser,
    });
  }),
);

// Disable user
router.patch(
  "/:id/status",
  authMiddleware,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const updatedUser = await userService.updateUserStatus(
      Number(req.params.id),
      req.body.status,
      req.user.id,
    );

    await audit({
      userId: req.user.id,
      module: "users",
      action: updatedUser.status === "inactive" ? "disable_user" : "enable_user",
      description: `${updatedUser.status === "inactive" ? "Disabled" : "Enabled"} user ${updatedUser.name}`,
      level: updatedUser.status === "inactive" ? "warning" : "info",
      ...clientInfo(req),
    });

    res.json({
      success: true,
      user: updatedUser,
    });
  }),
);

// Admin: approve a pending registration and assign its role (admin | it_staff).
router.post(
  "/:id/approve",
  authMiddleware,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const user = await userService.approveUser(parseInt(req.params.id), req.body.role);
    await audit({
      userId: req.user.id,
      module: "users",
      action: "approve_user",
      description: `Approved registration ${user.name} (${user.email}) as ${user.role}`,
      ...clientInfo(req),
    });
    // Tell the person their account is live. Until this existed, an approved user had
    // NO way to find out: `userApproved` below is a socket event that only reaches
    // admins, and the approved user holds no session for anything to be pushed to. The
    // only signal was retrying the sign-in and noticing the message had changed.
    //
    // Awaited rather than fire-and-forget. The sender never throws and returns a
    // boolean, so this cannot fail the approval — and awaiting is what lets the
    // response say whether the person was actually reached. An admin who sees it failed
    // can pass the word on another way; a silent failure leaves someone waiting for a
    // message that is never coming.
    const emailed = await emailService.sendAccountApprovedEmail(user);
    if (!emailed) {
      console.warn(
        `[users] approved ${user.email} but no notification email went out — ` +
          `SMTP unconfigured, or the send failed (see any [email] line above).`,
      );
    }

    req.app.get("io")?.emit("userApproved", { id: user.id });
    res.json({ success: true, user, emailed });
  }),
);

// Admin: reject a pending registration.
router.post(
  "/:id/reject",
  authMiddleware,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id);
    const target = await userService.getUserById(id);
    await userService.rejectUser(id);
    await audit({
      userId: req.user.id,
      module: "users",
      action: "reject_user",
      description: `Rejected registration ${target?.name ?? `#${id}`}${target?.email ? ` (${target.email})` : ""}`,
      level: "warning",
      ...clientInfo(req),
    });
    // Close the loop for the person too. Neutral by design — no reason and no actor,
    // see services/accountEmailTemplate.js — because a rejection can be a security
    // decision, and an email that explains itself tells whoever registered exactly what
    // was noticed. The case this exists for is the one rejected by mistake, who
    // otherwise has no way to learn of it or say so.
    //
    // Sent AFTER rejectUser, so a request for a user who does not exist (or is not
    // pending) throws first and nobody is mailed about a state change that never
    // happened.
    const emailed = await emailService.sendAccountRejectedEmail(target);
    if (!emailed) {
      console.warn(
        `[users] rejected ${target?.email ?? `#${id}`} but no notification email went ` +
          `out — SMTP unconfigured, or the send failed (see any [email] line above).`,
      );
    }

    // Refresh open admin pending lists (the row left the 'pending' state).
    req.app.get("io")?.emit("userPending", { id });
    res.json({ success: true, emailed });
  }),
);

// Delete user
router.delete(
  "/:id",
  authMiddleware,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id);
    const target = await userService.getUserById(id);
    await userService.deleteUser(id, req.user.id);

    await audit({
      userId: req.user.id,
      module: "users",
      action: "delete_user",
      description: `Deleted user ${target?.name ?? `#${id}`}${target?.email ? ` (${target.email})` : ""}`,
      level: "warning",
      ...clientInfo(req),
    });

    res.json({
      success: true,
      message: "User deleted successfully",
    });
  }),
);

export default router;
