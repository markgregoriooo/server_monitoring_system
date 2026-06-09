<#
  Windows installer — installs the CSPC-ICTU monitoring agent to run at startup
  via a Scheduled Task (SYSTEM account, auto-restart). Run from an elevated
  PowerShell, with go-agent-windows-amd64.exe in the same folder.

  Usage:
    .\install.ps1 -ApiUrl "http://192.168.100.9:3000" -InstallKey "my-shared-install-key"

  A native Windows service requires an SCM-aware wrapper (e.g. NSSM). A Scheduled
  Task gives the same "runs unattended at boot, restarts on failure" behaviour
  without bundling one. Swap to NSSM here if your environment standardises on it.
#>
param(
  [Parameter(Mandatory = $true)][string]$ApiUrl,
  [Parameter(Mandatory = $true)][string]$InstallKey
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

# First run: register and block until an admin approves (writes agent.conf).
if (-not (Test-Path $ConfPath)) {
  Write-Host "Registering with backend; waiting for admin approval (Ctrl-C to abort)..."
  & $BinaryDst --register-only -api-url $ApiUrl -install-key $InstallKey -conf $ConfPath
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
