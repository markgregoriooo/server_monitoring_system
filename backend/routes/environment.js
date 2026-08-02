import express from "express";
import asyncHandler from "../utils/asyncHandler.js";
import environmentService from "../services/environmentService.js";
import esp32Monitor from "../services/esp32Monitor.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";

const router = express.Router();

// ── POST /api/environment/calibrate-gas ─ re-measure the MQ-2 clean-air baseline ──
// Admin-only, and genuinely consequential: the ESP32 records whatever it smells RIGHT
// NOW as "clean air". Calibrating in poor air raises the baseline and makes the sensor
// under-report smoke from then on. The firmware rejects out-of-range results, but it
// cannot tell smoky air from clean air — only the person in the room can.
//
// Fire-and-forget from here: the device settles, measures, saves to its flash, then
// reports back with a `gasCalibrated` event (forwarded to browsers by
// sockets/connectionHandler.js). This replaces editing RO_CLEAN_AIR_* and reflashing.
router.post("/calibrate-gas", authMiddleware, requireRole("admin"), (req, res) => {
  const io = req.app.get("io");
  if (!io) return res.status(503).json({ error: "Socket server unavailable." });

  const room = io.sockets.adapter.rooms.get("devices");
  if (!room || room.size === 0) {
    return res.status(409).json({ error: "ESP32 is not connected — cannot calibrate." });
  }

  io.to("devices").emit("calibrateGas");
  res.json({ success: true, message: "Calibration requested. Keep the air clean." });
});

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

// ── GET /api/environment/sensor-status ─ is the ESP32 currently reporting? ────────
// The page needs this on first paint; without it a browser only learns the sensor is
// dead when the next `esp32Status` transition happens, which may be never.
router.get("/sensor-status", authMiddleware, (_req, res) => {
  res.json(esp32Monitor.getStatus());
});

export default router;
