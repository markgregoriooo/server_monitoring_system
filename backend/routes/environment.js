import express from "express";
import { generateSensorHistory, historyLogs } from "../data/db.js";
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

// GET /api/environment/history  — time-series data (simulates InfluxDB)
router.get("/history", authMiddleware, (req, res) => {
  const count = parseInt(req.query.count) || 20;
  res.json({ history: generateSensorHistory(Math.min(count, 100)) });
});

// GET /api/environment/logs  — daily summary logs
router.get("/logs", authMiddleware, (req, res) => {
  res.json({ logs: historyLogs });
});

export default router;
