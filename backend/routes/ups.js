import express from "express";
import { authMiddleware, requireRole } from "../middleware/auth.js";
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

// ── POST /api/ups ─ register a UPS (with SNMP/network card) for monitoring (admin)
// The poller picks it up on its next cycle (≤ SNMP_POLL_INTERVAL_MS) — no restart.
router.post("/", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    const device = await snmpPollerService.addUpsDevice(req.body || {});
    // Broadcast so other open dashboards insert it live (reuses the metrics merge).
    req.app.get("io")?.emit("upsMetrics", { ups: device });
    res.status(201).json({ device });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/ups/:id ─ decommission a UPS (admin) ──────────────────────────
router.delete("/:id", authMiddleware, requireRole("admin"), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid device id." });
  try {
    const removed = await snmpPollerService.removeDevice(id, "ups");
    if (!removed) return res.status(404).json({ error: "UPS not found." });
    req.app.get("io")?.emit("upsRemoved", { id });
    res.json({ success: true });
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
