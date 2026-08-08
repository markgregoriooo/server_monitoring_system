import express from "express";
import asyncHandler from "../utils/asyncHandler.js";
import userService from "../services/userService.js";
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

// Logged-in user changes own password
router.patch(
  "/me/password",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    await userService.changeOwnPassword(
      req.user.id,
      currentPassword,
      newPassword,
    );

    res.json({
      success: true,
      message: "Password updated successfully",
    });
  }),
);

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

// Create user
router.post(
  "/",
  authMiddleware,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const result = await userService.createUser(req.body);

    res.status(201).json({
      message: "User created successfully",
      user: result.user,
    });
  }),
);

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
    req.app.get("io")?.emit("userApproved", { id: user.id });
    res.json({ success: true, user });
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
    // Refresh open admin pending lists (the row left the 'pending' state).
    req.app.get("io")?.emit("userPending", { id });
    res.json({ success: true });
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
