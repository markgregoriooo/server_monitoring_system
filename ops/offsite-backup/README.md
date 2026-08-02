# Offsite Backup — Backblaze B2 (encrypted)

Scaffolding for the **"1 offsite" leg of 3-2-1**: a scheduled, encrypted `rclone`
job that copies the local NDJSON backup files (`BACKUP_DIR`) to a Backblaze B2
bucket. See `../../backup-storage.md` for the whole backup design.

> **This does NOT change the on-prem backend.** It's a standalone job that reads the
> backup folder and uploads copies. The backend has no cloud dependency; it only reads
> a local success-marker file for its offsite-health alert. Internet/cloud down →
> monitoring keeps working, only the offsite copy lags.

| Copy | Where | |
|---|---|---|
| 1 | InfluxDB/MySQL on backend disk | on-prem (live) |
| 2 | micro SD / USB (`BACKUP_DIR`) | on-prem (local backup) |
| 3 | **Backblaze B2 (encrypted)** | **offsite ← this** |

Files here:
- `sync-offsite.sh` — Linux sync script
- `sync-offsite.ps1` — Windows sync script
- `rclone.conf.example` — rclone config template (no secrets)

---

## Why `copy`, not `sync`

The scripts use `rclone copy` — it uploads new/changed files and **never deletes**
remotely. The local card purges files older than `BACKUP_RETENTION_DAYS`, but the cloud
should keep **full history**, so `copy` is correct (`sync` would delete them from the
cloud too). Manage cloud retention separately with a **B2 Lifecycle Rule** if desired.

---

## One-time setup

### 1. Install rclone
- **Linux:** `sudo -v && curl https://rclone.org/install.sh | sudo bash` (or `apt install rclone`)
- **Windows:** `choco install rclone` (or download the zip from rclone.org and put `rclone.exe` on `PATH`)

Verify: `rclone version`

### 2. Create the Backblaze B2 bucket + key
1. Backblaze account → **B2 Cloud Storage → Buckets → Create a Bucket**
   (e.g. `cspc-monitoring-backup`, **Private**).
2. **App Keys → Add a New Application Key**, **scoped to that one bucket**, read/write.
   Copy the **keyID** and **applicationKey** (shown once).
3. *(Recommended)* On the bucket, add **Object Lock / a Lifecycle Rule** for immutability +
   retention (ransomware protection — the enterprise "WORM" leg).

### 3. Configure rclone (two remotes: B2 + encryption)
Interactive (recommended):
```
rclone config      # create remote "b2" (type: b2) with your keyID/appKey
rclone config      # create remote "b2crypt" (type: crypt), remote = b2:cspc-monitoring-backup/offsite
```
…or copy `rclone.conf.example` to your real config path and fill it in. Obscure passwords with:
```
rclone obscure "your-strong-passphrase"
```
> ⚠️ **Keep the two crypt passphrases somewhere safe and OFFLINE.** Without them the cloud
> copy is unrecoverable — that is the point of client-side encryption.

Real config path:
- Linux: `/etc/rclone/rclone.conf` (or `~/.config/rclone/rclone.conf`)
- Windows: `C:\ProgramData\rclone\rclone.conf`

### 4. Test it
```bash
# should connect and list (empty at first)
rclone --config /etc/rclone/rclone.conf ls b2crypt:cspc-monitoring-backup/offsite

# one manual run of the sync
BACKUP_DIR=/mnt/backup/backups ./sync-offsite.sh
```
Then confirm the files appear in the B2 bucket (they'll show **encrypted names** — expected).

### 5. Schedule it
**Linux (cron)** — nightly at 02:30:
```cron
30 2 * * *  BACKUP_DIR=/mnt/backup/backups /opt/monitoring/ops/offsite-backup/sync-offsite.sh
```
**Windows (Task Scheduler)** — daily 02:30:
```powershell
$act = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\monitoring\ops\offsite-backup\sync-offsite.ps1"
$trg = New-ScheduledTaskTrigger -Daily -At 2:30AM
Register-ScheduledTask -TaskName "OffsiteBackupSync" -Action $act -Trigger $trg -RunLevel Highest
```

### 6. Turn on the backend offsite-health alert
Each successful sync stamps `BACKUP_DIR/.last_offsite_sync`. Tell the backend to watch it
by setting in `backend/.env`:
```
BACKUP_OFFSITE_ENABLED=true
BACKUP_OFFSITE_MAX_AGE_HOURS=26   # alert if no successful sync within this window
```
Restart the backend. If the offsite sync stalls (marker missing or older than the window),
the backend raises a **`backup_offsite`** warning on the normal bell/email pipeline, and
auto-resolves it once a fresh sync lands. Leave `BACKUP_OFFSITE_ENABLED` unset until sync is
running, so it never false-alerts.

---

## Restore (pull the cloud copy back)
```bash
rclone --config /etc/rclone/rclone.conf copy b2crypt:cspc-monitoring-backup/offsite ./restore
```
Files come back decrypted (rclone decrypts on the fly with your passphrases). Each `.ndjson`
line is self-describing, so replay into InfluxDB or load into pandas/Excel directly.

Verify integrity against the shipped manifest:
```bash
cd ./restore && sha256sum -c checksums.sha256
```

---

## Notes
- **Cost is negligible** — telemetry is ~15–30 MB/day; B2 is ~$6/TB/month → cents.
- **Bandwidth** — a nightly delta upload is tiny; no impact on monitoring.
- **`offsite-sync.log`** grows over time; add `logrotate` (Linux) or periodic truncation
  (Windows) if you care. It and the marker are excluded from upload.
- **The backend is untouched** by all of this except reading the local marker file.
