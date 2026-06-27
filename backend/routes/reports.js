import express from "express";
import reportService from "../services/reportService.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";

const router = express.Router();

// GET /api/reports — list saved reports (newest first), optional ?type= filter.
router.get("/", authMiddleware, async (req, res, next) => {
  try {
    const reports = await reportService.list({ type: req.query.type });
    res.json({ reports });
  } catch (err) {
    next(err);
  }
});

// POST /api/reports — generate a new report from live data (admin + it_staff).
// Body: { type, title?, periodStart?, periodEnd? }
router.post(
  "/",
  authMiddleware,
  requireRole("admin", "it_staff"),
  async (req, res, next) => {
    try {
      const { type, title, periodStart, periodEnd } = req.body;
      const report = await reportService.generate({
        userId: req.user.id,
        type,
        title,
        periodStart,
        periodEnd,
      });
      res.status(201).json({ report });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  },
);

// GET /api/reports/:id/download?format=csv|pdf — stream the stored file.
router.get("/:id/download", authMiddleware, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid report id." });

    const file = await reportService.fileFor(id, req.query.format ?? "csv");
    if (!file) return res.status(404).json({ error: "Report file not found." });

    res.download(file.absPath, file.downloadName);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/reports/:id — remove a report + its files (admin only).
router.delete("/:id", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid report id." });

    const ok = await reportService.remove(id);
    if (!ok) return res.status(404).json({ error: "Report not found." });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
