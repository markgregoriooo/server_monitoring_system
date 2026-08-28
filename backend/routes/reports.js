import express from "express";
import reportService from "../services/reportService.js";
import brandingService from "../services/reportBrandingService.js";
import { PAPER_SIZES, PAPER_SIZE_KEYS, MAX_LOGO_BYTES, MAX_SIGNATORIES } from "../services/reportTemplate.js";
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

// ─── Report template (ICTU branding) ─────────────────────────────────────────
//
// All declared BEFORE the /:id routes so a literal path can never be parsed as an id.
//
// ICTU asked for the letterhead to be theirs to maintain — "what if they change logo" —
// so the mark and the page size are configuration, not files in the repo.

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

// PUT /api/reports/template/signatories — the signature block (admin).
// Body: { signatories: [{ role, name, auto }] }. Order is the printed order.
//
// Validated strictly here rather than folded: normalizeSignatories DROPS a line with no
// role, and silently printing fewer signature lines than an admin just configured is
// exactly the kind of change nobody notices until a document comes back unsigned.
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

// POST /api/reports/template/logo/:slot — upload a letterhead mark (admin).
// Body is the RAW image (Content-Type: image/png or image/jpeg), not multipart and not
// base64. Three reasons:
//   - multer was removed with the avatar-upload feature (middleware/upload.js is gone),
//     and a whole multipart dependency for one admin-only endpoint is not worth it;
//   - base64-in-JSON would inflate the payload by a third and would have to fight the
//     100 kB JSON_BODY_LIMIT that protects every other route;
//   - express.raw is already in Express, and gives a Buffer, which is what both the
//     content sniff and fs.writeFileSync want.
// The declared Content-Type only decides whether the body is parsed at all — what the
// file actually IS gets decided by its leading bytes in reportBrandingService.
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
      // The original filename rides in a HEADER, since the body is the raw image.
      // URI-encoded by the client so a non-ASCII name survives a header, which is
      // Latin-1 by spec. Decoding is guarded: a malformed sequence throws, and it is
      // only a display label — not worth failing an upload that otherwise succeeded.
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

// POST /api/reports — start generating a report from live data (admin + it_staff).
// Body: { type, title?, periodStart?, periodEnd?, deviceId?, paperSize? }
// `deviceId` scopes the report to one device; omit for campus-wide.
// `paperSize` is a4 | letter | folio; omit to take the admin's configured default
// (ICTU asked for the size to be chosen per report, defaulting to long bond).
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
