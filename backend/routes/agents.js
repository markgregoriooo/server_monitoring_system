import express from "express";
import rateLimit from "express-rate-limit";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import agentService from "../services/agentService.js";
import installKeyService from "../services/installKeyService.js";
import alertsService from "../services/alertsService.js";
import alertBandState from "../services/alertBandState.js";
import { audit, clientInfo } from "../services/auditService.js";

const router = express.Router();

// Enrollment is now the only route that accepts a credential which is not a JWT and
// not an agent token, and there can be SEVERAL valid install keys rather than the one
// constant there used to be. The global limiter (500/15min) is sized for a dashboard
// loading panels, not for guarding a credential, so this path gets its own tighter
// budget. Generous enough for a real rollout — nobody installs 30 agents from one
// machine in 15 minutes — and it also caps how fast a wrong key can be retried.
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

// ── POST /api/agents/register ─ first-run enrollment (install key, no JWT) ─────
router.post("/register", enrollLimiter, async (req, res, next) => {
  // Keys live in `agent_install_keys` (admin-managed, revocable). AGENT_INSTALL_KEY in
  // .env still works as a deprecated bootstrap fallback — a fresh database has neither
  // a key nor an admin to mint one. See services/installKeyService.js.
  let resolved;
  try {
    resolved = await installKeyService.resolveKey(req.body?.install_key);
  } catch (err) {
    return next(err);
  }
  if (!resolved.ok) {
    // The log names WHICH failure; the response does not. An installer operator
    // learning "revoked" vs "unknown" would learn whether a key exists at all, but
    // the admin reading this log needs to know whether to re-issue or extend.
    console.warn(
      `[install-keys] enrollment refused (${resolved.reason}) from ${req.ip} ` +
        `host="${String(req.body?.hostname ?? "?").slice(0, 60)}"`,
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
    // Best-effort counter, deliberately not awaited — the enrollment has already
    // succeeded and a failed bump must not turn that into an error.
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

// ── GET /api/agents/status?pending_token=… ─ agent polls for approval ─────────
router.get("/status", async (req, res, next) => {
  const token = req.query.pending_token;
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
// Declared before the `/:id/...` routes below purely for readability — these paths
// are literal, so Express would not confuse them either way.

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

// GET /api/agents/install-keys/:id/reveal ─ the plaintext key again, for re-opening the
// install command. The only endpoint that ever returns a key after creation, so it is
// admin-gated AND audited: with keys recoverable, "who looked at this credential" is the
// question the audit trail has to be able to answer.
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

// GET /api/agents/install-keys/:id/servers ─ which servers this key enrolled and are
// still reporting. The revoke dialog shows these BY NAME before doing anything: a count
// tells an admin how much breaks, but not whether the production box is in the list.
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
//   false / omitted → block NEW enrolments only; every server already reporting is
//                     untouched (it runs on its own AGT- token, not on this key).
//   true            → also de-authorise the servers this key enrolled: their tokens go
//                     to 'revoked', the next metric POST 403s, and each agent deletes
//                     its own agent.conf and exits. Reversible by re-installing with a
//                     live key — the device row, its logs and its history are kept, and
//                     the machine re-enrols onto the same device_id.
//
// Opt-in rather than automatic: "stop issuing this key" and "de-authorise its whole
// fleet" are both legitimate, and they differ by a lot of monitoring going dark.
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

// DELETE /api/agents/install-keys/:id ─ remove a REVOKED key from the list.
//
// Revoke first, then delete: revoking is the decision that can take servers down, and
// hiding it behind a "delete" button would put that consequence behind a label that
// says nothing about it. Servers this key enrolled keep running and simply become
// unattributed (the FK is ON DELETE SET NULL).
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
