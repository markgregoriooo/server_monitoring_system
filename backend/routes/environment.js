import express from "express";
import asyncHandler from "../utils/asyncHandler.js";
import environmentService from "../services/environmentService.js";
import esp32Monitor from "../services/esp32Monitor.js";
import alertRulesService from "../services/alertRulesService.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { isDeviceConnected } from "../sockets/deviceRoom.js";

const router = express.Router();

// ── POST /api/environment/calibrate-gas ─ re-measure the MQ-2 clean-air baseline ──
// Admin-only. The ESP32 treats the current air as clean air, so calibrating in
// smoky air makes the sensor under-report from then on. The device measures, saves
// to flash and replies with `gasCalibrated` (forwarded to browsers).
router.post("/calibrate-gas", authMiddleware, requireRole("admin"), (req, res) => {
  const io = req.app.get("io");
  if (!io) return res.status(503).json({ error: "Socket server unavailable." });

  // Same check and message as the aircon toggle (sockets/deviceRoom.js).
  if (!isDeviceConnected(io)) {
    return res.status(409).json({ error: "The ESP32 is not connected — cannot calibrate." });
  }

  io.to("devices").emit("calibrateGas");
  res.json({ success: true, message: "Calibration requested. Keep the air clean." });
});

// ── GET /api/environment/daily?days=N ─ per-day summary from InfluxDB ──
// Average/max/min temperature, average humidity, peak gas and the day's alert
// count. `days` is clamped to 1-90 in the service. Live history goes over
// Socket.IO (`changeRange`), not REST.
router.get(
  "/daily",
  authMiddleware,
  requireRole("admin", "it_staff"),
  asyncHandler(async (req, res) => {
    res.json(await environmentService.getDailySummary({ days: req.query.days }));
  }),
);

// ── GET /api/environment/sensor-status ─ is the ESP32 reporting? ────────────────
// Needed on first paint; otherwise the page only learns the state at the next change.
router.get("/sensor-status", authMiddleware, (_req, res) => {
  res.json(esp32Monitor.getStatus());
});

// ── GET /api/environment/thresholds ─ room alert thresholds, for colouring ──
// Same shape as the `envConfig` sent to the ESP32, so the dashboards colour readings
// at the points where alerts fire. Kept here rather than in routes/alertRules.js,
// which is admin-only; these are read-only and both roles need them.
router.get(
  "/thresholds",
  authMiddleware,
  requireRole("admin", "it_staff"),
  asyncHandler(async (_req, res) => {
    res.json({ thresholds: await alertRulesService.getRoomThresholds() });
  }),
);

export default router;
