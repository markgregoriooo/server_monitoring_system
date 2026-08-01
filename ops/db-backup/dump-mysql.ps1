# ============================================================================
#  MySQL dump (Windows)  ->  BACKUP_DIR\mysql-YYYY-MM-DD.sql.gz
# ----------------------------------------------------------------------------
#  Windows twin of dump-mysql.sh. Dumps the whole monitoring database, gzip'd,
#  into BACKUP_DIR so the offsite rclone job uploads it and the backend's
#  retention + integrity manifest cover it.
#
#  Reads DB creds from backend/.env (override via env). Schedule via Task
#  Scheduler a few minutes BEFORE the offsite sync.
# ============================================================================
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile   = if ($env:ENV_FILE) { $env:ENV_FILE } else { Join-Path $ScriptDir "..\..\backend\.env" }

# Read one KEY=value from .env without executing it.
function Get-EnvVal($key, $default) {
  if (Test-Path $EnvFile) {
    $m = Select-String -Path $EnvFile -Pattern "^$key=" | Select-Object -First 1
    if ($m) { return ($m.Line -replace "^$key=", "") }
  }
  return $default
}

$DbHost = if ($env:DB_HOST)     { $env:DB_HOST }     else { Get-EnvVal "DB_HOST" "localhost" }
$DbPort = if ($env:DB_PORT)     { $env:DB_PORT }     else { Get-EnvVal "DB_PORT" "3306" }
$DbUser = if ($env:DB_USER)     { $env:DB_USER }     else { Get-EnvVal "DB_USER" "root" }
$DbName = if ($env:DB_NAME)     { $env:DB_NAME }     else { Get-EnvVal "DB_NAME" "" }
$DbPass = if ($env:DB_PASSWORD) { $env:DB_PASSWORD } else { Get-EnvVal "DB_PASSWORD" "" }
$BackupDir = if ($env:BACKUP_DIR) { $env:BACKUP_DIR } else { "E:\backups" }
$Log = if ($env:DB_BACKUP_LOG) { $env:DB_BACKUP_LOG } else { Join-Path $BackupDir "db-backup.log" }

function Ts { (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }

if ([string]::IsNullOrWhiteSpace($DbName)) {
  Add-Content $Log "[$(Ts)] ERROR: DB_NAME not set (checked env + $EnvFile)"; exit 1
}
if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null }

$Date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
$Out  = Join-Path $BackupDir "mysql-$Date.sql.gz"
$Tmp  = Join-Path $BackupDir "mysql-$Date.sql.tmp"
$ErrF = Join-Path $BackupDir "mysqldump-stderr.tmp"
Add-Content $Log "[$(Ts)] mysqldump '$DbName' @ ${DbHost}:$DbPort -> $Out"

# MYSQL_PWD keeps the password off the process command line.
$env:MYSQL_PWD = $DbPass
$args = @("-h", $DbHost, "-P", $DbPort, "-u", $DbUser,
          "--single-transaction", "--quick", "--routines", "--triggers", "--events",
          "--default-character-set=utf8mb4", $DbName)

# Start-Process -RedirectStandardOutput writes the raw stream (avoids PowerShell
# re-encoding the SQL text). Then gzip the temp .sql via .NET GzipStream.
$p = Start-Process -FilePath "mysqldump" -ArgumentList $args -NoNewWindow -Wait -PassThru `
       -RedirectStandardOutput $Tmp -RedirectStandardError $ErrF
$env:MYSQL_PWD = $null

try {
  if ($p.ExitCode -ne 0 -or -not (Test-Path $Tmp) -or (Get-Item $Tmp).Length -eq 0) {
    if (Test-Path $ErrF) { Add-Content $Log (Get-Content $ErrF -Raw) }
    Add-Content $Log "[$(Ts)] FAILED (mysqldump exit $($p.ExitCode))"
    throw "mysqldump failed"
  }
  $in  = [System.IO.File]::OpenRead($Tmp)
  $out = [System.IO.File]::Create($Out)
  $gz  = New-Object System.IO.Compression.GzipStream($out, [System.IO.Compression.CompressionMode]::Compress)
  $in.CopyTo($gz)
  $gz.Dispose(); $out.Dispose(); $in.Dispose()
  Add-Content $Log "[$(Ts)] OK ($([math]::Round((Get-Item $Out).Length/1KB,1)) KB)"
} catch {
  Remove-Item $Out -ErrorAction SilentlyContinue
  Remove-Item $Tmp, $ErrF -ErrorAction SilentlyContinue
  exit 1
}
Remove-Item $Tmp, $ErrF -ErrorAction SilentlyContinue
