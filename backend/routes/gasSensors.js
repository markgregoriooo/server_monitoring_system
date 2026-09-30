import express from "express";
import asyncHandler from "../utils/asyncHandler.js";
import gasSensorService from "../services/gasSensorService.js";
import { audit, clientInfo } from "../services/auditService.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { describeError } from "../utils/httpError.js";

const router = express.Router();

router.use(authMiddleware);

/**
 * Push the wiring map to the ESP32 (which pins to read, same shape as `irConfig`)
 * and the labels to every dashboard, so open pages show the new name right away.
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

// Both roles can read (the Environment page needs the labels). Changes are admin-only:
// enabling an unwired channel would let a floating pin raise smoke alarms.
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
