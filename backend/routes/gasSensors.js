import express from "express";
import asyncHandler from "../utils/asyncHandler.js";
import gasSensorService from "../services/gasSensorService.js";
import { audit, clientInfo } from "../services/auditService.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { describeError } from "../utils/httpError.js";

const router = express.Router();

router.use(authMiddleware);

/**
 * Push the wiring map to the ESP32 and the labels to every dashboard.
 *
 * Both halves matter and they go to different places. The DEVICE only needs to know which
 * ADC pins to read at all — same payload shape as `irConfig`, so the firmware reuses the
 * parser it already has. The BROWSERS need the labels, because an alert that says "MQ2-3" a
 * second after an admin renamed it "Above UPS cabinet" is the stale-dashboard problem
 * `envConfigUpdated` exists to avoid: the person who made the change is on the settings page
 * and is the least likely to notice everyone else is still seeing the old name.
 */
async function pushGasConfig(io) {
  try {
    const cfg = await gasSensorService.getDeviceConfig();
    io?.to("devices").emit("gasConfig", cfg);
    io?.emit("gasSensorsUpdated", { sensors: gasSensorService.cached() });
  } catch (err) {
    console.error("[gasConfig push error]", describeError(err));
  }
}

// Both roles can READ: the Environment page needs the labels to draw its lines, and it_staff
// live on that page. Mutation is admin-only below — asserting that a sensor is wired is a
// hardware claim, and a wrong one arms a floating ADC pin to raise smoke alarms.
router.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json({ sensors: await gasSensorService.list() });
  }),
);

router.patch(
  "/:channel",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { locationLabel, enabled } = req.body ?? {};
    const updated = await gasSensorService.update(
      req.params.channel,
      { locationLabel, enabled },
      req.user.id,
    );

    await pushGasConfig(req.app.get("io"));

    audit({
      userId: req.user.id,
      module: "devices",
      action: "gas_sensor_update",
      details: `MQ-2 channel ${updated.channel}: "${updated.label}"${updated.enabled ? "" : " (disabled)"}`,
      ...clientInfo(req),
    });

    res.json({ sensor: updated });
  }),
);

export default router;
