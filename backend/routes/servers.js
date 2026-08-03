import express from "express";
import rateLimit from "express-rate-limit";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { agentAuthMiddleware } from "../middleware/agentAuth.js";
import {
  serverMetricsHandler,
  serverMetricsBatchHandler,
} from "../handlers/serverMetricsHandler.js";
import { serverHistoryHandler } from "../handlers/serverHistoryHandler.js";
import agentService from "../services/agentService.js";
import { audit, clientInfo } from "../services/auditService.js";

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

// ── POST /api/servers/metrics/batch ─ backfill of samples buffered during an
// outage (agent bearer token). History only: writes InfluxDB + the on-site backup,
// never touches status or alerting. Shares the metric limiter — a reconnecting
// fleet sends a burst of these, and one batch replaces up to 60 live posts.
router.post("/metrics/batch", metricsLimiter, agentAuthMiddleware, serverMetricsBatchHandler);

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

// ── POST /api/servers/:id/maintenance ─ park/unpark a server (admin) ──────────
// Planned downtime: while parked, the offline sweep skips this server, threshold
// alerting is suppressed and a heartbeat won't flip its status — so a scheduled
// reboot doesn't page everyone. Body: { enabled: boolean }.
router.post("/:id/maintenance", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid server id." });
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ error: "Body must include a boolean `enabled`." });
    }

    const result = await agentService.setMaintenance(id, req.body.enabled);
    if (!result) return res.status(404).json({ error: "Server not found." });

    await audit({
      userId: req.user.id,
      module: "devices",
      action: req.body.enabled ? "start_maintenance" : "end_maintenance",
      description: `${req.body.enabled ? "Started" : "Ended"} maintenance for server "${result.name ?? `#${id}`}"`,
      level: "warning",
      ...clientInfo(req),
    });

    // Same event the offline sweep uses, so every open dashboard re-badges live.
    req.app.get("io")?.emit("serverStatus", { id, status: result.status });
    res.json({ success: true, status: result.status });
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

// ── DELETE /api/servers/:id ─ remove/decommission a server (admin) ────────────
// Cascades to server_specs/device_network/agent_tokens and revokes the token.
router.delete("/:id", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = await agentService.getServerById(id);
    const removed = await agentService.removeServer(id);
    if (!removed) return res.status(404).json({ error: "Server not found." });
    await audit({
      userId: req.user.id,
      module: "devices",
      action: "remove_server",
      description: `Removed server "${existing?.device_name ?? existing?.name ?? `#${id}`}" from monitoring`,
      level: "warning",
      ...clientInfo(req),
    });
    req.app.get("io")?.emit("serverRemoved", { id: +req.params.id });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
