import "../config/env.js";
import jwt from "jsonwebtoken";
import db from "../config/mysql.js";

const JWT_SECRET = process.env.JWT_SECRET;


  //  auth middleware
async function authMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Access denied. No token provided." });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
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