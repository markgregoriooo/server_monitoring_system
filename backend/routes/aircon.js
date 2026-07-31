import express from "express";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import airconService from "../services/airconService.js";

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

// ── GET /api/aircon/channels — ESP32 boot-time config fetch (no auth) ─────────
router.get("/channels", async (req, res, next) => {
  try {
    res.json(await airconService.getChannelConfig());
  } catch (err) {
    next(err);
  }
});

// Push the auto-cooling IR zone thresholds to the ESP32 (its getIRZone() boundaries) so
// changing WHEN IR fires needs no reflash — mirrors envConfig in routes/alertRules.js.
async function pushACConfig(io) {
  if (!io) return;
  try {
    io.to("devices").emit("acConfig", await airconService.getDeviceIRConfig());
  } catch (err) {
    console.error("[acConfig push error]", err.message);
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
  // F-07: cap at the firmware's MAX_IR_CHANNELS (env_monitor_v2.ino) — channels above
  // this are accepted by the DB but never actuate hardware.
  if (!ch || ch < 1 || ch > 4)          return res.status(400).json({ error: "ir_channel must be 1–4" });

  try {
    const { deviceId } = await airconService.addUnit({
      name: name.trim(), ir_channel: ch,
      userId: req.user.id, userName: req.user.name,
    });
    await pushIRConfig(req.app.get("io"));
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
    const deleted = await airconService.removeUnit(req.params.id);
    if (!deleted) return res.status(404).json({ error: "Unit not found" });
    await pushIRConfig(req.app.get("io"));
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/aircon/:id/toggle ──────────────────────────────────────────────
router.patch("/:id/toggle", authMiddleware, requireRole("admin", "it_staff"), async (req, res, next) => {
  try {
    const result = await airconService.toggle(req.params.id, req.user.id, req.user.name);
    if (!result) return res.status(404).json({ error: "Unit not found" });

    const io = req.app.get("io");
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
// Rename a unit. Gated like add/toggle (admin + it_staff) rather than delete
// (admin-only): a rename is a label change, not a destructive one — and whoever can
// create a unit with a name should be able to correct it.
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

// ── PATCH /api/aircon/:id/mode ────────────────────────────────────────────────
router.patch("/:id/mode", authMiddleware, requireRole("admin", "it_staff"), async (req, res, next) => {
  const { mode } = req.body;
  if (!["cool", "auto", "fan"].includes(mode?.toLowerCase())) {
    return res.status(400).json({ error: "mode must be cool, auto, or fan" });
  }
  try {
    const result = await airconService.setMode(req.params.id, mode.toLowerCase(), req.user.id, req.user.name);
    req.app.get("io")?.emit("airconStatus", { aircon: { id: +req.params.id, mode: mode.toLowerCase() }, entry: result.entry });
    res.json({ success: true, entry: result.entry });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/aircon/:id/temp ────────────────────────────────────────────────
router.patch("/:id/temp", authMiddleware, requireRole("admin", "it_staff"), async (req, res, next) => {
  const { temp } = req.body;
  if (typeof temp !== "number" || temp < 16 || temp > 30) {
    return res.status(400).json({ error: "temp must be 16–30" });
  }
  try {
    const result = await airconService.setTemp(req.params.id, temp, req.user.id, req.user.name);
    req.app.get("io")?.emit("airconStatus", { aircon: { id: +req.params.id, setTemp: temp }, entry: result.entry });
    res.json({ success: true, entry: result.entry });
  } catch (err) {
    next(err);
  }
});

export default router;
