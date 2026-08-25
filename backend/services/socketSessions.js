import db from "../config/mysql.js";
import { sessionRevocationReason } from "../middleware/auth.js";
import { describeError } from "../utils/httpError.js";

/**
 * Live-socket session revocation.
 *
 * Sockets authenticate ONCE, at the handshake (`io.use` in src/server.js), and
 * Socket.IO never re-verifies afterwards. So a connection opened with a valid token
 * outlives the session that opened it: disable an account or bump its token_version
 * and every HTTP call starts failing immediately, while the already-open socket
 * keeps streaming live sensor, server and alert data until the connection happens
 * to drop on its own. The user can't *do* anything — every action goes through HTTP
 * — but a revoked account should not still be watching.
 *
 * A periodic re-check rather than a push from each revocation site, on purpose.
 * token_version is bumped in four places today (logout, role change, disable,
 * reset) and nothing stops a fifth being added, or an admin editing the row by
 * hand during an incident. A sweep cannot miss any of them; a push can, silently.
 * The cost is a bounded delay — SWEEP_MS — and one indexed SELECT per sweep, only
 * when browser sockets are actually connected.
 *
 * Deliberately NOT checked: the token's own `exp`. HTTP sessions SLIDE — the auth
 * middleware re-issues a token once it passes its half-life — so an actively-used
 * session is legitimately alive long past the exp of the token its socket was
 * opened with. Kicking on exp would black out the live dashboard of a perfectly
 * valid session every hour. Idle expiry is already the client's job (AuthContext's
 * proactive-expiry and away timers), and both disconnect the socket themselves.
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

// Tell the client why before cutting it off, so the dashboard can show the sign-in
// notice instead of silently going stale. `disconnect(true)` closes the underlying
// connection: socket.io-client does not auto-reconnect from a server-side
// disconnect, which is what we want — reconnecting would just fail the handshake.
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

    // The SAME predicate the handshake and the HTTP auth middleware enforce — not a
    // third hand-written copy of it. This is the one caller that needs to know WHICH
    // condition failed, so it takes the reason rather than the boolean.
    const reason = sessionRevocationReason(row, socket.user.tv);

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
