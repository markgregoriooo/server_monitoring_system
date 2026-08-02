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

// GET /api/reports/scope-options?type=network — devices this report type can be
// scoped to, for the Generate modal's device picker. Empty = campus-wide only.
// Declared before the /:id routes so the literal path can't be read as an id.
router.get("/scope-options", authMiddleware, async (req, res, next) => {
  try {
    const devices = await reportService.scopeOptions(String(req.query.type ?? ""));
    res.json({ devices });
  } catch (err) {
    next(err);
  }
});

// POST /api/reports — start generating a report from live data (admin + it_staff).
// Body: { type, title?, periodStart?, periodEnd?, deviceId? }
// `deviceId` scopes the report to one device; omit for campus-wide.
//
// Answers 202 with the `pending` row as soon as it is recorded, then builds in the
// background — a 30-day network report queries a lot of InfluxDB and would otherwise
// hold the request open. The finished (or failed) row is pushed back over Socket.IO
// as `reportUpdated`; the row status is the fallback for a client that missed it.
router.post(
  "/",
  authMiddleware,
  requireRole("admin", "it_staff"),
  async (req, res, next) => {
    try {
      const { type, title, periodStart, periodEnd, deviceId } = req.body;
      const report = await reportService.create({
        userId: req.user.id,
        type,
        title,
        periodStart,
        periodEnd,
        deviceId,
      });

      res.status(202).json({ report });

      // Deliberately not awaited. build() never throws, but keep the .catch() so an
      // unexpected rejection can't become an unhandled rejection and take down the
      // process — this runs after the response is already sent.
      reportService.build(report.id).catch((err) => {
        console.error("[REPORTS] background build error:", err.message);
      });
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

// POST /api/reports/:id/email — mail an already-generated report as a PDF
// attachment (admin + it_staff). Separate from generate on purpose: re-sending must
// not rebuild the report, since a saved report's numbers are frozen.
// Always sends to the requesting user's own address.
router.post("/:id/email", authMiddleware, requireRole("admin", "it_staff"), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid report id." });

    const result = await reportService.email(id, { toUserId: req.user.id });
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
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
