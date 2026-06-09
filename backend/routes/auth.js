import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import authService from "../services/authService.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();

// login rate limiter
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 failed attempts per IP + email
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  // keyGenerator via ipKeyGenerator(req.ip, 56) below.
  // Bucket per account (email) + IP so one account's failures don't lock out
  // everyone else behind a shared NAT, and an attacker can't pivot accounts.
  // ipKeyGenerator normalizes IPv6 into the /56 subnet for the IP portion.
  keyGenerator: (req) => {
    const ipKey = ipKeyGenerator(req.ip, 56);
    const email = (req.body?.email ?? "").trim().toLowerCase();
    return `${ipKey}:${email}`;
  },
  handler: (req, res) => {
    res.status(429).json({
      error: "Too many login attempts. Try again in 15 minutes.",
    });
  },
});

// Extract client IP + browser from the request for audit logging.
// `trust proxy` is enabled in server.js, so req.ip respects X-Forwarded-For.
function getClientInfo(req) {
  return {
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  };
}

// POST /api/auth/login
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const result = await authService.login({
      ...req.body,
      ...getClientInfo(req),
    });

    res.json({
      token: result.token,
      user: result.user,
    });
  } catch (error) {
    res.status(401).json({
      error: error.message,
    });
  }
});

// GET /api/auth/me  
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await authService.getMe(req.user.id);
    res.json({ user });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

// POST /api/auth/logout
router.post("/logout", authMiddleware, async (req, res) => {
  try {
      await authService.logout(req.user.id, getClientInfo(req));

    res.json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Logout failed",
    });
  }
});

export default router;
