import express from "express";
import { authMiddleware } from "../middleware/auth.js";
import { upsHistoryHandler } from "../handlers/upsHistoryHandler.js";
import snmpPollerService from "../services/snmpPollerService.js";
import agentService from "../services/agentService.js";

const router = express.Router();

// ── GET /api/ups ─ UPS list with latest live battery/load/status (JWT) ────────
router.get("/", authMiddleware, async (req, res, next) => {
  try {
    res.json({ devices: await snmpPollerService.getUpsDevices() });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/ups/:id/history ─ battery/load/voltage history (JWT) ─────────────
router.get("/:id/history", authMiddleware, upsHistoryHandler);

// ── GET /api/ups/:id/logs ─ device event log from device_logs (JWT) ───────────
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
