import express from "express";
import { authMiddleware, requireRole } from "../middleware/auth.js";
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

// ── POST /api/network ─ register a router/switch for SNMP monitoring (admin) ──
// The poller picks it up on its next cycle (≤ SNMP_POLL_INTERVAL_MS) — no restart.
router.post("/", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    const device = await snmpPollerService.addNetworkDevice(req.body || {});
    // Broadcast so other open dashboards insert it live (reuses the metrics merge).
    req.app.get("io")?.emit("networkMetrics", { device });
    res.status(201).json({ device });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/network/:id ─ decommission a router/switch (admin) ────────────
router.delete("/:id", authMiddleware, requireRole("admin"), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid device id." });
  try {
    const removed = await snmpPollerService.removeDevice(id, "router");
    if (!removed) return res.status(404).json({ error: "Router not found." });
    req.app.get("io")?.emit("networkRemoved", { id });
    res.json({ success: true });
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
