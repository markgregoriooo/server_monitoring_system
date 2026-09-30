import express from "express";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { networkHistoryHandler } from "../handlers/networkHistoryHandler.js";
import snmpPollerService from "../services/snmpPollerService.js";
import { probe } from "../services/deviceProbe.js";
import { getDeviceLogs } from "../services/deviceLogs.js";

const router = express.Router();

// Tell the admin who registered a device how its first poll went. pollDeviceNow is
// not awaited, so without this a wrong IP or community only showed up in the
// server console. Sent to that admin's room (user:<id>) only.
function reportFirstPoll(req, kind, device) {
  const io = req.app.get("io");
  const userId = req.user?.id;
  void snmpPollerService.pollDeviceNow(io, device.id).then(({ ok, reason }) => {
    if (!userId) return;
    io?.to(`user:${userId}`).emit("deviceFirstPoll", {
      id: device.id,
      name: device.name,
      kind,
      ok,
      reason,
      // A ping-only router that answered ICMP is a SUCCESS, and its card will never
      // carry interfaces — so the client must not read an empty port list as a failure.
      mode: device.mode ?? "snmp",
    });
  });
}

// ── GET /api/network ─ router/switch list with latest live metrics (JWT) ──────
router.get("/", authMiddleware, async (req, res, next) => {
  try {
    res.json({ devices: await snmpPollerService.getNetworkDevices() });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/network/test ─ test an address before registering it (admin) ───
// Declared before the /:id routes. Saves nothing. Uses the same code as the poller
// and `npm run probe`, so a pass here means polling will work. A blank community
// means ICMP monitoring, so only ping is checked. See services/deviceProbe.js.
router.post("/test", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    res.json(
      await probe(req.body?.ip, {
        community: req.body?.community ?? "",
        port: req.body?.snmpPort,
        expect: "router",
      }),
    );
  } catch (err) {
    next(err);
  }
});

// ── POST /api/network ─ register a router/switch for SNMP monitoring (admin) ──
// Polled IMMEDIATELY on registration, then on the normal cycle — no restart.
router.post("/", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    const device = await snmpPollerService.addNetworkDevice(req.body || {});
    // Broadcast so other open dashboards insert it live (reuses the metrics merge).
    req.app.get("io")?.emit("networkMetrics", { device });
    /* Poll once right away instead of waiting for the next cycle. Not awaited, so the
       response is not held up by an SNMP timeout; the result comes through the usual
       `networkMetrics` broadcast. The admin is told the outcome (reportFirstPoll). */
    reportFirstPoll(req, "router", device);
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

// ── PATCH /api/network/:id/interfaces ─ label one discovered port (admin) ─────
// Body: { interfaceName, locationLabel }, e.g. "ether3" → "Uplink to admin building".
// 404 if the port was never discovered.
router.patch("/:id/interfaces", authMiddleware, requireRole("admin"), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid device id." });
  try {
    const updated = await snmpPollerService.setInterfaceLabel(
      id,
      req.body?.interfaceName,
      req.body?.locationLabel,
    );
    if (!updated) return res.status(404).json({ error: "No such interface on this device." });
    req.app.get("io")?.emit("networkInterfaceLabel", { id, ...updated });
    res.json({ interface: updated });
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
    res.json({ logs: await getDeviceLogs(id) });
  } catch (err) {
    next(err);
  }
});

export default router;
