import express from "express";
import rateLimit from "express-rate-limit";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import agentService from "../services/agentService.js";
import installKeyService from "../services/installKeyService.js";
import alertsService from "../services/alertsService.js";
import alertBandState from "../services/alertBandState.js";
import { audit, clientInfo } from "../services/auditService.js";
import { logSafe } from "../utils/logSafe.js";

const router = express.Router();

// Enrollment takes an install key, which is a credential, so it gets a tighter
// limit than the global one. Still enough for a real rollout, and it slows down
// guessing.
const enrollLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  ipv6Subnet: 56,
  handler: (req, res) => {
    res.status(429).json({ error: "Too many enrollment attempts. Please try again later." });
  },
});

// Rate limit for approval polling. The agent polls every 10s while it waits, so one
// agent uses ~90 requests per window; 600 allows several agents behind one NAT.
const statusLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AGENT_STATUS_RATE_MAX) || 600,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  ipv6Subnet: 56,
  handler: (req, res) => {
    console.warn(`[RATE] 429 agent status poll from ${req.ip}`);
    res.status(429).json({ error: "Too many status checks. Please try again later." });
  },
});

// ── POST /api/agents/register ─ first-run enrollment (install key, no JWT) ─────
router.post("/register", enrollLimiter, async (req, res, next) => {
  // Keys live in `agent_install_keys` (managed by admins, revocable). AGENT_INSTALL_KEY
  // in .env still works as a deprecated fallback for a fresh database with no admin
  // yet. See services/installKeyService.js.
  let resolved;
  try {
    resolved = await installKeyService.resolveKey(req.body?.install_key);
  } catch (err) {
    return next(err);
  }
  if (!resolved.ok) {
    // The log says which check failed (unknown / revoked / expired); the response does
    // not, so a caller cannot probe which keys exist.
    console.warn(
      `[install-keys] enrollment refused (${resolved.reason}) from ${req.ip} ` +
        `host="${logSafe(req.body?.hostname ?? "?", 60)}"`,
    );
    return res.status(401).json({ error: "Invalid install key." });
  }
  if (!req.body?.hostname) {
    return res.status(400).json({ error: "hostname is required." });
  }
  try {
    // The key id is stored on the enrollment (agent_tokens.install_key_id), which is
    // what lets an admin later revoke a key AND the servers it let in.
    const { pendingToken, deviceId, reused } = await agentService.register(req.body, resolved.keyId);
    // Not awaited: enrollment already succeeded, a failed counter update must not fail it.
    installKeyService.noteUsed(resolved.keyId);
    const io = req.app.get("io");
    // Tell open dashboards a pending agent appeared so admins see it live.
    io?.emit("agentPending", { id: deviceId });
    if (!reused) {
      const ev = await agentService.logDevice(
        deviceId,
        "info",
        `Agent registered from "${req.body.hostname}" — awaiting approval`,
      );
      if (ev) io?.emit("deviceLog", ev);
    }
    res.status(201).json({
      pending_token: pendingToken,
      device_id: deviceId,
      message: "Registered. Awaiting administrator approval.",
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/agents/status ─ agent polls for approval (pending token, no JWT) ─
// POST with the token in the body: the pending token is exchanged here for the
// permanent AGT- token, and a query string would end up in access logs. No extra
// limiter beyond statusLimiter: the token is 192 random bits.
router.post("/status", statusLimiter, async (req, res, next) => {
  const token = req.body?.pending_token;
  if (!token) return res.status(400).json({ error: "pending_token is required." });
  try {
    const result = await agentService.getStatusByPendingToken(String(token));
    if (!result) return res.status(404).json({ error: "Unknown pending token." });
    res.json({
      status: result.status,
      approved_token: result.approved_token,
      device_id: result.device_id,
    });
  } catch (err) {
    next(err);
  }
});

// ── Install keys (admin) ──────────────────────────────────────────────────────

// GET /api/agents/install-keys ─ list keys (never the plaintext, which is gone)
router.get("/install-keys", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    res.json({ keys: await installKeyService.list() });
  } catch (err) {
    next(err);
  }
});

// POST /api/agents/install-keys ─ mint a key. The response is the ONLY time the
// plaintext exists outside the installer command — only its hash is stored.
router.post("/install-keys", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    const { key, record } = await installKeyService.create({
      label: req.body?.label,
      expiresInDays: req.body?.expiresInDays ?? null,
      userId: req.user.id,
    });
    await audit({
      userId: req.user.id,
      module: "devices",
      action: "create_install_key",
      description:
        `Created agent install key "${record.label}" (${record.keyPrefix}…)` +
        (record.expiresAt ? `, expires ${record.expiresAt}` : ", no expiry"),
      ...clientInfo(req),
    });
    res.status(201).json({ key, record });
  } catch (err) {
    next(err);
  }
});

// GET /api/agents/install-keys/:id/reveal ─ show the key again so the install
// command can be reopened. Admin-only and audited.
router.get("/install-keys/:id/reveal", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    const result = await installKeyService.reveal(req.params.id);
    if (!result) return res.status(404).json({ error: "Install key not found." });
    if (result.unavailable) {
      return res.status(409).json({
        error: "This key cannot be shown again — it was created before keys were recoverable.",
      });
    }
    await audit({
      userId: req.user.id,
      module: "devices",
      action: "reveal_install_key",
      description: `Viewed the install key "${result.label}"`,
      ...clientInfo(req),
    });
    res.json({ key: result.key, label: result.label, revoked: result.revoked });
  } catch (err) {
    next(err);
  }
});

// GET /api/agents/install-keys/:id/servers ─ servers this key enrolled that are
// still reporting, listed by name in the revoke dialog.
router.get("/install-keys/:id/servers", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    res.json({ servers: await installKeyService.enrolledServers(req.params.id) });
  } catch (err) {
    next(err);
  }
});

// POST /api/agents/install-keys/:id/revoke ─ withdraw a key.
//
// Body: { revokeAgents?: boolean }
//   false / omitted → only blocks new enrollments; enrolled servers keep working
//                     (they use their own AGT- token).
//   true            → also revokes the servers this key enrolled: their next POST
//                     gets 403 and the agent removes its agent.conf and exits. The
//                     device, its logs and history are kept; re-installing with a
//                     valid key brings it back on the same device_id.
router.post("/install-keys/:id/revoke", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    const revokeAgents = req.body?.revokeAgents === true;
    const record = await installKeyService.revoke(req.params.id, req.user.id, { revokeAgents });
    if (!record) return res.status(404).json({ error: "Install key not found." });

    const io = req.app.get("io");
    for (const s of record.cutOff) {
      // Re-arm the detectors so a re-enrolled server alerts cleanly instead of being
      // swallowed as "same band as before it was cut off".
      alertBandState.resetDevice(s.id);
      // Its open "offline" incident is now expected, not a fault to chase.
      await alertsService.autoResolveMetric(s.id, "offline").catch(() => {});
      const ev = await agentService.logDevice(
        s.id,
        "warning",
        `Monitoring revoked — install key "${record.label}" was revoked by ${req.user?.name ?? "admin"}`,
      );
      if (ev) io?.emit("deviceLog", ev);
      // The server list INNER JOINs approved tokens, so it drops off the dashboard —
      // same event the delete path uses, so open pages update without a refresh.
      io?.emit("serverRemoved", { id: s.id });
    }

    await audit({
      userId: req.user.id,
      module: "devices",
      action: "revoke_install_key",
      description:
        `Revoked agent install key "${record.label}" (${record.keyPrefix}…) — enrolled ${record.useCount} agent(s)` +
        (revokeAgents
          ? `; de-authorised ${record.cutOff.length} server(s): ${record.cutOff.map((s) => s.name).join(", ") || "none"}`
          : "; running agents left untouched"),
      level: "warning",
      ...clientInfo(req),
    });
    res.json({ success: true, record, cutOff: record.cutOff });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/agents/install-keys/:id ─ remove a revoked key from the list.
// Must be revoked first. Servers it enrolled keep running (the FK is ON DELETE SET NULL).
router.delete("/install-keys/:id", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    const result = await installKeyService.remove(req.params.id);
    if (!result) return res.status(404).json({ error: "Install key not found." });
    if (result.blocked) {
      return res.status(400).json({ error: "Revoke the key before deleting it." });
    }
    await audit({
      userId: req.user.id,
      module: "devices",
      action: "delete_install_key",
      description: `Deleted revoked install key "${result.label}" (${result.keyPrefix}…) — had enrolled ${result.useCount} agent(s)`,
      level: "warning",
      ...clientInfo(req),
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/agents/pending ─ admin: list servers awaiting approval ───────────
router.get("/pending", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    res.json({ pending: await agentService.listPending() });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/agents/:id/approve ─ admin approves a pending agent ─────────────
router.post("/:id/approve", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    const result = await agentService.approve(parseInt(req.params.id, 10));
    if (!result) return res.status(404).json({ error: "No pending agent for that device." });
    const io = req.app.get("io");
    const ev = await agentService.logDevice(
      +req.params.id,
      "info",
      `Monitoring approved by ${req.user?.name ?? "admin"}`,
    );
    if (ev) io?.emit("deviceLog", ev);
    await audit({
      userId: req.user.id,
      module: "devices",
      action: "approve_server",
      description: `Approved monitoring agent "${result.deviceName ?? `#${req.params.id}`}"`,
      ...clientInfo(req),
    });
    io?.emit("agentApproved", { id: +req.params.id, name: result.deviceName });
    res.json({ success: true, device_name: result.deviceName });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/agents/:id/reject ─ admin rejects a pending agent ───────────────
router.post("/:id/reject", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    const ok = await agentService.reject(parseInt(req.params.id, 10));
    if (!ok) return res.status(404).json({ error: "No pending agent for that device." });
    await audit({
      userId: req.user.id,
      module: "devices",
      action: "reject_server",
      description: `Rejected pending monitoring agent #${req.params.id}`,
      level: "warning",
      ...clientInfo(req),
    });
    req.app.get("io")?.emit("agentPending", { id: +req.params.id });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
