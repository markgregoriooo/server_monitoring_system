import express from "express";
import asyncHandler from "../utils/asyncHandler.js";
import environmentService from "../services/environmentService.js";
import esp32Monitor from "../services/esp32Monitor.js";
import alertRulesService from "../services/alertRulesService.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { isDeviceConnected } from "../sockets/deviceRoom.js";

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

  // Shared with the aircon toggle (sockets/deviceRoom.js) rather than an inline copy —
  // one check and one wording, so a user never meets two different messages for the same
  // condition and takes them for two different faults.
  if (!isDeviceConnected(io)) {
    return res.status(409).json({ error: "The ESP32 is not connected — cannot calibrate." });
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

// ── GET /api/environment/thresholds ─ the room-level alert thresholds, for colouring ──
// The same `{tempWarn,tempCrit,gasWarn,gasCrit,humWarn,humCrit}` shape pushed to the ESP32
// as `envConfig`, so the dashboards can colour humidity and gas at exactly the points the
// system raises an alert. Previously the Dashboard carried its own `GAS_WARN = 150` /
// `GAS_CRIT = 300` copies with a comment asking whoever retuned the rules to retune the
// constants too — a promise nothing enforced, and one an admin editing Alert Rules would
// never see.
//
// Deliberately NOT mounted on routes/alertRules.js: that router is admin-only from its
// first line down, and slipping a both-roles route in above the gate is the kind of thing
// a security read of that file would miss. These are read-only numbers the pages already
// express as colour, and IT staff can see the alerts they produce, so exposing them to
// both roles here costs nothing. Rule MUTATION stays admin-only where it was.
router.get(
  "/thresholds",
  authMiddleware,
  requireRole("admin", "it_staff"),
  asyncHandler(async (_req, res) => {
    res.json({ thresholds: await alertRulesService.getRoomThresholds() });
  }),
);

export default router;
