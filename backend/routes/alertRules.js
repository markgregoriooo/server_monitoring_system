import express from "express";
import asyncHandler from "../utils/asyncHandler.js";
import alertRulesService from "../services/alertRulesService.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";

const router = express.Router();

// Managing thresholds is admin-only (it_staff can see alerts but not change the
// rules that produce them). Mirrors how user management / approvals are gated.
router.use(authMiddleware, requireRole("admin"));

// After any change, push the new room-level thresholds to the ESP32 so its
// LED/buzzer/reported status stay in sync with these rules (no reflash needed).
async function pushEnvConfig(io) {
  if (!io) return;
  try {
    io.to("devices").emit("envConfig", await alertRulesService.getRoomThresholds());
  } catch (err) {
    console.error("[envConfig push error]", err.message);
  }
}

// GET /api/alert-rules → all rules (global + per-server), newest scope first.
router.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json({ rules: await alertRulesService.list() });
  }),
);

// POST /api/alert-rules  body: { deviceId|null, metricName, thresholdValue, comparison, severity, isActive? }
router.post(
  "/",
  asyncHandler(async (req, res) => {
    const rule = await alertRulesService.create(req.body ?? {}, req.user.id);
    await pushEnvConfig(req.app.get("io"));
    res.status(201).json({ success: true, rule });
  }),
);

// PUT /api/alert-rules/:id  body: any subset of the create fields
router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const rule = await alertRulesService.update(req.params.id, req.body ?? {}, req.user.id);
    await pushEnvConfig(req.app.get("io"));
    res.json({ success: true, rule });
  }),
);

// DELETE /api/alert-rules/:id
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await alertRulesService.remove(req.params.id);
    await pushEnvConfig(req.app.get("io"));
    res.json({ success: true });
  }),
);

export default router;
