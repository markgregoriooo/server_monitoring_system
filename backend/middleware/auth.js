import "../config/env.js";
import jwt from "jsonwebtoken";
import db from "../config/mysql.js";

const JWT_SECRET = process.env.JWT_SECRET;

// ─── Sliding-session renewal ────────────────────────────────────────────────────
// issueSession() mints 1h tokens. Rather than hard-logging out an active user at the
// 1h mark, we re-issue a fresh 1h token once the current one is past its HALF-LIFE
// (>30 min old) and hand it back in the X-Renewed-Token response header; the frontend
// swaps it into sessionStorage transparently. A user who keeps making requests never
// gets kicked out, while a genuinely idle session (no requests) still expires ~1h
// after its last activity. The renewed token carries the SAME claims (incl. `tv`), so
// token_version revocation (logout/disable/role change) keeps working unchanged.
const RENEW_TTL = "1h";        // must match issueSession()'s expiresIn
const FALLBACK_TTL_SEC = 3600; // only used if a token somehow lacks iat/exp

function maybeRenewToken(res, decoded) {
  const now = Math.floor(Date.now() / 1000);
  const iat = decoded.iat ?? now;
  const exp = decoded.exp ?? iat + FALLBACK_TTL_SEC;
  if (now < iat + (exp - iat) / 2) return; // still in the first half of its life

  // Drop the time claims so jwt.sign can stamp fresh iat/exp from expiresIn.
  const { iat: _iat, exp: _exp, nbf: _nbf, ...claims } = decoded;
  const renewed = jwt.sign(claims, JWT_SECRET, { algorithm: "HS256", expiresIn: RENEW_TTL });
  res.setHeader("X-Renewed-Token", renewed);
}

  //  auth middleware
async function authMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Access denied. No token provided." });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
  } catch (err) {
    // The CLIENT is told only "Invalid or expired token." — deliberately vague, an
    // attacker learns nothing from it. But that one string collapses three failures
    // that need completely different fixes:
    //   TokenExpiredError                  → the token really is old (see expiredBy)
    //   JsonWebTokenError: invalid signature → signed with a different JWT_SECRET
    //   JsonWebTokenError: jwt malformed   → the stored string is truncated/corrupt
    // Swallowing that difference is what makes a spurious logout so hard to chase,
    // so the SERVER log spells it out. jwt.decode does NOT verify, so reading the
    // claims of a token we have already rejected is safe.
    const claims = jwt.decode(token) || {};
    const now = Math.floor(Date.now() / 1000);
    // WHO sent it matters as much as what was wrong with it. The server listens on
    // 0.0.0.0, so a rejected token can come from any machine on the LAN — a phone, a
    // second PC, another browser — not necessarily the one in front of you. Without
    // the origin you cannot tell "my session is broken" from "some other device left
    // a tab open". The UA is trimmed to the part that identifies the browser.
    const ua = (req.get("user-agent") ?? "?").slice(0, 60);
    console.warn(
      `[AUTH] rejected ${req.method} ${req.originalUrl} — ${err.name}: ${err.message} ` +
        `(len=${token.length} user=${claims.id ?? "?"} iat=${claims.iat ?? "?"} ` +
        `exp=${claims.exp ?? "?"} now=${now} ` +
        `ageSec=${claims.iat ? now - claims.iat : "?"} ` +
        `expiredBySec=${claims.exp ? now - claims.exp : "?"} ` +
        `from=${req.ip} ua="${ua}")`,
    );
    // 401, not 403. The credential is missing, malformed or expired, so the client
    // should RE-AUTHENTICATE — that is what 401 means. 403 means "authenticated, but
    // not allowed", which is a different situation with a different remedy, and this
    // middleware already answers 401 for a missing token (:36) and for a dead session
    // (below). The 403 here was the odd one out, and the frontend had to special-case
    // it by matching this exact message TEXT across package boundaries.
    return res.status(401).json({ error: "Invalid or expired token." });
  }

  // F-02: enforce live session state. A token is only valid while the account is
  // still active and its `tv` claim matches the current token_version. logout,
  // disable, role change, and password change all bump token_version, which
  // immediately invalidates previously-issued tokens.
  try {
    if (!sessionIsLive(await fetchSessionRow(decoded.id), decoded.tv)) {
      return res.status(401).json({ error: "Session is no longer valid." });
    }
  } catch (err) {
    return next(err);
  }

  req.user = decoded;
  maybeRenewToken(res, decoded); // sliding session: extend an active user's token
  next();
}


// ─── The one definition of "this token still corresponds to a live session" ────
//
// Enforced in three places that must never disagree: this middleware (every HTTP
// request), the Socket.IO handshake (src/server.js), and the revocation sweep that
// re-checks already-connected sockets (services/socketSessions.js). Three hand-written
// copies of the rule is three places to miss when a fifth `users.status` value appears —
// and it is the AUTHORISATION rule, so a miss is a security bug rather than a glitch.
//
// Returns WHICH condition failed, because the sweep reports the reason to the client
// while the HTTP path only needs pass/fail. See audits/code-duplication-report-2026-08-25.md — R-03.

/** The columns a liveness check needs. One query shape, so it cannot drift either. */
export async function fetchSessionRow(userId) {
  const [[row]] = await db.query(
    "SELECT status, token_version FROM users WHERE user_id = ? LIMIT 1",
    [userId],
  );
  return row ?? null;
}

/** null = the session is live. Otherwise the reason it is not. */
export function sessionRevocationReason(userRow, tvClaim) {
  if (!userRow) return "account_removed";
  if (userRow.status !== "active") return "account_inactive";
  if (userRow.token_version !== tvClaim) return "session_revoked";
  return null;
}

/** Convenience wrapper for callers that only need pass/fail. */
export function sessionIsLive(userRow, tvClaim) {
  return sessionRevocationReason(userRow, tvClaim) === null;
}

// role guard - coarse access
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized." });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Insufficient permissions." });
    }

    next();
  };
}

export {
  authMiddleware,
  requireRole,
  JWT_SECRET,
};