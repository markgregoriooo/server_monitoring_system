import express from "express";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { networkHistoryHandler } from "../handlers/networkHistoryHandler.js";
import mikrotikPollerService from "../services/mikrotikPollerService.js";
import agentService from "../services/agentService.js";

const router = express.Router();

// ── GET /api/mikrotik ─ the MikroTik(s) + latest live metrics, ports labeled by
//    building (JWT). Password is never returned — username only.
router.get("/", authMiddleware, async (req, res, next) => {
  try {
    res.json({ devices: await mikrotikPollerService.getMikrotikDevices() });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/mikrotik/:id/history ─ total throughput from InfluxDB (JWT).
//    Reuses the shared network_traffic handler (filters by device_id only).
router.get("/:id/history", authMiddleware, networkHistoryHandler);

// ── GET /api/mikrotik/:id/logs ─ device event log (JWT).
router.get("/:id/logs", authMiddleware, async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid device id." });
  try {
    res.json({ logs: await agentService.getDeviceLogs(id) });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/mikrotik/:id/connection ─ set API connection (admin). Encrypts the
//    password before storing; the password is write-only (never read back).
router.put("/:id/connection", authMiddleware, requireRole("admin"), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid device id." });
  try {
    const r = await mikrotikPollerService.saveConnection(id, req.body ?? {});
    if (!r.ok) {
      return res.status(r.error === "Nothing to update." ? 400 : 404).json({ error: r.error || "Update failed." });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/mikrotik/:id/test ─ probe the API with the stored creds (admin).
router.post("/:id/test", authMiddleware, requireRole("admin"), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid device id." });
  try {
    res.json(await mikrotikPollerService.testConnection(id));
  } catch (err) {
    next(err);
  }
});

export default router;
