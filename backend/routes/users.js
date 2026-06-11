import express from "express";
import asyncHandler from "../utils/asyncHandler.js";
import userService from "../services/userService.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import upload from "../middleware/upload.js";

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

// Logged-in user updates own profile
router.patch("/me", authMiddleware, upload.single("profile_image"), asyncHandler(async (req, res) => {
  
    const updatedUser = await userService.updateOwnProfile(req.user.id, {
      ...req.body,
      profile_image: req.file ? `/uploads/${req.file.filename}` : undefined,
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

    res.json({
      message: "User updated successfully",
      user: updatedUser,
    });
  }),
);

// Reset Password
router.patch(
  "/:id/reset-password",
  authMiddleware,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    await userService.resetPassword(Number(req.params.id), req.body.password);

    res.json({
      success: true,
      message: "Password reset successfully",
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
    );

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
    await userService.rejectUser(parseInt(req.params.id));
    // Refresh open admin pending lists (the row left the 'pending' state).
    req.app.get("io")?.emit("userPending", { id: parseInt(req.params.id) });
    res.json({ success: true });
  }),
);

// Delete user
router.delete(
  "/:id",
  authMiddleware,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    await userService.deleteUser(parseInt(req.params.id), req.user.id);

    res.json({
      success: true,
      message: "User deleted successfully",
    });
  }),
);

export default router;
