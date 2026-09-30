import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
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

// Agent metric posts get two limiters:
//   metricsIpLimiter     by IP, before agentAuth. Protects the token lookup from
//                        unauthenticated floods; sized for the whole fleet behind
//                        the campus NAT.
//   metricsAgentLimiter  by device, after agentAuth. One misbehaving agent is
//                        throttled without affecting the others.
// A single IP limiter ran out at about 11 agents behind one IP.
const AGENT_IP_MAX = Number(process.env.AGENT_RATE_IP_MAX) || 5000; // ≈55 agents @ 10s
const AGENT_DEVICE_MAX = Number(process.env.AGENT_RATE_MAX) || 300; // one agent @ ≥3s

const metricsIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: AGENT_IP_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  ipv6Subnet: 56,
  handler: (req, res) => {
    console.warn(`[RATE] 429 agent ingest (ip) ${req.ip} — over ${AGENT_IP_MAX}/15min`);
    res.status(429).json({ error: "Too many metric posts. Slow down." });
  },
});

const metricsAgentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: AGENT_DEVICE_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  // Runs after agentAuthMiddleware, so req.device is set. Falls back to the IP (via
  // ipKeyGenerator, never raw req.ip) in case the middleware order ever changes.
  keyGenerator: (req) =>
    req.device?.device_id != null
      ? `agent:${req.device.device_id}`
      : `ip:${ipKeyGenerator(req.ip, 56)}`,
  handler: (req, res) => {
    console.warn(
      `[RATE] 429 agent ingest device=${req.device?.device_id} — over ${AGENT_DEVICE_MAX}/15min. ` +
        `Check that agent's -interval.`,
    );
    res.status(429).json({ error: "Too many metric posts. Slow down." });
  },
});

// ── POST /api/servers/metrics ─ Go agent metric ingestion (agent bearer token) ─
// Authenticated by the agent token, NOT a user JWT.
router.post("/metrics", metricsIpLimiter, agentAuthMiddleware, metricsAgentLimiter, serverMetricsHandler);

// ── POST /api/servers/metrics/batch ─ backfill of samples buffered during an
// outage (agent token). History only: InfluxDB and the backup, no status or
// alerts. Shares the metric limiter; one batch replaces up to 60 posts.
router.post(
  "/metrics/batch",
  metricsIpLimiter,
  agentAuthMiddleware,
  metricsAgentLimiter,
  serverMetricsBatchHandler,
);

// ── Heartbeat + shutdown notice (agent bearer token) ───────────────────────────
// Heartbeats come every 2s, so they have their own limiters instead of the metric
// ones: per device about one every 0.75s, per IP enough for ~70 agents behind a NAT.
const BEAT_DEVICE_MAX = Number(process.env.AGENT_BEAT_RATE_MAX) || 1200;
const BEAT_IP_MAX = Number(process.env.AGENT_BEAT_RATE_IP_MAX) || 30000;

const beatIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: BEAT_IP_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  ipv6Subnet: 56,
  handler: (req, res) => {
    console.warn(`[RATE] 429 agent heartbeat (ip) ${req.ip} — over ${BEAT_IP_MAX}/15min`);
    res.status(429).json({ error: "Too many heartbeats. Slow down." });
  },
});

const beatAgentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: BEAT_DEVICE_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.device?.device_id != null
      ? `beat:${req.device.device_id}`
      : `beatip:${ipKeyGenerator(req.ip, 56)}`,
  handler: (req, res) => {
    console.warn(`[RATE] 429 agent heartbeat device=${req.device?.device_id} — over ${BEAT_DEVICE_MAX}/15min`);
    res.status(429).json({ error: "Too many heartbeats. Slow down." });
  },
});

// ── POST /api/servers/heartbeat ─ "still alive", nothing else. No body. ────────
router.post("/heartbeat", beatIpLimiter, agentAuthMiddleware, beatAgentLimiter, (req, res) => {
  agentService.noteHeartbeat(req.device.device_id);
  res.status(204).end();
});

// ── POST /api/servers/shutdown ─ the agent is going away. Body: { reason } ─────
// "shutdown" (the OS is shutting down or restarting) or "stopped" (only the agent).
// Marks the server offline and raises a critical alert right away.
router.post("/shutdown", beatIpLimiter, agentAuthMiddleware, beatAgentLimiter, async (req, res, next) => {
  try {
    const { rows, alert } = await agentService.recordShutdown(req.device.device_id, req.body?.reason);
    await agentService.announceOffline(req.app.get("io"), rows, alert);
    if (rows.length > 0) {
      console.warn(`[SHUTDOWN] server ${req.device.device_id} — ${alert.title}`);
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

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
// While parked the offline sweep skips it, threshold alerts are off and heartbeats
// do not change its status, so a planned reboot does not alert. Body: { enabled }.
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

// ── PATCH /api/servers/:id ─ set the display name (admin) ─────────────────────
// Sets devices.display_name; blank clears it and the hostname is shown again.
// Broadcasts serverRenamed so every dashboard updates.
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
