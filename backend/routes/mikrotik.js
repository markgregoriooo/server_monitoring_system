import express from "express";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { networkHistoryHandler } from "../handlers/networkHistoryHandler.js";
import mikrotikPollerService from "../services/mikrotikPollerService.js";
import agentService from "../services/agentService.js";

const router = express.Router();

// Push one device's current shape to every open dashboard on the SHARED
// `networkMetrics` event, so an add / connection edit shows up live instead of only
// after the next 30s poll or a manual reload. The client merge treats every field as
// optional, so a payload without `interfaces` leaves existing port data alone.
async function emitDevice(io, id) {
  if (!io) return;
  try {
    const devices = await mikrotikPollerService.getMikrotikDevices();
    const device = devices.find((d) => Number(d.id) === Number(id));
    if (device) io.emit("networkMetrics", { device });
  } catch (err) {
    console.error("[mikrotik] emitDevice error:", err.message);
  }
}

// ── GET /api/mikrotik ─ the MikroTik(s) + latest live metrics, ports labeled by
//    building (JWT). Password is never returned — username only.
router.get("/", authMiddleware, async (req, res, next) => {
  try {
    res.json({ devices: await mikrotikPollerService.getMikrotikDevices() });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/mikrotik ─ register a new MikroTik (admin). Requires the migration
//    (devices.device_type ENUM must already include 'mikrotik').
router.post("/", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    const r = await mikrotikPollerService.createDevice(req.body ?? {});
    // 409 when the name is already taken, 400 for the rest.
    if (!r.ok) return res.status(r.status ?? 400).json({ error: r.error || "Create failed." });
    await emitDevice(req.app.get("io"), r.id);
    res.status(201).json({ id: r.id });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/mikrotik/:id/interfaces ─ port → label map (JWT) ─────────────────
router.get("/:id/interfaces", authMiddleware, async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid device id." });
  try {
    res.json({ interfaces: await mikrotikPollerService.getInterfaces(id) });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/mikrotik/:id/interfaces ─ set port labels + alerting (admin) ─────
// Body: { labels: [{ name, label, monitored? }] }. `monitored: false` silences
// interface-down alerts for that port; omitting it leaves the current setting alone.
// A blank label clears the label, and drops the row only when it holds nothing else.
router.put("/:id/interfaces", authMiddleware, requireRole("admin"), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid device id." });
  try {
    const r = await mikrotikPollerService.saveInterfaces(id, req.body?.labels);
    if (!r.ok) return res.status(400).json({ error: r.error || "Save failed." });
    // Push the relabelled ports to every dashboard without waiting for the next poll.
    await emitDevice(req.app.get("io"), id);
    res.json({ success: true, interfaces: await mikrotikPollerService.getInterfaces(id) });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/mikrotik/:id ─ decommission a MikroTik (admin) ────────────────
// Cascades to mikrotik_devices / network_interfaces / device_logs / alerts.
// Mirrors DELETE /api/network/:id on the router/UPS side.
router.delete("/:id", authMiddleware, requireRole("admin"), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid device id." });
  try {
    const removed = await mikrotikPollerService.removeDevice(id);
    if (!removed) return res.status(404).json({ error: "MikroTik not found." });
    req.app.get("io")?.emit("networkRemoved", { id });
    res.json({ success: true });
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
    await emitDevice(req.app.get("io"), id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/mikrotik/test ─ probe credentials BEFORE the device exists (admin).
// Used by the Add form so a login can be verified without persisting it first.
// One path segment, so it never collides with /:id/test below.
router.post("/test", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    res.json(await mikrotikPollerService.testConnection(null, req.body ?? {}));
  } catch (err) {
    next(err);
  }
});

// ── POST /api/mikrotik/:id/test ─ probe the API (admin).
// Body may carry credentials to test instead of the stored ones; an empty body tests
// exactly what is saved.
router.post("/:id/test", authMiddleware, requireRole("admin"), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid device id." });
  try {
    res.json(await mikrotikPollerService.testConnection(id, req.body ?? {}));
  } catch (err) {
    next(err);
  }
});

export default router;
