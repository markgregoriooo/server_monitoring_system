import express from "express";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import airconService from "../services/airconService.js";
import { describeError } from "../utils/httpError.js";

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
//
// Device-only on purpose: no browser page colours anything by these boundaries. The
// AirConditioner page reads them over REST and already re-renders from its own save, and
// the Dashboard/Environment pages colour temperature by the ALERT RULES instead (see
// GET /api/environment/thresholds + `envConfigUpdated`). A broadcast with no listener is
// just a promise to keep something in sync that nothing is reading.
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
  // The limit comes from the DEVICE, not from a constant here. The ESP32 reports its pin
  // pool on every connect (sendChannelMap → airconService.setChannelMap), so adding an AC
  // unit is wiring plus registering — no code edit, which is what a hardcoded cap forced.
  //
  // Falls back to AIRCON_MAX_IR_CHANNELS (blank = 2, today's wired pair) only while the
  // ESP32 has never connected, so a cold backend can still be configured.
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

// ── REMOVED: PATCH /:id/mode and PATCH /:id/temp ──────────────────────────────
// Both were unreachable — nothing in the dashboard ever called them. They also
// couldn't have worked: the firmware has no per-degree or per-mode IR codes, so they
// only wrote to MySQL, and `applyAutoIR` overwrites set_temperature on every unit
// that is ON at the next zone change anyway. A manual setting would have been
// silently discarded minutes later.
//
// Mode / Set Temp / Fan are READ-ONLY status on the card — what auto-cooling chose.
// The one real manual control is the on/off toggle above, which does fire IR and
// which applyAutoIR deliberately respects (a unit switched off stays off).
//
// If manual override is ever wanted it needs more than these routes: captured codes
// per temperature AND a per-unit "manual" mode that suspends auto-cooling for that
// unit, with a rule for when auto resumes.

export default router;
