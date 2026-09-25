import express from "express";
import asyncHandler from "../utils/asyncHandler.js";
import alertsService from "../services/alertsService.js";
import { audit, clientInfo } from "../services/auditService.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";

const router = express.Router();

// The shared alert list + lifecycle. Acknowledge/resolve is an operational action,
// so both admin and it_staff can do it (managing the rules stays admin-only).
router.use(authMiddleware, requireRole("admin", "it_staff"));

// GET /api/alerts?status=active|acknowledged|resolved|open&device=<id>&limit=
router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json({
      alerts: await alertsService.list({
        status: req.query.status, limit: req.query.limit, device: req.query.device,
      }),
    });
  }),
);

// GET /api/alerts/count — number of alerts needing attention (not resolved). Sidebar badge.
router.get(
  "/count",
  asyncHandler(async (_req, res) => {
    res.json({ open: await alertsService.openCount() });
  }),
);

// POST /api/alerts/:id/acknowledge — "I'm handling this".
router.post(
  "/:id/acknowledge",
  asyncHandler(async (req, res) => {
    const alert = await alertsService.acknowledge(req.params.id, req.user.id);
    if (!alert) return res.status(404).json({ error: "Alert not found." });
    await audit({
      userId: req.user.id,
      module: "alerts",
      action: "acknowledge_alert",
      description: `Acknowledged alert: ${alert.title ?? alert.type ?? `#${req.params.id}`}`,
      ...clientInfo(req),
    });
    res.json({ success: true, alert });
  }),
);

// POST /api/alerts/:id/resolve — "this is over".
router.post(
  "/:id/resolve",
  asyncHandler(async (req, res) => {
    const alert = await alertsService.resolve(req.params.id, req.user.id);
    if (!alert) return res.status(404).json({ error: "Alert not found." });
    await audit({
      userId: req.user.id,
      module: "alerts",
      action: "resolve_alert",
      description: `Resolved alert: ${alert.title ?? alert.type ?? `#${req.params.id}`}`,
      ...clientInfo(req),
    });
    res.json({ success: true, alert });
  }),
);

export default router;
