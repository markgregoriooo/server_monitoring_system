import express from "express";
import crypto from "crypto";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import agentService from "../services/agentService.js";

const router = express.Router();

// Constant-time comparison of the shared install key. Fails closed when
// AGENT_INSTALL_KEY is not configured in the backend .env.
function validInstallKey(provided) {
  const expected = process.env.AGENT_INSTALL_KEY;
  if (!expected || typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── POST /api/agents/register ─ first-run enrollment (install key, no JWT) ─────
router.post("/register", async (req, res, next) => {
  if (!validInstallKey(req.body?.install_key)) {
    return res.status(401).json({ error: "Invalid install key." });
  }
  if (!req.body?.hostname) {
    return res.status(400).json({ error: "hostname is required." });
  }
  try {
    const { pendingToken, deviceId, reused } = await agentService.register(req.body);
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
    req.app.get("io")?.emit("agentPending", { id: +req.params.id });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
