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

// metric must be one of the known names (cpu/mem/disk/temperature/humidity/gas).
const validMetric = (m) => analyticsService.metricMeta(m) != null;
const parseDeviceId = (q) => {
  if (q == null || q === "") return null;
  const n = parseInt(q, 10);
  return Number.isInteger(n) ? n : null;
};

// GET /api/analytics/trends/:metric?deviceId=&hours=48&horizon=12  (Phase 2)
// EWMA-smoothed history + Holt's-linear short-horizon projection for one metric.
router.get(
  "/trends/:metric",
  asyncHandler(async (req, res) => {
    const { metric } = req.params;
    if (!validMetric(metric)) return res.status(400).json({ error: "Unknown metric." });
    const trend = await analyticsService.forecastTrend({
      metric,
      deviceId: parseDeviceId(req.query.deviceId),
      lookbackHours: req.query.hours,
      horizonHours: req.query.horizon,
    });
    res.json({ trend });
  }),
);

// GET /api/analytics/anomalies?metric=&deviceId=&days=7&z=3  (Phase 3)
// Per-hour-of-day z-score anomalies (+ global IQR fences) for one metric.
router.get(
  "/anomalies",
  asyncHandler(async (req, res) => {
    const metric = req.query.metric;
    if (!validMetric(metric)) return res.status(400).json({ error: "Unknown metric." });
    const result = await analyticsService.detectAnomalies({
      metric,
      deviceId: parseDeviceId(req.query.deviceId),
      lookbackDays: req.query.days,
      z: req.query.z,
    });
    res.json({ result });
  }),
);

// GET /api/analytics/recommendations?days=14  (Phase 4)
// Suggested alert-rule thresholds (warn=p95, crit=p99) vs current global rules.
router.get(
  "/recommendations",
  asyncHandler(async (req, res) => {
    const recommendations = await analyticsService.recommendThresholds({
      lookbackDays: req.query.days,
    });
    res.json({ recommendations });
  }),
);

// GET /api/analytics/accuracy?metric=&deviceId=&days=30&horizon=7&folds=5
// Rolling-origin backtest: how far off the forecasts actually were, measured on real
// history rather than on how well the line fits it. See predictive-analytics.md §17.
router.get(
  "/accuracy",
  asyncHandler(async (req, res) => {
    const metric = req.query.metric ?? "disk";
    if (!validMetric(metric)) return res.status(400).json({ error: "Unknown metric." });
    const accuracy = await analyticsService.forecastAccuracy({
      metric,
      deviceId: parseDeviceId(req.query.deviceId),
      lookbackDays: req.query.days,
      horizonDays: req.query.horizon,
      folds: req.query.folds,
    });
    res.json({ accuracy });
  }),
);

// GET /api/analytics/forecast/ups-battery?deviceId=&days=30&floor=5  (Phase 2b)
// Battery-degradation ETA (linear regression on runtime) for every UPS, or one.
router.get(
  "/forecast/ups-battery",
  asyncHandler(async (req, res) => {
    const forecasts = await analyticsService.forecastUpsBattery({
      deviceId: parseDeviceId(req.query.deviceId),
      lookbackDays: req.query.days,
      floorMinutes: req.query.floor,
    });
    res.json({ forecasts });
  }),
);

// GET /api/analytics/forecast/link-saturation?deviceId=&days=30&ceiling=90  (Phase 2b)
// Link-saturation ETA (linear regression on utilization) per router interface.
router.get(
  "/forecast/link-saturation",
  asyncHandler(async (req, res) => {
    const forecasts = await analyticsService.forecastLinkSaturation({
      deviceId: parseDeviceId(req.query.deviceId),
      lookbackDays: req.query.days,
      ceiling: req.query.ceiling,
    });
    res.json({ forecasts });
  }),
);

export default router;
