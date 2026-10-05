import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import ssh2 from "ssh2";
import db from "../config/mysql.js";
import agentService from "./agentService.js";
import { osFamily } from "./consoleCommands.js";
import { createHandshakeLimiter } from "./handshakeLimiter.js";

const { Client } = ssh2;

/**
 * Server Console — the SSH half (I/O). The backend opens the SSH connection to a
 * monitored server on the admin's behalf, so the browser never needs PowerShell or
 * PuTTY and never touches port 22 itself.
 *
 * Three rules this file exists to keep:
 *
 *  1. The TARGET is always the server's registered IP (`devices.ip_address`), looked
 *     up here by id. The client sends a server id, never a host, so the console cannot
 *     be pointed at an arbitrary machine on the campus network.
 *  2. The PASSWORD is used for one connection and never stored, logged or audited.
 *  3. The HOST KEY is pinned on first use (`server_ssh_hosts`) and checked on every
 *     later connection. Without it, anybody able to answer on that IP could pose as
 *     the server and collect the password an admin types. A changed key is refused,
 *     not warned about; an admin clears the pin from the console when the change is
 *     known to be legitimate (OS reinstall).
 */

const CONNECT_TIMEOUT_MS = Number(process.env.CONSOLE_CONNECT_TIMEOUT_MS) || 10000;

/** OpenSSH-style fingerprint, "SHA256:<base64 without padding>". */
export function fingerprintOf(keyBuffer) {
  return "SHA256:" + crypto.createHash("sha256").update(keyBuffer).digest("base64").replace(/=+$/, "");
}

// ─── Host-key pinning ─────────────────────────────────────────────────────────

export async function getPinnedHostKey(deviceId) {
  const [[row]] = await db.query(
    `SELECT fingerprint, key_type AS keyType, first_seen AS firstSeen, last_seen AS lastSeen
       FROM server_ssh_hosts WHERE device_id = ? LIMIT 1`,
    [deviceId],
  );
  return row ?? null;
}

async function pinHostKey(deviceId, fingerprint, keyType, userId) {
  // INSERT IGNORE: two consoles opened at once on a never-seen server both reach here;
  // the first pin wins and the second is compared against it on its next connect.
  await db.query(
    `INSERT IGNORE INTO server_ssh_hosts (device_id, fingerprint, key_type, pinned_by, first_seen, last_seen)
     VALUES (?, ?, ?, ?, NOW(), NOW())`,
    [deviceId, fingerprint, keyType, userId ?? null],
  );
}

async function touchHostKey(deviceId) {
  await db.query(`UPDATE server_ssh_hosts SET last_seen = NOW() WHERE device_id = ?`, [deviceId]);
}

export async function forgetHostKey(deviceId) {
  const [res] = await db.query(`DELETE FROM server_ssh_hosts WHERE device_id = ?`, [deviceId]);
  return res.affectedRows > 0;
}

// ─── Target ───────────────────────────────────────────────────────────────────

/**
 * Who is server `id`, from the database. Returns { id, name, ip, os, family } or null.
 * `osOverride` is honoured ONLY when the agent never reported an OS — otherwise the
 * stored one wins, so a client cannot run the Windows catalog against a Linux box.
 */
export async function resolveTarget(id, osOverride) {
  const server = await agentService.getServerById(id);
  if (!server) return null;
  let family = osFamily(server.os);
  if (!family && (osOverride === "linux" || osOverride === "windows")) family = osOverride;
  return { id: server.id, name: server.name, ip: server.ip, os: server.os, family };
}

// ─── Input validation ─────────────────────────────────────────────────────────

// user, DOMAIN\user, user@domain — the shapes an SSH login on Linux or Windows takes.
// Windows local accounts may contain spaces ("Mark Gregorio"), so a space is allowed in
// the middle, never at either end. Safe: the username goes to ssh2 as a protocol field
// and into audit text, never into a shell.
const USER_RE = /^[A-Za-z0-9._@\\-](?:[A-Za-z0-9._@\\ -]{0,62}[A-Za-z0-9._@\\-])?$/;

/** Validate the credential half of a request. Returns { username, password, port } or { error }. */
export function readCredentials(body) {
  const username = typeof body?.username === "string" ? body.username.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const port = body?.port == null || body.port === "" ? 22 : Number(body.port);
  if (!USER_RE.test(username)) return { error: "Enter a valid username." };
  if (!password || password.length > 256) return { error: "Enter the password." };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "Port must be 1-65535." };
  return { username, password, port };
}

// ─── Connect ──────────────────────────────────────────────────────────────────

/** Turn an ssh2/socket error into a sentence an admin can act on. */
function explain(err, target, port) {
  if (err?.code === "HOST_KEY_CHANGED") return err.message;
  if (err?.level === "client-authentication") {
    return "Wrong username or password (or this account is not allowed to log in over SSH).";
  }
  if (err?.code === "ECONNREFUSED") {
    return `${target.ip} refused the connection on port ${port}. Is the SSH server installed and running?` +
      (target.family === "windows" ? " On Windows, OpenSSH Server must be enabled (see the console help)." : "");
  }
  if (err?.code === "EHOSTUNREACH" || err?.code === "ENETUNREACH") {
    return `${target.ip} cannot be reached from the monitoring server.`;
  }
  if (err?.code === "ETIMEDOUT" || err?.level === "client-timeout" || /timed out/i.test(err?.message ?? "")) {
    return `No answer from ${target.ip}:${port} within ${CONNECT_TIMEOUT_MS / 1000}s — a firewall may be blocking SSH.`;
  }
  return `SSH connection failed: ${err?.message ?? "unknown error"}`;
}

/**
 * Open an authenticated SSH connection to `target`. Resolves
 * { conn, fingerprint, firstTrust } or rejects with an Error whose message is
 * already human-readable (see explain()).
 */
export async function connect(target, { username, password, port }, { userId } = {}) {
  if (!target?.ip) throw new Error("This server has no IP address on record.");
  const pinned = await getPinnedHostKey(target.id);

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let seen = null; // { fingerprint, keyType } of the key the server presented
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      conn.end();
      reject(new Error(explain(err, target, port)));
    };

    conn.on("keyboard-interactive", (_n, _i, _l, prompts, finish) => {
      // Ubuntu's default sshd offers password auth as keyboard-interactive. Answer
      // every prompt with the password; anything asking for more (an OTP) fails auth.
      finish(prompts.map(() => password));
    });

    conn.on("ready", async () => {
      if (settled) return;
      settled = true;
      try {
        if (!pinned) await pinHostKey(target.id, seen.fingerprint, seen.keyType, userId);
        else await touchHostKey(target.id);
      } catch (err) {
        // The pin table missing (migration not applied) must not take the console
        // down — but it must be loud, because every connection is now unpinned.
        console.error("[CONSOLE] could not record the host key:", err.message);
      }
      resolve({ conn, fingerprint: seen.fingerprint, firstTrust: !pinned });
    });

    conn.on("error", fail);
    conn.on("close", () => fail(new Error("the server closed the connection before login finished")));

    conn.connect({
      host: target.ip,
      port,
      username,
      password,
      tryKeyboard: true,
      readyTimeout: CONNECT_TIMEOUT_MS,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      hostVerifier: (key) => {
        let keyType = "unknown";
        try {
          keyType = ssh2.utils.parseKey(key)?.type ?? "unknown";
        } catch {
          /* type is informational only */
        }
        seen = { fingerprint: fingerprintOf(key), keyType };
        if (!pinned || pinned.fingerprint === seen.fingerprint) return true;
        // Fail FIRST, synchronously, so this message wins over ssh2's own generic
        // "Host denied (verification failed)" error that follows the `false`.
        const err = new Error(
          `The SSH host key of ${target.ip} has CHANGED (was ${pinned.fingerprint}, now ${seen.fingerprint}). ` +
            "This happens after an OS reinstall — or when another machine is answering on this address. " +
            "Connection refused. If the change is expected, an admin can clear the saved key and reconnect.",
        );
        err.code = "HOST_KEY_CHANGED";
        fail(err);
        return false;
      },
    });
  });
}

// ─── Quick Actions: run one command and collect its output ────────────────────

const ACTION_TIMEOUT_MS = Number(process.env.CONSOLE_ACTION_TIMEOUT_MS) || 60000;
const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Run `command` on an open connection. Never rejects after the channel opens.
 * Resolves { code, output, truncated, timedOut }.
 *   stdinPassword  written to stdin first — for `sudo -S` (see consoleCommands.sudoWrap)
 */
export function runCommand(conn, command, { stdinPassword = null, timeoutMs = ACTION_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      const decoder = new StringDecoder("utf8");
      let output = "";
      let bytes = 0;
      let truncated = false;
      let timedOut = false;
      const take = (chunk) => {
        if (truncated) return;
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          truncated = true;
          return;
        }
        output += decoder.write(chunk);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stream.close();
      }, timeoutMs);

      stream.on("data", take);
      stream.stderr.on("data", take);
      stream.on("close", (code) => {
        clearTimeout(timer);
        output += decoder.end();
        resolve({ code: typeof code === "number" ? code : null, output, truncated, timedOut });
      });

      if (stdinPassword != null) stream.write(stdinPassword + "\n");
      stream.end(); // EOF on stdin: sudo with a wrong password then fails instead of waiting
    });
  });
}

// ─── Web Terminal: an interactive shell ───────────────────────────────────────

/**
 * Open an interactive PTY. Linux gets the login shell; Windows gets PowerShell rather
 * than OpenSSH's default cmd.exe, so the console feels like what the staff use today.
 */
export function openShell(conn, family, { cols = 120, rows = 32 } = {}) {
  const pty = { term: "xterm-256color", cols, rows };
  return new Promise((resolve, reject) => {
    const done = (err, stream) => (err ? reject(err) : resolve(stream));
    if (family === "windows") conn.exec("powershell.exe -NoLogo", { pty }, done);
    else conn.shell(pty, done);
  });
}

export default {
  fingerprintOf,
  getPinnedHostKey,
  forgetHostKey,
  resolveTarget,
  readCredentials,
  connect,
  runCommand,
  openShell,
};

// ─── Failed-login throttle ────────────────────────────────────────────────────
// The console is an SSH client that any admin session can drive, so without a limit
// a stolen admin session could grind passwords against every server on campus. Keyed
// per (user, server); a successful login clears the key — the same failure-only rule
// as the Socket.IO handshake limiter, reused rather than re-written.

export const loginLimiter = createHandshakeLimiter({
  windowMs: 15 * 60 * 1000,
  maxFailures: Number(process.env.CONSOLE_MAX_FAILED_LOGINS) || 10,
});
export const limiterKey = (userId, deviceId) => `${userId}:${deviceId}`;

/**
 * connect() behind the failed-login throttle. Used by both the Quick Actions route
 * and the terminal socket, so neither can bypass it.
 */
export async function loginTo(target, creds, userId) {
  const key = limiterKey(userId, target.id);
  if (loginLimiter.isBlocked(key)) {
    const min = Math.ceil(loginLimiter.retryAfterSec(key) / 60);
    throw new Error(`Too many failed logins to this server. Try again in ${min} minute${min === 1 ? "" : "s"}.`);
  }
  try {
    const session = await connect(target, creds, { userId });
    loginLimiter.recordSuccess(key);
    return session;
  } catch (err) {
    loginLimiter.recordFailure(key);
    throw err;
  }
}
