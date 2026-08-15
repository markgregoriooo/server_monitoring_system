<#
  Windows installer — installs the CSPC-ICTU monitoring agent to run at startup
  via a Scheduled Task (SYSTEM account, auto-restart). Run from an elevated
  PowerShell, with go-agent-windows-amd64.exe in the same folder.

  Usage:
    .\install.ps1 -ApiUrl "http://192.168.100.9:3000" -InstallKey "AIK-..."
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

$InstallDir = "C:\Program Files\cspc-agent"
$BinarySrc  = Join-Path $PSScriptRoot "go-agent-windows-amd64.exe"
$BinaryDst  = Join-Path $InstallDir "go-agent.exe"
$ConfPath   = Join-Path $InstallDir "agent.conf"
$TaskName   = "CSPC-ICTU-MonitoringAgent"

if (-not (Test-Path $BinarySrc)) {
  throw "Binary not found: $BinarySrc (build it with 'make windows')"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item $BinarySrc $BinaryDst -Force

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
  # Say so LOUDLY. -InstallKey is a mandatory parameter, so silently ignoring it reads as
  # "the key was applied" — which is how a machine ends up still attributed to an old key
  # (or to none at all) while the operator believes they moved it onto the new one.
  Write-Warning "agent.conf already exists - this machine is ALREADY ENROLLED."
  Write-Warning "The -InstallKey you passed was NOT used and this server is NOT attributed to it."
  # A machine that is still approved keeps its approval and its AGT- token through a
  # re-enroll — it is only re-filed under the new key. One whose key was revoked comes
  # back as pending and does need approving again.
  Write-Warning "To move it onto that key, re-run with -ReEnroll."
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
