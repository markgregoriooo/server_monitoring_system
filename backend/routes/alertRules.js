import express from "express";
import asyncHandler from "../utils/asyncHandler.js";
import alertRulesService from "../services/alertRulesService.js";
import { audit, clientInfo } from "../services/auditService.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { describeError } from "../utils/httpError.js";

const router = express.Router();

// Human-readable one-liner for the audit trail, e.g.
//   "cpu > 90 critical [Web-01]" or "temperature >= 32 critical [global]"
function describeRule(rule) {
  const scope = rule.deviceName ? `[${rule.deviceName}]` : "[global]";
  const state = rule.isActive ? "" : " (paused)";
  return `${rule.metricName} ${rule.comparison} ${rule.thresholdValue} ${rule.severity} ${scope}${state}`;
}

// Managing thresholds is admin-only (it_staff can see alerts but not change the
// rules that produce them). Mirrors how user management / approvals are gated.
router.use(authMiddleware, requireRole("admin"));

// After any change, push the room thresholds to the ESP32 (envConfig) so its LED,
// buzzer and status follow the rules. Browsers get them too (`envConfigUpdated`),
// because the dashboards colour readings by these thresholds.
async function pushEnvConfig(io) {
  if (!io) return;
  try {
    const thresholds = await alertRulesService.getRoomThresholds();
    io.to("devices").emit("envConfig", thresholds);
    io.emit("envConfigUpdated", { thresholds });
  } catch (err) {
    console.error("[envConfig push error]", describeError(err));
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
    await audit({
      userId: req.user.id,
      module: "alerts",
      action: "create_rule",
      description: `Created alert rule: ${describeRule(rule)}`,
      ...clientInfo(req),
    });
    await pushEnvConfig(req.app.get("io"));
    res.status(201).json({ success: true, rule });
  }),
);

// PUT /api/alert-rules/:id  body: any subset of the create fields
router.put(
  "/:id",
  asyncHandler(async (req, res) => {
    const rule = await alertRulesService.update(req.params.id, req.body ?? {}, req.user.id);
    await audit({
      userId: req.user.id,
      module: "alerts",
      action: "update_rule",
      description: `Updated alert rule: ${describeRule(rule)}`,
      ...clientInfo(req),
    });
    await pushEnvConfig(req.app.get("io"));
    res.json({ success: true, rule });
  }),
);

// DELETE /api/alert-rules/:id
router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const existing = await alertRulesService.getById(req.params.id);
    await alertRulesService.remove(req.params.id);
    await audit({
      userId: req.user.id,
      module: "alerts",
      action: "delete_rule",
      description: `Deleted alert rule: ${existing ? describeRule(existing) : `#${req.params.id}`}`,
      level: "warning",
      ...clientInfo(req),
    });
    await pushEnvConfig(req.app.get("io"));
    res.json({ success: true });
  }),
);

export default router;
