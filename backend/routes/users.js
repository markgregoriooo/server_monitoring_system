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

// Logged-in user updates their own profile: username only. Name, email and photo
// come from Google and are re-synced on every sign-in.
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

// No password endpoints: sign-in is Google-only, so they were removed on 2026-08-25
// together with bcryptjs. See audits/auth-flow-security-2026-08-25.md (AF-03).

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

// There is no admin "create user" route. Accounts come from Google sign-in and are
// approved below. The first admin comes from FIRST_ADMIN_EMAIL under Docker, or is
// promoted by hand (deployment-guide.md §4.3).

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
    // Email the person that their account is active; otherwise they have no way to
    // know. Awaited so the response can report whether the email was sent (the sender
    // never throws).
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
    // Tell the person they were rejected, without a reason or the admin's name (see
    // services/accountEmailTemplate.js). Sent after rejectUser, so nobody is emailed if
    // the rejection itself failed.
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
