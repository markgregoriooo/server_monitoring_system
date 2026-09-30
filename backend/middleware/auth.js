import "../config/env.js";
import jwt from "jsonwebtoken";
import db from "../config/mysql.js";
import policyService from "../services/policyService.js";
import { logSafe } from "../utils/logSafe.js";

const JWT_SECRET = process.env.JWT_SECRET;

// ─── Sliding-session renewal ────────────────────────────────────────────────────
// Tokens last 1h. Once a token is past half its life we issue a fresh one in the
// X-Renewed-Token header, so an active user is never logged out while an idle one
// still expires. The new token keeps the same claims, including `tv`.
const RENEW_TTL = "1h";        // must match issueSession()'s expiresIn
const FALLBACK_TTL_SEC = 3600; // only used if a token somehow lacks iat/exp

// ─── JWT sign/verify options ────────────────────────────────────────────────────
// iss/aud are checked on every verify, so a token signed with the same secret by
// some other tool is not accepted as a session here. Shared by the middleware,
// the Socket.IO handshake and the rate limiter so they cannot drift apart.
export const JWT_ISSUER = "cspc-ictu-monitoring";
export const JWT_AUDIENCE = "cspc-ictu-dashboard";
export const JWT_VERIFY_OPTS = Object.freeze({
  algorithms: ["HS256"],
  issuer: JWT_ISSUER,
  audience: JWT_AUDIENCE,
});
export const JWT_SIGN_OPTS = Object.freeze({
  algorithm: "HS256",
  issuer: JWT_ISSUER,
  audience: JWT_AUDIENCE,
});

// Routes a user who has not accepted the Privacy Notice can still use: who am I,
// accept, and logout.
const POLICY_EXEMPT = /^\/api\/(policy|auth)(\/|$)/;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Absolute session cap. Renewal slides, so without a cap a token could be kept
// alive forever just by using it. `ist` is stamped once at sign-in and kept across
// renewals; past the cap we stop renewing and the token ends at its own `exp`.
const SESSION_MAX_HOURS = Number(process.env.SESSION_MAX_HOURS) || 12;
const SESSION_MAX_SEC = SESSION_MAX_HOURS * 3600;

// One token lifetime, in seconds. Must track RENEW_TTL above and issueSession()'s
// `expiresIn`. Named because the hard limit below is expressed in terms of it.
const TOKEN_TTL_SEC = 3600;

/**
 * Latest time any token from this session can still be valid (session cap + 1h).
 * Uses `iat` when an older token has no `ist`.
 */
export function sessionHardExpirySec(claims) {
  const start = claims?.ist ?? claims?.iat;
  if (typeof start !== "number") return null; // no anchor — caller decides
  return start + SESSION_MAX_SEC + TOKEN_TTL_SEC;
}

/**
 * Whether a session has passed its absolute cap. Not the same as the token being
 * expired: sessions slide, so an active session outlives each token's `exp`.
 */
export function sessionPastHardLimit(claims, nowSec = Math.floor(Date.now() / 1000)) {
  const hardExp = sessionHardExpirySec(claims);
  return hardExp !== null && nowSec >= hardExp;
}

export { SESSION_MAX_HOURS };

function maybeRenewToken(res, decoded) {
  const now = Math.floor(Date.now() / 1000);
  const iat = decoded.iat ?? now;
  const exp = decoded.exp ?? iat + FALLBACK_TTL_SEC;
  if (now < iat + (exp - iat) / 2) return; // still in the first half of its life

  // Fall back to `iat` for a token minted before `ist` existed, so an already-open
  // session is bounded from its current token rather than treated as ageless.
  const sessionStart = decoded.ist ?? iat;
  if (now - sessionStart >= SESSION_MAX_SEC) {
    console.log(
      `[AUTH] not renewing user=${decoded.id} — session is ` +
        `${Math.round((now - sessionStart) / 3600)}h old (cap ${SESSION_MAX_HOURS}h); ` +
        "it will expire and require a fresh sign-in.",
    );
    return;
  }

  // Drop the time claims and iss/aud before re-signing; jwt.sign throws if an
  // option duplicates a claim already in the payload.
  const { iat: _iat, exp: _exp, nbf: _nbf, iss: _iss, aud: _aud, ...claims } = decoded;
  const renewed = jwt.sign(claims, JWT_SECRET, { ...JWT_SIGN_OPTS, expiresIn: RENEW_TTL });
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
    decoded = jwt.verify(token, JWT_SECRET, JWT_VERIFY_OPTS);
  } catch (err) {
    // The client only gets "Invalid or expired token.", so log the real reason here:
    //   TokenExpiredError                    → the token is old (see expiredBy)
    //   JsonWebTokenError: invalid signature → signed with a different JWT_SECRET
    //   JsonWebTokenError: jwt malformed     → the stored token is corrupt
    // jwt.decode does not verify, so reading an already-rejected token is safe.
    const claims = jwt.decode(token) || {};
    const now = Math.floor(Date.now() / 1000);
    // Log where the request came from: the server listens on 0.0.0.0, so it could be
    // any device on the LAN. logSafe strips newlines from the attacker-controlled UA.
    const ua = logSafe(req.get("user-agent") ?? "?", 60);
    console.warn(
      `[AUTH] rejected ${req.method} ${req.originalUrl} — ${err.name}: ${err.message} ` +
        `(len=${token.length} user=${claims.id ?? "?"} iat=${claims.iat ?? "?"} ` +
        `exp=${claims.exp ?? "?"} now=${now} ` +
        `ageSec=${claims.iat ? now - claims.iat : "?"} ` +
        `expiredBySec=${claims.exp ? now - claims.exp : "?"} ` +
        `from=${req.ip} ua="${ua}")`,
    );
    // 401: the client should sign in again. 403 means signed in but not allowed.
    return res.status(401).json({ error: "Invalid or expired token." });
  }

  // The token is only valid while the account is active and its `tv` matches
  // token_version. Logout, disable and role changes bump token_version.
  let sessionRow;
  try {
    sessionRow = await fetchSessionRow(decoded.id);
    if (!sessionIsLive(sessionRow, decoded.tv)) {
      return res.status(401).json({ error: "Session is no longer valid." });
    }
  } catch (err) {
    return next(err);
  }

  // Use the role from the database, not the token. A role edited directly in SQL
  // (how the first admin is promoted) does not bump token_version, so the token
  // would keep the old role until it expired.
  if (sessionRow.role && sessionRow.role !== decoded.role) {
    console.warn(
      `[AUTH] role for user=${decoded.id} is "${sessionRow.role}" in the database but ` +
        `"${decoded.role}" in the token — using the database. If this was not a direct ` +
        "SQL edit, something changed a role without bumping token_version.",
    );
    decoded.role = sessionRow.role;
  }

  // ─── Privacy Notice gate ───────────────────────────────────────────────────
  // The React gate only hides the dashboard; the token still works with curl. So
  // writes (POST/PUT/PATCH/DELETE) are refused here until the user has accepted
  // the current version. Reads are left alone so the acceptance screen keeps
  // working. 403, not 401, so the client does not log the user out.
  // See audits/business-logic-review-2026-08-25.md (BL-01).
  if (
    MUTATING.has(req.method) &&
    !POLICY_EXEMPT.test(req.originalUrl) &&
    sessionRow.policy_version !== policyService.POLICY_VERSION
  ) {
    console.warn(
      `[POLICY] blocked ${req.method} ${req.originalUrl} — user=${decoded.id} accepted ` +
        `"${sessionRow.policy_version ?? "never"}", in force "${policyService.POLICY_VERSION}"`,
    );
    return res.status(403).json({
      error: "You must accept the Privacy Notice and Terms before making changes.",
      code: "policy_not_accepted",
    });
  }

  req.user = decoded;
  maybeRenewToken(res, decoded); // sliding session: extend an active user's token
  next();
}


// ─── Is this token still a live session? ───────────────────────────────────────
// Used by this middleware, the Socket.IO handshake and the revocation sweep
// (services/socketSessions.js), so all three apply the same rule. Returns which
// check failed; the sweep sends that reason to the client.

/** The columns a liveness check needs. One query shape, so it cannot drift either. */
export async function fetchSessionRow(userId) {
  const [[row]] = await db.query(
    "SELECT status, token_version, role, policy_version FROM users WHERE user_id = ? LIMIT 1",
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
      // Log every 403 so an incident review can see who tried what. Operational log
      // only, not system_logs: it also fires on ordinary mis-clicks.
      console.warn(
        `[AUTHZ] 403 ${req.method} ${logSafe(req.originalUrl, 100)} — user=${req.user.id} ` +
          `role="${logSafe(req.user.role, 20)}" needs one of [${roles.join(", ")}]`,
      );
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