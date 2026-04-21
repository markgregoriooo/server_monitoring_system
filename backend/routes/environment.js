import express from "express";
import { generateSensorHistory, historyLogs } from "../data/db.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();

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
