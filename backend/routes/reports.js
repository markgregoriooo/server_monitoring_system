import express from "express";
import reportService from "../services/reportService.js";
import brandingService from "../services/reportBrandingService.js";
import { PAPER_SIZES, PAPER_SIZE_KEYS, MAX_LOGO_BYTES, MAX_SIGNATORIES } from "../services/reportTemplate.js";
import { audit, clientInfo } from "../services/auditService.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { describeError } from "../utils/httpError.js";

const router = express.Router();

// Report actions are written to system_logs (module 'reports') so they appear on the
// History page. Reads are not logged.
const describe = (r) =>
  `${r.title}${r.deviceName ? ` [${r.deviceName}]` : ""} (${r.type})`;

// Who generated the report. The History row's actor is whoever did this action (for
// a delete, the admin), so the author goes in the description. Null if that user
// has been removed.
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

// GET /api/reports/scope-options?type=network ─ devices this report type can be
// limited to. Empty = campus-wide only. Declared before the /:id routes.
router.get("/scope-options", authMiddleware, async (req, res, next) => {
  try {
    const devices = await reportService.scopeOptions(String(req.query.type ?? ""));
    res.json({ devices });
  } catch (err) {
    next(err);
  }
});

// ─── Report template (ICTU branding) ─────────────────────────────────────────
// Declared before the /:id routes. ICTU maintains its own logos and page size, so
// they are settings, not files in the repo.

// GET /api/reports/template — active paper size + which marks are ICTU's own uploads.
// Readable by both roles: the Generate modal needs the size options and the default.
router.get("/template", authMiddleware, async (req, res, next) => {
  try {
    const template = await brandingService.describe();
    res.json({ template, paperSizes: PAPER_SIZES });
  } catch (err) {
    next(err);
  }
});

// PUT /api/reports/template/paper-size — set the DEFAULT size (admin).
// Body: { paperSize: "a4" | "letter" | "folio" }
router.put("/template/paper-size", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    const requested = String(req.body?.paperSize ?? "").trim().toLowerCase();
    if (!PAPER_SIZE_KEYS.includes(requested)) {
      return res
        .status(400)
        .json({ error: `Invalid paper size. Choose one of: ${PAPER_SIZE_KEYS.join(", ")}.` });
    }
    const paperSize = await brandingService.setDefaultPaperSize(requested, req.user.id);
    await audit({
      userId: req.user.id,
      module: "reports",
      action: "update_report_template",
      description: `Default report paper size set to ${PAPER_SIZES[paperSize].label}`,
      ...clientInfo(req),
    });
    // Fire-and-forget: every open Generate dialog picks the change up at once.
    reportService.broadcastTemplate();
    res.json({ success: true, paperSize });
  } catch (err) {
    next(err);
  }
});

// PUT /api/reports/template/unit-name — the large line on the letterhead (admin).
// Body: { unitName: string }. Blank restores the default.
router.put("/template/unit-name", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    const unitName = await brandingService.setUnitName(req.body?.unitName, req.user.id);
    await audit({
      userId: req.user.id,
      module: "reports",
      action: "update_report_template",
      description: `Report letterhead unit line set to "${unitName}"`,
      ...clientInfo(req),
    });
    // Fire-and-forget: every open Generate dialog picks the change up at once.
    reportService.broadcastTemplate();
    res.json({ success: true, unitName });
  } catch (err) {
    next(err);
  }
});

// PUT /api/reports/template/signatories ─ the signature block (admin).
// Body: { signatories: [{ role, name, auto }] }, in printed order. Validated
// strictly so a line without a role is rejected instead of silently dropped.
router.put("/template/signatories", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    const sent = req.body?.signatories;
    if (!Array.isArray(sent) || sent.length === 0) {
      return res.status(400).json({ error: "Provide at least one signature line." });
    }
    if (sent.length > MAX_SIGNATORIES) {
      return res.status(400).json({ error: `At most ${MAX_SIGNATORIES} signature lines.` });
    }
    if (sent.some((s) => !String(s?.role ?? "").trim())) {
      return res.status(400).json({ error: "Every signature line needs a label." });
    }
    const signatories = await brandingService.setSignatories(sent, req.user.id);
    await audit({
      userId: req.user.id,
      module: "reports",
      action: "update_report_template",
      description: `Report signature block set to: ${signatories.map((s) => s.role).join(" / ")}`,
      ...clientInfo(req),
    });
    // Fire-and-forget: every open Generate dialog picks the change up at once.
    reportService.broadcastTemplate();
    res.json({ success: true, signatories });
  } catch (err) {
    next(err);
  }
});

// POST /api/reports/template/logo/:slot ─ upload a letterhead logo (admin).
// The body is the raw image (image/png or image/jpeg), not multipart or base64:
// no extra dependency, and base64 would not fit the 100 kB JSON limit. The file
// type is checked from its first bytes in reportBrandingService, not from the header.
router.post(
  "/template/logo/:slot",
  authMiddleware,
  requireRole("admin"),
  express.raw({ type: ["image/png", "image/jpeg"], limit: MAX_LOGO_BYTES }),
  async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({
          error: "Send the image as a raw body with Content-Type image/png or image/jpeg.",
        });
      }
      // The original filename comes in a header (URI-encoded by the client). A bad
      // encoding is ignored; it is only a display label.
      let originalName = "";
      try {
        originalName = decodeURIComponent(String(req.get("X-Logo-Filename") ?? ""));
      } catch {
        originalName = "";
      }
      const saved = await brandingService.saveLogo(
        req.params.slot,
        req.body,
        req.user.id,
        originalName,
      );
      await audit({
        userId: req.user.id,
        module: "reports",
        action: "update_report_template",
        description: `Uploaded ${saved.slot.toUpperCase()} report logo (${saved.kind}, ${Math.round(saved.bytes / 1024)} KB)`,
        ...clientInfo(req),
      });
      // Fire-and-forget: every open Generate dialog picks the change up at once.
      reportService.broadcastTemplate();
      res.json({ success: true, ...saved });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  },
);

// DELETE /api/reports/template/logo/:slot — revert to the bundled mark (admin).
router.delete("/template/logo/:slot", authMiddleware, requireRole("admin"), async (req, res, next) => {
  try {
    const cleared = await brandingService.clearLogo(req.params.slot, req.user.id);
    await audit({
      userId: req.user.id,
      module: "reports",
      action: "update_report_template",
      description: `Removed the uploaded ${cleared.slot.toUpperCase()} report logo`,
      level: "warning", // the uploaded file is deleted, not just unlinked
      ...clientInfo(req),
    });
    // Fire-and-forget: every open Generate dialog picks the change up at once.
    reportService.broadcastTemplate();
    res.json({ success: true, ...cleared });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// POST /api/reports ─ generate a report from live data (admin + it_staff).
// Body: { type, title?, periodStart?, periodEnd?, deviceId?, paperSize? }
// `deviceId` limits it to one device; omit for campus-wide. `paperSize` is
// a4 | letter | folio; omit for the configured default.
//
// Answers 202 with the pending row, then builds in the background. The result is
// pushed as `reportUpdated`; the row status covers a client that missed it.
router.post(
  "/",
  authMiddleware,
  requireRole("admin", "it_staff"),
  async (req, res, next) => {
    try {
      const { type, title, periodStart, periodEnd, deviceId, paperSize } = req.body;
      const report = await reportService.create({
        userId: req.user.id,
        type,
        title,
        periodStart,
        periodEnd,
        deviceId,
        paperSize,
      });

      await audit({
        userId: req.user.id,
        module: "reports",
        action: "generate_report",
        description: `Generated report: ${describe(report)} for ${String(report.periodStart).slice(0, 10)} → ${String(report.periodEnd).slice(0, 10)}`,
        ...clientInfo(req),
      });

      res.status(202).json({ report });

      // Not awaited. build() never throws, but keep .catch() so an unexpected rejection
      // cannot crash the process after the response was sent.
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

// POST /api/reports/:id/email ─ email an already-generated report as a PDF
// (admin + it_staff). Does not rebuild, so the numbers stay as generated. Always
// sent to the requesting user.
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
