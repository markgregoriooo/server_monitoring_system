# CSPC-ICTU Monitoring Agent (Go)

A small, dependency-light, **cross-platform** program that runs on each monitored
server, measures that machine's CPU / memory / disk / network / uptime, and sends
those numbers to the CSPC-ICTU backend over plain HTTP. The dashboard then shows
them live.

> **This README explains the agent's code and how it talks to the backend** — written
> so you can follow it even if you've never read Go. For the *operational* runbook
> (USB folders, firewall, running it on another machine, troubleshooting table), see
> the repo-root **`server-metrics.md`**. This file is the "how it works inside" companion
> to that "how to run it" guide.

---

## Table of contents

1. [The big picture](#1-the-big-picture)
2. [A 5-minute Go primer (read this if Go is new to you)](#2-a-5-minute-go-primer)
3. [Project layout — what each file does](#3-project-layout)
4. [The two run modes](#4-the-two-run-modes)
5. [The full lifecycle / flow, end to end](#5-the-full-lifecycle-flow-end-to-end)
6. [How the agent talks to the backend (HTTP contract)](#6-how-the-agent-talks-to-the-backend)
7. [The data contracts: `ServerMetrics` and `HostInfo`](#7-the-data-contracts)
8. [File-by-file walkthrough of the logic](#8-file-by-file-walkthrough)
9. [`agent.conf` — the config file](#9-agentconf--the-config-file)
10. [How it's compiled & shipped (build once, run anywhere)](#10-how-its-compiled--shipped-build-once-run-anywhere)
11. [Install as a background service](#11-install-as-a-background-service)
12. [Run manually (dev)](#12-run-manually-dev)
13. [Resilience rules — what makes it stop vs. keep going](#13-resilience-rules)
14. [Adding or changing a metric (keep these in sync!)](#14-adding-or-changing-a-metric)
15. [Security notes](#15-security-notes)

---

## 1. The big picture

The agent is a **separate Go program** — it is *not* part of the Node.js backend.
You build it into a single self-contained binary (`.exe` on Windows, a plain
executable on Linux) and drop that one file onto each server you want to watch. It
has no installer dependencies, no runtime to install, no source needed on the target.

It speaks **only HTTP** to the backend. It never connects to InfluxDB or Socket.IO
directly — those are the backend's job. The agent's whole world is "collect numbers,
POST them, repeat."

```
   ┌────────────────────────────┐
   │  Go agent (on each server) │   POST /api/servers/metrics
   │  • gopsutil reads the OS    │   Authorization: Bearer AGT-…
   │  • every 10 seconds         │ ─────────────────────────────────┐
   └────────────────────────────┘                                   │
                                                                     ▼
                                   ┌──────────────────────────────────────────┐
                                   │  Express backend (backend/src/server.js)   │
                                   │  agentAuthMiddleware → serverMetricsHandler │
                                   │   1. validate the JSON payload              │
                                   │   2. write InfluxDB (measurement server_metrics) │
                                   │   3. MySQL heartbeat (status / last_seen)   │
                                   │   4. io.emit("serverMetrics") to browsers   │
                                   └───────────────────┬─────────────────────────┘
                                                       │
                                                       ▼
                                   React dashboard — Server Metrics page
                                   (live gauges + table, updated by socket)
```

**Two phases in the agent's life:**

- **Enrollment (once):** the agent introduces itself, an admin approves it in the
  dashboard, and the agent receives a permanent token it saves to `agent.conf`.
- **Steady state (forever after):** every 10 seconds it collects metrics and POSTs
  them using that token.

---

## 2. A 5-minute Go primer

Just enough Go to read this codebase. If you already know Go, skip to §3.

- **Packages.** Every folder is a *package* (the `package collector` line at the top
  of each file). Code in one package calls another by importing it
  (`"cspc-ictu/agent/internal/collector"`) and prefixing the call with the package
  name (`collector.Collect()`). The program starts at `func main()` in
  `package main` (`cmd/agent/main.go`).

- **Exported vs. private.** A name starting with a **Capital letter** is public
  (usable from other packages): `Collect`, `ServerMetrics`, `APIURL`. A
  **lowercase** name is private to its own package: `round1`, `postJSON`, `apiURL`.
  This is Go's only access modifier — capitalization *is* the keyword.

- **Structs and JSON tags.** A `struct` is a plain data record. The backtick part is
  a "tag" telling Go's JSON library what key name to use on the wire:

  ```go
  type ServerMetrics struct {
      CPUPercent float64 `json:"cpu_percent"`   // Go field CPUPercent ⇄ JSON "cpu_percent"
  }
  ```

  So the Go field `CPUPercent` becomes `"cpu_percent"` in the JSON the backend reads.
  This is *why* the field-name mapping between agent and backend matters (see §7).

- **Error handling.** Go functions return errors as a normal return value, not by
  throwing. The idiom you'll see everywhere:

  ```go
  m, err := collector.Collect()
  if err != nil {
      // handle it
  }
  ```

  There are no exceptions; you check `err` after each call.

- **Pointers.** `*Sender` means "a pointer to a Sender." `&Config{...}` means "the
  address of a new Config." You can mostly read past these — they're how Go passes
  things by reference. `s *Sender` in a function signature `func (s *Sender) Send(...)`
  is a *method* on the Sender type (like `sender.Send(...)`).

- **The `:=` operator.** Short variable declaration. `x := 5` is "make a new variable
  x and set it to 5." `=` (no colon) assigns to an existing variable.

- **Goroutines / tickers.** `time.NewTicker(d)` gives you a channel (`ticker.C`) that
  fires every `d`. `for range ticker.C { ... }` runs the body once per tick — that's
  the heartbeat of the metric loop.

- **`defer`.** `defer resp.Body.Close()` schedules that call to run when the function
  returns — a tidy way to guarantee cleanup.

That's all you need to follow everything below.

---

## 3. Project layout

```
agent/
├─ go.mod / go.sum                     module name + locked dependency versions
├─ Makefile                            build/cross-compile/format/vet targets
├─ cmd/
│  └─ agent/
│     └─ main.go                       ENTRY POINT — parses flags, chooses mode, runs the loop
├─ internal/                           private packages (can't be imported outside this module)
│  ├─ config/config.go                 read & write agent.conf
│  ├─ logger/logger.go                 tiny [INFO]/[ERROR] logger
│  ├─ collector/
│  │  ├─ metrics.go                    the two JSON data contracts (ServerMetrics, HostInfo)
│  │  ├─ collector.go                  reads live metrics + host specs via gopsutil
│  │  └─ netinfo.go                    best-effort gateway + DNS discovery (OS-specific)
│  ├─ sender/sender.go                 HTTP POST of metrics, with retry + backoff
│  └─ registration/register.go         first-run handshake: register → poll → approve
├─ installer/                         exactly what ships beside the binary, per OS
│  ├─ windows/install.ps1              install as a Scheduled Task (SYSTEM, at boot)
│  ├─ windows/RUN-ME.txt               the operator's guide, shipped under this name
│  ├─ linux/install.sh                 install as a systemd service
│  └─ linux/RUN-ME.txt                 the operator's guide, shipped under this name
└─ dist/                              built binaries + ready-to-ship installer folders
```

- **Module path:** `cspc-ictu/agent`, **Go 1.22**.
- **Direct dependencies (just two):**
  - `github.com/shirou/gopsutil/v3` — reads CPU/mem/disk/net/host info cross-platform.
  - `github.com/joho/godotenv` — reads/writes the `KEY=value` `agent.conf` file.
  - (Everything else in `go.mod` is an *indirect* dependency pulled in by gopsutil.)
- **`internal/`** is special in Go: packages under it can only be imported by code in
  this same module. It's the language's way of saying "these are private building
  blocks, not a public API."

---

## 4. The two run modes

Everything is driven by command-line flags parsed in `main.go`:

| Flag | Meaning |
|------|---------|
| `--register` | Enroll if not already enrolled, **wait** for admin approval, then **start the metric loop** (one command does it all). |
| `--register-only` | Enroll and **exit** after approval. Used by the installers — the service then runs the loop separately. |
| `-api-url URL` | Backend base URL, e.g. `http://<backend-server-ip>:3000`. Required for enrollment. |
| `-install-key KEY` | The enrollment key (`AIK-…`), minted by an admin on **Server Metrics → Agent install keys**. Required for enrollment. Used once — the agent then runs on the `AGT-…` token it gets at approval. Revoking the install key blocks new installs; the admin can *also* choose to de-authorise the servers it enrolled, in which case this agent gets a 403, deletes its `agent.conf` and exits (re-run with a live key to come back). |
| `-conf PATH` | Path to `agent.conf`. Defaults to **next to the executable** so the installed service finds it regardless of working directory. |
| `-interval N` | Seconds between metric posts (default **10**). Saved into `agent.conf` at enrollment. |

So in practice:

```bash
# Brand-new machine: enroll, wait for approval, then run forever
cspc-agent --register -api-url http://<backend-server-ip>:3000 -install-key <KEY> -conf agent.conf

# Already enrolled (agent.conf exists): just run the loop
cspc-agent -conf agent.conf
```

**How `main()` decides what to do** (`cmd/agent/main.go`):

1. Try to load `agent.conf`.
2. If that fails **and** `--register`/`--register-only` was passed → run the
   enrollment handshake (`registration.Run`), which blocks until approved and then
   writes `agent.conf`, then load it again.
3. If `--register-only` → stop here (the service will run the loop).
4. If there's still no usable config → print "run with `--register` first" and exit.
5. Otherwise → enter `runMetricLoop`, which only returns if the backend revokes our
   token (HTTP 403 = this server was removed). On that, the agent **deletes its own
   `agent.conf`** and exits cleanly, so a future `--register` can re-enroll fresh.

---

## 5. The full lifecycle / flow, end to end

### Phase A — Enrollment (happens once)

```
agent                                   backend                         admin (dashboard)
  │                                        │                                  │
  │  POST /api/agents/register             │                                  │
  │  { install_key, hostname, os, mac… } ─▶│                                  │
  │                                        │ verify install key (constant-time)│
  │                                        │ create devices(status=pending)    │
  │                                        │  + server_specs + device_network  │
  │                                        │  + agent_tokens(status=pending)   │
  │  ◀── { pending_token, device_id } ─────│ emit "agentPending" ───────────▶ │ (sees it appear)
  │                                        │                                  │
  │  (loop every 10s)                      │                                  │
  │  POST /api/agents/status               │                                  │
  │       { pending_token }                │                                  │
  │  ───────────────────────────────────▶ │                                  │
  │  ◀── { status: "pending" } ────────────│                                  │
  │           …                            │       POST /:id/approve ◀──────── │ (clicks Approve)
  │                                        │ generate AGT-… token              │
  │                                        │ agent_tokens.status=approved      │
  │                                        │ devices.status=online             │
  │  GET …/status (next poll)              │ emit "agentApproved" ──────────▶ │
  │  ◀── { status:"approved",              │                                  │
  │        approved_token:"AGT-…" } ───────│                                  │
  │                                        │                                  │
  │  write agent.conf (API_URL, token, id) │                                  │
  ▼                                        ▼                                  ▼
  enters Phase B
```

Key properties:

- **The install key is a shared secret**, not per-machine. Every agent presents the
  same `AGENT_INSTALL_KEY`. It only gets a machine to the "pending" stage; an admin
  must still approve it.
- **Idempotent per machine (MAC, then hostname).** If the same machine re-registers
  (e.g. you restart the agent before approving it), the backend recognizes it and reuses
  the existing pending enrollment instead of creating a duplicate. It matches on **MAC**
  first; if the MAC is absent or has changed (Wi-Fi randomized MAC, a different up
  interface, VPN/WSL/Hyper-V adapters), it falls back to the **hostname** so an unstable
  NIC can't fragment one server into many "ghost" device rows. It also refreshes that
  machine's IP/gateway/DNS/specs (and re-stamps the current MAC) in case they changed.
- The agent **blocks** in this phase — `registration.Run` doesn't return until the
  device is approved (or rejected/removed). With `--register` it then flows straight
  into Phase B; with `--register-only` it returns so the installer can create the
  service.

### Phase B — Steady-state metric loop (forever)

```
every <interval> seconds:
  collector.Collect()      → read CPU/mem/disk/net/uptime/process count from the OS
  sender.Send(metrics)     → POST /api/servers/metrics with Bearer <approved_token>
       ├─ 2xx success      → log "metrics sent (cpu=… mem=… disk=…)", wait for next tick
       ├─ network error    → retry up to 3× (1s, 2s, 4s backoff); if all fail, give up
       │                     THIS cycle and try again next tick (never crashes)
       └─ HTTP 403         → token revoked = server was removed → STOP the loop
```

On the backend, each POST drives `serverMetricsHandler.js`, which:
1. **validates** every numeric field,
2. **writes** one point to InfluxDB (`server_metrics` measurement),
3. **records a heartbeat** in MySQL (`devices.status='online'`, `server_specs.last_seen=NOW()`),
4. caches the latest values so a dashboard refresh shows numbers instantly,
5. logs threshold crossings / online transitions to `device_logs`,
6. **broadcasts** a `serverMetrics` socket event so open dashboards update live.

### Phase C — Decommission (admin removes the server)

When an admin clicks **Remove** on the dashboard, the backend deletes the device row;
the `agent_tokens` row cascades away, so the token is revoked. The very next metric
POST from that still-running agent gets **HTTP 403**. The agent recognizes that as
"I've been removed," logs it, **deletes its own `agent.conf`, and exits**. No stale
config is left behind; to monitor that machine again you just `--register` once more.

> A transient backend **outage** is a *network error*, not a 403 — so an outage never
> triggers self-removal. Only an explicit 403 does. This distinction is deliberate
> (see `sender.go` and `runMetricLoop` in §8).

---

## 6. How the agent talks to the backend

All communication is **HTTP/JSON**. There are exactly four endpoints the agent calls,
plus the headers/auth it uses.

### Endpoints the agent calls

| When | Method & path | Auth it sends | Body it sends | What it expects back |
|------|---------------|---------------|---------------|----------------------|
| Enroll | `POST /api/agents/register` | the **install key** (inside the JSON body) | `install_key` + all `HostInfo` fields | `{ pending_token, device_id }` |
| Poll | `POST /api/agents/status` | the **pending token** (inside the JSON body) | `pending_token` | `{ status, approved_token, device_id }` |
| Send metrics | `POST /api/servers/metrics` | `Authorization: Bearer <approved_token>` | all `ServerMetrics` fields | `{ success: true }` |

(The other server endpoints — `GET /api/servers`, `/api/agents/pending`,
`/:id/approve`, etc. — are called by the **dashboard/admin**, not the agent. They're
listed in `server-metrics.md` §5.)

### Headers

- Every request sets `Content-Type: application/json`.
- Metric POSTs additionally set `Authorization: Bearer <approved_token>` — this is how
  `agentAuthMiddleware.js` on the backend identifies which device is reporting. The
  middleware looks up the token in `agent_tokens WHERE approved_token=? AND
  status='approved'`; if it matches it attaches `req.device` (id, name, ip, location,
  os) and lets the request through, otherwise it returns **403**.

### Timeouts & retries

- Every HTTP client uses a **10-second timeout** (`registration` and `sender` both set
  `http.Client{Timeout: 10 * time.Second}`).
- The **metric sender** retries a failed POST up to **3 times** with exponential
  backoff (1s → 2s → 4s). A `403` short-circuits the retries (no point retrying a
  revoked token).
- The **poller** retries every `pollInterval` (10s) until approved/rejected.

### Why HTTP-only?

The agent runs on arbitrary servers across the LAN. Keeping it to a single outbound
HTTP call (no DB drivers, no socket library, no inbound ports) makes it tiny, easy to
firewall (only the backend's port 3000 needs to be reachable *from* the agent), and
trivial to secure later behind HTTPS/a reverse proxy without touching agent code.

---

## 7. The data contracts

Two Go structs in `internal/collector/metrics.go` define exactly what crosses the
wire. **These must stay in sync with the backend** — the JSON key names here are what
the backend reads.

### `ServerMetrics` — sent on every metric POST

| Go field | JSON key | Type | Meaning |
|----------|----------|------|---------|
| `CPUPercent` | `cpu_percent` | float | CPU busy %, sampled over 500 ms |
| `MemUsedMB` | `mem_used_mb` | float | RAM used (MB) |
| `MemTotalMB` | `mem_total_mb` | float | RAM total (MB) |
| `MemPercent` | `mem_percent` | float | RAM used % |
| `DiskUsedGB` | `disk_used_gb` | float | Disk used on root volume (GB) |
| `DiskTotalGB` | `disk_total_gb` | float | Disk total on root volume (GB) |
| `DiskPercent` | `disk_percent` | float | Disk used % |
| `NetBytesSent` | `net_bytes_sent` | float | **Cumulative** bytes sent since boot |
| `NetBytesRecv` | `net_bytes_recv` | float | **Cumulative** bytes received since boot |
| `UptimeSeconds` | `uptime_seconds` | float | Seconds since boot |
| `ProcessCount` | `process_count` | **int** | Number of running processes |

> Network I/O is **cumulative byte counters**, not a rate. The dashboard derives MB/s
> by diffing consecutive samples — which is why the first point of any chart range
> reads 0 (there's no earlier sample to subtract).

The backend (`serverMetricsHandler.js`) validates every one of these, writes them to
InfluxDB, and then **re-emits them to the dashboard in camelCase** (`cpuPercent`,
`memPercent`, …) plus a derived `uptimeLabel` like `"3d 4h"`. So the names change shape
three times: gopsutil → snake_case JSON (wire) → camelCase socket payload (browser).

### `HostInfo` — sent once at registration

Static identity + specs used to create the device record. Maps to the backend's
`devices` / `server_specs` / `device_network` tables.

| Go field | JSON key | Goes to |
|----------|----------|---------|
| `Hostname` | `hostname` | `devices.device_name` |
| `OS` | `os` | gopsutil family: `"windows"` / `"linux"` |
| `Platform` | `platform` | `server_specs.os` (e.g. `"Ubuntu 22.04"`) |
| `KernelVersion` | `kernel_version` | `server_specs.kernel` |
| `Arch` | `arch` | `server_specs.architecture` (amd64 / arm64) |
| `Cores` | `cores` | `server_specs.cores` |
| `IPAddress` | `ip_address` | `devices.ip_address` |
| `MACAddress` | `mac_address` | `device_network.mac_address` (the idempotency key) |
| `Gateway` | `gateway` | `device_network.gateway` |
| `DNS` | `dns` | `device_network.dns` |
| `MemoryTotalMB` | `memory_total_mb` | `server_specs.memory_total_mb` |
| `DiskTotalGB` | `disk_total_gb` | `server_specs.disk_total_gb` |
| `AgentVersion` | `agent_version` | `server_specs.agent_version` |

---

## 8. File-by-file walkthrough

### `cmd/agent/main.go` — the brain

The entry point. Responsibilities:

- **Parse flags** (`flag.Bool`, `flag.String`, …) — the modes/options from §4.
- **Choose a mode**: load config; enroll if needed; stop if `--register-only`; else
  run the loop.
- **`runMetricLoop(sender, intervalSec)`** — the heartbeat:
  - Creates a `time.Ticker` firing every `intervalSec` seconds.
  - Sends **one sample immediately** on startup (so you don't wait a full interval to
    see the machine appear), then once per tick.
  - Each cycle calls `collectAndSend`, and **stops only** if that returns
    `sender.ErrUnauthorized` (the 403 = revoked case). Any other error is logged and
    the loop continues.
- **Self-cleanup on revoke:** when the loop returns, `main` logs "removed by the
  server," deletes `agent.conf`, and exits 0.
- **`defaultConfPath()`** puts `agent.conf` next to the binary, so an installed service
  finds it no matter what directory it's launched from.

The version string lives here: `const agentVersion = "1.0.0"`.

### `internal/registration/register.go` — the enrollment handshake

`Run(apiURL, installKey, confPath, agentVersion, interval)`:

1. Collects `HostInfo` (`collector.CollectHostInfo`).
2. POSTs it + the install key to `/api/agents/register`; reads back the
   `pending_token`.
3. **Polls** `POST /api/agents/status` with `{ pending_token }` in the body every 10 s
   (body rather than a query string — the token is exchanged for the permanent one, and
   a URL would land in the access log on every poll):
   - `status: "approved"` → writes `agent.conf` (with the permanent token) and returns
     success.
   - `status: "rejected"` → returns an error (the agent will exit).
   - HTTP **404** on the poll → the pending token is gone (admin rejected/removed it)
     → returns "rejected or removed."
   - anything else → logs "still pending…" and keeps polling.

Helper functions `postJSON` / `getJSON` / `do` wrap Go's `net/http`: build the request,
set `Content-Type`, send with a 10 s timeout, and treat any non-2xx as an error
(returning the status code so the caller can special-case 404).

### `internal/collector/collector.go` — reading the machine

- **`Collect()`** samples live metrics via gopsutil:
  - `cpu.Percent(500ms, false)` — **blocks for 500 ms** to measure CPU accurately
    (don't remove the interval; a zero interval returns garbage on first call).
  - `mem.VirtualMemory()`, `disk.Usage(diskPath())`, `net.IOCounters(false)`,
    `host.Uptime()`, `process.Pids()`.
  - **Each probe is independent**: if one fails, that metric stays at its zero value
    and the rest still report. Collection never fails as a whole.
  - Numbers are converted (bytes→MB/GB) and rounded to one decimal (`round1`).
- **`CollectHostInfo(version)`** gathers the static specs for registration: hostname,
  OS family, platform string, kernel, core count, total RAM/disk, architecture, plus
  the network identity from `primaryNIC()` + `netinfo.go`.
- **`diskPath()`** returns `C:\` on Windows, `/` elsewhere — the agent is
  cross-platform, so the root volume differs by OS.
- **`primaryNIC()`** walks the network interfaces and returns the IPv4 + MAC of the
  first **up, non-loopback** interface that has an IPv4 address. That MAC is what the
  backend uses to recognize a re-registering machine.

### `internal/collector/netinfo.go` — gateway & DNS (best-effort)

Discovering the default gateway and DNS servers has no portable Go API, so this file
does it per-OS, and only at registration (so the slightly heavier Windows path is
fine):

- **Gateway:** Windows shells out to PowerShell `Get-NetRoute` for the `0.0.0.0/0`
  next hop; Linux parses `/proc/net/route` (the gateway there is a little-endian hex
  IPv4, decoded by `hexLEToIP`).
- **DNS:** Windows uses `Get-DnsClientServerAddress`; Unix parses `nameserver` lines
  from `/etc/resolv.conf`. Results are de-duplicated.
- All of this is **best-effort** — if it can't determine a value it returns `""` and
  the agent carries on. These are informational fields, not required for operation.

### `internal/collector/metrics.go` — the contracts

Just the two structs from §7 — no logic. The comments here are the canonical reminder
that these JSON tags must match the backend handler.

### `internal/sender/sender.go` — POSTing metrics

- `New(apiURL, token)` builds a `Sender` holding the backend URL, the device's token,
  and an `http.Client` with a 10 s timeout.
- `Send(metrics)`:
  - Marshals the metrics to JSON.
  - POSTs to `/api/servers/metrics` with the `Authorization: Bearer <token>` header.
  - **Up to 3 attempts** with backoff (1s → 2s → 4s).
  - On success: logs `metrics sent (cpu=… mem=… disk=…)`.
  - On **HTTP 403**: returns the sentinel `ErrUnauthorized` *immediately* (caller uses
    this to self-decommission).
  - On other failures after 3 tries: logs "giving up this cycle" and returns a generic
    error (the loop will just try again next interval).
- `ErrUnauthorized` is an exported sentinel error so `main.go` can test for it with
  `errors.Is(err, sender.ErrUnauthorized)`.

### `internal/config/config.go` — reading/writing `agent.conf`

- `Load(path)` reads `agent.conf` (a simple `KEY=value` file, parsed by `godotenv`)
  into a `Config{ APIURL, DeviceToken, DeviceID, IntervalSeconds }`. It **errors** if
  `API_URL` or `DEVICE_TOKEN` is missing (so the agent won't run half-configured), and
  defaults the interval to 10 s.
- `Write(path, …)` saves the file with **`0600` permissions** (owner read/write only)
  because it contains the device token.

### `internal/logger/logger.go` — logging

A four-line wrapper: `Infof` → stdout with `[INFO]`, `Errorf` → stderr with `[ERROR]`,
both timestamped. When installed as a service the agent has no console, so you confirm
it's working from the **dashboard**, not the logs.

---

## 9. `agent.conf` — the config file

Written automatically by the agent after approval (never edit it by hand unless you're
re-pointing it). Plain `KEY=value`:

```ini
# Written by `cspc-agent --register` after admin approval. Do not commit.
API_URL=http://<backend-server-ip>:3000
DEVICE_TOKEN=AGT-3f9c…           # the permanent bearer token for this machine
DEVICE_ID=42
INTERVAL_SECONDS=10
```

- It holds the **device token** → it is **gitignored; never commit it**.
- It caches the backend URL → if the backend's address ever changes, every agent's
  `agent.conf` must be updated (edit `API_URL` + restart, or re-register). This is why
  `server-metrics.md` recommends a *stable* backend address (static IP / DNS name).
- File permissions are `0600` so only the owner (the service account) can read the
  token.

---

## 10. How it's compiled & shipped (build once, run anywhere)

Go is a **compiled** language. The `.go` files in this repo are human-readable
*source*; the thing you actually put on a server is a *compiled binary*. That split
explains the whole build-and-deploy workflow — including why testing on the backend PC
needs an extra command, and why a target server needs no Go and no source.

> **Analogy:** the `.go` source is a *recipe* (instructions a human reads). The binary
> (`cspc-agent.exe`) is the *cooked meal* — you can serve it anywhere without the recipe
> or the kitchen. `go build` is the cooking.

### What `go build` does

`go build` runs the Go compiler, which turns your source **plus every dependency
(gopsutil, godotenv) plus the Go runtime** into **one self-contained executable** of
CPU machine code. Nothing is left "outside" the file.

You can prove it — these readable strings are baked *inside* the shipped binary:

```
# Written by `cspc-agent --register` after admin approval.   ← from internal/config/config.go
waiting for admin approval...                              ← from internal/registration/register.go
github.com/shirou/gopsutil/v3/cpu /mem /disk /host ...     ← the gopsutil dependency, compiled in
...net/http, crypto/tls...                                 ← the whole Go runtime + std library, compiled in
```

So a single `cspc-agent.exe` (~6.7 MB) already contains *your code + all dependencies +
the runtime*. That's **why** it's several MB for such a small program — and why it
needs **no Go install, no source, and no `node_modules`-style folder** on the target.

> Contrast: a Node.js app needs `node` + `node_modules` on every machine; Python needs
> the interpreter present. A Go binary needs **nothing else** — ideal for an agent you
> scatter across many servers.

### Build once on the dev PC → run anywhere

This is exactly why the two test scenarios in `server-metrics.md` look different:

| | Same PC as backend (your dev machine) | Another server |
|---|---|---|
| Has Go + the source? | **Yes** | No |
| So you… | **build first** (`go build …`), then run | just **run** the pre-built binary from USB |
| Commands | 2 (build, then `--register …`) | 1 (`--register …`) |

The `--register …` command itself is **identical**; the only extra step on the dev PC
is compiling. (The other change — `localhost` → the backend's LAN IP — is only because
`localhost` means "this same machine," which is wrong from a different server.)

### Build commands

```bash
cd cspc-agent
go mod tidy          # fetch dependencies (needs internet the first time)
make all             # builds all three targets into dist/:
                     #   dist/cspc-agent-linux-amd64
                     #   dist/cspc-agent-windows-amd64.exe
                     #   dist/cspc-agent-linux-arm64   (Raspberry Pi etc.)
```

Other Makefile targets: `make linux` / `make windows` / `make arm64` (single target),
`make run` (run locally against `./agent.conf`), `make fmt` (`gofmt -w .`),
`make vet` (`go vet ./...`), `make tidy`, `make clean`.

> Go cross-compiles natively: one machine can produce Windows, Linux, and ARM binaries
> by just setting `GOOS`/`GOARCH` (the Makefile does this for you). No toolchain per
> target needed. The `-ldflags "-s -w"` strips debug info to shrink the binary.

> If `go mod tidy` fails, that's almost always a network/sandbox limitation, not a code
> problem — the source is verified with `gofmt -e` and `go vet`.

### Why there are three binaries

Machine code is specific to the **OS + CPU**, so you need one build per platform (all
produced by `make all`):

| Binary | Runs on | Approx size |
|--------|---------|-------------|
| `cspc-agent-windows-amd64.exe` | Windows, Intel/AMD 64-bit | 6.7 MB |
| `cspc-agent-linux-amd64` | Linux, Intel/AMD 64-bit | 6.5 MB |
| `cspc-agent-linux-arm64` | Linux ARM (e.g. Raspberry Pi) | 6.0 MB |

A Windows `.exe` won't run on Linux/ARM and vice-versa — which is why the USB has a
**separate folder per OS**. You copy the one matching the target.

### Why each installer folder bundles the binary

The installer (`install.ps1` / `install.sh`) is **not** a compiler — it builds nothing.
It just (1) **copies** the binary into place (`C:\Program Files\cspc-agent\` or
`/opt/cspc-agent/`), (2) enrolls it once, (3) registers it as a service. Step 1 is a
plain file copy, so the binary **must physically sit in the folder** next to the
installer. That's why each shipped folder contains *both* the script **and** the binary
(plus `RUN-ME.txt`).

### Can I look inside a binary?

To read **what it does**, read the `.go` source (see §8) — that's the human-readable
version; the binary is machine code you can't meaningfully read by eye. It is
**generated by the Go compiler, not hand-written** (you write `.go`; the compiler
produces the `.exe` — you never edit the `.exe`). If you're curious, these dev-PC
commands peek at it:

```bash
go version dist/cspc-agent.exe    # which Go version built it
go tool nm   dist/cspc-agent.exe  # list the functions/symbols compiled in
```

---

## 11. Install as a background service

The installers live in `installer/windows/` and `installer/linux/` — each folder holds
exactly what ships beside the binary (the script + `RUN-ME.txt`), so `make package` is
"copy the folder, add the binary". Each script **enrolls first (`--register-only`),
pauses until you approve in the dashboard, then creates and starts the OS service.**

```powershell
# Windows — run from an ELEVATED PowerShell, binary in the same folder
.\install.ps1 -ApiUrl "http://<backend-server-ip>:3000" -InstallKey "<INSTALL_KEY>"
```

- Copies the binary to `C:\Program Files\cspc-agent\`.
- Registers a **Scheduled Task** `CSPC-ICTU-MonitoringAgent` running as **SYSTEM**, at
  startup, auto-restarting on failure.
- Sets `-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0` so
  a server on a **UPS** keeps reporting during a power outage (Windows' defaults would
  otherwise kill the task the moment it switches to battery — exactly when you want
  monitoring). A Scheduled Task is used instead of a native service to avoid bundling
  an SCM wrapper like NSSM.

```bash
# Linux — systemd, binary in the same folder (auto-picks amd64 vs arm64)
sudo bash install.sh http://<backend-server-ip>:3000 <INSTALL_KEY>
```

- Copies the binary to `/opt/cspc-agent/`, writes `/etc/systemd/system/cspc-agent.service`,
  then `systemctl enable --now`.
- Uses `Restart=on-failure` (not `always`) **on purpose**: a *clean* exit means
  "deauthorized by the server" (the 403 self-removal), so it should stay stopped; a
  crash should restart.

**Heartbeat + shutdown notice.** Besides the metric post, the agent sends an empty
`POST /api/servers/heartbeat` every 2s, so the backend notices a dead server after 6s
(`SERVER_HEARTBEAT_TIMEOUT_SEC`) instead of 30s+. On its way down it sends
`POST /api/servers/shutdown` (`{reason: "shutdown"|"stopped"}`), which raises a CRITICAL
alert at once. Linux: systemd's SIGTERM — `systemctl is-system-running` = `stopping` tells a
system shutdown from a `systemctl stop`. Windows: the scheduled-task agent is not reliably
signalled, so the installer adds a second task, **"CSPC-ICTU Monitoring Agent - Shutdown
Notice"**, triggered by System Event 1074 (User32 — logged when a shutdown/restart is
initiated) that runs `cspc-agent.exe --notify-shutdown -reason shutdown`. A power cut sends
nothing; the heartbeat covers it.

Manage / uninstall:

```powershell
Get-ScheduledTask -TaskName "CSPC-ICTU Monitoring Agent*"            # check (both tasks)
Stop-Process -Name cspc-agent -Force -ErrorAction SilentlyContinue      # remove:
Unregister-ScheduledTask -TaskName "CSPC-ICTU Monitoring Agent" -Confirm:$false
Unregister-ScheduledTask -TaskName "CSPC-ICTU Monitoring Agent - Shutdown Notice" -Confirm:$false
```
```bash
systemctl status cspc-agent            # check
sudo systemctl disable --now cspc-agent   # remove
```

> Full ops walkthrough (USB folders, firewall rule for port 3000, running on a second
> machine, UPS notes, troubleshooting table) is in **`server-metrics.md` §2**.

---

## 12. Run manually (dev)

```bash
# one-time enrollment (blocks until you Approve it in the dashboard), then runs
go run ./cmd/agent --register -api-url http://<backend-server-ip>:3000 -install-key <KEY> -conf ./agent.conf

# already enrolled — just run the loop
make run     # == go run ./cmd/agent -conf ./agent.conf
```

On the **same PC as the backend**, use `-api-url http://localhost:3000`. On any other
machine, use the backend's LAN IP (localhost would point at the wrong machine).

---

## 13. Resilience rules

These are the deliberate "when does it stop vs. keep going" decisions baked into the
code — worth understanding before changing anything:

| Situation | Agent's behavior | Where |
|-----------|------------------|-------|
| Backend down / network blip / connection refused | **Keep running.** Retry the POST 3× (1/2/4 s), then give up *this* cycle and try again next interval. Never crashes. | `sender.Send`, `runMetricLoop` |
| One metric probe fails (e.g. disk read) | That metric reports 0; the rest are still sent. | `collector.Collect` |
| Admin **removes** the server (token revoked) | Next POST gets **403** → log it, **delete `agent.conf`**, exit 0. | `sender` → `main` |
| Admin **rejects** a *pending* enrollment | Poll gets 404/"rejected" → exit with an error (never enrolled). | `registration.Run` |
| Backend restarts but server still approved | Just transient network errors during downtime; resumes automatically. No 403, so no self-removal. | `sender` |
| Agent restarts before approval | Re-registers; backend recognizes the MAC and reuses the same pending device (no duplicate). | backend `agentService.register` |

The single most important rule: **a network error is not a 403.** Only an explicit 403
(revoked token) ends the agent's life. Everything else is treated as temporary.

---

## 14. Adding or changing a metric

The metric contract is duplicated across four places that **must stay in sync**. To add
a metric (e.g. `swap_percent`), edit all of:

1. **`internal/collector/metrics.go`** — add the field + `json:"swap_percent"` tag to
   `ServerMetrics`.
2. **`internal/collector/collector.go`** — collect it inside `Collect()`.
3. **`backend/handlers/serverMetricsHandler.js`** — add it to `NUMERIC_FIELDS`, to the
   InfluxDB `Point`, and to the camelCase `serverMetrics` emit.
4. **`frontend/src/pages/ServerMetrics.tsx`** — map it in the row/merge logic so the UI
   shows it.

(Miss any one and the field silently won't reach the dashboard, or the backend will
reject the POST as "Invalid or missing field.")

---

## 15. Security notes

- **Install key** (`AGENT_INSTALL_KEY`): a shared secret that only gets a machine to
  the *pending* stage — an admin must still approve it. The backend compares it in
  **constant time** and **fails closed** if the env var isn't set. Keep it out of git;
  rotate it if it leaks (already-approved agents are unaffected, since they use their
  own per-device token).
- **Device token** (`AGT-…`): unique per machine, lives only in `agent.conf` (0600,
  gitignored). Sent as a Bearer token on every metric POST; revoked by deleting the
  server.
- **Transport:** in dev it's plain `http://` over a trusted LAN. For production, put
  the backend behind **HTTPS** (a TLS reverse proxy) and point `-api-url` at the
  `https://` URL — no agent code change needed. Don't expose plain HTTP beyond a
  trusted network, since the token travels in the header.

---

*See also: `server-metrics.md` (root) for the operational runbook and the full backend
API reference; `CLAUDE.md` for the overall system architecture.*
