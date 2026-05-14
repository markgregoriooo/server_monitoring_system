import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import authService from "../services/authService.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();

// login rate limiter
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 5, // 5 attempts per ip
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const forwarded = req.headers["x-forwarded-for"];
    const ip = forwarded ? forwarded.split(",")[0].trim() : req.ip;
    return ipKeyGenerator(ip);
  },
  handler: (req, res) => {
    res.status(429).json({
      error: "Too many login attempts. Try again in 5 minutes.",
    });
  },
});

// POST /api/auth/login
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const result = await authService.login(req.body);

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
router.get("/me", authMiddleware, (req, res) => {
  res.json({
    user: req.user,
  });
});

// POST /api/auth/logout
router.post("/logout", authMiddleware, async (req, res) => {
  try {
    // req.user comes from authMiddleware
    await db.query(
      "UPDATE users SET status = ? WHERE id = ?",
      ["inactive", req.user.id]
    );

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
