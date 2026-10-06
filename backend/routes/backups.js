import express from "express";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import systemBackupService from "../services/systemBackupService.js";
import { validateSchedule, DAY_NAMES } from "../services/backupSchedule.js";
import { audit, clientInfo } from "../services/auditService.js";

/**
 * Backups module (mounted at /api/backups) — ADMIN ONLY, every route.
 *
 *   GET  /                  status cards + the backup list + the schedule
 *   POST /run               "Back up now" (202; the result arrives as `backupUpdated`)
 *   POST /verify            verify every archive still on disk
 *   POST /:id/verify        verify one
 *   GET  /:id/download      the ENCRYPTED archive, as stored
 *   DELETE /:id             a MANUAL backup only (weekly ones age out; the last good one stays)
 *   PUT  /schedule          { day, time, keepWeeks }
 *
 * Gated at router.use, so a route added later inherits the guard. it_staff is excluded
 * on purpose: an archive is the whole database — every account, the audit trail, the
 * ciphertexts of the agent and RouterOS credentials. A download stays encrypted, but
 * who may take a copy of the database off the server is an admin decision.
 *
 * There is NO restore route. Restoring replaces the live database, and a click — or a
 * stolen admin session — must not be able to do that. It is a documented command
 * (`npm run backup:decrypt`, then the steps in backup-storage.md).
 */
const router = express.Router();
router.use(authMiddleware, requireRole("admin"));

const parseId = (req) => {
  const id = parseInt(req.params.id, 10);
  return Number.isInteger(id) ? id : null;
};

const mb = (b) => (b == null ? "?" : `${(b / 1048576).toFixed(1)} MB`);

router.get("/", async (_req, res, next) => {
  try {
    const [status, backups] = await Promise.all([systemBackupService.status(), systemBackupService.list()]);
    res.json({ status, backups });
  } catch (err) {
    next(err);
  }
});

router.post("/run", async (req, res, next) => {
  try {
    if (systemBackupService.isRunning()) return res.status(409).json({ error: "A backup is already running." });
    // Answer straight away; a backup takes from seconds to minutes. Errors that stop it
    // from STARTING (no key) are still reported here, by awaiting until the row exists.
    const started = systemBackupService.runBackup({ kind: "manual", userId: req.user.id });
    const early = await Promise.race([started.then(() => null, (e) => e), new Promise((r) => setTimeout(() => r(null), 300))]);
    if (early) return res.status(early.status ?? 500).json({ error: early.message });
    started
      .then((row) =>
        audit({
          userId: req.user.id,
          module: "backups",
          action: "backup_run",
          description:
            row?.status === "ok"
              ? `Backed up the system now: ${row.fileName} (${mb(row.sizeBytes)}, ${row.dataFiles} data files)`
              : `Tried to back up the system now — failed: ${row?.error ?? "unknown error"}`,
          level: row?.status === "ok" ? "info" : "warning",
          ...clientInfo(req),
        }),
      )
      .catch(() => {});
    res.status(202).json({ started: true });
  } catch (err) {
    next(err);
  }
});

router.post("/verify", async (req, res, next) => {
  try {
    const result = await systemBackupService.verifyAll();
    await audit({
      userId: req.user.id,
      module: "backups",
      action: "backup_verify",
      description: `Verified all backups: ${result.ok} OK, ${result.failed} failed`,
      level: result.failed ? "warning" : "info",
      ...clientInfo(req),
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/:id/verify", async (req, res, next) => {
  const id = parseId(req);
  if (id == null) return res.status(400).json({ error: "Invalid backup id." });
  try {
    const row = await systemBackupService.verify(id);
    if (!row) return res.status(404).json({ error: "Backup not found." });
    await audit({
      userId: req.user.id,
      module: "backups",
      action: "backup_verify",
      description: `Verified ${row.fileName}: ${row.verifyStatus ?? "not verifiable (failed or removed)"}`,
      level: row.verifyStatus && row.verifyStatus !== "ok" ? "warning" : "info",
      ...clientInfo(req),
    });
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.get("/:id/download", async (req, res, next) => {
  const id = parseId(req);
  if (id == null) return res.status(400).json({ error: "Invalid backup id." });
  try {
    const file = await systemBackupService.fileFor(id);
    if (!file) return res.status(404).json({ error: "This backup is not available for download." });
    // Audited BEFORE the bytes leave: a copy of the whole database going off the server
    // is the event an audit trail exists for, even if the transfer is then cut short.
    await audit({
      userId: req.user.id,
      module: "backups",
      action: "backup_download",
      description: `Downloaded backup ${file.name} (${mb(file.row.sizeBytes)}, encrypted)`,
      level: "warning",
      ...clientInfo(req),
    });
    res.download(file.abs, file.name);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  const id = parseId(req);
  if (id == null) return res.status(400).json({ error: "Invalid backup id." });
  try {
    const row = await systemBackupService.remove(id);
    await audit({
      userId: req.user.id,
      module: "backups",
      action: "backup_delete",
      description: `Deleted manual backup ${row.fileName}${row.sizeBytes != null ? ` (${mb(row.sizeBytes)})` : ""}`,
      level: "warning",
      ...clientInfo(req),
    });
    res.json({ success: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.put("/schedule", async (req, res, next) => {
  const v = validateSchedule(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const before = systemBackupService.getSchedule();
    const after = await systemBackupService.saveSchedule(v.value, req.user.id);
    const fmt = (s) => `${DAY_NAMES[s.day]} ${s.time}, keep ${s.keepWeeks} weeks`;
    await audit({
      userId: req.user.id,
      module: "backups",
      action: "backup_schedule",
      description: `Weekly backup schedule: ${fmt(before)} → ${fmt(after)}`,
      level: "warning",
      ...clientInfo(req),
    });
    res.json({ schedule: after });
  } catch (err) {
    next(err);
  }
});

export default router;
