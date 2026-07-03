# ============================================================================
#  Offsite backup sync (Windows)  ->  Backblaze B2, client-side encrypted
# ----------------------------------------------------------------------------
#  Windows twin of sync-offsite.sh. Pushes the local NDJSON backup files to a
#  Backblaze B2 bucket via rclone, then stamps a success marker the backend
#  reads for its offsite-health alert.
#
#  Uses `rclone copy` (NOT sync): uploads new/changed files, never deletes
#  remotely, so the cloud keeps full history after local retention purges.
#  Data is encrypted client-side (crypt remote) before it leaves the building.
#
#  STANDALONE job — the backend does not depend on it. Schedule via Task
#  Scheduler (see README.md). A non-zero exit signals failure.
# ============================================================================
$ErrorActionPreference = "Stop"

# ── Config (override via environment, or edit these defaults) ──────────────
$BackupDir  = if ($env:BACKUP_DIR)          { $env:BACKUP_DIR }          else { "E:\backups" }
$Remote     = if ($env:RCLONE_REMOTE)       { $env:RCLONE_REMOTE }       else { "b2crypt:cspc-monitoring-backup/offsite" }
$RcloneConf = if ($env:RCLONE_CONFIG)       { $env:RCLONE_CONFIG }       else { "C:\ProgramData\rclone\rclone.conf" }
$Marker     = if ($env:BACKUP_OFFSITE_MARKER) { $env:BACKUP_OFFSITE_MARKER } else { Join-Path $BackupDir ".last_offsite_sync" }
$Log        = if ($env:OFFSITE_LOG)         { $env:OFFSITE_LOG }         else { Join-Path $BackupDir "offsite-sync.log" }

function Ts { (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }

Add-Content -Path $Log -Value "[$(Ts)] offsite sync start -> $Remote"

& rclone --config $RcloneConf copy $BackupDir $Remote `
    --exclude ".last_offsite_sync" `
    --exclude "*.log" `
    --exclude "*.tmp" `
    --transfers 4 --checkers 8 `
    --log-file $Log --log-level INFO

if ($LASTEXITCODE -eq 0) {
    Set-Content -Path $Marker -Value (Ts) -NoNewline   # success stamp for backend health check
    Add-Content -Path $Log -Value "[$(Ts)] offsite sync OK"
} else {
    Add-Content -Path $Log -Value "[$(Ts)] offsite sync FAILED (rclone exit $LASTEXITCODE)"
    exit 1
}
