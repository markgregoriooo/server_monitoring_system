import express from "express";
import asyncHandler from "../utils/asyncHandler.js";
import historyService from "../services/historyService.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";

const router = express.Router();

// History is read-only operational insight (like Alerts/Analytics), so both
// admin and it_staff can view it. Managing things stays gated elsewhere.
router.use(authMiddleware, requireRole("admin", "it_staff"));

// GET /api/history — unified activity/audit timeline across system_logs,
// aircon_logs, alerts and device_logs, with actor accountability.
// Query: days, category, severity, actorType (admin|staff|system), search, page, pageSize
router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(
      await historyService.getHistory({
        days: req.query.days,
        start: req.query.start,
        end: req.query.end,
        category: req.query.category,
        severity: req.query.severity,
        actorType: req.query.actorType,
        userId: req.query.userId,
        search: req.query.search,
        page: req.query.page,
        pageSize: req.query.pageSize,
      }),
    );
  }),
);

// GET /api/history/actors — users who appear in the history (per-user filter).
router.get(
  "/actors",
  asyncHandler(async (_req, res) => {
    res.json({ actors: await historyService.getActors() });
  }),
);

export default router;
