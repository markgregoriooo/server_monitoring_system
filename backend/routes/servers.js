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

// Agent metric ingestion gets TWO limiters, because one cannot do both jobs.
//
// This used to be a single IP-keyed limiter at 1000/15min, described as "generous
// headroom even for several agents behind one NAT IP". The arithmetic says otherwise:
// an agent at the default `-interval 10` posts 6/min = 90 per window, so the budget
// ran out at ~11 agents sharing a public IP. Past that, agents 429 and metrics are
// dropped SILENTLY — it looks like servers randomly stopping, not like a limit.
//
//   OUTER (metricsIpLimiter)  keyed by IP, runs BEFORE agentAuth. The only thing between
//                             an unauthenticated flood and the token lookup, because the
//                             global browser limiter deliberately skips this path
//                             (src/server.js). Sized for the WHOLE fleet, since every
//                             agent behind the campus NAT shares one IP.
//   INNER (metricsAgentLimiter) keyed by DEVICE, runs AFTER agentAuth. The real quota:
//                             one misconfigured agent hammering the endpoint is throttled
//                             on its own without taking the rest of the fleet with it.
//
// Both tiers are needed. Device-keying alone would leave the pre-auth path unlimited;
// IP-keying alone is the bug above.
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
  // Runs after agentAuthMiddleware, so req.device is set. It cannot be absent here —
  // an unauthenticated request never reaches this middleware — but fall back to the IP
  // rather than to a single shared `undefined` bucket if the order is ever changed.
  // The IP fallback goes through ipKeyGenerator, never raw req.ip. A raw IPv6 address
  // is one address out of a /64 the same host owns, so an attacker could rotate through
  // them for unlimited budget — the exact hazard CLAUDE.md documents for the global
  // limiter. express-rate-limit detects the raw form and warned about it at every boot
  // (ERR_ERL_KEY_GEN_IPV6). Unreachable in practice (agentAuthMiddleware runs first), but
  // an unreachable branch is exactly where this kind of thing survives a refactor.
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
// outage (agent bearer token). History only: writes InfluxDB + the on-site backup,
// never touches status or alerting. Shares the metric limiter — a reconnecting
// fleet sends a burst of these, and one batch replaces up to 60 live posts.
router.post(
  "/metrics/batch",
  metricsIpLimiter,
  agentAuthMiddleware,
  metricsAgentLimiter,
  serverMetricsBatchHandler,
);

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
