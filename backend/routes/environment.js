import express from "express";
import asyncHandler from "../utils/asyncHandler.js";
import environmentService from "../services/environmentService.js";
import esp32Monitor from "../services/esp32Monitor.js";
import alertRulesService from "../services/alertRulesService.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { isDeviceConnected } from "../sockets/deviceRoom.js";
import envMaintenance from "../services/envMaintenanceService.js";
import { parseStartRequest } from "../services/envMaintenanceRules.js";
import { clientInfo } from "../services/auditService.js";

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

// ── Maintenance windows for the environment node ───────────────────────────────
// While one is open the room alerts are held back and auto-cooling is paused (see
// services/envMaintenanceService.js). Reading the state is both roles — everyone must
// be able to see that the alarms are off. Opening, extending and ending is admin only.

// GET /api/environment/maintenance → { active, startedAt, endsAt, note, startedBy }
router.get(
  "/maintenance",
  authMiddleware,
  requireRole("admin", "it_staff"),
  (_req, res) => {
    res.json(envMaintenance.getStatus());
  },
);

// POST /api/environment/maintenance { minutes, note? } → open a window, or extend the
// open one to `minutes` from now. minutes ∈ 30 | 60 | 120 | 240.
router.post(
  "/maintenance",
  authMiddleware,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const parsed = parseStartRequest(req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const status = await envMaintenance.start({
      minutes: parsed.minutes,
      note: parsed.note,
      userId: req.user.id,
      ...clientInfo(req),
    });
    res.json(status);
  }),
);

// DELETE /api/environment/maintenance → end the open window now (Resume).
router.delete(
  "/maintenance",
  authMiddleware,
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    res.json(await envMaintenance.end({ userId: req.user.id, ...clientInfo(req) }));
  }),
);

export default router;
