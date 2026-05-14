import "../config/env.js";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;


  //  auth middleware
function authMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Access denied. No token provided." });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    // IMPORTANT: always ensure permissions exist
    req.user = {
      ...decoded,
      permissions: decoded.permissions || [],
    };

    next();
  } catch (err) {
    return res.status(403).json({ error: "Invalid or expired token." });
  }
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

// permission - fine access
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const userPermissions = req.user.permissions || [];

    if (!userPermissions.includes(permission)) {
      return res.status(403).json({ error: "Forbidden: missing permission" });
    }

    next();
  };
}

export {
  authMiddleware,
  requireRole,
  requirePermission,
  JWT_SECRET,
};