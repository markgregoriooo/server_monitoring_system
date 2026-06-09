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
    io?.emit("airconStatus", { aircon: { id: +req.params.id, enabled: result.enabled }, entry: result.entry });
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
