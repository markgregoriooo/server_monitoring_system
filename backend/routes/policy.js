import express from "express";
import policyService from "../services/policyService.js";
import { authMiddleware } from "../middleware/auth.js";
import { clientInfo } from "../services/auditService.js";

const router = express.Router();

// GET /api/policy/version — PUBLIC on purpose (no authMiddleware).
//
// The Privacy Notice has to be readable by someone who has not signed in — a
// notice you can only see after agreeing to it defeats the point, and the Data
// Privacy Act's transparency principle expects it available up front. The public
// /privacy page reads this to stamp itself with the version in force. It exposes
// nothing but a date string.
router.get("/version", (_req, res) => {
  res.json({ version: policyService.POLICY_VERSION });
});

// POST /api/policy/accept — record that the signed-in user accepted the version
// currently in force. Takes no body: the version comes from the server constant,
// never from the client (see policyService.accept).
router.post("/accept", authMiddleware, async (req, res) => {
  try {
    const result = await policyService.accept(req.user.id, clientInfo(req));
    res.json({ success: true, ...result });
  } catch (error) {
    if (error?.message === "User not found.") {
      return res.status(404).json({ error: error.message });
    }
    // The acceptance record failed to write, so the user has NOT accepted. Say so
    // rather than letting the UI proceed on an optimistic assumption.
    console.error("[POLICY] failed to record acceptance:", error);
    res.status(503).json({ error: "Could not record your acceptance. Please try again." });
  }
});

export default router;
