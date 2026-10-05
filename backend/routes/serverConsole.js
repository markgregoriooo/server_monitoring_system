import express from "express";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import consoleCommands from "../services/consoleCommands.js";
import sshConsole from "../services/sshConsole.js";
import { loginTo } from "../services/sshConsole.js";
import { audit, clientInfo } from "../services/auditService.js";
import { logSafe } from "../utils/logSafe.js";

/**
 * Server Console — Quick Actions over HTTP (mounted at /api/servers).
 *
 *   GET    /:id/console              catalog for this server's OS + the pinned host key   admin, it_staff
 *   POST   /:id/console/actions      run one Quick Action                                 admin, it_staff*
 *   DELETE /:id/console/host-key     forget the pinned SSH host key                       admin
 *
 *   * it_staff may run only the read-only ("info") actions — consoleCommands.roleMayRun.
 *
 * The interactive Web Terminal is a Socket.IO concern (sockets/consoleHandler.js), and
 * admin-only. A Quick Action opens its own SSH connection, runs one fixed command and
 * closes it: no session is kept between clicks, so nothing here holds a password
 * longer than the one request that carried it.
 */
const router = express.Router();

const parseId = (req) => {
  const id = parseInt(req.params.id, 10);
  return Number.isInteger(id) ? id : null;
};

router.get("/:id/console", authMiddleware, requireRole("admin", "it_staff"), async (req, res, next) => {
  const id = parseId(req);
  if (id == null) return res.status(400).json({ error: "Invalid server id." });
  try {
    const target = await sshConsole.resolveTarget(id);
    if (!target) return res.status(404).json({ error: "Server not found." });
    const hostKey = await sshConsole.getPinnedHostKey(id).catch(() => null);
    res.json({
      server: { id: target.id, name: target.name, ip: target.ip, os: target.os },
      family: target.family, // null = unknown, the UI asks
      actions: consoleCommands
        .listActions()
        .map((a) => ({ ...a, allowed: consoleCommands.roleMayRun(req.user.role, a.id) })),
      terminalAllowed: req.user.role === "admin",
      hostKey,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/console/actions", authMiddleware, requireRole("admin", "it_staff"), async (req, res, next) => {
  const id = parseId(req);
  if (id == null) return res.status(400).json({ error: "Invalid server id." });

  const actionId = req.body?.action;
  if (!consoleCommands.ACTIONS[actionId]) return res.status(400).json({ error: "Unknown action." });
  if (!consoleCommands.roleMayRun(req.user.role, actionId)) {
    console.warn(`[AUTHZ] 403 console action "${logSafe(actionId, 40)}" — user=${req.user.id} role=${req.user.role}`);
    return res.status(403).json({ error: "Only an admin can run this action." });
  }

  const creds = sshConsole.readCredentials(req.body);
  if (creds.error) return res.status(400).json({ error: creds.error });

  let conn;
  try {
    const target = await sshConsole.resolveTarget(id, req.body?.os);
    if (!target) return res.status(404).json({ error: "Server not found." });
    if (!target.family) {
      return res.status(400).json({ error: "This server's OS is unknown. Choose Linux or Windows." });
    }

    const built = consoleCommands.buildCommand(actionId, target.family, {
      param: req.body?.param,
      username: creds.username,
    });
    if (built.error) return res.status(400).json({ error: built.error });

    const action = consoleCommands.ACTIONS[actionId];
    const what = action.param ? `${action.label} (${req.body.param.trim()})` : action.label;
    const started = Date.now();

    let session;
    try {
      session = await loginTo(target, creds, req.user.id);
    } catch (err) {
      await audit({
        userId: req.user.id,
        module: "devices",
        action: "console_login_failed",
        description: `Console: could not log in to "${target.name}" (${target.ip}) as ${creds.username} — ${err.message}`,
        level: "warning",
        ...clientInfo(req),
      });
      // 422, NOT 502. 502 is the textbook code for "an upstream failed", but Cloudflare
      // (the tunnel in front of the backend) replaces any origin 502/504 with its own
      // HTML error page, so the explanation never reached the admin — the dashboard only
      // saw "Cannot connect to server". 422 passes through untouched.
      return res.status(422).json({ error: err.message });
    }
    conn = session.conn;

    const result = await sshConsole.runCommand(conn, built.command, {
      stdinPassword: built.sudo ? creds.password : null,
    });

    const ok = result.code === 0 && !result.timedOut;
    await audit({
      userId: req.user.id,
      module: "devices",
      action: action.group === "control" ? "console_control_action" : "console_action",
      description:
        `Console: ran "${what}" on "${target.name}" (${target.ip}) as ${creds.username} — ` +
        (result.timedOut ? "timed out" : `exit ${result.code ?? "?"}`),
      level: action.group === "control" ? "warning" : "info",
      ...clientInfo(req),
    });

    res.json({
      ok,
      action: actionId,
      exitCode: result.code,
      output: result.output,
      truncated: result.truncated,
      timedOut: result.timedOut,
      durationMs: Date.now() - started,
      hostKey: { fingerprint: session.fingerprint, firstTrust: session.firstTrust },
    });
  } catch (err) {
    next(err);
  } finally {
    conn?.end();
  }
});

router.delete("/:id/console/host-key", authMiddleware, requireRole("admin"), async (req, res, next) => {
  const id = parseId(req);
  if (id == null) return res.status(400).json({ error: "Invalid server id." });
  try {
    const target = await sshConsole.resolveTarget(id);
    if (!target) return res.status(404).json({ error: "Server not found." });
    const pinned = await sshConsole.getPinnedHostKey(id);
    const removed = await sshConsole.forgetHostKey(id);
    if (removed) {
      await audit({
        userId: req.user.id,
        module: "devices",
        action: "console_forget_host_key",
        description: `Console: cleared the saved SSH host key of "${target.name}" (${target.ip}) — was ${pinned?.fingerprint}`,
        level: "warning",
        ...clientInfo(req),
      });
    }
    res.json({ success: true, removed });
  } catch (err) {
    next(err);
  }
});

export default router;
