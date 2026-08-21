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
# < > that would break `source` — e.g. MAIL_FROM).
#
# Mirrors what dotenv does on the backend side, so a value read here is the value the
# backend is using: an inline `# comment` is not part of it, surrounding quotes are not
# either, and trailing spaces are trimmed. The .env template ships lines written as
#   BACKUP_DIR=/mnt/backup/backups   # Linux mount path
# and without the strip the path would come back with the comment glued to it.
getenv() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" | head -1 \
    | sed -e 's/[[:space:]][[:space:]]*#.*$//' \
          -e 's/[[:space:]]*$//' \
          -e 's/^"\(.*\)"$/\1/' \
          -e "s/^'\(.*\)'$/\1/"
}

DB_HOST="${DB_HOST:-$(getenv DB_HOST)}";         DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-$(getenv DB_PORT)}";         DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-$(getenv DB_USER)}";         DB_USER="${DB_USER:-root}"
DB_NAME="${DB_NAME:-$(getenv DB_NAME)}"
DB_PASSWORD="${DB_PASSWORD:-$(getenv DB_PASSWORD)}"
# BACKUP_DIR comes from backend/.env unless the caller overrides it, so the scheduled
# job does not have to repeat a path that is already configured once. Without this the
# dump landed in the built-in default while the backend wrote its NDJSON somewhere else
# — two backup folders, one of them the wrong one, and nothing to say so.
BACKUP_DIR="${BACKUP_DIR:-$(getenv BACKUP_DIR)}"; : "${BACKUP_DIR:=/mnt/backup/backups}"
LOG="${DB_BACKUP_LOG:-$BACKUP_DIR/db-backup.log}"

# Which mysqldump to run. A bare name resolves on PATH, which is right on a server with
# MySQL client tools installed; set MYSQLDUMP (env or backend/.env) to a full path when
# it is not — a cron job does not inherit an interactive shell's PATH either.
MYSQLDUMP="${MYSQLDUMP:-$(getenv MYSQLDUMP)}"; : "${MYSQLDUMP:=mysqldump}"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
OUT="$BACKUP_DIR/mysql-$(date -u +%Y-%m-%d).sql.gz"

if [ -z "${DB_NAME:-}" ]; then
  echo "[$(ts)] ERROR: DB_NAME not set (checked env + $ENV_FILE)" >> "$LOG"
  exit 1
fi
mkdir -p "$BACKUP_DIR"
# Checked up front so a missing binary reads as a setup problem, not as a dump that
# failed for some database reason.
if ! command -v "$MYSQLDUMP" >/dev/null 2>&1; then
  echo "[$(ts)] ERROR: mysqldump not found ('$MYSQLDUMP'). Put MySQL's bin on PATH or set MYSQLDUMP to the full path." >> "$LOG"
  exit 1
fi
echo "[$(ts)] mysqldump '$DB_NAME' @ $DB_HOST:$DB_PORT → $OUT" >> "$LOG"

# MYSQL_PWD keeps the password OFF the process list (no -p on the CLI). pipefail
# (set above) makes the pipeline fail if mysqldump fails, not just gzip.
rc=0
{ MYSQL_PWD="$DB_PASSWORD" "$MYSQLDUMP" \
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
