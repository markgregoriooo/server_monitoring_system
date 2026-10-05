// PURE, import-free catalog of the Server Console's Quick Actions — the "shortcuts"
// half of the console. Each action is a FIXED command per OS family; the dashboard
// sends an action id, never command text, so a Quick Action can only ever run what is
// written in this file. The free-form half is the Web Terminal (services/sshConsole.js),
// which is admin-only for exactly that reason.
//
// Import-free so tests/consoleCommands.test.js runs with no MySQL/InfluxDB/.env.

// ─── OS family ────────────────────────────────────────────────────────────────
// server_specs.os holds the agent's `platform` ("Ubuntu 22.04", "Microsoft Windows
// Server 2019 Standard") or its gopsutil family ("linux"/"windows"), or "unknown".
// Anything that is not recognisably Windows is treated as Linux: every non-Windows
// agent build targets Linux, and a wrong guess only means a Quick Action prints a
// "command not found" — it cannot do anything the chosen OS's catalog doesn't list.
export function osFamily(os) {
  const s = String(os ?? "").toLowerCase();
  if (s.includes("windows")) return "windows";
  if (!s.trim() || s === "unknown") return null; // the caller decides (UI asks)
  return "linux";
}

// ─── Parameters ───────────────────────────────────────────────────────────────
// The only user-supplied value a Quick Action accepts is a SERVICE NAME, and it is
// spliced into a shell (Linux) or a PowerShell string (Windows). So it is validated
// against a strict allow-list rather than escaped: letters, digits, _ . @ - only,
// and it may not START with "-" (that would be read as an option by systemctl).
// systemd unit names ("nginx", "php8.1-fpm", "getty@tty1") and almost every Windows
// service name ("Spooler", "W3SVC") fit. "$" is deliberately excluded even though a
// few Windows names use it (MSSQL$SQLEXPRESS): inside a POSIX shell it is expansion,
// and one rule for both OSes is easier to trust. Use the Web Terminal for those.
const SERVICE_RE = /^[A-Za-z0-9_@][A-Za-z0-9_.@-]{0,127}$/;

export function isValidServiceName(name) {
  return typeof name === "string" && SERVICE_RE.test(name);
}

// ─── SSH address override ─────────────────────────────────────────────────────
// The console normally connects to the IP the agent reported. An admin can override it
// per server (server_console_settings) when SSH listens somewhere else — a VM whose
// default route is VirtualBox NAT (10.0.2.15, unreachable from outside), or a server
// with a separate management network. Accepted: an IPv4 address, an IPv6 address, or a
// DNS hostname. Nothing else — this value becomes the target of an SSH connection.
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RE = /^[0-9A-Fa-f:.]{2,45}$/;
const HOSTNAME_RE = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export function isValidSshHost(host) {
  if (typeof host !== "string") return false;
  const h = host.trim();
  if (IPV4_RE.test(h)) return true;
  if (h.includes(":")) return IPV6_RE.test(h) && (h.match(/::/g) ?? []).length <= 1;
  // A dotted string of digits that failed IPV4_RE (999.1.1.1) is a typo, not a hostname.
  if (/^[\d.]+$/.test(h)) return false;
  return HOSTNAME_RE.test(h);
}

// ─── Command builders ─────────────────────────────────────────────────────────

const AGENT_UNIT = "cspc-agent";                        // agent/installer/linux/install.sh
const AGENT_TASK = "CSPC-ICTU Monitoring Agent";         // agent/installer/windows/install.ps1
const REBOOT_MSG = "Reboot requested from the CSPC-ICTU monitoring dashboard";

// PowerShell wrapper. -EncodedCommand (base64 of UTF-16LE) sidesteps every layer of
// quoting between here and PowerShell: OpenSSH on Windows hands the command to cmd.exe
// by default, and cmd and PowerShell disagree about quotes. Progress output is
// silenced because it arrives as CLIXML noise over a non-interactive channel, and
// Out-String -Width keeps tables from being truncated to 80 columns.
//
// Errors: with stderr redirected, PowerShell writes its error stream as CLIXML
// (`#< CLIXML <Objs …>`), which is unreadable in the output panel. So the script runs
// inside `& { } 2>&1`, which turns every error into ordinary text on stdout, and the
// exit code is set by hand — 1 if any error was written or a terminating one thrown —
// because the trailing Out-String would otherwise always "succeed".
export function powershell(script) {
  const body =
    "$ProgressPreference='SilentlyContinue'\n" +
    "$ErrorActionPreference='Continue'\n" +
    "$script:failed = $false\n" +
    "try {\n" +
    "& {\n" +
    script +
    "\n} 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $script:failed = $true; \"ERROR: $($_.Exception.Message)\" } else { $_ } } | Out-String -Width 220\n" +
    "} catch { \"ERROR: $($_.Exception.Message)\"; exit 1 }\n" +
    "if ($script:failed) { exit 1 }";
  const b64 = Buffer.from(body, "utf16le").toString("base64");
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${b64}`;
}

const ft = "Format-Table -AutoSize | Out-String -Width 220";

// Each entry:
//   label / description   what the button says
//   group                 "info" (read-only) | "control" (changes the server)
//   param                 "service" when it needs a service name
//   sudo                  Linux: run through sudo (needs the login's password)
//   confirm               the dialog text shown before running — only on control actions
//   linux / windows       (param) => command string
export const ACTIONS = Object.freeze({
  overview: {
    label: "Overview",
    description: "Uptime, memory, disks",
    group: "info",
    linux: () =>
      "echo \"== $(hostname) ==\"; uname -sr; uptime; echo; free -h; echo; " +
      "df -hT -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null || df -h",
    windows: () =>
      powershell(
        "$os = Get-CimInstance Win32_OperatingSystem\n" +
          "\"== $env:COMPUTERNAME ==\"\n" +
          "$os.Caption\n" +
          "\"Last boot : $($os.LastBootUpTime)\"\n" +
          "\"Uptime    : $(((Get-Date) - $os.LastBootUpTime).ToString('d\\.hh\\:mm'))  (days.hh:mm)\"\n" +
          "\"Memory    : $([math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory)/1MB,2)) GB used of $([math]::Round($os.TotalVisibleMemorySize/1MB,2)) GB\"\n" +
          "''\n" +
          "Get-Volume | Where-Object DriveLetter | Select-Object DriveLetter, FileSystemLabel, FileSystem, " +
          "@{n='Size(GB)';e={[math]::Round($_.Size/1GB,1)}}, @{n='Free(GB)';e={[math]::Round($_.SizeRemaining/1GB,1)}} | " +
          ft,
      ),
  },
  top_processes: {
    label: "Top processes",
    description: "Highest CPU use",
    group: "info",
    linux: () => "ps -eo pid,user,%cpu,%mem,etime,comm --sort=-%cpu | head -n 16",
    windows: () =>
      powershell(
        "Get-Process | Sort-Object CPU -Descending | Select-Object -First 15 Id, ProcessName, " +
          "@{n='CPU(s)';e={[math]::Round($_.CPU,1)}}, @{n='Mem(MB)';e={[math]::Round($_.WorkingSet64/1MB,1)}} | " +
          ft,
      ),
  },
  disk: {
    label: "Disk usage",
    description: "Space per drive",
    group: "info",
    linux: () => "df -hT -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null || df -h",
    windows: () =>
      powershell(
        "Get-Volume | Where-Object DriveLetter | Select-Object DriveLetter, FileSystemLabel, FileSystem, HealthStatus, " +
          "@{n='Size(GB)';e={[math]::Round($_.Size/1GB,1)}}, @{n='Free(GB)';e={[math]::Round($_.SizeRemaining/1GB,1)}}, " +
          "@{n='Used%';e={if($_.Size){[math]::Round(100*($_.Size-$_.SizeRemaining)/$_.Size,1)}}} | " +
          ft,
      ),
  },
  network: {
    label: "Network",
    description: "IPs and open ports",
    group: "info",
    linux: () => "ip -brief address 2>/dev/null || ifconfig; echo; (ss -tuln 2>/dev/null || netstat -tuln) | head -n 40",
    windows: () =>
      powershell(
        "Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, IPAddress, PrefixLength | " + ft + "\n" +
          "Get-NetTCPConnection -State Listen | Sort-Object LocalPort -Unique | " +
          "Select-Object LocalAddress, LocalPort, @{n='Process';e={(Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName}} | " +
          ft,
      ),
  },
  failed_services: {
    label: "Failed services",
    description: "Should run, but stopped",
    group: "info",
    linux: () => "systemctl --failed --no-pager",
    windows: () =>
      powershell(
        "$s = Get-CimInstance Win32_Service -Filter \"StartMode='Auto' AND State<>'Running'\"\n" +
          "if ($s) { $s | Select-Object Name, DisplayName, State, ExitCode | " + ft + " } " +
          "else { 'All automatic services are running.' }",
      ),
  },
  running_services: {
    label: "Running services",
    description: "All active services",
    group: "info",
    linux: () => "systemctl list-units --type=service --state=running --no-pager --no-legend",
    windows: () =>
      powershell("Get-Service | Where-Object Status -eq 'Running' | Select-Object Name, DisplayName | " + ft),
  },
  recent_logs: {
    label: "Recent errors",
    description: "Last 50 log warnings",
    group: "info",
    linux: () =>
      "journalctl -p warning -n 50 --no-pager 2>/dev/null || tail -n 50 /var/log/syslog 2>/dev/null || tail -n 50 /var/log/messages",
    windows: () =>
      powershell(
        "Get-WinEvent -FilterHashtable @{LogName='System'; Level=1,2,3} -MaxEvents 50 -ErrorAction SilentlyContinue | " +
          "Select-Object TimeCreated, Id, LevelDisplayName, ProviderName, " +
          "@{n='Message';e={($_.Message -split \"`n\")[0]}} | Format-Table -AutoSize -Wrap | Out-String -Width 220",
      ),
  },
  agent_status: {
    label: "Agent status",
    description: "Is the agent running?",
    group: "info",
    linux: () => `systemctl status ${AGENT_UNIT} --no-pager -l | head -n 20`,
    windows: () =>
      powershell(
        `Get-ScheduledTask -TaskName '${AGENT_TASK}' | Select-Object TaskName, State | ${ft}\n` +
          `Get-ScheduledTaskInfo -TaskName '${AGENT_TASK}' | Select-Object LastRunTime, LastTaskResult | Format-List | Out-String`,
      ),
  },
  service_status: {
    label: "Service status",
    description: "Check one service",
    group: "info",
    param: "service",
    linux: (svc) => `systemctl status ${svc} --no-pager -l | head -n 40`,
    windows: (svc) =>
      powershell(`Get-Service -Name '${svc}' -ErrorAction Stop | Format-List Name, DisplayName, Status, StartType | Out-String`),
  },
  restart_service: {
    label: "Restart service",
    description: "Restart one service",
    group: "control",
    param: "service",
    sudo: true,
    confirm: "Restart this service? Anything using it will be interrupted for a moment.",
    linux: (svc) => `systemctl restart ${svc} && echo "Restarted." && systemctl is-active ${svc}`,
    windows: (svc) =>
      powershell(
        `Restart-Service -Name '${svc}' -Force -ErrorAction Stop\n` +
          `'Restarted.'\nGet-Service -Name '${svc}' | Format-List Name, Status | Out-String`,
      ),
  },
  restart_agent: {
    label: "Restart agent",
    description: "If it stopped reporting",
    group: "control",
    sudo: true,
    confirm: "Restart the monitoring agent? The server may show Offline for a few seconds.",
    linux: () => `systemctl restart ${AGENT_UNIT} && echo "Restarted." && systemctl is-active ${AGENT_UNIT}`,
    windows: () =>
      powershell(
        `Stop-ScheduledTask -TaskName '${AGENT_TASK}' -ErrorAction SilentlyContinue\n` +
          "Start-Sleep -Seconds 2\n" +
          `Start-ScheduledTask -TaskName '${AGENT_TASK}' -ErrorAction Stop\n` +
          `'Restarted.'\n(Get-ScheduledTask -TaskName '${AGENT_TASK}').State`,
      ),
  },
  reboot: {
    label: "Reboot",
    description: "Restarts in 1 minute",
    group: "control",
    sudo: true,
    confirm:
      "Reboot this server? It goes down in 1 minute and everything on it stops until it comes back. " +
      "Put it in Maintenance first if you do not want an Offline alert.",
    // A 1-minute delay rather than "now": the command returns cleanly so the result
    // reaches the dashboard (and the audit row is written), and an admin who clicked
    // the wrong server has a minute to run `shutdown -c` / `shutdown /a`.
    linux: () => `shutdown -r +1 "${REBOOT_MSG}" && echo "Reboot scheduled in 1 minute. Cancel with: sudo shutdown -c"`,
    windows: () =>
      `shutdown.exe /r /t 60 /c "${REBOOT_MSG}" && echo Reboot scheduled in 1 minute. Cancel with: shutdown /a`,
  },
});

/** The catalog as the dashboard sees it — no command text, just what to draw. */
export function listActions() {
  return Object.entries(ACTIONS).map(([id, a]) => ({
    id,
    label: a.label,
    description: a.description,
    group: a.group,
    param: a.param ?? null,
    confirm: a.confirm ?? null,
  }));
}

/** Who may run an action. Info actions: admin + it_staff. Control actions: admin. */
export function roleMayRun(role, actionId) {
  const a = ACTIONS[actionId];
  if (!a) return false;
  if (role === "admin") return true;
  return role === "it_staff" && a.group === "info";
}

/**
 * Resolve an action into the exact command to run.
 * Returns { command, sudo } or { error } — never throws.
 *   username  the SSH login; Linux sudo is skipped for root
 */
export function buildCommand(actionId, family, { param, username } = {}) {
  const a = ACTIONS[actionId];
  if (!a) return { error: "Unknown action." };
  if (family !== "linux" && family !== "windows") return { error: "Unknown server OS." };

  let arg;
  if (a.param === "service") {
    const svc = typeof param === "string" ? param.trim() : "";
    if (!isValidServiceName(svc)) {
      return { error: "Service name may only contain letters, digits, _ . @ - and must not start with -." };
    }
    arg = svc;
  }

  const command = a[family](arg);
  const sudo = family === "linux" && a.sudo === true && username !== "root";
  return { command: sudo ? sudoWrap(command) : command, sudo };
}

// `sudo -S` reads the password from stdin (written by sshConsole.runCommand), and
// `-p ''` suppresses the prompt so it does not land in the output. The command runs
// under `sh -c` so a `&&` chain is elevated as a whole, not just its first word.
// Single-quote escaping is the standard POSIX '\'' dance; the only user input in
// any command has already passed SERVICE_RE, which contains no quote.
export function sudoWrap(command) {
  return `sudo -S -p '' sh -c '${command.replace(/'/g, "'\\''")}'`;
}

export default { ACTIONS, osFamily, isValidServiceName, isValidSshHost, listActions, roleMayRun, buildCommand, sudoWrap, powershell };
