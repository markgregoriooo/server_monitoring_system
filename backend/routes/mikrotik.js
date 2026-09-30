import express from "express";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { networkHistoryHandler } from "../handlers/networkHistoryHandler.js";
import mikrotikPollerService from "../services/mikrotikPollerService.js";
import { getDeviceLogs } from "../services/deviceLogs.js";
import { describeError } from "../utils/httpError.js";

const router = express.Router();

// Send the device's current state to every dashboard on `networkMetrics`, so an add
// or edit shows up right away instead of at the next poll. Missing fields (such as
// `interfaces`) leave the existing data alone.
async function emitDevice(io, id) {
  if (!io) return;
  try {
    const devices = await mikrotikPollerService.getMikrotikDevices();
    const device = devices.find((d) => Number(d.id) === Number(id));
    if (device) io.emit("networkMetrics", { device });
  } catch (err) {
    console.error("[mikrotik] emitDevice error:", describeError(err));
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
    /* Log in and poll once right away. With a MikroTik, "no data yet" and "wrong
       password" look the same until something connects. Not awaited; the result comes
       through the usual broadcast, and the admin who added it is told how the first
       poll went (same as routes/network.js). */
    const io = req.app.get("io");
    const userId = req.user?.id;
    void mikrotikPollerService.pollDeviceNow(io, r.id).then(({ ok, reason }) => {
      if (!userId) return;
      io?.to(`user:${userId}`).emit("deviceFirstPoll", {
        id: r.id,
        name: String(req.body?.name ?? "").trim() || "MikroTik",
        kind: "mikrotik",
        ok,
        reason,
        mode: "api",
      });
    });
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
// Body: { labels: [{ name, label, monitored? }] }. `monitored: false` mutes
// interface-down alerts for that port; leaving it out keeps the current setting.
// A blank label clears the label.
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

// ── DELETE /api/mikrotik/:id ─ remove a MikroTik (admin) ──────────────────────
// Cascades to mikrotik_devices, network_interfaces, device_logs and alerts.
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
    res.json({ logs: await getDeviceLogs(id) });
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

// ── POST /api/mikrotik/test ─ test credentials before the device exists (admin).
// Used by the Add form.
router.post("/test", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    res.json(await mikrotikPollerService.testConnection(null, req.body ?? {}));
  } catch (err) {
    next(err);
  }
});

// ── POST /api/mikrotik/:id/test ─ test the API connection (admin).
// The body may carry credentials to test; an empty body tests the saved ones.
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
