import express from "express";
import { airconState, airconLog } from "../data/db.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";

const router = express.Router();

// GET /api/aircon — get current aircon state
router.get("/", authMiddleware, (req, res) => {
  res.json({
    aircon: airconState,
    log: airconLog
  });
});

// POST /api/aircon/toggle — turn aircon ON or OFF
router.post(
  "/toggle",
  authMiddleware,
  requireRole("super_admin", "it_staff"),
  (req, res) => {
    airconState.enabled = !airconState.enabled;

    const action = airconState.enabled
      ? "Manually turned ON"
      : "Manually turned OFF";

    const entry = {
      time: new Date().toLocaleTimeString("en-PH"),
      action,
      reason: `By ${req.user.name}`
    };

    airconLog.unshift(entry);

    res.json({
      aircon: airconState,
      entry
    });
  }
);

// POST /api/aircon/mode — change aircon mode
router.post(
  "/mode",
  authMiddleware,
  requireRole("super_admin", "it_staff"),
  (req, res) => {
    const { mode } = req.body;

    if (!["Cool", "Auto", "Fan"].includes(mode)) {
      return res.status(400).json({
        error: "Invalid mode. Use Cool, Auto, or Fan."
      });
    }

    airconState.mode = mode;

    const entry = {
      time: new Date().toLocaleTimeString("en-PH"),
      action: `Mode changed to ${mode}`,
      reason: `By ${req.user.name}`
    };

    airconLog.unshift(entry);

    res.json({
      aircon: airconState,
      entry
    });
  }
);

// POST /api/aircon/temp — set target temperature
router.post(
  "/temp",
  authMiddleware,
  requireRole("super_admin", "it_staff"),
  (req, res) => {
    const { temp } = req.body;

    if (typeof temp !== "number" || temp < 16 || temp > 30) {
      return res.status(400).json({
        error: "Temperature must be between 16 and 30."
      });
    }

    airconState.setTemp = temp;

    const entry = {
      time: new Date().toLocaleTimeString("en-PH"),
      action: `Target temp set to ${temp}°C`,
      reason: `By ${req.user.name}`
    };

    airconLog.unshift(entry);

    res.json({
      aircon: airconState,
      entry
    });
  }
);

export default router;
