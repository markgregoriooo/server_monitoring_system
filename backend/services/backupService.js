import fs from "fs";
import fsp from "fs/promises";
import path from "path";

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

const ENABLED = (process.env.BACKUP_ENABLED ?? "true").toLowerCase() !== "false";
const BACKUP_DIR =
  (process.env.BACKUP_DIR ?? "").trim() || path.resolve(process.cwd(), "backups");
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS) || 30;
const FLUSH_MS = Number(process.env.BACKUP_FLUSH_MS) || 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// JSON can't serialize BigInt (router rx/tx byte counters are BigInt) → stringify.
const bigIntSafe = (_k, v) => (typeof v === "bigint" ? v.toString() : v);

// In-memory buffer: absolute filename → array of serialized lines awaiting flush.
const buffer = new Map();
let started = false;

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
    console.error("[BACKUP] record error:", err.message);
  }
}

// Async flush (timer-driven). Drains the buffer to disk; re-queues on failure so a
// transient I/O error (card busy) retries next tick instead of dropping rows.
async function flush() {
  if (buffer.size === 0) return;
  const pending = new Map(buffer);
  buffer.clear();
  for (const [file, lines] of pending) {
    try {
      await fsp.appendFile(file, lines.join("\n") + "\n");
    } catch (err) {
      console.error("[BACKUP] flush error:", err.message);
      const remaining = buffer.get(file);
      buffer.set(file, remaining ? lines.concat(remaining) : lines);
    }
  }
}

// Synchronous flush for shutdown handlers (can't rely on the event loop then).
function flushSync() {
  if (buffer.size === 0) return;
  for (const [file, lines] of buffer) {
    try {
      fs.appendFileSync(file, lines.join("\n") + "\n");
    } catch (err) {
      console.error("[BACKUP] flushSync error:", err.message);
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
      const m = f.match(/-(\d{4}-\d{2}-\d{2})\.ndjson$/);
      if (!m) continue;
      const when = new Date(`${m[1]}T23:59:59`).getTime();
      if (Number.isFinite(when) && when < cutoff) {
        await fsp.unlink(path.join(BACKUP_DIR, f)).catch(() => {});
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[BACKUP] purge error:", err.message);
  }
}

// Call once at startup (server.js). Creates the dir, starts the flush + retention
// timers, and wires a shutdown flush so nothing buffered is lost on a clean stop.
function init() {
  if (!ENABLED) {
    console.log("[BACKUP] disabled (BACKUP_ENABLED=false)");
    return;
  }
  if (started) return;
  started = true;

  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  } catch (err) {
    console.error("[BACKUP] cannot create dir:", BACKUP_DIR, err.message);
  }
  console.log(
    `[BACKUP] on-site backup → ${BACKUP_DIR} (flush ${FLUSH_MS}ms, retain ${RETENTION_DAYS}d)`,
  );

  const flushTimer = setInterval(() => flush().catch(() => {}), FLUSH_MS);
  flushTimer.unref?.(); // the HTTP server keeps the process alive, not this timer

  purgeOld();
  const purgeTimer = setInterval(purgeOld, DAY_MS);
  purgeTimer.unref?.();

  // Flush the last buffered samples on shutdown. A UPS low-battery event typically
  // triggers an OS shutdown (SIGTERM); Ctrl+C sends SIGINT. Node does NOT emit
  // 'exit' for an unhandled signal, so we must catch the signals ourselves.
  const shutdown = (sig) => {
    flushSync();
    console.log(`[BACKUP] flushed on ${sig}`);
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", flushSync); // final safety net for a normal event-loop exit
}

export default { init, record, flush, flushSync, purgeOld, BACKUP_DIR };
