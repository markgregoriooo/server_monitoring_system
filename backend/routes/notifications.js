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

// POST /api/notifications/clear  body: { ids: number[] }  OR  { all: true }
// Removes feed rows (dismiss). Scoped to the caller.
router.post(
  "/clear",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const { ids, all } = req.body ?? {};
    const removed = all
      ? await notificationService.clearAll(req.user.id)
      : await notificationService.dismiss(req.user.id, ids ?? []);
    const unreadCount = await notificationService.unreadCount(req.user.id);
    res.json({ success: true, removed, unreadCount });
  }),
);

// GET /api/notifications/prefs → this user's notification preferences
router.get(
  "/prefs",
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json({ prefs: await notificationService.getPrefs(req.user.id) });
  }),
);

// PUT /api/notifications/prefs  body: { emailEnabled?, popupEnabled?, minEmailSeverity? }
router.put(
  "/prefs",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const prefs = await notificationService.savePrefs(req.user.id, req.body ?? {});
    res.json({ success: true, prefs });
  }),
);

export default router;
