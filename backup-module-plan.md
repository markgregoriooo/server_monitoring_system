# Backup Module — Plan (panel RSC #2)

Status: **BUILT** on branch `backup-module` (2026-10-06) — see `backup-storage.md` §13. Decisions: Sunday 02:00 PHT, keep 12 weeks, report included.

## The recommendation (verbatim)

> **Backup Server**
> Integrate a backup server module to manage and secure system backups.
> **FOD:** Present the system weekly backup.

(FOD = Final Oral Defense.)

**Meaning (confirmed with Mark):** backups of **OUR monitoring system** (its database + collected
data) — NOT backups of ICTU's own servers. The panel wants:

1. A **Backups module/page in the dashboard** to see, manage and secure the system's backups.
2. At the final defense, **show weekly backups** — a list of backups taken week by week.

---

## What already exists (works today, but invisible in the dashboard)

| Piece | Where | What it does |
|---|---|---|
| Live on-site copy | `backend/services/backupService.js` | Every ingested sample (env/server/router/MikroTik/UPS) also written to NDJSON files in `BACKUP_DIR` (USB drive), one file per stream per day |
| Integrity manifest | `backupService.updateChecksums` | SHA-256 of every backup file, in a manifest |
| Retention | `backupService.purgeOld` | Deletes dated files older than `BACKUP_RETENTION_DAYS` (30) |
| Nightly DB dump | `ops/db-backup/dump-mysql.sh` / `.ps1` | Full MySQL dump → `BACKUP_DIR/mysql-YYYY-MM-DD.sql.gz`. Run by **host cron**, not the backend. Docker mode runs `mariadb-dump` inside `db` |
| Offsite copy | `ops/offsite-backup/sync-offsite.sh` | rclone → Backblaze B2, **client-side encrypted** (`b2crypt` crypt remote). Host cron. Stamps a marker file on success |
| Offsite staleness alert | `backupService.checkOffsite` + `services/offsiteStaleness.js` | Warning after 26 h without a successful sync, critical after 72 h |
| Docs | `backup-storage.md`, `ops/backup-setup-linux.md`, `ops/offsite-backup/README.md`, `ops/backblaze-setup-guide.md` | Setup + restore steps |

**Gap:** nothing in the frontend. No page, no list, no buttons. The panel could not see it.
Also: the local `mysql-*.sql.gz` dump on the USB drive is **not encrypted** (only the offsite copy is).

---

## Proposed build

### 1. Weekly backup job (inside the backend)
- Once a week (default **Sunday 02:00 PH time**, configurable) the backend creates ONE weekly
  backup: full DB dump + that week's NDJSON files + checksum manifest → one archive,
  e.g. `weekly-2026-W41.tar.gz`, **encrypted** (AES-256-GCM, reuse `services/secretCrypto.js` /
  a backup key in `.env`).
- Keep **12 weeks** (configurable), separate from the 30-day daily retention.
- Offsite: lands in `BACKUP_DIR`, so the existing nightly rclone job uploads it — no new plumbing.
- Record each run in a new MySQL table (e.g. `system_backups`: id, kind weekly|manual|daily,
  file, size, sha256, status ok|failed, started/finished, error, created_by).
- ⚠️ The DB dump currently runs on the HOST (cron). For the backend to do it in Docker, add
  `mariadb-client` to the backend image (`Dockerfile`) and run `mariadb-dump` against the `db`
  service with the app's DB credentials. Do NOT mount the Docker socket into the backend.

### 2. Backups page (admin only) — what gets presented at the FOD
- **Status cards:** On-site copy · Database dump · Offsite — last success, health colour, size.
- **Weekly backups table:** week, date, size, contents, **Verified ✓** (re-checked SHA-256),
  Download.
- **Buttons:** Back up now · Verify integrity · Download (all audited in History).
- **Settings:** backup day/time, weeks to keep.
- **Restore:** a guided step-by-step panel, **NOT a one-click restore** (a click — or a stolen
  admin session — must not be able to wipe the live database).
- Use the Grafana `--gf-*` tokens and `.gf-btn` buttons (UI rules in CLAUDE.md).

### 3. (Optional) Weekly backup report
- New **"Backup"** report type in the existing Reports page: PDF on ICTU letterhead listing the
  week's backups, sizes, verification results. Printable for the panel.

### Security ("secure system backups")
- Encrypted weekly archives on-site AND offsite.
- SHA-256 verification shows tampering/corruption.
- Admin-only routes + page; every action in `system_logs` (History).
- Rate-limit / size-limit downloads; never expose `BACKUP_DIR` paths to the client.
- New migration → **also fold into `v13_cspc-ictu-monitoring-system.sql`**.

---

## ⚠️ Timing

Weekly backups accumulate **one per week**. To show several at the FOD, the weekly job must be
**deployed on the real system at ICTU as early as possible**. Start date matters more than polish.

## Open questions for next session

1. **When is the final defense?** (decides how many weeks can be shown)
2. Build the optional **weekly backup report** (Reports page) too?
3. Weekly day/time and how many weeks to keep — defaults OK (Sunday 02:00, 12 weeks)?
4. Branch: start a new branch off `main`, or after `server-console` is merged?
