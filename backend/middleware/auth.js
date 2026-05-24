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

    req.user = decoded;

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

export {
  authMiddleware,
  requireRole,
  JWT_SECRET,
};