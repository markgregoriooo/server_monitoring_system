import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import db from "../config/mysql.js";
import backupService from "./backupService.js";
import notificationService from "./notificationService.js";
import alertsService from "./alertsService.js";
import { describeError } from "../utils/httpError.js";
import schedule, {
  SCHEDULE_DEFAULTS,
  normalizeSchedule,
  lastSlotAtOrBefore,
  nextSlotAfter,
  isoWeekLabel,
  coverageFor,
  filesInCoverage,
  selectExpired,
  archiveName,
  ARCHIVE_NAME_RE,
} from "./backupSchedule.js";
import backupCrypto from "./backupCrypto.js";

// ─── Backups module: the weekly system backup ─────────────────────────────────
// Panel RSC #2: "Integrate a backup server module to manage and secure system backups.
// FOD: present the system weekly backup." This is the module; backup-module-plan.md
// is the plan it came from.
//
// What existed before stays as it was and keeps running:
//   - backupService      — every sample mirrored to NDJSON on BACKUP_DIR, all day
//   - ops/db-backup      — the HOST's nightly MySQL dump (cron), mysql-*.sql.gz
//   - ops/offsite-backup — the HOST's nightly rclone upload to Backblaze
// None of it was visible in the dashboard. This adds the part a person can see and
// manage: one ENCRYPTED archive a week, recorded, verified and kept for N weeks.
//
// One archive (<BACKUP_DIR>/weekly/weekly-2026-W41.tar.gz.enc) holds:
//   manifest.json   what is inside + the SHA-256 of every file
//   database.sql    a full dump of the MySQL database, taken by THIS process
//   data/*.ndjson   the seven whole days of samples the archive covers
// It is .tar.gz, then AES-256-GCM (backupCrypto.js). `npm run backup:decrypt` turns it
// back into a plain .tar.gz. The nightly rclone job already copies everything under
// BACKUP_DIR, so the archives reach Backblaze with no new plumbing.
//
// Why the dump runs HERE rather than reusing the host's nightly dump: that file is
// written by cron, unencrypted, on a schedule this process does not control — a
// weekly archive built from it would silently contain whatever night last succeeded.
// Running mariadb-dump/mysqldump ourselves makes "this archive = the database at this
// moment" true. The Docker image ships the client for it (Dockerfile).
//
// ⚠️ The schedule is in PHILIPPINE time (backupSchedule.js), and a run missed while the
// backend was down is caught up once on the next start: the scheduler looks for the
// most recent slot with no successful run, not for "is it exactly 02:00 now".

const WEEKLY_ENABLED = (process.env.BACKUP_WEEKLY_ENABLED ?? "true").toLowerCase() !== "false";
const ARCHIVE_DIR = path.join(backupService.BACKUP_DIR, "weekly");
const TICK_MS = 60 * 1000;
const FIRST_TICK_MS = 2 * 60 * 1000; // let the backend finish starting before a catch-up run
const MAX_ATTEMPTS_PER_SLOT = 3;
const RETRY_AFTER_MS = 60 * 60 * 1000;
const DUMP_TIMEOUT_MS = (Number(process.env.BACKUP_DUMP_TIMEOUT_MIN) || 30) * 60 * 1000;
const ALERT_TYPE = "backup_weekly";

const SETTING_KEYS = {
  day: "backup.weekly_day",
  time: "backup.weekly_time",
  keepWeeks: "backup.keep_weeks",
};

let io = null;
let running = null; // { id, kind, startedAt } while a backup is being made
let current = { ...SCHEDULE_DEFAULTS };
let dumpTool; // undefined = not probed yet; null = none found

// ─── Settings ────────────────────────────────────────────────────────────────

async function loadSchedule() {
  try {
    const [rows] = await db.query(
      "SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'backup.%'",
    );
    const v = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
    current = normalizeSchedule({
      day: v[SETTING_KEYS.day] ?? SCHEDULE_DEFAULTS.day,
      time: v[SETTING_KEYS.time] ?? SCHEDULE_DEFAULTS.time,
      keepWeeks: v[SETTING_KEYS.keepWeeks] ?? SCHEDULE_DEFAULTS.keepWeeks,
    });
  } catch (err) {
    console.error("[BACKUP] could not read the weekly schedule, using defaults:", describeError(err));
  }
  return current;
}

/** Save an already-validated schedule (backupSchedule.validateSchedule). */
async function saveSchedule(value, userId) {
  for (const [field, key] of Object.entries(SETTING_KEYS)) {
    await db.query(
      `INSERT INTO settings (setting_key, setting_value, updated_by)
            VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
                               updated_by    = VALUES(updated_by),
                               updated_at    = CURRENT_TIMESTAMP`,
      [key, String(value[field]), userId ?? null],
    );
  }
  current = normalizeSchedule(value);
  broadcast();
  return current;
}

// ─── The dump tool ───────────────────────────────────────────────────────────

/** Run `bin --version`; resolves the first line, or null if the binary is not there. */
function probe(bin) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(bin, ["--version"], { windowsHide: true });
    } catch {
      return resolve(null);
    }
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out.split("\n")[0].trim() : null));
  });
}

/**
 * Find mariadb-dump / mysqldump once. BACKUP_DUMP_BIN wins; then PATH; then XAMPP's
 * copy, since that is how this project runs on a Windows dev machine.
 */
async function findDumpTool() {
  if (dumpTool !== undefined) return dumpTool;
  const candidates = [
    process.env.BACKUP_DUMP_BIN?.trim(),
    "mariadb-dump",
    "mysqldump",
    process.platform === "win32" ? "C:\\xampp\\mysql\\bin\\mysqldump.exe" : null,
  ].filter(Boolean);
  for (const bin of candidates) {
    const version = await probe(bin);
    if (version) {
      dumpTool = { bin, version, mariadb: /mariadb/i.test(version) };
      return dumpTool;
    }
  }
  dumpTool = null;
  return null;
}

/**
 * Dump the whole database to `outPath`. Credentials come from the same DB_* variables
 * the pool uses; the password goes in the child's ENVIRONMENT (MYSQL_PWD), never on
 * the command line, where `ps` would show it to every user on the host.
 */
async function dumpDatabase(outPath) {
  const tool = await findDumpTool();
  if (!tool) {
    throw new Error(
      "No database dump tool found (mariadb-dump / mysqldump). The Docker image includes one; " +
        "elsewhere install the MariaDB client or set BACKUP_DUMP_BIN to its full path.",
    );
  }
  const args = [
    `--host=${process.env.DB_HOST || "localhost"}`,
    `--port=${process.env.DB_PORT || 3306}`,
    `--user=${process.env.DB_USER || "root"}`,
    // A consistent snapshot of InnoDB without locking the tables the pollers write to.
    "--single-transaction",
    "--quick",
    "--hex-blob",
    "--default-character-set=utf8mb4",
    // MySQL 8 needs the PROCESS privilege for tablespace info; the app user has none.
    "--no-tablespaces",
  ];
  // MariaDB 11.4+ clients demand TLS by default and the database container has no
  // certificate. The traffic stays on the compose network (the DB port is not published).
  if (tool.mariadb) args.push("--skip-ssl");
  args.push(process.env.DB_NAME);

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outPath);
    const child = spawn(tool.bin, args, {
      env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD ?? "" },
      windowsHide: true,
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Database dump took longer than ${DUMP_TIMEOUT_MS / 60000} minutes.`));
    }, DUMP_TIMEOUT_MS);
    child.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-2000);
    });
    child.stdout.pipe(out);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      out.end(() => {
        if (code === 0) resolve();
        else {
          // Keep the tool's own words but never a line that could echo a credential.
          const why = stderr.split("\n").filter((l) => l && !/password/i.test(l)).slice(-3).join(" ");
          reject(new Error(`Database dump failed (exit ${code})${why ? `: ${why}` : ""}`));
        }
      });
    });
  });
}

// ─── Building one archive ────────────────────────────────────────────────────

/** Add a file from disk to a tar pack under `name`. */
async function addFile(pack, name, absPath) {
  const st = await fsp.stat(absPath);
  const entry = pack.entry({ name, size: st.size, mtime: st.mtime });
  await pipeline(fs.createReadStream(absPath), entry);
}

/**
 * Make one backup. Never throws to its caller: the outcome is the row's status, and a
 * scheduled failure raises an alert. Returns the finished row.
 *
 * @param {{kind:"weekly"|"manual", userId?:number|null, slot?:Date|null}} opts
 */
async function runBackup({ kind, userId = null, slot = null }) {
  if (running) throw Object.assign(new Error("A backup is already running."), { status: 409 });
  const { key } = backupCrypto.resolveKey();
  if (!key) {
    throw Object.assign(
      new Error("No encryption key is configured (BACKUP_ENC_KEY, SECRET_ENC_KEY or MIKROTIK_ENC_KEY). Backups are never written unencrypted."),
      { status: 503 },
    );
  }

  const startedAt = new Date();
  // A weekly run is named and dated by its SLOT, so a catch-up on Monday still files
  // as the week it was due for.
  const anchor = kind === "weekly" && slot ? slot : startedAt;
  const fileName = archiveName(kind, anchor);
  const coverage = coverageFor(anchor);
  const keyId = backupCrypto.keyIdOf(key).toString("hex");

  const [ins] = await db.query(
    `INSERT INTO system_backups
       (kind, status, file_name, week_label, scheduled_for, coverage_from, coverage_to, key_id, started_at, created_by)
     VALUES (?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [kind, fileName, isoWeekLabel(anchor), kind === "weekly" ? slot : null, coverage.from, coverage.to, keyId, startedAt, userId],
  );
  const id = ins.insertId;
  running = { id, kind, startedAt };
  broadcast();
  console.log(`[BACKUP] ${kind} backup #${id} started → ${fileName}`);

  // Both temporary names end in .tmp, which the offsite rclone job excludes, so a
  // half-written archive is never uploaded.
  const dumpTmp = path.join(ARCHIVE_DIR, `.dump-${id}.sql.tmp`);
  const archiveTmp = path.join(ARCHIVE_DIR, `${fileName}.tmp`);
  const finalPath = path.join(ARCHIVE_DIR, fileName);

  try {
    await fsp.mkdir(ARCHIVE_DIR, { recursive: true });
    await dumpDatabase(dumpTmp);
    const dbStat = await fsp.stat(dumpTmp);

    const names = await fsp.readdir(backupService.BACKUP_DIR).catch(() => []);
    const dataNames = filesInCoverage(names, coverage);
    const dataFiles = [];
    for (const n of dataNames) {
      const abs = path.join(backupService.BACKUP_DIR, n);
      const st = await fsp.stat(abs);
      dataFiles.push({ file: `data/${n}`, abs, bytes: st.size, sha256: await backupCrypto.sha256File(abs) });
    }

    const manifest = {
      format: 1,
      system: "CSPC-ICTU Server Infrastructure Monitoring System",
      kind,
      week: isoWeekLabel(anchor),
      createdAt: startedAt.toISOString(),
      coverage,
      database: {
        file: "database.sql",
        name: process.env.DB_NAME,
        bytes: dbStat.size,
        sha256: await backupCrypto.sha256File(dumpTmp),
        tool: dumpTool?.version ?? null,
      },
      data: dataFiles.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })),
      encryption: { algorithm: "AES-256-GCM", keyId },
      restore: "npm run backup:decrypt -- <this file>  →  tar -xzf <output>  →  see backup-storage.md",
    };

    const pack = tar.pack();
    const written = pipeline(pack, zlib.createGzip({ level: 6 }), backupCrypto.createEncryptStream(key), fs.createWriteStream(archiveTmp));
    // Observed now, awaited below: if adding an entry fails first, this promise rejects
    // while nothing is awaiting it, which Node treats as an unhandled rejection.
    written.catch(() => {});
    try {
      pack.entry({ name: "manifest.json" }, JSON.stringify(manifest, null, 2));
      await addFile(pack, "database.sql", dumpTmp);
      for (const f of dataFiles) await addFile(pack, f.file, f.abs);
      pack.finalize();
    } catch (err) {
      pack.destroy(err);
      throw err;
    }
    await written;

    // Prove the file opens with the key and is intact BEFORE calling it a backup.
    await backupCrypto.verifyDecrypts(archiveTmp, key);
    await fsp.rename(archiveTmp, finalPath);
    const st = await fsp.stat(finalPath);
    const sha256 = await backupCrypto.sha256File(finalPath);
    const finishedAt = new Date();

    await db.query(
      `UPDATE system_backups
          SET status = 'ok', size_bytes = ?, sha256 = ?, db_bytes = ?, data_files = ?, data_bytes = ?,
              finished_at = ?, verified_at = ?, verify_status = 'ok', error = NULL
        WHERE backup_id = ?`,
      [st.size, sha256, dbStat.size, dataFiles.length, dataFiles.reduce((a, f) => a + f.bytes, 0), finishedAt, finishedAt, id],
    );
    console.log(`[BACKUP] ${kind} backup #${id} OK — ${fileName}, ${st.size} bytes, ${dataFiles.length} data file(s)`);
    if (kind === "weekly") alertsService.autoResolveMetric(null, ALERT_TYPE).catch(() => {});
    await applyRetention().catch((err) => console.error("[BACKUP] retention error:", describeError(err)));
  } catch (err) {
    const message = describeError(err);
    console.error(`[BACKUP] ${kind} backup #${id} FAILED:`, message);
    await fsp.unlink(archiveTmp).catch(() => {});
    await db
      .query(`UPDATE system_backups SET status = 'failed', error = ?, finished_at = ? WHERE backup_id = ?`, [
        message.slice(0, 2000),
        new Date(),
        id,
      ])
      .catch(() => {});
    if (kind === "weekly") {
      notificationService
        .raiseAlert({
          deviceId: null,
          type: ALERT_TYPE,
          severity: "critical",
          title: "Weekly system backup failed",
          message: `The weekly backup for ${isoWeekLabel(anchor)} could not be made: ${message}`,
        })
        .catch(() => {});
    }
  } finally {
    await fsp.unlink(dumpTmp).catch(() => {});
    running = null;
    broadcast();
  }
  return getById(id);
}

// ─── Retention ───────────────────────────────────────────────────────────────

/** Delete archives older than the configured weeks. The rows stay, stamped purged_at. */
async function applyRetention(now = new Date()) {
  const [rows] = await db.query(
    `SELECT backup_id AS id, status, finished_at AS finishedAt, file_name AS fileName
       FROM system_backups WHERE purged_at IS NULL`,
  );
  const ids = new Set(selectExpired(rows, now, current.keepWeeks));
  for (const r of rows) {
    if (!ids.has(r.id)) continue;
    if (ARCHIVE_NAME_RE.test(r.fileName ?? "")) {
      await fsp.unlink(path.join(ARCHIVE_DIR, r.fileName)).catch((err) => {
        if (err.code !== "ENOENT") throw err;
      });
    }
    await db.query("UPDATE system_backups SET purged_at = ? WHERE backup_id = ?", [now, r.id]);
    console.log(`[BACKUP] retention: removed ${r.fileName} (older than ${current.keepWeeks} weeks)`);
  }
  if (ids.size) broadcast();
  return [...ids];
}

// ─── Verify ──────────────────────────────────────────────────────────────────

/**
 * Re-check one archive: it is still there, its bytes still hash to what was recorded,
 * and it still decrypts and authenticates. The second check is what proves a backup
 * can be RESTORED; a matching hash alone only proves it did not change.
 */
async function verify(id) {
  const row = await getRow(id);
  if (!row) return null;
  if (row.status !== "ok" || row.purged_at) return toClient(row);
  const abs = archivePath(row.file_name);
  let status = "ok";
  if (!abs || !fs.existsSync(abs)) status = "missing";
  else if ((await backupCrypto.sha256File(abs)) !== row.sha256) status = "mismatch";
  else {
    const { key } = backupCrypto.resolveKey();
    try {
      if (!key) throw new Error("no key");
      await backupCrypto.verifyDecrypts(abs, key);
    } catch {
      status = "undecryptable";
    }
  }
  await db.query("UPDATE system_backups SET verified_at = ?, verify_status = ? WHERE backup_id = ?", [new Date(), status, id]);
  if (status !== "ok") {
    notificationService
      .raiseAlert({
        deviceId: null,
        type: "backup_integrity",
        severity: "critical",
        title: "Backup archive failed verification",
        message:
          status === "missing"
            ? `Backup archive ${row.file_name} is missing from the backup drive.`
            : status === "mismatch"
              ? `Backup archive ${row.file_name} no longer matches its recorded checksum — it was modified or the drive is failing.`
              : `Backup archive ${row.file_name} cannot be decrypted with the current key (the key changed, or the file is damaged).`,
      })
      .catch(() => {});
  }
  broadcast();
  return getById(id);
}

/** Verify every archive still on disk. */
async function verifyAll() {
  const [rows] = await db.query(
    "SELECT backup_id FROM system_backups WHERE status = 'ok' AND purged_at IS NULL ORDER BY backup_id",
  );
  const out = { ok: 0, failed: 0 };
  for (const r of rows) {
    const v = await verify(r.backup_id);
    if (v?.verifyStatus === "ok") out.ok++;
    else out.failed++;
  }
  return out;
}

// ─── Reads ───────────────────────────────────────────────────────────────────

const SELECT = `
  SELECT b.*, u.name AS created_by_name
    FROM system_backups b
    LEFT JOIN users u ON u.user_id = b.created_by`;

async function getRow(id) {
  const [[row]] = await db.query(`${SELECT} WHERE b.backup_id = ?`, [id]);
  return row ?? null;
}

async function getById(id) {
  const row = await getRow(id);
  return row ? toClient(row) : null;
}

function toClient(r) {
  const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);
  const day = (v) => (v instanceof Date ? schedule.phDate(v) : v ?? null);
  return {
    id: r.backup_id,
    kind: r.kind,
    status: r.status,
    fileName: r.file_name,
    week: r.week_label,
    scheduledFor: iso(r.scheduled_for),
    coverageFrom: day(r.coverage_from),
    coverageTo: day(r.coverage_to),
    sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
    sha256: r.sha256,
    keyId: r.key_id,
    dbBytes: r.db_bytes == null ? null : Number(r.db_bytes),
    dataFiles: r.data_files,
    dataBytes: r.data_bytes == null ? null : Number(r.data_bytes),
    error: r.error,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    verifiedAt: iso(r.verified_at),
    verifyStatus: r.verify_status,
    purgedAt: iso(r.purged_at),
    createdBy: r.created_by_name ?? null,
    downloadable: r.status === "ok" && !r.purged_at,
  };
}

async function list({ limit = 200 } = {}) {
  const [rows] = await db.query(`${SELECT} ORDER BY b.started_at DESC LIMIT ?`, [limit]);
  return rows.map(toClient);
}

/** Backups started inside [start, stop] — for the backup report. */
async function listBetween(start, stop) {
  const [rows] = await db.query(`${SELECT} WHERE b.started_at BETWEEN ? AND ? ORDER BY b.started_at`, [start, stop]);
  return rows.map(toClient);
}

/** Absolute path of an archive, or null if the name is not one this module writes. */
function archivePath(fileName) {
  return ARCHIVE_NAME_RE.test(fileName ?? "") ? path.join(ARCHIVE_DIR, fileName) : null;
}

/** For downloads: { abs, name } of a live archive, or null. */
async function fileFor(id) {
  const row = await getRow(id);
  if (!row || row.status !== "ok" || row.purged_at) return null;
  const abs = archivePath(row.file_name);
  if (!abs || !fs.existsSync(abs)) return null;
  return { abs, name: row.file_name, row: toClient(row) };
}

/**
 * Most recently WRITTEN file matching `re` in BACKUP_DIR → { name, date, bytes, modifiedAt }.
 * By modification time, not by name: the four NDJSON streams share a date, and sorting
 * names would always pick `ups-…` whether or not the UPS was the last thing written.
 */
async function newest(re) {
  const names = await fsp.readdir(backupService.BACKUP_DIR).catch(() => []);
  let best = null;
  for (const name of names.filter((n) => re.test(n))) {
    const st = await fsp.stat(path.join(backupService.BACKUP_DIR, name)).catch(() => null);
    if (st && (!best || st.mtimeMs > best.st.mtimeMs)) best = { name, st };
  }
  if (!best) return null;
  return {
    name: best.name,
    date: best.name.match(/(\d{4}-\d{2}-\d{2})/)?.[1] ?? null,
    bytes: best.st.size,
    modifiedAt: best.st.mtime.toISOString(),
  };
}

/** Everything the status cards need. Paths are deliberately left out. */
async function status() {
  const now = new Date();
  const { key, source } = backupCrypto.resolveKey();
  const tool = await findDumpTool();
  let disk = null;
  try {
    const s = await fsp.statfs(backupService.BACKUP_DIR);
    disk = { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    /* folder missing — the live card already says so */
  }
  const [[lastOk]] = await db.query(
    `${SELECT} WHERE b.status = 'ok' ORDER BY b.finished_at DESC LIMIT 1`,
  );
  const [[counts]] = await db.query(
    `SELECT SUM(status = 'ok' AND purged_at IS NULL) AS kept,
            COALESCE(SUM(CASE WHEN status = 'ok' AND purged_at IS NULL THEN size_bytes END), 0) AS keptBytes
       FROM system_backups`,
  );
  return {
    live: {
      enabled: backupService.ENABLED,
      healthy: backupService.isHealthy(),
      latest: await newest(/^[a-z]+-\d{4}-\d{2}-\d{2}\.ndjson$/),
      retentionDays: backupService.RETENTION_DAYS,
    },
    nightlyDump: { latest: await newest(/^mysql-\d{4}-\d{2}-\d{2}\.sql\.gz$/) },
    offsite: await backupService.offsiteStatus(),
    weekly: {
      enabled: WEEKLY_ENABLED,
      schedule: current,
      nextRunAt: WEEKLY_ENABLED ? nextSlotAfter(now, current).toISOString() : null,
      running: running ? { id: running.id, kind: running.kind, startedAt: running.startedAt.toISOString() } : null,
      lastOk: lastOk ? toClient(lastOk) : null,
      kept: Number(counts?.kept ?? 0),
      keptBytes: Number(counts?.keptBytes ?? 0),
      encryption: { configured: Boolean(key), source, keyId: key ? backupCrypto.keyIdOf(key).toString("hex") : null },
      dumpTool: tool ? { found: true, version: tool.version } : { found: false, version: null },
    },
    disk,
  };
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

/**
 * Is a weekly run due? The most recent slot must have no successful (or running) run,
 * fewer than MAX_ATTEMPTS failures, and the last failure must be over an hour old —
 * so a broken dump retries a few times instead of every minute all day.
 */
let warnedNoKey = false;

async function tick() {
  if (!WEEKLY_ENABLED || running) return;
  if (!backupCrypto.resolveKey().key) {
    // runBackup refuses without a key; say it once rather than every minute.
    if (!warnedNoKey) console.error("[BACKUP] weekly backup skipped: no encryption key configured (BACKUP_ENC_KEY).");
    warnedNoKey = true;
    return;
  }
  warnedNoKey = false;
  const slot = lastSlotAtOrBefore(new Date(), current);
  const [rows] = await db.query(
    `SELECT status, finished_at FROM system_backups WHERE kind = 'weekly' AND scheduled_for = ?`,
    [slot],
  );
  if (rows.some((r) => r.status === "ok" || r.status === "running")) return;
  const failed = rows.filter((r) => r.status === "failed");
  if (failed.length >= MAX_ATTEMPTS_PER_SLOT) return;
  const lastFail = Math.max(0, ...failed.map((r) => new Date(r.finished_at).getTime() || 0));
  if (lastFail && Date.now() - lastFail < RETRY_AFTER_MS) return;
  await runBackup({ kind: "weekly", slot });
}

function broadcast() {
  io?.emit("backupUpdated", { running: running ? { id: running.id, kind: running.kind } : null });
}

async function init(socketIo) {
  io = socketIo;
  try {
    // A run cut off by a restart would stay "running" forever and block its slot.
    const [res] = await db.query(
      `UPDATE system_backups SET status = 'failed', error = 'Interrupted — the backend stopped while the backup was being made.', finished_at = NOW()
        WHERE status = 'running'`,
    );
    if (res.affectedRows) console.warn(`[BACKUP] marked ${res.affectedRows} interrupted backup(s) as failed`);
  } catch (err) {
    // Table missing = migration not applied. Say so once, loudly, and do not schedule.
    console.error(
      "[BACKUP] weekly backups are OFF — system_backups is not readable " +
        `(${describeError(err)}). Run migrations/2026-10-06_system_backups.sql.`,
    );
    return;
  }
  await loadSchedule();
  if (!WEEKLY_ENABLED) {
    console.log("[BACKUP] weekly backups disabled (BACKUP_WEEKLY_ENABLED=false)");
    return;
  }
  const { key, source } = backupCrypto.resolveKey();
  const tool = await findDumpTool();
  console.log(
    `[BACKUP] weekly backup: ${schedule.DAY_NAMES[current.day]} ${current.time} PH, keep ${current.keepWeeks} weeks, ` +
      `key ${key ? `from ${source}` : "MISSING"}, dump ${tool ? tool.version : "tool NOT FOUND"}`,
  );
  const safeTick = () =>
    tick().catch((err) => console.error("[BACKUP] scheduler error:", describeError(err)));
  setTimeout(safeTick, FIRST_TICK_MS).unref?.();
  setInterval(safeTick, TICK_MS).unref?.();
}

export default {
  init,
  runBackup,
  verify,
  verifyAll,
  list,
  listBetween,
  status,
  fileFor,
  getSchedule: () => current,
  saveSchedule,
  applyRetention,
  isRunning: () => Boolean(running),
};
