# MySQL Dump — the relational half of the backup

The NDJSON backup covers the **time-series** (InfluxDB). This step covers the
**MySQL** side — the data you can't regenerate: users, device registrations,
`alert_rules`, alert/notification history, `device_logs`, `aircon_logs`,
`system_logs`, agent tokens, UPS/network/MikroTik config, and more.

A nightly dump lands compressed in `BACKUP_DIR` as `mysql-YYYY-MM-DD.sql.gz`, so:
- the **offsite rclone job** (`../offsite-backup/`) uploads it to Backblaze automatically,
- the **backend** covers it with the **same retention** (`BACKUP_RETENTION_DAYS`) and the
  **SHA-256 integrity manifest** — no extra config.

Files:
- `dump-mysql.sh` — Linux
- `dump-mysql.ps1` — Windows

---

## Requirements
- `mysqldump` on `PATH` (ships with MySQL / MariaDB client tools).
- **Linux:** `gzip` (present by default). **Windows:** none — it gzips via .NET.
- DB credentials — read automatically from `backend/.env` (`DB_HOST`, `DB_PORT`,
  `DB_USER`, `DB_PASSWORD`, `DB_NAME`). Override with the same env vars if needed.

The password is passed via `MYSQL_PWD` (kept off the process command line).

## Test it
```bash
# Linux
BACKUP_DIR=/mnt/backup/backups ./dump-mysql.sh
ls -lh /mnt/backup/backups/mysql-*.sql.gz
```
```powershell
# Windows
$env:BACKUP_DIR="E:\backups"; .\dump-mysql.ps1
Get-ChildItem E:\backups\mysql-*.sql.gz
```

## Schedule it (a few minutes BEFORE the offsite sync)
**Linux (cron)** — dump 02:15, offsite 02:30:
```cron
15 2 * * *  BACKUP_DIR=/mnt/backup/backups /opt/monitoring/ops/db-backup/dump-mysql.sh
30 2 * * *  BACKUP_DIR=/mnt/backup/backups /opt/monitoring/ops/offsite-backup/sync-offsite.sh
```
**Windows (Task Scheduler)** — dump 02:15:
```powershell
$act = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\monitoring\ops\db-backup\dump-mysql.ps1"
$trg = New-ScheduledTaskTrigger -Daily -At 2:15AM
Register-ScheduledTask -TaskName "MonitoringDbDump" -Action $act -Trigger $trg -RunLevel Highest
```

## Restore
```bash
gunzip -c mysql-2026-07-03.sql.gz | mysql -u root -p cspc-ictu-monitoring-system
```
```powershell
# Windows: decompress then pipe into mysql
```

## What this does NOT include (handle separately)
- **Secrets** — `backend/.env` (DB password, JWT/Google/Resend keys, `DEVICE_SECRET`,
  `MIKROTIK_ENC_KEY`) and `rclone.conf`. Keep an **encrypted, offline** copy. Note: the
  dump contains MikroTik passwords **encrypted with `MIKROTIK_ENC_KEY`** — the dump is
  useless for those creds without that key, so back the key up safely and separately.
- **Uploaded files** (`/uploads`) — if you use image uploads, add that folder to the
  backup too (not in MySQL).
- **Pre-backup InfluxDB history** — the NDJSON covers time-series from deployment forward;
  a one-time `influx backup` captures anything older.
