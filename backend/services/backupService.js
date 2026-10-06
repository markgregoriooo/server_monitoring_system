import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import notificationService from "./notificationService.js";
import alertsService from "./alertsService.js";
import { describeError } from "../utils/httpError.js";
import { resolveThresholds, offsiteSeverity } from "./offsiteStaleness.js";
import { BACKEND_ROOT } from "../config/env.js";

// ─── On-site backup writer ────────────────────────────────────────────────────
// Appends every ingested sample (environment, servers, routers/MikroTik, UPS) to
// NDJSON files on BACKUP_DIR (a micro SD / USB drive, or a local folder). It is a
// second copy, separate from InfluxDB/MySQL, that survives a database wipe or a
// power cut. Not the live source of data.
//
// Writes are buffered and flushed every few seconds (default 5s) to limit SD wear,
// plus a synchronous flush on shutdown. Worst-case loss on a hard power cut is one
// flush interval.
//
// One file per stream per day: `env-2026-07-03.ndjson`, `server-…`, `network-…`
// (SNMP and MikroTik, told apart by device_type), `ups-…`. One JSON object per line.
//
// Never throws. Repeated flush failures raise a `backup` alert that resolves on
// recovery, and a daily SHA-256 manifest of finished files catches silent
// corruption (`backup_integrity` alert). The manifest works with `sha256sum -c`.

const ENABLED = (process.env.BACKUP_ENABLED ?? "true").toLowerCase() !== "false";
const BACKUP_DIR =
  (process.env.BACKUP_DIR ?? "").trim() || path.resolve(BACKEND_ROOT, "backups");
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS) || 30;
const FLUSH_MS = Number(process.env.BACKUP_FLUSH_MS) || 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const FLUSH_ERROR_THRESHOLD = 3; // consecutive failed flushes before raising a health alert
const MAX_BUFFER_LINES = 100_000; // per-file safety cap so a long write outage can't OOM the process
const MANIFEST_FILE = "checksums.sha256"; // integrity manifest (sha256sum -c compatible)
// Dated backup files this service owns for retention + integrity: the NDJSON metric
// streams AND the MySQL dumps dropped in by ops/db-backup (mysql-YYYY-MM-DD.sql.gz).
const DATED_FILE_RE = /-(\d{4}-\d{2}-\d{2})\.(?:ndjson|sql\.gz)$/;
// Offsite (cloud) sync health — a SEPARATE rclone job (ops/offsite-backup) stamps a marker
// on each successful upload; the backend only READS that local marker (no cloud dependency).
const OFFSITE_ENABLED = (process.env.BACKUP_OFFSITE_ENABLED ?? "false").toLowerCase() === "true";
// Warning after OFFSITE_MAX_AGE_HOURS (bell only), CRITICAL — i.e. email — after
// OFFSITE_CRITICAL_HOURS (0 = never escalate). See offsiteStaleness.js for why two.
const { warnHours: OFFSITE_MAX_AGE_HOURS, critHours: OFFSITE_CRITICAL_HOURS } = resolveThresholds(
  process.env.BACKUP_OFFSITE_MAX_AGE_HOURS,
  process.env.BACKUP_OFFSITE_CRITICAL_HOURS,
);
// Re-announce a stale offsite backup at most once a day. The check runs every 6h,
// and the 30-minute default cooldown would send an alert (and email) every time.
const OFFSITE_COOLDOWN_MIN = 24 * 60;
const OFFSITE_MARKER =
  (process.env.BACKUP_OFFSITE_MARKER ?? "").trim() || path.join(BACKUP_DIR, ".last_offsite_sync");
const OFFSITE_CHECK_MS = 6 * 60 * 60 * 1000; // re-check offsite freshness every 6h

// JSON can't serialize BigInt (router rx/tx byte counters are BigInt) → stringify.
const bigIntSafe = (_k, v) => (typeof v === "bigint" ? v.toString() : v);

// In-memory buffer: absolute filename → array of serialized lines awaiting flush.
const buffer = new Map();
let started = false;
let healthFailing = false; // true while writes keep failing — drives the backup health alert
let consecutiveFlushErrors = 0;

function dayStamp(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fileFor(stream) {
  return path.join(BACKUP_DIR, `${stream}-${dayStamp()}.ndjson`);
}

// Buffer one record. `stream` ∈ env|server|network|ups. Cheap + synchronous — the
// caller can fire-and-forget; disk I/O happens on the flush timer.
function record(stream, payload) {
  if (!ENABLED) return;
  try {
    const line = JSON.stringify(
      { ts: new Date().toISOString(), stream, ...payload },
      bigIntSafe,
    );
    const file = fileFor(stream);
    const arr = buffer.get(file);
    if (arr) arr.push(line);
    else buffer.set(file, [line]);
  } catch (err) {
    console.error("[BACKUP] record error:", describeError(err));
  }
}

// Timer flush. On failure the rows go back in the buffer and are retried next tick.
// Counts consecutive failures to raise and clear the health alert. A per-file cap
// limits memory if the drive is gone for a long time.
async function flush() {
  if (buffer.size === 0) return;
  const pending = new Map(buffer);
  buffer.clear();
  let failed = null;
  for (const [file, lines] of pending) {
    try {
      await fsp.appendFile(file, lines.join("\n") + "\n");
    } catch (err) {
      failed = err;
      console.error("[BACKUP] flush error:", describeError(err));
      const remaining = buffer.get(file);
      let merged = remaining ? lines.concat(remaining) : lines;
      // Keep the NEWEST rows if we've backed up past the cap (drop oldest to avoid OOM).
      if (merged.length > MAX_BUFFER_LINES) merged = merged.slice(-MAX_BUFFER_LINES);
      buffer.set(file, merged);
    }
  }
  // Health transition: alert once on the ok→failing edge, auto-resolve on recovery.
  if (failed) {
    consecutiveFlushErrors++;
    if (!healthFailing && consecutiveFlushErrors >= FLUSH_ERROR_THRESHOLD) {
      healthFailing = true;
      reportUnhealthy(failed.code || failed.message);
    }
  } else if (healthFailing || consecutiveFlushErrors) {
    consecutiveFlushErrors = 0;
    if (healthFailing) {
      healthFailing = false;
      console.log("[BACKUP] writes recovered");
      reportHealthy();
    }
  }
}

// ─── Backup-health alerting ───────────────────────────────────────────────────
// Raised through the normal alert pipeline, not awaited (raiseAlert de-dups while
// the alert is open). deviceId null = system alert.
function reportUnhealthy(detail) {
  notificationService
    .raiseAlert({
      deviceId: null,
      type: "backup",
      severity: "critical",
      title: "Backup storage failing",
      message: `On-site backup can't write to ${BACKUP_DIR} — ${detail}. Check the drive (unmounted / full / read-only).`,
    })
    .catch(() => {});
}

function reportHealthy() {
  // Recovery → auto-resolve the open backup alert (same path metric-recovery uses).
  alertsService.autoResolveMetric(null, "backup").catch(() => {});
}

// Synchronous flush for shutdown handlers (can't rely on the event loop then).
function flushSync() {
  if (buffer.size === 0) return;
  for (const [file, lines] of buffer) {
    try {
      fs.appendFileSync(file, lines.join("\n") + "\n");
    } catch (err) {
      console.error("[BACKUP] flushSync error:", describeError(err));
    }
  }
  buffer.clear();
}

// Delete backup files whose day-stamp is older than RETENTION_DAYS.
async function purgeOld() {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * DAY_MS;
    const files = await fsp.readdir(BACKUP_DIR);
    for (const f of files) {
      const m = f.match(DATED_FILE_RE);
      if (!m) continue;
      const when = new Date(`${m[1]}T23:59:59`).getTime();
      if (Number.isFinite(when) && when < cutoff) {
        await fsp.unlink(path.join(BACKUP_DIR, f)).catch(() => {});
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[BACKUP] purge error:", describeError(err));
  }
}

// ─── Integrity: SHA-256 manifest ────────────────────────────
// A file from a past day is never written again, so its hash is recorded once.
// A later hash that differs means the bytes changed on disk (card corruption).
// Lines are `<hash>  <filename>` so `sha256sum -c checksums.sha256` works.

function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(absPath);
    s.on("error", reject);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

async function readManifest() {
  const map = new Map();
  try {
    const txt = await fsp.readFile(path.join(BACKUP_DIR, MANIFEST_FILE), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^([0-9a-f]{64})\s+(.+)$/);
      if (m) map.set(m[2], m[1]);
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[BACKUP] manifest read error:", describeError(err));
  }
  return map;
}

async function writeManifest(map) {
  const lines = [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([file, hash]) => `${hash}  ${file}`);
  await fsp
    .writeFile(path.join(BACKUP_DIR, MANIFEST_FILE), lines.length ? lines.join("\n") + "\n" : "")
    .catch((e) => console.error("[BACKUP] manifest write error:", e.message));
}

// Hash newly-sealed files, prune manifest entries for purged files, and verify existing
// entries against current bytes. A mismatch → `backup_integrity` alert. Returns counts.
async function updateChecksums() {
  const today = dayStamp();
  let files;
  try {
    files = await fsp.readdir(BACKUP_DIR);
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[BACKUP] checksum readdir error:", describeError(err));
    return { added: 0, rotted: [] };
  }
  const sealed = files.filter((f) => {
    const m = f.match(DATED_FILE_RE);
    return m && m[1] < today; // date strictly before today = immutable
  });
  const present = new Set(files);
  const manifest = await readManifest();

  // Prune entries whose file was purged by retention.
  for (const name of [...manifest.keys()]) if (!present.has(name)) manifest.delete(name);

  const rotted = [];
  let added = 0;
  for (const name of sealed) {
    let hash;
    try {
      hash = await sha256File(path.join(BACKUP_DIR, name));
    } catch (err) {
      // Do not skip unreadable files: an unreadable file is the most likely to be damaged.
      // See audits/error-flow-report-2026-08-25.md (F-04).
      console.error(
        `[BACKUP] cannot checksum ${name}: ${err.message} — EXCLUDED from the integrity ` +
          `manifest. An unreadable backup file is exactly what this check exists to catch.`,
      );
      continue;
    }
    const known = manifest.get(name);
    if (known == null) {
      manifest.set(name, hash); // first seal → record known-good hash
      added++;
    } else if (known !== hash) {
      rotted.push(name); // sealed bytes changed = corruption; KEEP the known-good hash
    }
  }

  await writeManifest(manifest);

  if (rotted.length) {
    console.error("[BACKUP] integrity mismatch:", rotted.join(", "));
    notificationService
      .raiseAlert({
        deviceId: null,
        type: "backup_integrity",
        severity: "critical",
        title: "Backup integrity check failed",
        message: `Checksum mismatch on ${rotted.join(", ")} in ${BACKUP_DIR} — file(s) may be corrupted (card rot). Replace the drive and restore from another copy.`,
      })
      .catch(() => {});
  }
  if (added) console.log(`[BACKUP] checksummed ${added} sealed file(s)`);
  return { added, rotted };
}

// Daily maintenance: drop expired files, then refresh + verify the integrity manifest.
async function dailyMaintenance() {
  await purgeOld();
  await updateChecksums();
}

// Offsite sync health. The rclone job (ops/offsite-backup) writes OFFSITE_MARKER
// after each successful upload. Older than OFFSITE_MAX_AGE_HOURS → warning; older
// than OFFSITE_CRITICAL_HOURS → critical (emailed). Opt-in with
// BACKUP_OFFSITE_ENABLED. Only reads a local file.
async function checkOffsite() {
  if (!OFFSITE_ENABLED) return;
  let stampMs = null;
  try {
    const t = Date.parse((await fsp.readFile(OFFSITE_MARKER, "utf8")).trim());
    if (Number.isFinite(t)) stampMs = t;
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[BACKUP] offsite marker read error:", describeError(err));
  }
  const severity = offsiteSeverity(stampMs, Date.now(), {
    warnHours: OFFSITE_MAX_AGE_HOURS,
    critHours: OFFSITE_CRITICAL_HOURS,
  });
  if (severity !== "ok") {
    // Log the folder name, not BACKUP_DIR: under Docker that is /app/backups, which
    // does not exist on the host.
    const message =
      stampMs == null
        ? "No successful offsite (cloud) backup has ever been recorded — the rclone sync job " +
          "is not running or has never succeeded. Check offsite-sync.log in the backup folder."
        : `No successful offsite (cloud) backup for over ` +
          `${severity === "critical" ? OFFSITE_CRITICAL_HOURS : OFFSITE_MAX_AGE_HOURS}h ` +
          `(last: ${new Date(stampMs).toISOString()}). Check offsite-sync.log in the backup folder.`;
    // Escalation raises a SECOND alert alongside any open warning, as every other
    // threshold trigger does; both close together when a fresh sync lands (below).
    notificationService
      .raiseAlert({
        deviceId: null,
        type: "backup_offsite",
        severity,
        title: severity === "critical" ? "Offsite backup failing" : "Offsite backup stale",
        message,
        cooldownMin: OFFSITE_COOLDOWN_MIN,
      })
      .catch(() => {});
  } else {
    alertsService.autoResolveMetric(null, "backup_offsite").catch(() => {});
  }
}

/**
 * Offsite (cloud) status for the Backups page — the SAME marker and thresholds the
 * staleness alert uses, so the page and the bell can never disagree. Read-only.
 * @returns {Promise<{enabled:boolean, lastSyncAt:string|null, severity:"ok"|"warning"|"critical"|null, warnHours:number, critHours:number}>}
 */
async function offsiteStatus() {
  let stampMs = null;
  try {
    const t = Date.parse((await fsp.readFile(OFFSITE_MARKER, "utf8")).trim());
    if (Number.isFinite(t)) stampMs = t;
  } catch {
    /* no marker yet: never synced, or the job is not set up */
  }
  return {
    enabled: OFFSITE_ENABLED,
    lastSyncAt: stampMs == null ? null : new Date(stampMs).toISOString(),
    severity: OFFSITE_ENABLED
      ? offsiteSeverity(stampMs, Date.now(), { warnHours: OFFSITE_MAX_AGE_HOURS, critHours: OFFSITE_CRITICAL_HOURS })
      : null,
    warnHours: OFFSITE_MAX_AGE_HOURS,
    critHours: OFFSITE_CRITICAL_HOURS,
  };
}

// Call once at startup (server.js). Creates the dir, starts the flush + maintenance
// timers, and wires a shutdown flush so nothing buffered is lost on a clean stop.
/** False when the backup directory could not be created — see init(). */
let dirReady = false;

/** Is the on-site backup actually able to write? Distinct from ENABLED, which is config. */
function isHealthy() {
  return ENABLED && dirReady;
}

function init() {
  if (!ENABLED) {
    console.log("[BACKUP] disabled (BACKUP_ENABLED=false)");
    return;
  }
  if (started) return;
  started = true;

  // Only print "on-site backup → …" when the folder was created; otherwise the
  // reassuring line would appear right after the error.
  // See audits/error-handling-report-2026-08-25.md (E-13).
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    dirReady = true;
  } catch (err) {
    dirReady = false;
    console.error(
      `[BACKUP] NOT RUNNING — cannot write to ${BACKUP_DIR}: ${err.message}
` +
        `[BACKUP] Samples will buffer in memory and be DROPPED at the ${MAX_BUFFER_LINES}-line cap.
` +
        `[BACKUP] This is the on-site copy that survives a database wipe and a power cut.
` +
        `[BACKUP] Attach the drive, or point BACKUP_DIR at a path that exists, then restart.`,
    );
  }
  if (dirReady) {
    console.log(
      `[BACKUP] on-site backup → ${BACKUP_DIR} (flush ${FLUSH_MS}ms, retain ${RETENTION_DAYS}d)`,
    );
  }

  const flushTimer = setInterval(() => flush().catch(() => {}), FLUSH_MS);
  flushTimer.unref?.(); // the HTTP server keeps the process alive, not this timer

  dailyMaintenance();
  const maintTimer = setInterval(dailyMaintenance, DAY_MS);
  maintTimer.unref?.();

  if (OFFSITE_ENABLED) {
    console.log(
      `[BACKUP] offsite health watch on ${OFFSITE_MARKER} (max age ${OFFSITE_MAX_AGE_HOURS}h)`,
    );
    checkOffsite();
    const offsiteTimer = setInterval(checkOffsite, OFFSITE_CHECK_MS);
    offsiteTimer.unref?.();
  }

  // Flush the remaining buffer on shutdown.
  //
  // Signals are handled in src/server.js, which calls flushSync() first and then
  // closes everything else. This module used to call process.exit(0) itself, which
  // cut off in-flight responses. See audits/error-handling-report-2026-08-25.md (E-10).
  // The 'exit' listener is a last resort for a normal exit and the uncaughtException
  // path.
  process.on("exit", flushSync);
}

export default {
  init,
  isHealthy,
  record,
  flush,
  flushSync,
  purgeOld,
  updateChecksums,
  checkOffsite,
  offsiteStatus,
  BACKUP_DIR,
  ENABLED,
  RETENTION_DAYS,
};
