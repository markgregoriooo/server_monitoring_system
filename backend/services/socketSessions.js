import db from "../config/mysql.js";
import { sessionRevocationReason, sessionPastHardLimit } from "../middleware/auth.js";
import { describeError } from "../utils/httpError.js";

/**
 * Live-socket session revocation.
 *
 * Sockets are only authenticated at the handshake (`io.use` in src/server.js), so an
 * open socket kept streaming after its account was disabled or its tokens revoked.
 * This sweep re-checks connected browser sockets every SWEEP_MS. A sweep rather than
 * a push from each place that bumps token_version, so it cannot miss one (or a row
 * edited by hand). One indexed SELECT per sweep.
 *
 * The token's own `exp` is not checked: HTTP sessions slide, so an active session
 * outlives the token its socket opened with.
 *
 * The absolute session cap (SESSION_MAX_HOURS) is checked, using
 * sessionHardExpirySec (cap + one token lifetime). Otherwise a socket could keep
 * reading live data forever with a stolen token, since it never needs a new token.
 */

// How often connected sockets are re-validated. 30s keeps revocation prompt without
// making this a per-second query; nothing here is latency-critical.
const SWEEP_MS = Number(process.env.SOCKET_REVOKE_SWEEP_MS) || 30000;

let io = null;
let timer = null;

/** Connected BROWSER sockets that carry a user (ESP32 device sockets are not sessions). */
function browserSockets() {
  const out = [];
  for (const socket of io.sockets.sockets.values()) {
    if (socket.isDevice) continue;
    if (socket.user?.id == null) continue;
    out.push(socket);
  }
  return out;
}

// Tell the client why, then disconnect, so the dashboard shows the sign-in notice.
// socket.io-client does not auto-reconnect after a server-side disconnect, which is
// what we want.
function kick(socket, reason) {
  socket.emit("sessionRevoked", { reason });
  socket.disconnect(true);
}

/**
 * Re-validate every connected browser socket against the users table and drop the
 * ones whose session is no longer valid. Returns how many were dropped.
 */
async function sweep() {
  if (!io) return 0;

  const sockets = browserSockets();
  if (sockets.length === 0) return 0;

  const ids = [...new Set(sockets.map((s) => s.user.id))];
  const [rows] = await db.query(
    "SELECT user_id, status, token_version FROM users WHERE user_id IN (?)",
    [ids],
  );
  const live = new Map(rows.map((r) => [r.user_id, r]));

  let kicked = 0;
  for (const socket of sockets) {
    const row = live.get(socket.user.id);

    // The same rule as the handshake and the HTTP middleware, returning the reason
    // because the client is told why. The session cap is checked separately: over HTTP
    // the cap means "stop renewing", not a 401, so it is not part of this rule.
    const reason =
      sessionRevocationReason(row, socket.user.tv) ??
      (sessionPastHardLimit(socket.user) ? "session_expired" : null);

    if (reason) {
      kick(socket, reason);
      kicked++;
    }
  }

  if (kicked) {
    console.log(`[sessions] revoked ${kicked} live socket(s)`);
  }
  return kicked;
}

function init(server) {
  io = server;
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    // A DB blip must not take the process down — the next sweep retries.
    sweep().catch((err) => console.error("[sessions] sweep error:", describeError(err)));
  }, SWEEP_MS);
  timer.unref?.(); // never hold the process open just for this
  console.log(`[sessions] live-socket revocation sweep every ${SWEEP_MS}ms`);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

export default { init, sweep, stop };
