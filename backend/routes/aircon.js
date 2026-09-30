import express from "express";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import airconService from "../services/airconService.js";
import { describeError } from "../utils/httpError.js";
import { isDeviceConnected, NO_DEVICE_MESSAGE } from "../sockets/deviceRoom.js";
import { audit, clientInfo } from "../services/auditService.js";

const router = express.Router();

// Convenience: push updated IR channel config to the single ESP32
async function pushIRConfig(io) {
  if (!io) return;
  const config = await airconService.getChannelConfig();
  io.to("devices").emit("irConfig", config);
}

// ── GET /api/aircon ───────────────────────────────────────────────────────────
router.get("/", authMiddleware, async (req, res, next) => {
  try {
    const data = await airconService.getAll();
    res.json({ ...data, channelMap: airconService.getChannelMap() });
  } catch (err) {
    next(err);
  }
});

// GET /api/aircon/channels was removed on 2026-08-25: it was unauthenticated and
// unused (the ESP32 gets the same data as the `irConfig` socket event). If firmware
// ever needs an HTTP bootstrap, protect it with the device secret.
// See audits/authorization-review-2026-08-25.md (AZ-01).

// Push the auto-cooling zone thresholds to the ESP32 (acConfig) so changing when IR
// fires needs no reflash. Sent to the device only: the dashboards colour temperature
// by the alert rules, not by these.
async function pushACConfig(io) {
  if (!io) return;
  try {
    io.to("devices").emit("acConfig", await airconService.getDeviceIRConfig());
  } catch (err) {
    console.error("[acConfig push error]", describeError(err));
  }
}

// ── GET /api/aircon/ir-config — auto-cooling zone thresholds (both roles) ──────
router.get("/ir-config", authMiddleware, async (req, res, next) => {
  try {
    res.json({ config: await airconService.getIRConfig() });
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/aircon/ir-config — admin only; persist + re-push to the ESP32 ─────
router.put("/ir-config", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    const config = await airconService.saveIRConfig(req.body ?? {}, req.user.id);
    await pushACConfig(req.app.get("io"));
    res.json({ success: true, config });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// ── POST /api/aircon ──────────────────────────────────────────────────────────
router.post("/", authMiddleware, requireRole("admin", "it_staff"), async (req, res, next) => {
  const { name, ir_channel } = req.body;
  
  if (!name?.trim())                    return res.status(400).json({ error: "name is required" });
  const ch = parseInt(ir_channel);
  // The channel limit comes from the ESP32, which reports its pins on connect. Falls
  // back to AIRCON_MAX_IR_CHANNELS (default 2) until the ESP32 has connected once.
  const maxChannels = airconService.getChannelMap().length
    || Number(process.env.AIRCON_MAX_IR_CHANNELS)
    || 2;
  if (!ch || ch < 1 || ch > maxChannels) {
    return res.status(400).json({ error: `ir_channel must be 1–${maxChannels}` });
  }

  try {
    const { deviceId } = await airconService.addUnit({
      name: name.trim(), ir_channel: ch,
      userId: req.user.id, userName: req.user.name,
    });
    await pushIRConfig(req.app.get("io"));

    // Adding a unit puts its IR channel under automatic control, so record it in the audit log.
    audit({
      userId: req.user.id,
      module: "aircon",
      action: "aircon_add",
      details: `Registered "${name.trim()}" on IR channel ${ch}`,
      ...clientInfo(req),
    });

    res.status(201).json({ success: true, deviceId });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: `IR channel ${ch} is already assigned` });
    }
    // Duplicate display name (409) from airconService.addUnit.
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// ── DELETE /api/aircon/:id ────────────────────────────────────────────────────
router.delete("/:id", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    const removed = await airconService.removeUnit(req.params.id);
    if (!removed) return res.status(404).json({ error: "Unit not found" });
    await pushIRConfig(req.app.get("io"));

    // Removing a unit stops IR control for it. The name is read before the DELETE so
    // the audit entry can say which unit it was.
    audit({
      userId: req.user.id,
      module: "aircon",
      action: "aircon_remove",
      details: `Removed "${removed.name}"${removed.ir_channel ? ` from IR channel ${removed.ir_channel}` : ""}`,
      ...clientInfo(req),
    });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/aircon/:id/toggle ──────────────────────────────────────────────
router.patch("/:id/toggle", authMiddleware, requireRole("admin", "it_staff"), async (req, res, next) => {
  try {
    const io = req.app.get("io");

    // Check the ESP32 is connected before writing anything. An emit into an empty room
    // is silently dropped, and we must not log "turned ON" when no IR was sent. Same
    // check as calibrate-gas (sockets/deviceRoom.js).
    if (!isDeviceConnected(io)) {
      return res.status(409).json({ error: NO_DEVICE_MESSAGE });
    }

    const result = await airconService.toggle(req.params.id, req.user.id, req.user.name);
    if (!result) return res.status(404).json({ error: "Unit not found" });

    io?.emit("airconStatus", {
      aircon: {
        id: +req.params.id,
        enabled: result.enabled,
        // Present only when switching ON re-synced the unit to the current zone.
        ...(result.setTemp != null && { setTemp: result.setTemp }),
      },
      entry: result.entry,
    });
    // Second event so the re-sync shows as its own activity-log row (like an auto IR fire).
    if (result.syncEntry) {
      io?.emit("airconStatus", { aircon: { id: +req.params.id }, entry: result.syncEntry });
    }
    await pushIRConfig(io);

    // Fire the actual ON/OFF IR signal on the physical AC's channel
    io?.to("devices").emit("irCommand", {
      channel: result.ir_channel,
      action:  result.enabled ? "on" : "off",
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/aircon/:id/name ────────────────────────────────────────────────
// Rename a unit. Admin + it_staff, like add/toggle; renaming is not destructive.
router.patch("/:id/name", authMiddleware, requireRole("admin", "it_staff"), async (req, res, next) => {
  try {
    const result = await airconService.rename(
      req.params.id, req.body?.name, req.user.id, req.user.name,
    );
    if (!result) return res.status(404).json({ error: "Unit not found" });
    // Only broadcast a real change — a no-op rename shouldn't spam other dashboards.
    if (result.entry) {
      req.app.get("io")?.emit("airconStatus", {
        aircon: { id: +req.params.id, name: result.name },
        entry: result.entry,
      });
    }
    res.json({ success: true, name: result.name, entry: result.entry });
  } catch (err) {
    // 400 (empty/too long) or 409 (name already used by another unit).
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// PATCH /:id/mode and PATCH /:id/temp were removed: nothing called them, and the
// firmware has no per-degree IR codes, so they only changed the database (and
// applyAutoIR would overwrite it at the next zone change). Mode, set temp and fan
// are read-only status. Manual override would need captured codes per temperature
// and a per-unit manual mode that pauses auto-cooling.

export default router;
