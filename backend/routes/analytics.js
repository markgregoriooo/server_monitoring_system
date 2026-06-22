import express from "express";
import asyncHandler from "../utils/asyncHandler.js";
import analyticsService from "../services/analyticsService.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";

const router = express.Router();

// Analytics is read-only insight — both roles may view it (unlike Alert Rules,
// which only admins can change).
router.use(authMiddleware, requireRole("admin", "it_staff"));

// GET /api/analytics/forecast/disk?days=14&full=100
// Disk-full ETA (linear regression) for every server that has history.
router.get(
  "/forecast/disk",
  asyncHandler(async (req, res) => {
    const forecasts = await analyticsService.forecastDiskFull({
      lookbackDays: req.query.days,
      full: req.query.full,
    });
    res.json({ forecasts });
  }),
);

// GET /api/analytics/forecast/disk/:id?days=14&full=100  → single server.
router.get(
  "/forecast/disk/:id",
  asyncHandler(async (req, res) => {
    const deviceId = parseInt(req.params.id, 10);
    if (!Number.isInteger(deviceId)) {
      return res.status(400).json({ error: "Invalid server id." });
    }
    const [forecast] = await analyticsService.forecastDiskFull({
      deviceId,
      lookbackDays: req.query.days,
      full: req.query.full,
    });
    res.json({ forecast: forecast ?? null });
  }),
);

// GET /api/analytics/alerts/summary?days=30
// MTTR, counts by severity, per-day volume, noisiest devices/types.
router.get(
  "/alerts/summary",
  asyncHandler(async (req, res) => {
    const summary = await analyticsService.alertSummary(req.query.days);
    res.json({ summary });
  }),
);

export default router;
