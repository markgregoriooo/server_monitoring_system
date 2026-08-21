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
#
# Mirrors what dotenv does on the backend side, so a value read here is the value the
# backend is using: an inline `# comment` is not part of it, surrounding quotes are not
# either, and trailing spaces are trimmed. The .env template ships lines written as
#   BACKUP_DIR=D:/backups            # Windows drive letter
# and without the strip the path came back with the comment glued to it.
function Get-EnvVal($key, $default) {
  if (Test-Path $EnvFile) {
    $m = Select-String -Path $EnvFile -Pattern "^\s*$key=" | Select-Object -First 1
    if ($m) {
      $v = $m.Line -replace "^\s*$key=", ""
      $v = $v -replace '\s+#.*$', ''
      $v = $v.Trim()
      if ($v -match '^"(.*)"$') { $v = $Matches[1] }
      elseif ($v -match "^'(.*)'$") { $v = $Matches[1] }
      if ($v -ne "") { return $v }
    }
  }
  return $default
}

$DbHost = if ($env:DB_HOST)     { $env:DB_HOST }     else { Get-EnvVal "DB_HOST" "localhost" }
$DbPort = if ($env:DB_PORT)     { $env:DB_PORT }     else { Get-EnvVal "DB_PORT" "3306" }
$DbUser = if ($env:DB_USER)     { $env:DB_USER }     else { Get-EnvVal "DB_USER" "root" }
$DbName = if ($env:DB_NAME)     { $env:DB_NAME }     else { Get-EnvVal "DB_NAME" "" }
$DbPass = if ($env:DB_PASSWORD) { $env:DB_PASSWORD } else { Get-EnvVal "DB_PASSWORD" "" }
# BACKUP_DIR comes from backend/.env unless the caller overrides it, so the scheduled
# task does not have to repeat a path that is already configured once. The Task Scheduler
# command in README.md passes no environment, so without this the dump landed in the
# built-in default while the backend wrote its NDJSON somewhere else — two backup
# folders, one of them the wrong one, and nothing to say so.
$BackupDir = if ($env:BACKUP_DIR) { $env:BACKUP_DIR } else { Get-EnvVal "BACKUP_DIR" "E:\backups" }
$Log = if ($env:DB_BACKUP_LOG) { $env:DB_BACKUP_LOG } else { Join-Path $BackupDir "db-backup.log" }

# Which mysqldump to run. A bare name resolves on PATH, which is right on a server with
# MySQL client tools installed. XAMPP does NOT put its bin folder on PATH, and a
# scheduled task does not inherit an interactive shell's PATH either — so point this at
# the binary instead of editing the system PATH. In backend/.env:
#   MYSQLDUMP=C:/xampp/mysql/bin/mysqldump.exe
$MysqlDump = if ($env:MYSQLDUMP) { $env:MYSQLDUMP } else { Get-EnvVal "MYSQLDUMP" "mysqldump" }

function Ts { (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }

if ([string]::IsNullOrWhiteSpace($DbName)) {
  Add-Content $Log "[$(Ts)] ERROR: DB_NAME not set (checked env + $EnvFile)"; exit 1
}
# Checked up front so a missing binary reads as a setup problem rather than as a dump
# that failed for some database reason. Start-Process would otherwise throw a .NET
# "cannot find the file specified" that says nothing about PATH.
if (-not (Get-Command $MysqlDump -ErrorAction SilentlyContinue)) {
  Add-Content $Log ("[$(Ts)] ERROR: mysqldump not found ('$MysqlDump'). Put MySQL's bin " +
    "folder on PATH, or set MYSQLDUMP to the full path (XAMPP: C:/xampp/mysql/bin/mysqldump.exe).")
  exit 1
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
$p = Start-Process -FilePath $MysqlDump -ArgumentList $args -NoNewWindow -Wait -PassThru `
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
