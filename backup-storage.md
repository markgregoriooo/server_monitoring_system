# On-Site Backup Storage — System Guide

Reference for the **backup storage subsystem**: an independent, non-volatile copy of
every monitored metric, written to a micro SD / USB drive (or local folder) on the
**backend server**. Survives a database wipe *and* a power outage.

> Scope: this document covers *what* is backed up, *where* it lives, *why* the design
> is shaped this way, and *how* to operate it. For the metric pipelines themselves see
> `CLAUDE.md`, `Environment.md`, and `router-ups-monitoring.md`.

---

## 1. Why this exists

The deployment requirement ("there must be a backup storage, and it is a micro SD card")
is satisfied by a single durable, **flat-file** copy of all incoming telemetry. It serves
two purposes that the live databases (InfluxDB + MySQL) do **not**:

| Purpose | What it protects against |
|---------|--------------------------|
| **Independent second copy** | InfluxDB/MySQL corruption, disk failure, accidental wipe |
| **Non-volatile survival** | A power outage — the files outlive the blackout and are intact when power returns |

It is **not** the live source of truth (the dashboard still reads InfluxDB/MySQL). It is
the *safety copy* — the thing you fall back to when the primary store is gone.

---

## 2. The one idea that shapes everything

**A micro SD card doesn't collect anything by itself — it only holds what the device it's
plugged into can see.** So the real question is *which device holds the card and receives
all the data?*

| Data stream | Who collects it | Reaches the ESP32? | Reaches the backend? |
|-------------|-----------------|--------------------|----------------------|
| Environment (temp/smoke/humidity) | ESP32 sensors → Socket.IO | ✅ (its own) | ✅ |
| Server metrics | Go agent → HTTP POST | ❌ | ✅ |
| Non-MikroTik routers + UPS | backend SNMP poller | ❌ | ✅ |
| MikroTik routers | backend RouterOS poller | ❌ | ✅ |

The **backend is the only device that receives all four streams**, so the backup card
lives **on the backend** — *not* on the ESP32, and *not* on the UPS.

> **The UPS never stores anything.** It is a *monitored device* (it reports battery %,
> runtime, on-battery) and a *power source*. Its job in this design is to keep the backend
> — and therefore the backup card — powered through an outage.

The ESP32's own SD-card offline buffer was **removed** (see §9): the client's ESP32
(mini-UPS), router gear (router UPS), and backend (its own UPS) all stay powered through
an outage, so the ESP32 never disconnects and never needs a local buffer.

---

## 3. Architecture

```
   ESP32 (environment)  ──Socket.IO──┐
   Go agents (servers)  ──HTTP POST──┤
   SNMP poll (router+UPS) ───────────┼──►  BACKEND (Node.js)  ──┬──►  InfluxDB + MySQL   (live source of truth)
   RouterOS poll (MikroTik) ─────────┘        │                 │
                                              │                 └──►  backupService.js  ──►  ONE micro SD / USB
                                              │                                              (the backup: NDJSON files)
                                        UPS ──┘  keeps the backend + card powered during an outage
```

Every ingest handler, at the moment it writes to InfluxDB, **also** calls
`backupService.record(stream, payload)`. The backup write is independent: if InfluxDB is
down the backup still happens, and if the backup fails it never breaks ingestion.

---

## 4. What gets backed up (per stream)

One record is written per sample. Every record is a JSON object prefixed with `ts`
(server ISO-8601 timestamp) and `stream`.

### `env` — environment (from `sensorHandler.js`)
`temperature`, `humidity`, `mq2_1_ppm`, `mq2_2_ppm`, `heat_index`, `smoke_status`,
`temp_status`, `environment_status`

### `server` — servers (from `serverMetricsHandler.js`)
`device_id`, `device_name`, `location`, `os`, `cpu_percent`, `mem_used_mb`,
`mem_total_mb`, `mem_percent`, `disk_used_gb`, `disk_total_gb`, `disk_percent`,
`net_bytes_sent`, `net_bytes_recv`, `uptime_seconds`, `process_count`

### `network` — routers, **both** non-MikroTik (SNMP) and MikroTik (RouterOS)
_(from `networkMetricsHandler.js` — both pollers share `writeNetworkSample`, so one hook
covers both; `device_type` distinguishes them)_

`device_id`, `device_name`, `device_type`, `ip`, `location`, `reachable`,
`uptime_seconds`, `cpu_percent`, `mem_percent`, `latency_ms`, `packet_loss_pct`,
`connected_clients`, and per interface: `name`, `location_label`, `rx_bytes`, `tx_bytes`,
`rx_errors`, `tx_errors`, `link_up`, `utilization_pct`.

> `rx_bytes`/`tx_bytes` are 64-bit `Counter64` values (BigInt in JS) — serialized as
> **strings** so no precision is lost (JSON has no BigInt).

### `ups` — UPS (from `upsMetricsHandler.js`) — the most important stream during an outage
`device_id`, `device_name`, `ip`, `location`, `battery_charge_pct`,
`runtime_remaining_min`, `load_pct`, `input_voltage`, `output_voltage`, `battery_voltage`,
`on_battery`, `battery_status`, `temperature`

---

## 5. File format & layout

- **Format:** NDJSON — one JSON object per line. Append-only, robust to partial writes,
  trivial to `grep`/replay/import.
- **Layout:** one file per stream per day, under `BACKUP_DIR`:

```
BACKUP_DIR/
  env-2026-07-03.ndjson
  server-2026-07-03.ndjson
  network-2026-07-03.ndjson
  ups-2026-07-03.ndjson
  env-2026-07-04.ndjson
  ...
  mysql-2026-07-03.sql.gz   # nightly MySQL dump (relational data) — see ops/db-backup/
  checksums.sha256          # SHA-256 of every sealed (past-day) file — integrity manifest, §6
```

Example line (`ups-2026-07-03.ndjson`):
```json
{"ts":"2026-07-03T03:58:16.613Z","stream":"ups","device_id":5,"battery_charge_pct":88,"on_battery":false}
```

The `.ndjson` files are the **time-series** (InfluxDB). The **relational** data — users,
devices, `alert_rules`, and the history/log tables (`alerts`, `device_logs`, `aircon_logs`,
`system_logs`) — is captured by a nightly **`mysql-YYYY-MM-DD.sql.gz`** dump
(`ops/db-backup/`) that lands in the same folder, so it inherits the same retention,
integrity manifest, and offsite sync.

---

## 6. Durability model (buffer → flush)

Writes are **buffered in memory and flushed on a timer**, not written one-per-sample. This
spares micro-SD **write endurance** (constant tiny writes are what wear flash cards out).

| Mechanism | When | Purpose |
|-----------|------|---------|
| Timer flush | every `BACKUP_FLUSH_MS` (default 5 s) | normal durability; batches writes |
| `flushSync()` | on `SIGINT` / `SIGTERM` (Ctrl+C, or a UPS low-battery OS shutdown) | write the last buffered samples before the process dies |
| `process.on('exit')` | normal event-loop exit | final safety net |
| Re-queue on error | a failed `appendFile` (card busy) | retry next tick instead of dropping rows |

**Worst-case data loss** on a hard, un-graceful power cut = one flush window (≤ 5 s).
A graceful shutdown (see §8) loses nothing.

### Health alerts & integrity checks

The writer is self-monitoring — a backup that silently stops or rots is worse than none.
Both surface on the **same bell + email pipeline** as every other alert (`deviceId` null =
system-level):

- **Write-failure alert.** After 3 consecutive failed flushes (drive unmounted / full /
  read-only) it raises a **`critical` "Backup storage failing"** alert (type `backup`) and
  **auto-resolves** it once writes recover. While the drive is unreachable the buffer keeps
  the newest samples, capped (`MAX_BUFFER_LINES`) so a long outage can't exhaust memory.
- **Integrity manifest (rot detection).** Once a day's file is *sealed* (its date has
  passed, so it is never appended to again), its SHA-256 is recorded in
  `BACKUP_DIR/checksums.sha256`. The daily pass re-hashes sealed files and, on any mismatch
  (silent corruption / card rot), raises a **`critical` "Backup integrity check failed"**
  alert (type `backup_integrity`). The manifest is `sha256sum -c checksums.sha256`-compatible,
  so you can also verify the whole card from a shell.

### Offsite copy (3-2-1) — Backblaze B2

The **offsite leg** is a SEPARATE, scheduled `rclone` job (`ops/offsite-backup/`) that copies
the NDJSON files to an **encrypted Backblaze B2** bucket. It does **not** change the on-prem
backend — the backend only reads a local success-marker for a `backup_offsite` staleness
alert and has **zero cloud runtime dependency** (internet/cloud down → monitoring is fine,
only the offsite copy lags). It uses `rclone copy` (never deletes remotely) so the cloud keeps
full history after local retention purges, and encrypts client-side (rclone `crypt`).

Full setup (install, B2 bucket/key, encryption, schedule, restore): **`ops/offsite-backup/README.md`**.
Enable the backend staleness alert with `BACKUP_OFFSITE_ENABLED=true` once the sync is running.

> Remaining enterprise hardening beyond this: B2 **Object Lock / lifecycle** for immutability
> (ransomware/WORM), and a documented **restore drill**.

---

## 7. Configuration (`backend/.env`)

| Variable | Default | Meaning |
|----------|---------|---------|
| `BACKUP_DIR` | `<backend cwd>/backups` | Where files are written — set this to the **SD/USB mount path** |
| `BACKUP_ENABLED` | `true` | Set `false` to disable the whole subsystem |
| `BACKUP_RETENTION_DAYS` | `30` | Files older than this (by day-stamp) are purged daily |
| `BACKUP_FLUSH_MS` | `5000` | Buffer flush interval (lower = less loss window, more flash wear) |

Retention runs at startup and every 24 h, deleting `*-YYYY-MM-DD.ndjson` files older than
the cutoff (mirrors `NOTIFY_RETENTION_DAYS` for the alerts tables).

---

## 8. The power-outage scenario (why the design holds)

Worst case raised during design: **UPS runtime ≈ 3 h, brownout ≈ 24 h.**

```
Hour 0        Power lost. Everything on UPS. ESP32 → backend → backup all running.
Hours 0–3     CAPTURED: room heating, UPS %, runtime dropping, load, on-battery events.
              ← the window that matters, fully recorded to the backup card.
~Hour 2:50    UPS low battery → GRACEFUL SHUTDOWN of the backend (flushSync writes tail).
~Hour 3       UPS dead. Everything off. No data exists to record (nothing is powered).
Hours 3–24    Dark. Nothing to back up. (expected — you can't monitor an unpowered room.)
Hour 24       Power returns → backend boots → the hours 0–3 files are STILL THERE.
```

Two takeaways this design depends on:

1. **Non-volatile medium is mandatory.** RAM would lose hours 0–3 the moment the UPS dies.
   Disk/SD survives the blackout — that's the whole point.
2. **Graceful shutdown before the UPS dies.** Wire the UPS to trigger an OS shutdown at a
   low-battery threshold (NUT / apcupsd over USB, or an SNMP low-battery trap). The
   resulting `SIGTERM` fires `flushSync()`, so the last buffered samples and a clean DB
   close are guaranteed. Because the system already monitors `battery_charge_pct` /
   `runtime_remaining_min`, that same signal can drive the shutdown.

> No UPS realistically covers a 24 h outage — that needs a **generator**. The monitoring
> system's job is to *record the transition and shut down safely*, not run for a day.

---

## 9. What changed vs. the old design

- **ESP32 SD offline buffer: removed.** `env_monitor_v2.ino` no longer includes `SD.h`/
  `SPI.h`, `SD_ENABLED`, `sdAppendRow()`, `sdFlushToServer()`, the SD init block, or the
  WiFi-restore flush. When offline it now just logs a warning. (Removed across all
  firmware branches.) Rationale in §2.
- **Backend backup writer: added.** `services/backupService.js` + hooks in the four ingest
  handlers + `init()` in `server.js`.

---

## 10. Key files

| File | Responsibility |
|------|----------------|
| `backend/services/backupService.js` | The writer: buffer, timer flush, `flushSync`, retention, BigInt-safe serialize, **health alert** on write failure, **SHA-256 integrity manifest** + rot detection |
| `backend/handlers/sensorHandler.js` | `record("env", …)` after the InfluxDB write |
| `backend/handlers/serverMetricsHandler.js` | `record("server", …)` |
| `backend/handlers/networkMetricsHandler.js` | `record("network", …)` — covers SNMP **and** MikroTik (shared `writeNetworkSample`) |
| `backend/handlers/upsMetricsHandler.js` | `record("ups", …)` |
| `backend/src/server.js` | `backupService.init()` at startup |

---

## 11. Setup — deploy on the backend

The folder, file naming, rotation, and cleanup are all **automatic** — on startup the
service runs `mkdir` (recursive) on `BACKUP_DIR`, so you never create the folder by hand.
You only tell it *where* to write; otherwise it defaults to the backend's own disk
(`backend/backups/`), which works but defeats the "independent copy" purpose.

**Step 1 — plug in and mount the USB / micro SD on the backend server.**
- **Windows:** it gets a drive letter, e.g. `E:`
- **Linux:** mount it, e.g. `sudo mount /dev/sda1 /mnt/backup`, then add it to `/etc/fstab`
  so it re-mounts automatically after a reboot (see gotcha below).

**Step 2 — point the backend at that drive** in `backend/.env`:
```ini
# Windows
BACKUP_DIR=E:/backups
```
```ini
# Linux
BACKUP_DIR=/mnt/backup/backups
```
> Use forward slashes even on Windows — Node accepts them and it avoids backslash-escaping
> confusion in `.env`. Point at a **subfolder** on the drive, not the drive root.

**Step 3 — restart the backend** so it re-reads `.env`.

**Step 4 — done. The folder + files appear automatically.** Confirm the startup log:
```
[BACKUP] on-site backup → E:/backups (flush 5000ms, retain 30d)
```
Within ~a minute of live data the folder fills with `env-*.ndjson`, `server-*.ndjson`,
`network-*.ndjson`, `ups-*.ndjson` (one file per stream per day).

**Verify:** `dir E:\backups` (Windows) or `ls -la /mnt/backup/backups` (Linux) — the
`.ndjson` files should be growing.

### Setup gotchas
- **Skip Step 2 → it lands on the backend's own disk** (`backend/backups/`), i.e. the same
  disk as the app/DB. Fine for a quick test, wrong for a real backup — always point at the
  USB/SD (see §13).
- **The drive must re-mount after a reboot.** After an outage the server reboots; if the
  USB/SD isn't mounted then, backup writes fail. Windows usually re-assigns the same drive
  letter automatically; **Linux needs an `/etc/fstab` entry** or it won't mount on boot.
- **Graceful-shutdown flush on Windows:** a UPS/OS-initiated shutdown doesn't raise
  `SIGTERM` on Windows, so the synchronous shutdown flush won't fire there — you fall back
  to the timer flush (≤ `BACKUP_FLUSH_MS`). Lower `BACKUP_FLUSH_MS` or run under a service
  wrapper (NSSM/PM2) that stops cleanly. On Linux `SIGTERM` works, so this is a non-issue.

---

## 12. Reading the backup

**Inspect a day of UPS data:**
```bash
cat "$BACKUP_DIR/ups-2026-07-03.ndjson" | jq .
```

**Find every on-battery event (the outages):**
```bash
grep '"on_battery":true' "$BACKUP_DIR"/ups-*.ndjson
```

**Count environment samples for a day:**
```bash
wc -l "$BACKUP_DIR/env-2026-07-03.ndjson"
```

Each line is self-describing (`ts` + `stream` + fields), so the files can be replayed into
InfluxDB, loaded into pandas/Excel, or diffed against the live DB with no schema lookup.

---

## 13. Gotchas / known limits

- **Backend must be on the UPS.** The backup only survives an outage if the backend (and
  its card) stay powered — that is the linchpin of the whole design (§2, §8).
- **Micro-SD write endurance.** Use a high-endurance ("dashcam/surveillance") card, or a
  USB SSD, which outlasts a micro SD under continuous logging. Buffered writes (§6) already
  minimize wear.
- **A backup on the same disk as the DB is not a real backup.** Prefer a *separate* medium
  (removable card / second drive) so one disk failure can't take both copies.
- **≤ 5 s loss on a hard cut.** Un-graceful power loss can drop the current buffer window;
  graceful shutdown (§8) avoids it.
- **No live gap-fill.** With the ESP32 SD removed, if the backend/network is briefly down
  while mains power is *fine* (backend restart, WiFi blip), telemetry for that window is
  lost — accepted trade-off given everything is on UPS.
```
