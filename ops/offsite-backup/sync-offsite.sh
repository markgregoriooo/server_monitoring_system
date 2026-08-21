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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../../backend/.env}"

# Read one KEY=value from .env without sourcing it. Strips an inline `# comment`,
# trailing spaces and surrounding quotes, so the value matches what dotenv hands the
# backend. Same helper as ops/db-backup/dump-mysql.sh.
getenv() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" | head -1 \
    | sed -e 's/[[:space:]][[:space:]]*#.*$//' \
          -e 's/[[:space:]]*$//' \
          -e 's/^"\(.*\)"$/\1/' \
          -e "s/^'\(.*\)'$/\1/"
}

# ── Config (override via environment, or edit these defaults) ──────────────
# BACKUP_DIR is read from backend/.env so this job uploads the folder the backend is
# actually writing to. Hardcoding it here meant the cron line and the .env could drift
# apart, and the failure is silent: rclone happily uploads an empty/absent folder and
# still exits 0, which stamps the success marker and clears the staleness alert.
BACKUP_DIR="${BACKUP_DIR:-$(getenv BACKUP_DIR)}"; : "${BACKUP_DIR:=/mnt/backup/backups}"
: "${RCLONE_REMOTE:=b2crypt:cspc-monitoring-backup/offsite}"  # crypt remote:bucket[/path]
: "${RCLONE_CONFIG:=/etc/rclone/rclone.conf}"             # where the (secret) rclone.conf lives
MARKER="${BACKUP_OFFSITE_MARKER:-$BACKUP_DIR/.last_offsite_sync}"
LOG="${OFFSITE_LOG:-$BACKUP_DIR/offsite-sync.log}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

echo "[$(ts)] offsite sync start → $RCLONE_REMOTE" >> "$LOG"

rc=0
rclone --config "$RCLONE_CONFIG" copy "$BACKUP_DIR" "$RCLONE_REMOTE" \
  --exclude ".last_offsite_sync" \
  --exclude "*.log" \
  --exclude "*.tmp" \
  --transfers 4 --checkers 8 \
  --log-file "$LOG" --log-level INFO || rc=$?

if [ "$rc" -eq 0 ]; then
  ts > "$MARKER"                      # success stamp → backend offsite-health check reads this
  echo "[$(ts)] offsite sync OK" >> "$LOG"
else
  echo "[$(ts)] offsite sync FAILED (rclone exit $rc)" >> "$LOG"
  exit 1
fi
