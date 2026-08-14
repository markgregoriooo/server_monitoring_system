# Server Metrics — Go Monitoring Agent

A cross-platform **Go agent** runs on each monitored server, collects system metrics, and
POSTs them to the Node backend, which stores them in InfluxDB + MySQL and pushes live
updates to the dashboard.

> **This file is the feature flow.** For installing, building and cross-compiling the
> agent, and the file-by-file source walkthrough, see **`go-agent/README.md`**.
> Sensors/aircon → `Environment.md`. Users/auth → `CLAUDE.md`.

---

## 1. The flow

```
  Go agent (per server)        POST /api/servers/metrics
  gopsutil · 10s interval  ──  Authorization: Bearer AGT-…  ──┐
                                                              ▼
                              ┌──────────────────────────────────────┐
                              │ Express backend                       │
                              │  agentAuth → serverMetricsHandler     │
                              │  validate → InfluxDB write            │
                              │  MySQL heartbeat (status/last_seen)   │
                              │  checkThresholds → alerts             │
                              │  io.emit("serverMetrics")             │
                              └──────────────┬───────────────────────┘
             InfluxDB (time-series) ◀────────┤────▶ MySQL (devices, server_specs,
             server_metrics, server_volumes  │       device_network, agent_tokens)
                                             ▼
                              React dashboard — Server Metrics page
```

**The agent speaks only HTTP to the backend.** It never connects to InfluxDB and never opens
a socket — Socket.IO is browser↔Node only. Each monitored host holds one credential for one
endpoint, not database access.

**One sample, end to end:** agent collects (500 ms blocking CPU read) → POSTs snake_case JSON
with its Bearer token → `agentAuth` resolves the token to a device → handler validates every
field → writes `server_metrics` + one `server_volumes` point per volume → MySQL heartbeat
sets `status='online'`, `last_seen=now` → `checkThresholds` evaluates the configurable rules
→ emits camelCase `serverMetrics` to every dashboard.

### Key numbers

| | |
|---|---|
| Post interval | **10s** default, per-agent (`-interval`) |
| CPU sample | **500 ms** blocking read — keep it, it's what makes the number accurate |
| Send retries | **3×**, backoff 1s → 2s → 4s, then buffer |
| Outage buffer | **240** samples in memory ≈ 40 min at 10s |
| Backfill batch | **≤ 60** samples per request |
| Offline sweep | every **15s** |
| Offline window | `clamp(interval × 3, SERVER_OFFLINE_AFTER_SEC … 3600s)` |

---

## 2. Enrollment & auth

Two different secrets: a **shared install key** (`AGENT_INSTALL_KEY` in `backend/.env`) gets
an agent in the door; a **per-device token** is what it runs on. Rotating the install key
never disturbs approved agents.

1. **Register** — agent POSTs the install key + host info. Backend creates, in one
   transaction: `devices` (`device_type='server'`, `status='pending'`), `server_specs`,
   `device_network`, `agent_tokens` (`status='pending'`). Returns `{ pending_token, device_id }`.
   **Idempotent per NIC** — re-registering with the same MAC reuses the enrollment, so a
   restart before approval can't spawn duplicate pending devices.
2. **Poll** — agent GETs `/api/agents/status?pending_token=…` every 10s and waits.
3. **Approve** — an admin approves in the dashboard → backend mints a permanent `AGT-…`
   token, sets `agent_tokens.status='approved'` + `devices.status='online'`, emits
   `agentApproved`.
4. **Run** — agent writes `agent.conf` (gitignored — holds the token) and posts every
   interval with `Authorization: Bearer <token>`.

**Nothing self-approves.** A machine can announce itself, but a human decides whether it
joins — that's the answer to "what stops an arbitrary host on the LAN injecting metrics?"

**Removal is self-cleaning.** `DELETE /api/servers/:id` drops the `devices` row; the rest
cascades, revoking the token. The agent's next POST gets a `403`, so it logs the removal,
**deletes its own `agent.conf` and exits**. A backend outage is a network error, not a 403,
so it won't trip this. InfluxDB history is left intact.

### Endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/agents/register` | install key | First-run enrollment |
| `GET /api/agents/status?pending_token=` | pending token | Poll for approval |
| `GET /api/agents/pending` | JWT admin | Servers awaiting approval |
| `POST /api/agents/:id/approve` \| `/reject` | JWT admin | Approve (issue `AGT-…`) / reject |
| `POST /api/servers/metrics` | agent Bearer | Metric ingestion |
| `POST /api/servers/metrics/batch` | agent Bearer | Backfill (§4) — history only |
| `GET /api/servers` \| `/:id` \| `/:id/logs` | JWT | List / detail / device event log |
| `GET /api/servers/:id/history?range=` | JWT | InfluxDB history — `-1h`/`-6h`/`-24h`/`-7d`/`-30d` |
| `POST /api/servers/:id/maintenance` | JWT admin | Park/unpark — `{ enabled: boolean }` |
| `DELETE /api/servers/:id` | JWT admin | Remove + revoke token |

---

## 3. Data contract

InfluxDB measurement **`server_metrics`** (ms precision, same write client as
`sensor_environment`).

- **Tags:** `device_id`, `device_name`, `location`, `os`
- **Fields:** `cpu_percent`, `mem_used_mb`, `mem_total_mb`, `mem_percent`, `disk_used_gb`,
  `disk_total_gb`, `disk_percent`, `net_bytes_sent`, `net_bytes_recv`, `uptime_seconds`,
  `process_count` (integer; the rest float)
- **Timestamp:** server-side `new Date()` — the agent's clock is ignored, as for the ESP32.

Agent posts snake_case; the handler emits **camelCase** to the browser plus a derived
`uptimeLabel`.

**Per-volume disk — `server_volumes`.** The `disk_*` fields above are the **root volume
only**. A data or log volume filling while the system drive looks healthy is the likelier
real incident, so every sample also carries `volumes[]` — one point per fixed volume, tagged
`mount`, with `total_gb` / `used_gb` / `percent`. The array is **optional** (an older agent
still ingests; absent means "not reported", not "zero volumes") and capped at **32 volumes /
120-char mounts**, because `mount` is a tag and unbounded cardinality is what kills a bucket.
Volume history is stored but **not yet charted** — the detail page shows current volumes only.

> Adding/removing a metric means updating **all** of: `metrics.go` (struct + json tags),
> `collector.go`, `serverMetricUtils.js` (`NUMERIC_FIELDS`), `serverMetricsHandler.js`
> (point + emit), `ServerMetrics.tsx` (mapping). `npm test` fails if the Go struct and
> `NUMERIC_FIELDS` drift — `contract.test.js` parses `metrics.go` to enforce it.

---

## 4. Why it behaves the way it does

Each of these replaced something that was actively wrong.

**Disk alerting uses the worst volume, not the root.** `checkThresholds` evaluates the `disk`
rule against the highest-percentage volume, so a full `D:` alerts. Still one band, one open
alert per server; the message names the mount only on multi-volume hosts.
*Before: a full data volume was invisible while `C:` looked fine.*

**The offline window follows each agent's cadence.** The agent reports `interval_seconds`,
stored in `server_specs.metric_interval_sec`; the window is `clamp(interval × 3, floor …
3600s)`. Three missed posts is the tolerance — one dropped POST must not raise a false alarm
— floored so a 1s agent doesn't get a 3s hair trigger, capped so a nonsense interval can't
disable offline detection. `NULL` reads as 10s, reproducing the old behaviour exactly.
*Before: a flat 30s, so an `-interval 60` agent flapped Offline→Online forever, with a log row and an alert every cycle.*

**Outage backfill writes history only.** Failed samples spool in memory and replay to
`/metrics/batch` when the link returns. That path writes InfluxDB and the on-site backup and
**nothing else** — no heartbeat, no status change, no threshold evaluation, no broadcast.
Alerting on an hours-old CPU spike would page someone for a condition long since passed, and
letting a backlog mark a server "Online" would resurrect a host that is still down. Each
buffered sample carries `collected_at` — the only path where the agent's clock is trusted —
clamped to `[now − 7d, now + 60s]` so a broken RTC can't write points years out. The spool is
in memory **on purpose**: a spool file would put unbounded churn on every host's flash to
cover the rarer agent-restart case.
*Result: an outage leaves a gap in the live view, but not in stored history.*

**Maintenance mode parks a server without blinding you.** While `status='maintenance'` the
sweep skips it and `checkThresholds` isn't called, but metrics are still ingested, stored and
broadcast — you keep watching the box through the work. A heartbeat **won't** flip it back to
online (the state is operator-owned), though `last_seen` still refreshes, which is how
**Resume** re-derives Online vs Offline instead of assuming Online. Both transitions re-arm
`alertBandState` so the first breach after the window alerts, and both auto-resolve any open
offline alert. Renders **blue**, not red — a parked box is not a fault, and red would hide
real outages in a sea of red. No migration needed; `'maintenance'` was already in the ENUM.
*Before: a planned reboot fired the sweep, rang the bell and sent email.*

**Static host facts refresh hourly.** IP, MAC, RAM, kernel and agent version ride along as an
optional `host` object on the first post after start and hourly after, routed to the same
`refreshHostInfo` re-enrollment uses. Best-effort, and the clock only advances on a successful
send, so a failure retries next cycle rather than waiting out the hour.
*Before: sent only at enrollment, so a DHCP change left a stale IP forever and a RAM upgrade made every derived memory figure wrong.*

**Alerting is rules-only.** Thresholds resolve from `alert_rules` (per-server override, else
global `device_id=NULL`) via `getEffectiveRules`/`nextBand`, with the band tracked in
`alertBandState` and auto-resolve on recovery. **No matching rule means silence**, by design.
*Before: 80/90 hardcoded.*

---

## 5. Socket events

| Event | When |
|---|---|
| `serverMetrics` | each metric POST — `{ server: { id, name, ip, os, location, status, volumes, cpuPercent, memPercent, memUsedMB, memTotalMB, diskPercent, diskUsedGB, diskTotalGB, netBytesSent, netBytesRecv, uptimeSeconds, uptimeLabel, processCount, timestamp } }` |
| `agentApproved` / `agentPending` | approval / register-or-reject → admin lists refresh live |
| `serverRemoved` | admin delete — `{ id }` |
| `serverStatus` | the 15s sweep flips a stale server Offline, **or** an admin parks/resumes one |
| `deviceLog` | new `device_logs` entry — `{ device_id, log_level, message, recorded_at }` |

The dashboard merges each `serverMetrics` onto the matching server by `id`; static fields
come from the initial `GET /api/servers`. Lifecycle events and CPU/Mem/Disk threshold
crossings are written to `device_logs` and shown in Server Detail's *Recent events* —
recoveries are intentionally **not** logged, which keeps the table lean with no retention job.

---

## 6. MySQL tables

| Table | Role |
|---|---|
| `devices` | one row per server (`device_type='server'`, status lifecycle incl. `maintenance`) |
| `server_specs` | os, kernel, cores, arch, memory/disk totals, agent_version, `last_seen`, uptime, **`metric_interval_sec`** |
| `device_network` | mac_address, gateway, dns, network_segment |
| `agent_tokens` | pending `token`, permanent `approved_token`, `status`, `last_used_at` |

> **Apply `migrations/2026-08-03_server_metric_interval.sql`** — adds
> `server_specs.metric_interval_sec` (§4). Idempotent and behaviour-neutral until agents
> report a cadence, but **not optional**: without it the sweep query errors on the unknown
> column.

---

## 7. Key files

| File | Role |
|---|---|
| `go-agent/` | The agent — see `go-agent/README.md` |
| `backend/middleware/agentAuth.js` | Validate agent Bearer token → `req.device` |
| `backend/services/agentService.js` | register/approve/heartbeat/read DB logic |
| `backend/handlers/serverMetricsHandler.js` | Validate + Influx write + heartbeat + emit, and the backfill batch handler |
| `backend/services/serverMetricUtils.js` | Pure helpers (validation, volume sanitising, offline-window maths, backfill clamping). **No imports** — this is what lets tests run with no MySQL/InfluxDB |
| `backend/routes/agents.js` \| `servers.js` | `/api/agents/*` \| `POST /metrics` + dashboard GETs |
| `frontend/src/pages/ServerMetrics.tsx` | Live list/gauges + admin pending-approval panel |

**Tests** — `cd backend && npm test` (`node --test`, no dependency, no database).
`serverMetricUtils.test.js` covers validation, volume sanitising, offline-window maths
(including the `-interval 60` flapping regression) and backfill clamping.
`contract.test.js` parses the Go source to catch contract drift.

---

## 8. Gotchas

- **Restart the backend after editing `.env`** — nodemon doesn't watch it. A mismatch shows
  as `Invalid install key` at register.
- **`localhost` only works on the backend's own PC** — every other machine needs the LAN IP,
  and port 3000 open. Agents cache the URL in `agent.conf`, so **pick a stable backend
  address up front** (static IP / DHCP reservation / DNS name) or every agent needs
  re-pointing later.
- **Server never appears?** You didn't Approve it. **Pending panel missing?** You're
  `it_staff`, not `admin`.
- **InfluxDB retention is a manual, one-time config action** on the InfluxDB server —
  `server_metrics` (every 10s/host) is the only high-volume store; MySQL stays tiny.
  History ranges beyond 24h are bounded by it: a 30d view on a 7d bucket shows 7d.
  ```bash
  influx bucket update --name "$INFLUX_BUCKET" --retention 60d --org "$INFLUX_ORG" --token "$INFLUX_TOKEN"
  ```
- **Network I/O on charts is derived** (MB/s from cumulative counters), so the first point of
  any range reads 0. Ranges are aggregated to ~150–200 points; 7d/30d labels include the date.
- **Offline recovery auto-resolves the open `offline` alert** on the next POST, mirroring
  `deviceAlerts.checkReachability`. Before that fix, every reboot left a permanently open
  alert inflating the sidebar badge.
- **Buffering is memory-only** — ~40 min. A longer outage, or an agent restart mid-outage,
  loses those samples.
- **Servers on UPS/battery stop reporting** unless the Scheduled Task has
  `-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`. Windows kills tasks the moment a
  machine switches to battery — exactly when you want eyes on it. The agent never exits on a
  backend outage (only on a 403), so a dead agent is almost always this. Fix in
  `go-agent/README.md` §11.
- **Never commit `agent.conf`** (holds the device token) or `.env`.
