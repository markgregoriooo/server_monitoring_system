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
    return res.status(403).json({ error: "Invalid or expired token." });
  }

  // F-02: enforce live session state. A token is only valid while the account is
  // still active and its `tv` claim matches the current token_version. logout,
  // disable, role change, and password change all bump token_version, which
  // immediately invalidates previously-issued tokens.
  try {
    const [[user]] = await db.query(
      "SELECT status, token_version FROM users WHERE user_id = ? LIMIT 1",
      [decoded.id],
    );
    if (!user || user.status !== "active" || user.token_version !== decoded.tv) {
      return res.status(401).json({ error: "Session is no longer valid." });
    }
  } catch (err) {
    return next(err);
  }

  req.user = decoded;
  maybeRenewToken(res, decoded); // sliding session: extend an active user's token
  next();
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