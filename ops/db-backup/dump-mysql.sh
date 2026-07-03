#!/usr/bin/env bash
# ============================================================================
#  MySQL dump (Linux)  →  BACKUP_DIR/mysql-YYYY-MM-DD.sql.gz
# ----------------------------------------------------------------------------
#  Dumps the whole monitoring database, compressed, into BACKUP_DIR. Because it
#  lands there, the offsite rclone job uploads it to Backblaze AND the backend's
#  retention + SHA-256 integrity manifest cover it — no extra plumbing.
#
#  This captures the RELATIONAL half of the system the NDJSON streams do not:
#  users, devices, alert_rules, alerts + notifications history, device_logs,
#  aircon_logs, system_logs, agent tokens, ups/network/mikrotik config, etc.
#
#  Reads DB creds from backend/.env (override via env). Schedule from cron a few
#  minutes BEFORE the offsite sync so the fresh dump ships the same night.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../../backend/.env}"

# Read one KEY=value from .env WITHOUT sourcing it (values may contain spaces /
# < > that would break `source` — e.g. RESEND_FROM).
getenv() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }

DB_HOST="${DB_HOST:-$(getenv DB_HOST)}";         DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-$(getenv DB_PORT)}";         DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-$(getenv DB_USER)}";         DB_USER="${DB_USER:-root}"
DB_NAME="${DB_NAME:-$(getenv DB_NAME)}"
DB_PASSWORD="${DB_PASSWORD:-$(getenv DB_PASSWORD)}"
: "${BACKUP_DIR:=/mnt/backup/backups}"
LOG="${DB_BACKUP_LOG:-$BACKUP_DIR/db-backup.log}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
OUT="$BACKUP_DIR/mysql-$(date -u +%Y-%m-%d).sql.gz"

if [ -z "${DB_NAME:-}" ]; then
  echo "[$(ts)] ERROR: DB_NAME not set (checked env + $ENV_FILE)" >> "$LOG"
  exit 1
fi
mkdir -p "$BACKUP_DIR"
echo "[$(ts)] mysqldump '$DB_NAME' @ $DB_HOST:$DB_PORT → $OUT" >> "$LOG"

# MYSQL_PWD keeps the password OFF the process list (no -p on the CLI). pipefail
# (set above) makes the pipeline fail if mysqldump fails, not just gzip.
rc=0
{ MYSQL_PWD="$DB_PASSWORD" mysqldump \
    -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" \
    --single-transaction --quick --routines --triggers --events \
    --default-character-set=utf8mb4 \
    "$DB_NAME" | gzip -c > "$OUT"; } 2>> "$LOG" || rc=$?

if [ "$rc" -eq 0 ] && [ -s "$OUT" ]; then
  echo "[$(ts)] OK ($(du -h "$OUT" | cut -f1))" >> "$LOG"
else
  echo "[$(ts)] FAILED (exit $rc) — removing partial dump" >> "$LOG"
  rm -f "$OUT"
  exit 1
fi
