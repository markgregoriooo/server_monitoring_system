import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import notificationService from "./notificationService.js";
import alertsService from "./alertsService.js";
import { describeError } from "../utils/httpError.js";

// ─── On-site backup writer ────────────────────────────────────────────────────
//
// Appends every ingested sample (environment, servers, routers/MikroTik, UPS) to
// rotating NDJSON files on a configurable path — the "backup storage" the panel
// requires (a micro SD / USB drive mounted on the backend, or just a local folder).
//
// WHY: this is an INDEPENDENT second copy of the data, separate from InfluxDB/MySQL,
// so it survives (a) a DB corruption/wipe and (b) a power outage — the files are
// non-volatile and outlive the blackout, so the record of the outage is still there
// when power returns. It is NOT the live source of truth; it's the safety copy.
//
// DURABILITY vs FLASH WEAR: writes are BUFFERED and flushed on a timer (default 5s)
// to spare micro-SD write endurance, PLUS a synchronous flush on shutdown (a UPS
// low-battery-triggered SIGTERM, or Ctrl+C) so the last buffered samples aren't lost.
// Worst-case loss on a hard cut = one flush window.
//
// FORMAT: one file per stream per day → `env-2026-07-03.ndjson`, `server-…`,
// `network-…` (both non-MikroTik + MikroTik, distinguished by device_type), `ups-…`.
// One JSON object per line — append-only, robust to partial writes, trivial to replay.
//
// Never throws: a backup failure must never break metric ingestion.
//
// HEALTH + INTEGRITY: a silently-failing backup is worse than none. Repeated flush
// failures raise a `backup` alert on the normal bell/email pipeline and auto-resolve on
// recovery. A daily SHA-256 manifest of "sealed" (past-day, immutable) files detects
// silent corruption — a later re-hash that differs = card rot → `backup_integrity` alert.
// The manifest is `sha256sum -c`-compatible.

const ENABLED = (process.env.BACKUP_ENABLED ?? "true").toLowerCase() !== "false";
const BACKUP_DIR =
  (process.env.BACKUP_DIR ?? "").trim() || path.resolve(process.cwd(), "backups");
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
const OFFSITE_MAX_AGE_HOURS = Number(process.env.BACKUP_OFFSITE_MAX_AGE_HOURS) || 26;
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

// Async flush (timer-driven). Drains the buffer to disk; re-queues on failure so a
// transient I/O error (card busy) retries next tick instead of dropping rows. Tracks
// consecutive failures so a genuinely failing drive raises a health alert (and clears
// it on recovery). A per-file cap bounds memory if the drive is gone for a long time.
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
// A backup that silently stops writing is worse than none, so surface it on the same
// bell/email pipeline as every other alert. Fired fire-and-forget (raiseAlert de-dups
// while the alert is open, so this never spams). deviceId null = a system-level alert.
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

// ─── Integrity: SHA-256 manifest for rot detection ────────────────────────────
// A "sealed" file is one whose day-stamp has passed → it's never appended to again, so
// its bytes are immutable. We hash each sealed file once (the known-good hash) into a
// manifest; a later re-hash that differs means the bytes changed on disk with no writer
// touching them = silent corruption (card rot). Manifest lines are `<hash>  <filename>`
// so `sha256sum -c checksums.sha256` verifies the whole card from a shell.

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
      // This is the ROT DETECTOR. Silently skipping a file it cannot read means the
      // one file most likely to be damaged is the one excluded from the integrity check —
      // an unreadable backup would pass "no rot detected" simply by not being looked at.
      // See audits/error-flow-report-2026-08-25.md — F-04.
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

// Offsite-sync health. The standalone rclone job (ops/offsite-backup) writes OFFSITE_MARKER
// with an ISO timestamp on each successful cloud upload. If that stamp is missing or older
// than OFFSITE_MAX_AGE_HOURS, the "1 offsite" copy of 3-2-1 has stalled → warn. Opt-in
// (BACKUP_OFFSITE_ENABLED) so it never false-fires before cloud sync is configured. Reads
// ONLY a local file, so the backend keeps zero runtime dependency on the cloud.
async function checkOffsite() {
  if (!OFFSITE_ENABLED) return;
  let stampMs = null;
  try {
    const t = Date.parse((await fsp.readFile(OFFSITE_MARKER, "utf8")).trim());
    if (Number.isFinite(t)) stampMs = t;
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[BACKUP] offsite marker read error:", describeError(err));
  }
  const stale = stampMs == null || Date.now() - stampMs > OFFSITE_MAX_AGE_HOURS * 60 * 60 * 1000;
  if (stale) {
    const when = stampMs == null ? "never" : new Date(stampMs).toISOString();
    notificationService
      .raiseAlert({
        deviceId: null,
        type: "backup_offsite",
        severity: "warning",
        title: "Offsite backup stale",
        message: `No successful offsite (cloud) backup within ${OFFSITE_MAX_AGE_HOURS}h (last: ${when}). Check the rclone sync job.`,
      })
      .catch(() => {});
  } else {
    alertsService.autoResolveMetric(null, "backup_offsite").catch(() => {});
  }
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

  // Do NOT print the reassuring "on-site backup → …" line when the directory could
  // not be created. It used to print unconditionally, one line BELOW the error — so a
  // detached backup drive produced a boot log that said "cannot create dir" and then
  // immediately "on-site backup → D:/backups", and the second line is the one people
  // read. The backup that exists specifically to survive a DB wipe plus a power cut can
  // be completely non-functional while the log looks healthy.
  // See audits/error-handling-report-2026-08-25.md — E-13.
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

  // Flush the last buffered samples on shutdown.
  //
  // This module no longer handles SIGINT/SIGTERM itself. It used to — and the flush
  // was right — but it also called process.exit(0) immediately after, which meant a
  // BACKUP WRITER decided when the whole process died: server.close() never ran,
  // in-flight HTTP responses were cut mid-write, and any other service that later
  // registered a signal handler could be killed before it finished. Shutdown is now
  // owned by src/server.js, the composition root, which calls flushSync() FIRST and
  // then closes everything else. See audits/error-handling-report-2026-08-25.md — E-10.
  //
  // The 'exit' listener stays as the last-resort net: Node does NOT emit 'exit' for an
  // unhandled signal, but it DOES on a normal event-loop exit and on the
  // uncaughtException path in src/server.js.
  process.on("exit", flushSync);
}

export default { init, isHealthy, record, flush, flushSync, purgeOld, updateChecksums, checkOffsite, BACKUP_DIR };
