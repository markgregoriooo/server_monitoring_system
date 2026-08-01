import express from "express";
import asyncHandler from "../utils/asyncHandler.js";
import environmentService from "../services/environmentService.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";

const router = express.Router();

// ── GET /api/environment/daily?days=N ─ per-day summary, measured from InfluxDB ──
// Temperature avg/max/min, humidity avg, peak gas, and that day's environment-alert
// count. `days` is clamped 1–90 in the service.
//
// Replaces two mock endpoints that used to live here:
//   • /history — returned `24 + Math.random() * 4` as "time-series data". It had no
//     callers at all. Live sensor history is a Socket.IO concern (`changeRange` →
//     querySensorHistoryHandler → real Flux), not a REST one.
//   • /logs    — returned five rows hardcoded to March 2025.
//
// Read-only operational insight, so both roles can see it (same gate as /api/history).
router.get(
  "/daily",
  authMiddleware,
  requireRole("admin", "it_staff"),
  asyncHandler(async (req, res) => {
    res.json(await environmentService.getDailySummary({ days: req.query.days }));
  }),
);

export default router;
