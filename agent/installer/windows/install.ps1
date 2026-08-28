<#
  Windows installer — installs the CSPC-ICTU monitoring agent to run at startup
  via a Scheduled Task (SYSTEM account, auto-restart). Run from an elevated
  PowerShell, with cspc-agent-windows-amd64.exe in the same folder.

  Usage:
    $env:CSPC_INSTALL_KEY = 'AIK-...'
    .\install.ps1 -ApiUrl "http://<backend-server-ip>:3000"
    .\install.ps1 -ApiUrl "..." -ReEnroll                        # re-register an existing install

    .\install.ps1 -ApiUrl "..." -InstallKey "AIK-..."            # still works, discouraged

  PREFER $env:CSPC_INSTALL_KEY. A key passed as a PARAMETER is visible in the process
  list (Get-CimInstance Win32_Process | Select CommandLine) to anyone who can query it
  while enrollment runs, is written to PSReadLine's history file — which persists on
  disk across reboots, under $env:APPDATA\Microsoft\Windows\PowerShell\PSReadLine — and
  is recorded in Windows Security event 4688 where command-line auditing is enabled.
  An environment variable is scoped to this PowerShell session and the child it starts.
  Clear it afterwards with:  Remove-Item Env:\CSPC_INSTALL_KEY

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
  # No longer Mandatory: keeping it so would force the discouraged form on everyone, and
  # would re-prompt for it interactively even when the environment variable is set.
  [string]$InstallKey,
  [switch]$ReEnroll
)
$ErrorActionPreference = "Stop"

# The environment wins over the parameter, matching the agent binary's own precedence,
# so a stale -InstallKey in an old runbook cannot override a deliberately-set variable.
$Key = $env:CSPC_INSTALL_KEY
if ([string]::IsNullOrWhiteSpace($Key)) {
  $Key = $InstallKey
  if (-not [string]::IsNullOrWhiteSpace($Key)) {
    Write-Host "NOTE: the install key was passed as a parameter, so it is visible in the process"
    Write-Host "NOTE: list and in PowerShell history. For future installs use:"
    Write-Host "NOTE:   `$env:CSPC_INSTALL_KEY = 'AIK-...'  then  .\install.ps1 -ApiUrl `"$ApiUrl`""
  }
}
if ([string]::IsNullOrWhiteSpace($Key)) {
  Write-Error ("An install key is required. Set `$env:CSPC_INSTALL_KEY = 'AIK-...' (preferred), " +
    "or pass -InstallKey. Get one from the dashboard: Server Metrics -> Agent install keys.")
  exit 1
}

$InstallDir = "C:\Program Files\CSPC Monitoring Agent"
$BinarySrc  = Join-Path $PSScriptRoot "cspc-agent-windows-amd64.exe"
$BinaryDst  = Join-Path $InstallDir "cspc-agent.exe"
$ConfPath   = Join-Path $InstallDir "agent.conf"
$TaskName   = "CSPC-ICTU Monitoring Agent"

# Where installs made before the 2026-08-18 rename put things. The agent shipped as
# go-agent.exe under a folder and task of its own, and this installer keys off those
# paths — so without the migration below an upgrade would leave the OLD task running
# alongside the new one, and the host would post twice every interval.
$OldInstallDir = "C:\Program Files\cspc-agent"
$OldTaskName   = "CSPC-ICTU-MonitoringAgent"

if (-not (Test-Path $BinarySrc)) {
  throw "Binary not found: $BinarySrc (build it with 'make windows')"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item $BinarySrc $BinaryDst -Force

# ── Migrate an install that predates the rename ───────────────────────────────
# agent.conf is carried across FIRST: it holds this machine's approved token, so moving
# it keeps the enrolment, the device id and the history. (Losing it is survivable — the
# agent re-registers onto the same device and picks its token back up without another
# approval — but it would read as a re-enrolment for no reason.)
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
  # Handed over in the ENVIRONMENT, not as an argument — the point of the change: even
  # when the operator used -InstallKey, the key stops being visible in the process list
  # from here on. The agent unsets it as soon as it has read it. Restored afterwards so
  # the installer does not leave a credential sitting in the caller's session that the
  # caller did not put there.
  $prevKey = $env:CSPC_INSTALL_KEY
  $env:CSPC_INSTALL_KEY = $Key
  try {
    & $BinaryDst --register-only -api-url $ApiUrl -conf $ConfPath
  } finally {
    $env:CSPC_INSTALL_KEY = $prevKey
  }
}
else {
  # Say so LOUDLY. An install key was supplied, so silently ignoring it reads as
  # "the key was applied" — which is how a machine ends up still attributed to an old key
  # (or to none at all) while the operator believes they moved it onto the new one.
  Write-Host "NOTE: agent.conf already exists - this machine is ALREADY ENROLLED."
  Write-Host "NOTE: the install key you supplied was NOT used. The enrolment is unchanged, so this"
  Write-Host "      server stays attributed to whatever key first enrolled it (possibly this one)."
  # A machine that is still approved keeps its approval and its AGT- token through a
  # re-enroll — it is only re-filed under the new key. One whose key was revoked comes
  # back as pending and does need approving again.
  Write-Host "      Only if you meant to MOVE it onto a different key, re-run with -ReEnroll."
}

$action    = New-ScheduledTaskAction -Execute $BinaryDst -Argument "-conf `"$ConfPath`""
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
# -AllowStartIfOnBatteries / -DontStopIfGoingOnBatteries: a server on a UPS counts as
# "on battery" during an outage, so the defaults would kill the agent exactly then (and
# block startup on any battery-powered host). -ExecutionTimeLimit 0: the agent runs forever.
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable `
              -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
              -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed. Manage with: Get-ScheduledTask -TaskName $TaskName"
