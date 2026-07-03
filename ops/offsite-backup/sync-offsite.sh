#!/usr/bin/env bash
# ============================================================================
#  Offsite backup sync (Linux)  →  Backblaze B2, client-side encrypted
# ----------------------------------------------------------------------------
#  Pushes the local NDJSON backup files to a Backblaze B2 bucket via rclone,
#  then stamps a success marker the backend reads for its offsite-health alert.
#
#  Uses `rclone copy` (NOT sync): it only uploads new/changed files and NEVER
#  deletes remotely — so the cloud keeps full history even after the local card
#  purges old files (BACKUP_RETENTION_DAYS). Data is encrypted client-side by
#  the `crypt` remote before it leaves the building.
#
#  This is a STANDALONE job — the backend has no dependency on it. Schedule it
#  from cron (see README.md). Runs are logged; a failure exits non-zero.
# ============================================================================
set -euo pipefail

# ── Config (override via environment, or edit these defaults) ──────────────
: "${BACKUP_DIR:=/mnt/backup/backups}"                    # local backup folder (match backend .env)
: "${RCLONE_REMOTE:=b2crypt:cspc-monitoring-backup/offsite}"  # crypt remote:bucket[/path]
: "${RCLONE_CONFIG:=/etc/rclone/rclone.conf}"             # where the (secret) rclone.conf lives
MARKER="${BACKUP_OFFSITE_MARKER:-$BACKUP_DIR/.last_offsite_sync}"
LOG="${OFFSITE_LOG:-$BACKUP_DIR/offsite-sync.log}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

echo "[$(ts)] offsite sync start → $RCLONE_REMOTE" >> "$LOG"

rc=0
rclone --config "$RCLONE_CONFIG" copy "$BACKUP_DIR" "$RCLONE_REMOTE" \
  --exclude ".last_offsite_sync" \
  --exclude "offsite-sync.log" \
  --transfers 4 --checkers 8 \
  --log-file "$LOG" --log-level INFO || rc=$?

if [ "$rc" -eq 0 ]; then
  ts > "$MARKER"                      # success stamp → backend offsite-health check reads this
  echo "[$(ts)] offsite sync OK" >> "$LOG"
else
  echo "[$(ts)] offsite sync FAILED (rclone exit $rc)" >> "$LOG"
  exit 1
fi
