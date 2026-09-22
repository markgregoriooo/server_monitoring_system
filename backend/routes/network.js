import express from "express";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { networkHistoryHandler } from "../handlers/networkHistoryHandler.js";
import snmpPollerService from "../services/snmpPollerService.js";
import { probe } from "../services/deviceProbe.js";
import { getDeviceLogs } from "../services/deviceLogs.js";

const router = express.Router();

// Tell the admin who registered a device how its FIRST poll went.
//
// `pollDeviceNow` is fire-and-forget by design — the response must not be held behind an
// SNMP timeout — which used to mean its verdict reached the server console and nobody
// else. Registering a device with a wrong IP, a wrong community or a blocked UDP 161 was
// therefore indistinguishable from registering a healthy one: both showed a card that
// said Offline, and an admin had no way to know whether to wait or to go and fix it.
//
// Addressed to `user:<id>` (the room connectionHandler joins every browser socket to)
// rather than broadcast: this is feedback on one person's action, and the other dashboards
// already get the device itself through networkMetrics/networkStatus.
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

// ── POST /api/network/test ─ probe an address BEFORE registering it (admin) ───
//
// Declared before every `/:id` route so a literal path can never be parsed as an id.
//
// Nothing is persisted. The Add form calls this so a wrong IP, a wrong community or a
// blocked UDP 161 is caught while the admin is still looking at the field that caused
// it — rather than becoming a device that sits Offline with no explanation. Same engine
// as `npm run probe` and as the poller itself, so a pass here means the poller will
// succeed for the same reasons.
//
// A blank community is passed through as blank on purpose: that is the ICMP-monitoring
// choice, and what has to be verified for it is ICMP. See services/deviceProbe.js.
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
    /* Poll it once, RIGHT NOW, without waiting for the next cycle. Fire-and-forget on
       purpose: the response must not be held behind an SNMP timeout (up to several seconds
       on a wrong IP), and the result arrives on its own through the same `networkMetrics`
       broadcast the poller already uses. So the panel fills in a second or two rather than
       up to a minute, and a wrong IP/community/port shows as Offline immediately instead of
       being indistinguishable from "the poller has not got round to it yet".
       The interval itself is untouched — see pollDeviceNow.
       Its verdict now also goes back to the admin who did this — see reportFirstPoll. */
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

// ── PATCH /api/network/:id/interfaces ─ name one discovered port (admin) ──────
// Body: { interfaceName, locationLabel }. The poller discovers the ports; this puts
// a human label on one ("ether3" → "Uplink to admin building"). 404 when the pair
// isn't a discovered interface, so a typo can't create an orphan row.
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
