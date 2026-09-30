<#
  Windows installer — installs the CSPC-ICTU monitoring agent to run at startup
  via a Scheduled Task (SYSTEM account, auto-restart). Run from an elevated
  PowerShell, with cspc-agent-windows-amd64.exe in the same folder.

  Usage:
    .\install.ps1 -ApiUrl "https://monitoring.cspc-ictu.stream" -InstallKey "AIK-..."
    .\install.ps1 -ApiUrl "..." -InstallKey "AIK-..." -ReEnroll   # re-register an existing install

  Get the key from the dashboard: Server Metrics -> Agent install keys -> + New key.

  -ReEnroll discards the existing agent.conf and registers again. Needed when moving a
  machine onto a different install key (e.g. off the legacy .env key, or to another
  branch's key) — a plain re-run does NOT re-register, because agent.conf already exists.

  A native Windows service requires an SCM-aware wrapper (e.g. NSSM). A Scheduled
  Task gives the same "runs unattended at boot, restarts on failure" behaviour
  without bundling one. Swap to NSSM here if your environment standardises on it.
#>
param(
  [Parameter(Mandatory = $true)][string]$ApiUrl,
  [Parameter(Mandatory = $true)][string]$InstallKey,
  [switch]$ReEnroll
)
$ErrorActionPreference = "Stop"

$InstallDir = "C:\Program Files\CSPC Monitoring Agent"
$BinarySrc  = Join-Path $PSScriptRoot "cspc-agent-windows-amd64.exe"
$BinaryDst  = Join-Path $InstallDir "cspc-agent.exe"
$ConfPath   = Join-Path $InstallDir "agent.conf"
$TaskName   = "CSPC-ICTU Monitoring Agent"
$ShutdownTaskName = "CSPC-ICTU Monitoring Agent - Shutdown Notice"

# Paths used by installs before the 2026-08-18 rename (go-agent.exe, its own folder and
# task). Without the migration below an upgrade would leave the old task running too,
# and the server would post twice.
$OldInstallDir = "C:\Program Files\cspc-agent"
$OldTaskName   = "CSPC-ICTU-MonitoringAgent"

if (-not (Test-Path $BinarySrc)) {
  throw "Binary not found: $BinarySrc (build it with 'make windows')"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item $BinarySrc $BinaryDst -Force

# ── Migrate an install from before the rename ───────────────────────────────
# Move agent.conf first: it has this machine's approved token, so the enrollment,
# device id and history are kept.
$oldTask = Get-ScheduledTask -TaskName $OldTaskName -ErrorAction SilentlyContinue
$oldConf = Join-Path $OldInstallDir "agent.conf"
if ($oldTask -or (Test-Path $OldInstallDir)) {
  Write-Host "Found an older install ($OldInstallDir) - migrating it."
  if ($oldTask) {
    Stop-ScheduledTask -TaskName $OldTaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $OldTaskName -Confirm:$false
  }
  # The old binary has its own name, so stop it by that one, not by the new one.
  Get-Process -Name "go-agent" -ErrorAction SilentlyContinue | Stop-Process -Force
  if ((Test-Path $oldConf) -and -not (Test-Path $ConfPath)) {
    Copy-Item $oldConf $ConfPath -Force
    Write-Host "Carried the existing enrolment across (agent.conf)."
  }
  Remove-Item $OldInstallDir -Recurse -Force -ErrorAction SilentlyContinue
}

# -ReEnroll: drop the existing enrollment so the key below is actually presented.
if ($ReEnroll -and (Test-Path $ConfPath)) {
  Write-Host "-ReEnroll: removing $ConfPath to register again."
  Remove-Item $ConfPath -Force
}

# First run: register and block until an admin approves (writes agent.conf).
if (-not (Test-Path $ConfPath)) {
  Write-Host "Registering with backend; waiting for admin approval (Ctrl-C to abort)..."
  & $BinaryDst --register-only -api-url $ApiUrl -install-key $InstallKey -conf $ConfPath
}
else {
  # Warn clearly: the key is ignored here, and the operator may think it was applied.
  Write-Host "NOTE: agent.conf already exists - this machine is ALREADY ENROLLED."
  Write-Host "NOTE: the install key you supplied was NOT used. The enrolment is unchanged, so this"
  Write-Host "      server stays attributed to whatever key first enrolled it (possibly this one)."
  # An approved machine keeps its approval and AGT- token through a re-enroll; it is only
  # moved to the new key. One whose key was revoked comes back as pending and needs
  # approving again.
  Write-Host "      Only if you meant to MOVE it onto a different key, re-run with -ReEnroll."
}

$action    = New-ScheduledTaskAction -Execute $BinaryDst -Argument "-conf `"$ConfPath`""
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
# -AllowStartIfOnBatteries / -DontStopIfGoingOnBatteries: a server on a UPS counts as
# "on battery" during an outage, and the defaults would stop the agent then.
# -ExecutionTimeLimit 0: the agent runs indefinitely.
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable `
              -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
              -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null

# ── Shutdown notice ───────────────────────────────────────────────────────────
# Windows does not reliably tell a scheduled-task process that the machine is shutting
# down. This second task runs on System Event 1074 (logged when a shutdown or restart
# starts, while the network is still up) and sends `--notify-shutdown`, so the alert is
# raised right away. A power cut logs nothing; the heartbeat covers that.
$class   = Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace Root/Microsoft/Windows/TaskScheduler
$onShutdown = $class | New-CimInstance -ClientOnly
$onShutdown.Enabled = $true
$onShutdown.Subscription = @"
<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name='User32'] and EventID=1074]]</Select></Query></QueryList>
"@
$notifyAction   = New-ScheduledTaskAction -Execute $BinaryDst -Argument "--notify-shutdown -reason shutdown -conf `"$ConfPath`""
$notifySettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                    -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $ShutdownTaskName -Action $notifyAction -Trigger $onShutdown `
  -Principal $principal -Settings $notifySettings -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed. Manage with: Get-ScheduledTask -TaskName $TaskName"
Write-Host "Shutdown notice task: $ShutdownTaskName"
