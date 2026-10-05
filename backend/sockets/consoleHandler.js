import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { fetchSessionRow, sessionIsLive } from "../middleware/auth.js";
import policyService from "../services/policyService.js";
import sshConsole, { loginTo } from "../services/sshConsole.js";
import { audit } from "../services/auditService.js";

/**
 * Server Console — the Web Terminal (Socket.IO, browser sockets only, ADMIN only).
 *
 *   console:open    {serverId, username, password, port, cols, rows, os?}  ack → {ok, sessionId, fingerprint, firstTrust} | {ok:false, error}
 *   console:input   {sessionId, data}       keystrokes → the shell
 *   console:resize  {sessionId, cols, rows}
 *   console:close   {sessionId}
 *   ← console:output {sessionId, data}      shell output
 *   ← console:closed {sessionId, reason}
 *
 * Authorization is re-read from the DATABASE on every open — not from the token the
 * socket was opened with, which may be hours old — matching what authMiddleware does
 * for HTTP: live session, role = admin, Privacy Notice accepted. Sessions die with
 * their socket, and the revocation sweep (services/socketSessions.js) disconnects the
 * socket of a disabled or demoted account, so a terminal cannot outlive its admin.
 *
 * What is audited: who opened a terminal on which server as which login, and when it
 * closed and why. Keystrokes are deliberately NOT recorded — a terminal carries
 * passwords typed at sudo prompts, and a log of them would be a credential store in
 * `system_logs`, which is backed up offsite nightly.
 */

const IDLE_MS = (Number(process.env.CONSOLE_IDLE_MIN) || 15) * 60 * 1000;
const MAX_SESSIONS_PER_SOCKET = 4;
const MAX_INPUT_CHARS = 64 * 1024;

const clampDim = (n, lo, hi, dflt) => (Number.isInteger(n) && n >= lo && n <= hi ? n : dflt);

async function adminCheck(socket) {
  const row = await fetchSessionRow(socket.user.id);
  if (!sessionIsLive(row, socket.user.tv)) return "Your session is no longer valid. Sign in again.";
  if (row.role !== "admin") return "Only an admin can open a terminal.";
  if (row.policy_version !== policyService.POLICY_VERSION) {
    return "Accept the Privacy Notice and Terms before using the console.";
  }
  return null;
}

export function registerConsoleEvents(socket) {
  if (socket.isDevice || socket.user?.id == null) return;

  /** sessionId → { stream, conn, target, username, openedAt, idleTimer } */
  const sessions = new Map();

  const close = (sessionId, reason) => {
    const s = sessions.get(sessionId);
    if (!s) return;
    sessions.delete(sessionId);
    clearTimeout(s.idleTimer);
    try {
      s.stream.close();
    } catch {
      /* already closed */
    }
    s.conn.end();
    socket.emit("console:closed", { sessionId, reason });
    const mins = Math.max(1, Math.round((Date.now() - s.openedAt) / 60000));
    audit({
      userId: socket.user.id,
      module: "devices",
      action: "console_terminal_closed",
      description: `Console: terminal on "${s.target.name}" (${s.target.ip}) as ${s.username} closed after ~${mins} min — ${reason}`,
      ip: socket.clientIp ?? null,
      userAgent: socket.handshake.headers?.["user-agent"] ?? null,
    });
  };

  const armIdle = (sessionId) => {
    const s = sessions.get(sessionId);
    if (!s) return;
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(
      () => close(sessionId, `idle for ${Math.round(IDLE_MS / 60000)} minutes`),
      IDLE_MS,
    );
  };

  socket.on("console:open", async (req, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    try {
      const denied = await adminCheck(socket);
      if (denied) return reply({ ok: false, error: denied });
      if (sessions.size >= MAX_SESSIONS_PER_SOCKET) {
        return reply({ ok: false, error: `At most ${MAX_SESSIONS_PER_SOCKET} terminals at once. Close one first.` });
      }

      const id = parseInt(req?.serverId, 10);
      if (!Number.isInteger(id)) return reply({ ok: false, error: "Invalid server id." });
      const creds = sshConsole.readCredentials(req);
      if (creds.error) return reply({ ok: false, error: creds.error });

      const target = await sshConsole.resolveTarget(id, req?.os);
      if (!target) return reply({ ok: false, error: "Server not found." });
      if (!target.family) return reply({ ok: false, error: "This server's OS is unknown. Choose Linux or Windows." });

      const meta = {
        userId: socket.user.id,
        module: "devices",
        ip: socket.clientIp ?? null,
        userAgent: socket.handshake.headers?.["user-agent"] ?? null,
      };

      let session;
      try {
        session = await loginTo(target, creds, socket.user.id);
      } catch (err) {
        audit({
          ...meta,
          action: "console_login_failed",
          description: `Console: could not open a terminal on "${target.name}" (${target.ip}) as ${creds.username} — ${err.message}`,
          level: "warning",
        });
        return reply({ ok: false, error: err.message });
      }

      let stream;
      try {
        stream = await sshConsole.openShell(session.conn, target.family, {
          cols: clampDim(req?.cols, 20, 500, 120),
          rows: clampDim(req?.rows, 5, 200, 32),
        });
      } catch (err) {
        session.conn.end();
        return reply({ ok: false, error: `Logged in, but the server refused a terminal: ${err.message}` });
      }

      // The socket may have dropped while we were connecting.
      if (!socket.connected) {
        stream.close();
        session.conn.end();
        return;
      }

      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, {
        stream,
        conn: session.conn,
        target,
        username: creds.username,
        openedAt: Date.now(),
        idleTimer: null,
      });
      armIdle(sessionId);

      const decoder = new StringDecoder("utf8");
      const forward = (chunk) => socket.emit("console:output", { sessionId, data: decoder.write(chunk) });
      stream.on("data", forward);
      stream.stderr?.on("data", forward);
      stream.on("close", () => close(sessionId, "the remote shell exited"));
      session.conn.on("error", (err) => close(sessionId, `connection error: ${err.message}`));
      session.conn.on("close", () => close(sessionId, "connection closed"));

      audit({
        ...meta,
        action: "console_terminal_opened",
        description:
          `Console: opened a terminal on "${target.name}" (${target.ip}) as ${creds.username}` +
          (session.firstTrust ? ` — first connection, host key ${session.fingerprint} saved` : ""),
        level: "warning",
      });

      reply({
        ok: true,
        sessionId,
        family: target.family,
        fingerprint: session.fingerprint,
        firstTrust: session.firstTrust,
        idleMinutes: Math.round(IDLE_MS / 60000),
      });
    } catch (err) {
      console.error("[CONSOLE] open failed:", err?.stack ?? err);
      reply({ ok: false, error: "The console could not be opened (server error)." });
    }
  });

  socket.on("console:input", (msg) => {
    const s = sessions.get(msg?.sessionId);
    if (!s || typeof msg.data !== "string" || msg.data.length > MAX_INPUT_CHARS) return;
    s.stream.write(msg.data);
    armIdle(msg.sessionId);
  });

  socket.on("console:resize", (msg) => {
    const s = sessions.get(msg?.sessionId);
    if (!s) return;
    const cols = clampDim(msg.cols, 20, 500, null);
    const rows = clampDim(msg.rows, 5, 200, null);
    if (cols && rows) s.stream.setWindow(rows, cols, 0, 0);
  });

  socket.on("console:close", (msg) => close(msg?.sessionId, "closed by the user"));

  socket.on("disconnect", () => {
    for (const sessionId of [...sessions.keys()]) close(sessionId, "the dashboard disconnected");
  });
}
