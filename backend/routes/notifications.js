import express from "express";
import asyncHandler from "../utils/asyncHandler.js";
import notificationService from "../services/notificationService.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();

// GET /api/notifications → this user's bell feed + unread badge count
router.get(
  "/",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const [notifications, unreadCount] = await Promise.all([
      notificationService.listForUser(req.user.id, { limit: req.query.limit }),
      notificationService.unreadCount(req.user.id),
    ]);
    res.json({ notifications, unreadCount });
  }),
);

// POST /api/notifications/read  body: { ids: number[] }  OR  { all: true }
// Scoped to req.user.id inside the service, so a user can only mark their own read.
router.post(
  "/read",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { ids, all } = req.body ?? {};
    const updated = all
      ? await notificationService.markAllRead(req.user.id)
      : await notificationService.markRead(req.user.id, ids ?? []);
    const unreadCount = await notificationService.unreadCount(req.user.id);
    res.json({ success: true, updated, unreadCount });
  }),
);

export default router;
