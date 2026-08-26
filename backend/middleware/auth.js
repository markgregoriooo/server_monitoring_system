import "../config/env.js";
import jwt from "jsonwebtoken";
import db from "../config/mysql.js";
import policyService from "../services/policyService.js";
import { logSafe } from "../utils/logSafe.js";

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

// ─── The one definition of how this app's JWTs are stamped and checked ─────────
//
// `iss`/`aud` are enforced on EVERY verify. HS256 rests on a single shared secret,
// and a secret has a way of being reused — copied into a sibling service, a script,
// a staging box. Without these claims any token signed with that secret is accepted
// here as a session; with them, a token has to have been minted BY this app FOR this
// app. Cheap, and it is the difference between "the signature is right" and "this
// credential was issued for this purpose".
//
// Exported because there are THREE verify sites (this middleware, the Socket.IO
// handshake, and the rate limiter's user key — both in src/server.js) plus two sign
// sites. Five hand-written copies of the same options is four chances to drift, and
// a drift here fails as a mass logout.
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

// ─── Absolute session cap ─────────────────────────────────────────────────────
//
// The renewal below is a SLIDING window, and a sliding window with no ceiling is not
// a session — it is a permanent credential that merely re-writes itself. Any tab that
// keeps making requests (this dashboard polls constantly, and one of its jobs is to
// live on a wall display) renewed forever, so a token captured once could be kept
// alive indefinitely by an attacker simply by using it. Nothing expired it but the
// user thinking to press Log out.
//
// `ist` ("issued session time") is stamped once at sign-in and carried across every
// renewal, so it measures the age of the SESSION rather than of the current token.
// Past the cap we simply stop renewing: the token then dies at its own `exp`, which
// the client already handles cleanly (api/client.ts notifySessionExpired), instead of
// a hard 401 in the middle of whatever the user was doing. Worst case the session
// lives cap + 1h. Re-authenticating is one click, because Google SSO is already warm.
// The routes a not-yet-accepted user must still reach, or the gate would lock them out
// of the screen that lets them through it: reading who they are, accepting, and logging
// out. Anchored to the mount path so "/api/policyXYZ" cannot satisfy it.
const POLICY_EXEMPT = /^\/api\/(policy|auth)(\/|$)/;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const SESSION_MAX_HOURS = Number(process.env.SESSION_MAX_HOURS) || 12;
const SESSION_MAX_SEC = SESSION_MAX_HOURS * 3600;

// One token lifetime, in seconds. Must track RENEW_TTL above and issueSession()'s
// `expiresIn`. Named because the hard limit below is expressed in terms of it.
const TOKEN_TTL_SEC = 3600;

/**
 * The latest instant at which ANY token belonging to this session can still be valid.
 *
 * Past the cap, maybeRenewToken stops renewing — it does NOT 401, deliberately, so the
 * current token lives out its own `exp` and the client's ordinary expiry path handles
 * the ending. That is why the documented worst case is "cap + 1h": the last renewal
 * possible happens a moment before the cap, and it mints a token good for one more TTL.
 *
 * After this instant no validly-issued token for this session exists, so anything still
 * presenting itself as this session is outliving it by definition.
 *
 * Takes the CLAIMS rather than a bare `ist` so the `iat` fallback lives in one place:
 * a token minted before `ist` existed has no session start, and treating it as ageless
 * is the exact hole `ist` was added to close.
 */
export function sessionHardExpirySec(claims) {
  const start = claims?.ist ?? claims?.iat;
  if (typeof start !== "number") return null; // no anchor — caller decides
  return start + SESSION_MAX_SEC + TOKEN_TTL_SEC;
}

/**
 * Whether a session has outlived its absolute ceiling.
 *
 * ⚠️ This is NOT the same question as "has this token expired". HTTP sessions slide, so
 * an actively-used session legitimately outlives the `exp` of any single token it has
 * held — which is why socketSessions.js is right to ignore `exp`. The CAP has no such
 * excuse: nothing legitimately outlives it, so it is safe to enforce anywhere.
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

  // Drop the time claims so jwt.sign can stamp fresh ones from expiresIn — and drop
  // iss/aud too: jwt.sign THROWS if an option duplicates a claim already in the
  // payload, so leaving them here would make every renewal a 500.
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
    // logSafe, not slice: the User-Agent is fully attacker-controlled, and a newline in
    // it forges a second log line that reads as a genuine [AUTH] entry (CWE-117). Slicing
    // does not help — the newline is usually in the first few bytes.
    const ua = logSafe(req.get("user-agent") ?? "?", 60);
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
  let sessionRow;
  try {
    sessionRow = await fetchSessionRow(decoded.id);
    if (!sessionIsLive(sessionRow, decoded.tv)) {
      return res.status(401).json({ error: "Session is no longer valid." });
    }
  } catch (err) {
    return next(err);
  }

  // AUTHORIZATION READS THE DATABASE, NOT THE TOKEN.
  //
  // `requireRole` gates on `req.user.role`, which came out of the JWT payload. In the
  // normal path that is safe — every role change goes through userService.updateUser,
  // which bumps token_version and so rejects the old token outright. But that safety
  // is a property of ONE code path remembering to bump a counter, and this codebase
  // has already been bitten by that shape: socketSessions.js exists as a sweep rather
  // than a push precisely because "there are four such sites and a sweep cannot miss a
  // fifth (or a hand-edited row)".
  //
  // A role edited straight in SQL — the documented way the first admin is created
  // (deployment-guide.md §4.3) — bumps nothing, so the token keeps asserting the old
  // role until it expires. Taking the role from the row we have just read costs no
  // extra query and makes that window zero. `permissions` in the payload stays as-is:
  // it drives which nav links the dashboard draws, never a server-side decision.
  if (sessionRow.role && sessionRow.role !== decoded.role) {
    console.warn(
      `[AUTH] role for user=${decoded.id} is "${sessionRow.role}" in the database but ` +
        `"${decoded.role}" in the token — using the database. If this was not a direct ` +
        "SQL edit, something changed a role without bumping token_version.",
    );
    decoded.role = sessionRow.role;
  }

  // ─── Privacy Notice acceptance, enforced on the SERVER ─────────────────────
  //
  // The acceptance gate was `App.tsx:138` and nothing else — a React component that
  // renders PolicyGate instead of the dashboard. That stops the UI from drawing; it
  // does NOT stop the token from working. An `active` user who has never accepted
  // holds a fully functional session and can drive the whole API with curl.
  //
  // That is the same class of mistake CLAUDE.md already rejects for the login page:
  // "a checkbox on the login page could not be attributed to a person — it would be a
  // client-side flag, bypassable by clearing sessionStorage." Correct — and a gate in
  // AppShell is a client-side flag too, just a less obvious one. RA 10173 compliance
  // rests on consent being recorded BEFORE the system is used, so the check has to run
  // where the credential is checked.
  //
  // Scoped to MUTATING methods on purpose. The principled line is attribution: every
  // write lands an attributable `system_logs` row, and consent should precede an
  // attributable action. Reads are already gated in the UI, and blocking them here
  // would risk breaking the very screen a user needs in order to accept. Widen to all
  // methods by deleting the `MUTATING.has(...)` term if ICTU wants the stricter reading.
  //
  // 403, never 401: the session is perfectly valid, so the client must NOT treat this
  // as an expiry and log out (api/client.ts fires logout on 401 and deliberately not on
  // a 403 "Insufficient permissions"). See audits/business-logic-review-2026-08-25.md — BL-01.
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
      // A 403 is a SECURITY EVENT and was previously silent — the one authorisation
      // outcome this codebase did not write down. "it_staff user 9 tried DELETE
      // /api/users/1" is exactly what an incident review needs, and its absence is why
      // an insufficient-logging finding is on every OWASP list (CWE-778).
      // Logged, not audited to `system_logs`: this fires on every mis-click of a nav link
      // a role cannot use, so it belongs in the operational log, not the compliance one.
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