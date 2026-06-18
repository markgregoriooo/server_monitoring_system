import express from "express";
import rateLimit from "express-rate-limit";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { agentAuthMiddleware } from "../middleware/agentAuth.js";
import { serverMetricsHandler } from "../handlers/serverMetricsHandler.js";
import { serverHistoryHandler } from "../handlers/serverHistoryHandler.js";
import agentService from "../services/agentService.js";

const router = express.Router();

// Dedicated limiter for agent metric ingestion. Agents POST every ~10s (≈90 per
// 15-min window), so this is generous headroom even for several agents behind one
// NAT IP plus retry bursts — while still capping an unauthenticated flood on this
// route. The global browser limiter SKIPS this path (see src/server.js) so agent
// traffic never eats into the dashboard's request budget.
const metricsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  ipv6Subnet: 56,
  handler: (req, res) => {
    res.status(429).json({ error: "Too many metric posts. Slow down." });
  },
});

// ── POST /api/servers/metrics ─ Go agent metric ingestion (agent bearer token) ─
// Authenticated by the agent token, NOT a user JWT.
router.post("/metrics", metricsLimiter, agentAuthMiddleware, serverMetricsHandler);

// ── GET /api/servers ─ dashboard server list (JWT) ────────────────────────────
router.get("/", authMiddleware, async (req, res, next) => {
  try {
    res.json({ servers: await agentService.getServers() });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/servers/:id/history ─ real metric history from InfluxDB (JWT) ────
router.get("/:id/history", authMiddleware, serverHistoryHandler);

// ── GET /api/servers/:id/logs ─ device event log from MySQL device_logs (JWT) ─
router.get("/:id/logs", authMiddleware, async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid server id." });
  try {
    res.json({ logs: await agentService.getDeviceLogs(id) });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/servers/:id ─ single server detail (JWT) ─────────────────────────
router.get("/:id", authMiddleware, async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid server id." });
  try {
    const server = await agentService.getServerById(id);
    if (!server) return res.status(404).json({ error: "Server not found." });
    res.json({ server });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/servers/:id ─ rename a server / set display label (admin) ──────
// Sets devices.display_name (the friendly label); a blank value clears it so the
// UI falls back to the real hostname. Leaves device_name (the hostname) untouched.
// Broadcasts serverRenamed so every dashboard updates the label live.
router.patch("/:id", authMiddleware, requireRole("admin"), async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid server id." });

  const raw = req.body?.displayName;
  if (typeof raw !== "string") return res.status(400).json({ error: "displayName must be a string." });
  const displayName = raw.trim();
  if (displayName.length > 100) {
    return res.status(400).json({ error: "Display name must be 100 characters or fewer." });
  }

  try {
    const result = await agentService.renameServer(id, displayName);
    if (!result) return res.status(404).json({ error: "Server not found." });

    const io = req.app.get("io");
    const ev = await agentService.logDevice(
      id,
      "info",
      displayName
        ? `Renamed to "${result.name}" by ${req.user?.name ?? "admin"}`
        : `Display label cleared by ${req.user?.name ?? "admin"} — using hostname "${result.hostname}"`,
    );
    if (ev) io?.emit("deviceLog", ev);
    io?.emit("serverRenamed", {
      id,
      name: result.name,
      displayName: result.displayName,
      hostname: result.hostname,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/servers/:id ─ remove/decommission a server (admin) ────────────
// Cascades to server_specs/device_network/agent_tokens and revokes the token.
router.delete("/:id", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    const removed = await agentService.removeServer(parseInt(req.params.id, 10));
    if (!removed) return res.status(404).json({ error: "Server not found." });
    req.app.get("io")?.emit("serverRemoved", { id: +req.params.id });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
