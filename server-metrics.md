# Server Metrics — Go Monitoring Agent

Guide to the server-metrics feature: a cross-platform **Go agent** runs on each
monitored server, collects system metrics, and POSTs them to the Node.js backend,
which stores them in InfluxDB + MySQL and pushes live updates to the dashboard.

> Scope: this document covers the Go agent, its enrollment/approval flow, the
> backend ingestion path, and the Server Metrics page. For the sensor/aircon
> pipeline see `Environment.md`; for users/auth see `CLAUDE.md`.

---

## 1. Architecture

```
   ┌───────────────────────┐        POST /api/servers/metrics
   │  Go agent (per server)│        Authorization: Bearer <AGT-…>
   │  gopsutil collection  │ ──────────────────────────────────────┐
   │  10s interval         │                                        │
   └───────────────────────┘                                        ▼
                                          ┌──────────────────────────────────────┐
                                          │  Express backend (backend/src)        │
                                          │  agentAuth → serverMetricsHandler      │
                                          │   • validate payload                   │
                                          │   • write InfluxDB (server_metrics)    │
                                          │   • MySQL heartbeat (status/last_seen) │
                                          │   • io.emit("serverMetrics")           │
                                          └───────────────┬───────────────────────┘
                                                          │
                              InfluxDB (time-series)  ◀───┤───▶  MySQL (devices, server_specs,
                              measurement: server_metrics  │       device_network, agent_tokens)
                                                          │
                                                          ▼
                                          React dashboard — Server Metrics page
                                          (socket "serverMetrics" → live gauges/table)
```

The agent speaks **only HTTP** to the backend. It never connects to InfluxDB or
Socket.IO directly (Socket.IO is browser↔Node only).

---

## 2. Quick start — how to run & test it

This is the practical "I just want to see it work" guide. Do the **backend prep**
once, then either test on the **same PC** (§2.2) or on **another server** (§2.3).

### 2.1 Backend prep (do this once, on the PC running the backend)

1. **MySQL and InfluxDB must be running** (the backend needs both).
2. **Add the shared install key** to `backend/.env` (any long random string — you
   invent it; it's the secret every agent presents at enrollment):
   ```
   AGENT_INSTALL_KEY=REDACTED-REVOKED-INSTALL-KEY
   ```
3. **Restart the backend** — `.env` is only read at startup, and nodemon does NOT
   restart on `.env` changes:
   ```powershell
   cd "C:\Users\Mark Angelo\Documents\server-infrastructure-monitoring-system-webSystem\backend"
   nodemon src/server.js          # listens on 0.0.0.0:3000
   ```
4. **Start the frontend and log in as an admin** (the approval panel is admin-only):
   ```powershell
   cd "C:\Users\Mark Angelo\Documents\server-infrastructure-monitoring-system-webSystem\frontend"
   npm run dev
   ```

### 2.2 Test on the SAME PC as the backend (simplest first test)

The agent monitors this PC and talks to `localhost`.

```powershell
cd "C:\Users\Mark Angelo\Documents\server-infrastructure-monitoring-system-webSystem\go-agent"

# 1) build a native binary
go build -o dist/go-agent.exe ./cmd/agent

# 2) enroll + run (prints "waiting for admin approval..." and polls every 10s)
.\dist\go-agent.exe --register -api-url http://localhost:3000 -install-key "REDACTED-REVOKED-INSTALL-KEY" -conf agent.conf

# 3) APPROVE in the browser: Server Metrics page → refresh → "Pending agent approvals" → Approve
```

That's it — **no second command**. After you approve, the *same* `--register`
process writes `agent.conf` and immediately starts the metric loop: you'll see
`metrics sent (cpu=… mem=… disk=…)` every 10s, and this PC appears and updates
**live** on the Server Metrics page. (To run it again later once enrolled, just
`.\dist\go-agent.exe -conf agent.conf`.)

### 2.3 Test on ANOTHER server

The target machine needs **only the binary** — no Go, no source. The only real
differences from §2.2: use the backend PC's **LAN IP** (not `localhost`), and open
the firewall.

**A. Make the backend reachable** (on the backend PC):
- Find its IPv4: `ipconfig` → e.g. `192.168.100.9`.
- Allow inbound port 3000 (elevated PowerShell, once):
  ```powershell
  New-NetFirewallRule -DisplayName "CSPC Backend 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
  ```
- Make sure both machines are on the **same network/WiFi**.
- **Reachability test from the OTHER machine:** open `http://192.168.100.9:3000` in
  its browser. Seeing `{"error":"Route not found"}` means it's reachable. ✅

**B. Copy the agent folder from the USB to the target machine.** The USB has two
ready-made folders (each contains the binary, its installer, and a `RUN-ME.txt`) — copy
the one matching the target's OS:

| Target machine | USB folder | Binary inside |
|---|---|---|
| Windows server | `cspc-ictu-agent-windows\` | `go-agent-windows-amd64.exe` |
| Linux server (Intel/AMD) | `cspc-ictu-agent-linux/` | `go-agent-linux-amd64` |
| Raspberry Pi / ARM | `cspc-ictu-agent-linux/` | `go-agent-linux-arm64` |

The target needs **only this folder** — no Go, no source. (`RUN-ME.txt` inside repeats
these steps in plain language.)

**C. On the target, open a terminal in that folder and register** — using the backend's
**IP, NOT localhost:**
```powershell
# Windows target (inside cspc-ictu-agent-windows)
.\go-agent-windows-amd64.exe --register -api-url http://192.168.100.9:3000 -install-key "REDACTED-REVOKED-INSTALL-KEY" -conf agent.conf
```
```bash
# Linux target (inside cspc-ictu-agent-linux) — use -arm64 on a Pi
chmod +x go-agent-linux-amd64
./go-agent-linux-amd64 --register -api-url http://192.168.100.9:3000 -install-key "REDACTED-REVOKED-INSTALL-KEY" -conf agent.conf
```

**D. Approve** it in the dashboard (admin → Server Metrics → refresh → Approve). The
`--register` command keeps running and **starts sending metrics automatically** right after
approval — the target shows up live on the Server Metrics page. (To run it again later once
enrolled: `.\go-agent-windows-amd64.exe -conf agent.conf`. For boot-start, see §2.4.)

### 2.4 Install as a background service (auto-start at boot)

Do this only after the manual run works. Use the USB folder for the target OS (it already
has the binary **and** the installer together).

**Windows — must run from an _elevated_ PowerShell** (right-click → "Run as administrator").
Writing to `Program Files` + creating a SYSTEM task needs admin, or you get
`Access … is denied`:
```powershell
cd "<...>\cspc-ictu-agent-windows"
Set-ExecutionPolicy -Scope Process Bypass        # only if the .ps1 is blocked
.\install.ps1 -ApiUrl "http://192.168.100.9:3000" -InstallKey "REDACTED-REVOKED-INSTALL-KEY"
```

> On the **same PC as the backend**, use `-ApiUrl "http://localhost:3000"`.
.\install.ps1 -ApiUrl "http://localhost:3000" -InstallKey "REDACTED-REVOKED-INSTALL-KEY"

**Linux — systemd** (binary + `install.sh` in the same folder):
```bash
sudo bash install.sh http://192.168.100.9:3000 REDACTED-REVOKED-INSTALL-KEY
```

The installer enrolls first (`--register-only`) and **pauses at "waiting for admin
approval"** → Approve it in the dashboard → it then creates and starts the service. After
that the agent:
- runs in the **background** (Windows: Scheduled Task as SYSTEM; Linux: systemd service),
  **survives closing the terminal**, and **auto-starts at boot** — no need to stay logged in;
- has **no visible window/logs** — confirm it's reporting on the **dashboard**.

```powershell
# Windows — check / uninstall
Get-ScheduledTask -TaskName "CSPC-ICTU-MonitoringAgent"          # State: Running
Unregister-ScheduledTask -TaskName "CSPC-ICTU-MonitoringAgent" -Confirm:$false
```
```bash
# Linux — check / uninstall
systemctl status cspc-agent
sudo systemctl disable --now cspc-agent
```

> Dev note: the agent auto-starts at boot, but your **backend** is started by hand
> (`nodemon`), so after a reboot the agent just retries until the backend is up. And don't
> leave a **manual** agent running alongside the service — they'd double-post the same machine.

> **Servers on UPS / battery power.** `install.ps1` registers the task with
> `-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0`. Without these,
> Windows' default Scheduled-Task settings **won't start the task while on battery** and
> **kill it the moment the machine switches to battery** — so a server on a UPS stops
> reporting during a power outage (exactly when you want eyes on it), and a battery-powered
> host that boots unplugged never starts the agent at all. If you installed with an **older**
> `install.ps1`, fix the existing task in an **elevated** PowerShell (no reinstall needed):
> ```powershell
> $s = New-ScheduledTaskSettingsSet -StartWhenAvailable `
>        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
>        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
>        -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
> Set-ScheduledTask  -TaskName "CSPC-ICTU-MonitoringAgent" -Settings $s
> Start-ScheduledTask -TaskName "CSPC-ICTU-MonitoringAgent"
> ```
> Verify with `(Get-ScheduledTask -TaskName "CSPC-ICTU-MonitoringAgent").Settings | Select-Object DisallowStartIfOnBatteries, StopIfGoingOnBatteries` — both should be `False`. (Or just re-run the patched `install.ps1`; `-Force` overwrites the task and skips re-enrollment since `agent.conf` already exists.)

### 2.5 Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Invalid install key` on register | `-install-key` ≠ `AGENT_INSTALL_KEY` in `.env`, or backend wasn't restarted after editing `.env` |
| Agent logs `send attempt 1/3 failed` / connection refused | Backend not running, wrong `-api-url`, or firewall blocking 3000 |
| `http://192.168.100.9:3000` won't load from the other machine | Firewall (step A), different network, or the backend PC's IP changed |
| Server never appears on the page | You didn't **Approve** it (the agent sits waiting for approval until you do) |
| Worked, then all agents went silent | Backend PC's IP changed (DHCP). Give it a **static IP / DHCP reservation**; agents cache `-api-url` in `agent.conf` |
| Pending panel not visible | You're logged in as `it_staff`, not `admin` (the endpoint is admin-only) |

> `localhost` only works when the agent runs on the **same** PC as the backend. On any
> other machine you must use the backend's LAN IP.

### 2.6 Remove / stop monitoring a server

**Pause temporarily** — just stop the agent on that machine; the server stays in the
list so you can resume later:
```powershell
# Windows (scheduled-task install)
Unregister-ScheduledTask -TaskName "CSPC-ICTU-MonitoringAgent" -Confirm:$false
```
```bash
# Linux (systemd)
sudo systemctl disable --now cspc-agent
```
(If you were running it by hand, Ctrl-C is enough.)

**Remove permanently** — on the **Server Metrics** page (as an **admin**), click the red
**Remove** button on the server's row. This calls `DELETE /api/servers/:id`, which:
- deletes the `devices` row — `server_specs` / `device_network` / `agent_tokens` cascade
  away, which **revokes the agent token** (a still-running agent then gets 403);
- clears the in-memory metric cache and emits `serverRemoved` so the dashboard drops it live.

**The agent cleans up after itself when removed.** Once its token is revoked, its very next
POST returns `403`; the agent logs that it was removed, **deletes its own
`agent.conf`, and exits** — so a manually-run agent stops on its own and leaves no stale
config behind. A transient backend **outage** is a network error, not a 403, so it won't
trip this. An agent still **waiting for approval** that gets rejected likewise exits
("rejected or removed").

> **To monitor a removed machine again:** just run `--register …` again on it → it enrolls
> fresh → shows up in *Pending* → Approve. No files to touch (the old `agent.conf` was
> already deleted).
>
> **Service installs** run with restart-on-failure, so a clean "removed" exit stays
> stopped. To fully decommission, uninstall the agent on that machine. InfluxDB history
> for the removed server is left intact.

### 2.7 Going to production (beyond localhost + LAN)

In development everything is on one LAN and the backend is reached at `localhost` (same PC)
or `192.168.100.9:3000` (other machines). For a real deployment the **enrollment/approval
flow is identical** — only **where the backend lives** and **how it's secured** change:

| Concern | Dev (now) | Production |
|---|---|---|
| Backend address | `localhost` / LAN IP `192.168.100.9` | a **stable** address: static IP / **DHCP reservation**, a **hostname/DNS name**, or for cross-site a **VPN/overlay** (Tailscale, ZeroTier) or public host (DDNS + port-forward) |
| Transport | `http://` | **`https://`** behind a TLS reverse proxy (Nginx/Caddy). The agent sends a bearer token, so don't expose plain HTTP beyond a trusted LAN |
| Agent `-api-url` | `http://192.168.100.9:3000` | the production URL, e.g. `https://monitor.cspc.edu.ph` (passed at `--register` / install time; stored in `agent.conf`) |
| Dashboard endpoints | hardcoded `192.168.100.9:3000` in `frontend/src/api/client.ts` + `frontend/src/socket/socket.ts` | point both at the production URL, then `npm run build` |
| CORS | `WEB_ORIGIN` defaults to localhost/LAN | set `WEB_ORIGIN` in `.env` to the production dashboard origin(s) |
| Install key | a fixed dev value | a strong, secret `AGENT_INSTALL_KEY`; keep out of git; rotate if leaked (already-approved agents keep working) |
| Firewall | open 3000 on the LAN | expose only 443 (the proxy) to where agents/dashboards live |
| Agents | run by hand for testing | install as a **service** (§2.4) so they auto-start at boot |

> **Pick a stable backend address up front.** Agents cache it in `agent.conf`, so if it
> later changes, every agent must be re-pointed (edit `agent.conf`'s `API_URL` + restart,
> or re-register). A hostname or reserved/static IP is far better than a raw DHCP IP. See
> also §9 "Move to a new network" and §10.

---

## 3. The Go agent (`go-agent/`)

Standalone Go program — **not** inside the Node project. Built to `.exe`/Linux
binaries and installed on each monitored server.

```
cmd/agent/main.go                  entry point — normal loop + --register mode
internal/config/config.go          load/write agent.conf (godotenv)
internal/logger/logger.go          tiny stdout/stderr logger
internal/collector/metrics.go      ServerMetrics + HostInfo JSON contracts
internal/collector/collector.go    gopsutil collection (cross-platform)
internal/sender/sender.go          HTTP POST with retry + exponential backoff
internal/registration/register.go  register → poll → write agent.conf
installer/install.sh               Linux systemd installer
installer/install.ps1              Windows scheduled-task installer
Makefile                           cross-compile targets
```

Conventions:
- Go 1.22, module path `cspc-ictu/go-agent`.
- Dependencies: `gopsutil/v3` (metrics) + `godotenv` (read agent.conf) only.
- CPU sampling uses a **500 ms blocking interval** for accuracy — keep it.
- The agent **never exits on a backend outage**: the sender retries 3× with
  exponential backoff (1s → 2s → 4s), logs, and continues to the next interval.
- Cross-platform: disk root is `/` on Linux, `C:\` on Windows.
- Two modes:
  - `--register -api-url URL -install-key KEY` — enroll, wait for approval, then run the loop (one command).
  - `--register-only -api-url URL -install-key KEY` — enroll and exit (used by the installers).
  - `-conf agent.conf` — already enrolled: just run the loop (default interval 10s).

`agent.conf` (written after approval, holds the device token) is **gitignored** —
never commit it.

---

## 4. Data contract: `server_metrics`

InfluxDB measurement **`server_metrics`**, written via the shared `writeClient`
(bucket from `INFLUX_BUCKET`, ms precision — same client as `sensor_environment`).

- **Tags:** `device_id`, `device_name`, `location`, `os`
- **Fields** (float unless noted): `cpu_percent`, `mem_used_mb`, `mem_total_mb`,
  `mem_percent`, `disk_used_gb`, `disk_total_gb`, `disk_percent`,
  `net_bytes_sent`, `net_bytes_recv`, `uptime_seconds`,
  `process_count` (**integer**)
- **Timestamp:** server-side `new Date()` (the agent's clock is ignored), matching
  `sensorHandler`.

The agent POSTs these as snake_case JSON (`metrics.go`). The handler validates
every field, writes the point, then emits **camelCase** to the dashboard
(`cpuPercent`, `memPercent`, …) plus a derived `uptimeLabel`.

> If you add/remove a metric you MUST update all of: `metrics.go` (struct + json
> tags), `collector.go` (collection), `serverMetricsHandler.js` (validation +
> point + emit), and the frontend `Server` mapping in `ServerMetrics.tsx`.

---

## 5. Enrollment & auth model

Single shared install key in the backend `.env` as **`AGENT_INSTALL_KEY`**
(no `install_keys` table). Per-device tokens live in `agent_tokens`.

1. **Register** — agent POSTs `/api/agents/register` with the install key + host
   info. Backend creates, in one transaction:
   - `devices` row (`device_type='server'`, `status='pending'`)
   - `server_specs` row (os, kernel, cores, arch, mem/disk totals, agent_version)
   - `device_network` row (mac_address, derived /24 segment)
   - `agent_tokens` row (`status='pending'`, random `token`)

   Returns `{ pending_token, device_id }`. **Idempotent per NIC**: a host that
   re-registers with the same MAC reuses its existing enrollment (an agent restart
   before approval won't spawn duplicate pending devices).
2. **Poll** — agent GETs `/api/agents/status?pending_token=…` every 10s.
3. **Approve** — an admin approves in the dashboard → `POST /api/agents/:id/approve`
   → backend generates a permanent `approved_token` (`AGT-…`), sets
   `agent_tokens.status='approved'` + `devices.status='online'`, and emits
   `agentApproved` to browsers. (Reject: `POST /api/agents/:id/reject`.)
4. **Run** — agent writes `agent.conf` and POSTs every interval with
   `Authorization: Bearer <approved_token>`. `agentAuthMiddleware` validates the
   token against `agent_tokens.approved_token WHERE status='approved'`, attaches
   `req.device`, and best-effort bumps `last_used_at`.

### API endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/agents/register` | install key | First-run enrollment |
| `GET /api/agents/status?pending_token=` | pending token | Agent polls for approval |
| `GET /api/agents/pending` | JWT, `admin` | List servers awaiting approval |
| `POST /api/agents/:id/approve` | JWT, `admin` | Approve → issue `AGT-…` token |
| `POST /api/agents/:id/reject` | JWT, `admin` | Reject a pending agent |
| `POST /api/servers/metrics` | agent Bearer token | Metric ingestion |
| `GET /api/servers` | JWT | Dashboard server list |
| `GET /api/servers/:id` | JWT | Single server detail |
| `GET /api/servers/:id/history?range=` | JWT | Real metric history (InfluxDB) — `-1h` / `-6h` / `-24h` |
| `GET /api/servers/:id/logs` | JWT | Device event log (MySQL `device_logs`) |
| `DELETE /api/servers/:id` | JWT, `admin` | Remove/decommission a server (revokes its token) |

---

## 6. Socket events

| Event | Direction | When |
|---|---|---|
| `serverMetrics` | server → browsers | On each metric POST: `{ server: { id, name, ip, os, location, status, cpuPercent, memPercent, memUsedMB, memTotalMB, diskPercent, diskUsedGB, diskTotalGB, netBytesSent, netBytesRecv, uptimeSeconds, uptimeLabel, processCount, timestamp } }` |
| `agentApproved` | server → browsers | On admin approval: `{ id, name }` — page refreshes its lists |
| `serverRemoved` | server → browsers | On admin delete: `{ id }` — drops the server from the dashboard/list |
| `agentPending` | server → browsers | On register/reject: `{ id }` — admins re-fetch the pending list live |
| `serverStatus` | server → browsers | On the 15s offline sweep flipping a stale server: `{ id, status: "Offline" }` — dashboard sets it Offline + zeroes its live metrics |
| `deviceLog` | server → browsers | On a new `device_logs` entry: `{ device_id, log_level, message, recorded_at }` |

The dashboard merges each `serverMetrics` event onto the matching server by `id`
(static fields like kernel/cores/network come from the initial `GET /api/servers`).

**Device events** — lifecycle (registered, approved) and CPU/Mem/Disk **threshold crossings**
(warning ≥ 80%, critical ≥ 90%, with a 70–80% hysteresis band so it can't spam) are written
to `device_logs` and shown in the Server Detail **"Recent events"** panel
(`GET /api/servers/:id/logs` + the live `deviceLog` event). Recoveries are intentionally
**not** logged, which keeps the table lean (no retention job needed).

---

## 7. MySQL tables

All already present in the V9 schema — **no migration needed**.

| Table | Role |
|---|---|
| `devices` | one row per server (`device_type='server'`, `status` lifecycle) |
| `server_specs` | os, kernel, cores, architecture, memory/disk totals, agent_version, `last_seen`, uptime |
| `device_network` | mac_address, gateway, dns, network_segment |
| `agent_tokens` | pending `token`, permanent `approved_token`, `status`, `last_used_at` (NOT NULL — set on insert) |

---

## 8. Key files

| File | Role |
|---|---|
| `go-agent/` | The Go agent (see §3) |
| `backend/middleware/agentAuth.js` | Validate agent Bearer token → `req.device` |
| `backend/services/agentService.js` | All register/approve/heartbeat/read DB logic |
| `backend/handlers/serverMetricsHandler.js` | Validate + Influx write + heartbeat + emit |
| `backend/routes/agents.js` | `/api/agents/*` (register, status, pending, approve, reject) |
| `backend/routes/servers.js` | `POST /metrics` + dashboard GETs |
| `backend/src/server.js` | Mounts `/api/agents` (mock SNMP loop removed) |
| `frontend/src/pages/ServerMetrics.tsx` | Live list/gauges + admin pending-approval panel |
| `frontend/src/api/api.ts` | `getServers`, `getPendingAgents`, `approveAgent`, `rejectAgent` |

---

## 9. Dev tasks

### Add a new metric
1. `go-agent/internal/collector/metrics.go` — add the field + json tag.
2. `go-agent/internal/collector/collector.go` — collect it.
3. `backend/handlers/serverMetricsHandler.js` — add to `NUMERIC_FIELDS`, the Point, and the emit.
4. `frontend/src/pages/ServerMetrics.tsx` — map it in `mapServerRow` / `mergeLive`.

### Move to a new network
The agent's backend URL is set at install time (`-api-url` / installer arg), stored
in `agent.conf` — no rebuild needed. The dashboard's own hardcoded endpoints are in
`frontend/src/api/client.ts` and `frontend/src/socket/socket.ts`.

### Rotate the install key
Change `AGENT_INSTALL_KEY` in `backend/.env` and restart. Already-approved agents
are unaffected (they use their per-device `approved_token`, not the install key).

---

## 10. Gotchas / known limitations

- **Restart the backend after editing `.env`** — `AGENT_INSTALL_KEY` is read at
  startup; nodemon does not restart on `.env` changes. A mismatch returns
  `Invalid install key` on register.
- **Per-server history is real** — `ServerDetail.tsx` charts query
  `GET /api/servers/:id/history` (InfluxDB `server_metrics`, 1h/6h/24h ranges) and stay live
  via the `serverMetrics` socket. Network I/O is *derived* (MB/s) from the cumulative byte
  counters, so the first point of a range reads 0 (no prior sample to diff against).
- **InfluxDB retention** — `server_metrics` (every 10s/host) is the only high-volume store.
  It won't crash anything, but set a **bucket retention policy** (e.g. 30–90 days) so old
  points expire. MySQL tables (`device_logs` + device rows) are bounded and tiny. This is a
  one-time **config action on the InfluxDB server**, not application code — run it once:
  ```bash
  # 60-day retention (5184000s). Use the same bucket as INFLUX_BUCKET in backend/.env.
  influx bucket update --name "$INFLUX_BUCKET" --retention 60d --org "$INFLUX_ORG" --token "$INFLUX_TOKEN"
  # or in the InfluxDB UI: Load Data → Buckets → <bucket> → Settings → Retention = 60 days.
  ```
- **Offline detection** — a server is set `online` on approve and on each metric. A
  `last_seen` staleness check now flips it back to `offline`: `GET /api/servers` reports
  Offline (with zeroed live metrics) once `last_seen` is older than `OFFLINE_AFTER_SEC`
  (30s ≈ three missed 10s posts), and a 15s sweep in `src/server.js` persists the flip,
  logs a `device_logs` "went offline" entry, and pushes a live `serverStatus` event so the
  dashboard/Server Metrics page update without a refresh. Recovery is automatic on the next
  metric POST (`serverMetrics` with `status:"Online"`).
- **Contract is duplicated** in two places that must stay in sync:
  `go-agent/internal/collector/metrics.go` ↔ `backend/handlers/serverMetricsHandler.js`.
- **`agent.conf` holds the device token** — gitignored; never commit it. Same for
  `AGENT_INSTALL_KEY` / `.env`.
- **Windows install uses a Scheduled Task**, not a native service (no SCM wrapper is
  bundled to keep deps light). Swap to NSSM if your environment standardises on it.
- **Servers on UPS/battery stop reporting** — Windows Scheduled Tasks default to
  "don't start on battery / stop when going on battery", so a server on a UPS drops its agent
  the instant a power outage flips it to battery, and a battery-powered host that boots
  unplugged never starts the agent. `install.ps1` now sets
  `-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0` to fix this;
  tasks created by an **older** installer must be updated (see §2.4). The agent itself never
  exits on a backend outage (only on a 403 token revoke), so a dead agent is almost always
  this battery policy.
