import express from "express";
import asyncHandler from "../utils/asyncHandler.js";
import widgetPrefsService from "../services/widgetPrefsService.js";
import { authMiddleware } from "../middleware/auth.js";

const router = express.Router();

// GET /api/widget-layout → this user's saved PiP widget layout (defaults if no row)
router.get(
  "/",
  authMiddleware,
  asyncHandler(async (req, res) => {
    res.json(await widgetPrefsService.getLayout(req.user.id));
  }),
);

// PUT /api/widget-layout  body: { tiles: string[] }  (unknown/dupe ids dropped server-side)
router.put(
  "/",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const input = Array.isArray(req.body?.tiles) ? req.body.tiles : req.body;
    if (!Array.isArray(input)) return res.status(400).json({ error: "tiles must be an array" });
    const result = await widgetPrefsService.saveLayout(req.user.id, input);
    res.json({ success: true, ...result });
  }),
);

export default router;
