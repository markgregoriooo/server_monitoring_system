import express from "express";
import rateLimit from "express-rate-limit";
import authService from "../services/authService.js";
import googleAuthService from "../services/googleAuthService.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();

// Google sign-in limiter. Each attempt is a real Google verification; legit
// sign-ins succeed and are skipped, so only failures/abuse count toward the cap.
const googleLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  ipv6Subnet: 56,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    res.status(429).json({ error: "Too many sign-in attempts. Try again in 15 minutes." });
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

// POST /api/auth/google — the ONLY login path. Body: { code } (one-time auth code
// from the custom "CSPC Mail" button's authorization-code flow). The service
// exchanges it with Google and verifies the ID token, enforces CSPC domains, then
// logs in (active) or creates a pending registration for admin approval.
// See services/googleAuthService.js.
router.post("/google", googleLimiter, async (req, res) => {
  try {
    const result = await googleAuthService.authenticate(req.body?.code, getClientInfo(req));
    const io = req.app.get("io");

    switch (result.outcome) {
      case "ok":
        return res.json({ token: result.token, user: result.user });
      case "pending_created":
        // Tell open admin dashboards a new request appeared (live pending list).
        io?.emit("userPending", { id: result.user.id });
        return res.status(200).json({
          status: "pending",
          message: "Registration submitted. An administrator will review your request.",
        });
      case "pending":
        return res.status(403).json({
          status: "pending",
          error: "Your registration is still awaiting administrator approval.",
        });
      case "rejected":
        return res.status(403).json({
          status: "rejected",
          error: "Your access request was declined. Please contact an administrator.",
        });
      case "disabled":
        return res.status(403).json({ status: "disabled", error: "Your account has been disabled." });
      default:
        return res.status(401).json({ error: "Sign-in failed." });
    }
  } catch (error) {
    res.status(401).json({ error: error.message });
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
