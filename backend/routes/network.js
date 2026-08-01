import express from "express";
import { authMiddleware } from "../middleware/auth.js";
import { networkHistoryHandler } from "../handlers/networkHistoryHandler.js";
import snmpPollerService from "../services/snmpPollerService.js";
import agentService from "../services/agentService.js";

const router = express.Router();

// ── GET /api/network ─ router/switch list with latest live metrics (JWT) ──────
router.get("/", authMiddleware, async (req, res, next) => {
  try {
    res.json({ devices: await snmpPollerService.getNetworkDevices() });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/network/:id/history ─ total throughput from InfluxDB (JWT) ───────
router.get("/:id/history", authMiddleware, networkHistoryHandler);

// ── GET /api/network/:id/logs ─ device event log from device_logs (JWT) ───────
router.get("/:id/logs", authMiddleware, async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid device id." });
  try {
    res.json({ logs: await agentService.getDeviceLogs(id) });
  } catch (err) {
    next(err);
  }
});

export default router;
