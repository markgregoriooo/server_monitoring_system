import express from "express";
import reportService from "../services/reportService.js";
import { audit, clientInfo } from "../services/auditService.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { describeError } from "../utils/httpError.js";

const router = express.Router();

// Every report action lands in `system_logs` (module 'reports' — a value the schema
// already carried) so it shows up on the History page alongside auth, aircon and
// alert activity. Reads (list, scope-options) are not audited: they are noise, and
// the History page is for actions that changed or exported something.
const describe = (r) =>
  `${r.title}${r.deviceName ? ` [${r.deviceName}]` : ""} (${r.type})`;

// Who originally generated the report. A History row's actor is whoever performed
// THIS action — for a delete that's the admin — so the author has to be carried in
// the description or it is lost with the row. `generatedByName` is null when that
// user has since been removed (BASE_SELECT left-joins `users`).
const byAuthor = (r) => ` — created by ${r.generatedByName ?? `user #${r.generatedBy ?? "?"}`}`;

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

      await audit({
        userId: req.user.id,
        module: "reports",
        action: "generate_report",
        description: `Generated report: ${describe(report)} for ${String(report.periodStart).slice(0, 10)} → ${String(report.periodEnd).slice(0, 10)}`,
        ...clientInfo(req),
      });

      res.status(202).json({ report });

      // Deliberately not awaited. build() never throws, but keep the .catch() so an
      // unexpected rejection can't become an unhandled rejection and take down the
      // process — this runs after the response is already sent.
      reportService.build(report.id).catch((err) => {
        console.error("[REPORTS] background build error:", describeError(err));
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

    // Audited: a download is an EXPORT of campus monitoring data leaving the system,
    // which is exactly what an audit trail exists to record.
    await audit({
      userId: req.user.id,
      module: "reports",
      action: "download_report",
      description: `Downloaded ${String(req.query.format ?? "csv").toUpperCase()}: ${describe(file.report)}${byAuthor(file.report)}`,
      ...clientInfo(req),
    });

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
    await audit({
      userId: req.user.id,
      module: "reports",
      action: "email_report",
      description: `Emailed to ${result.sentTo}: ${describe(result.report)}${byAuthor(result.report)}`,
      ...clientInfo(req),
    });
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

    const removed = await reportService.remove(id);
    if (!removed) return res.status(404).json({ error: "Report not found." });
    await audit({
      userId: req.user.id,
      module: "reports",
      action: "delete_report",
      description: `Deleted report: ${describe(removed)}${byAuthor(removed)}`,
      level: "warning", // destructive + irreversible: the files go too
      ...clientInfo(req),
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
