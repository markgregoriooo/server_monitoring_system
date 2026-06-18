# SESSION_NOTES.md

---

## SESSION 1 — 2026-06-04
**Branch:** `EnvironmentMonitor`  
**Developer:** Mark Gregorio

---

### Environment Page

- X-axis labels now include year: `"Jun 04 2026 14:30"` across all ranges
- Added Grafana-style drag-select zoom: drag to create blue selection box → `ZoomRangeBox` appears with **Apply range** and **✕** actions
- Scroll-wheel zoom kept alongside drag
- `isZoomedRef` freezes live data appending while user is zoomed — no viewport jumps on new ESP32 readings
- Refresh button spins for 800ms as visual feedback (`isRefreshing` state)
- Replaced `SegBar` (32-segment line) with `GaugeArc` (canvas arc gauge) in all 4 stat panels; value now shown inside gauge center

---

### Air Conditioner — Scalable Multi-Unit Architecture

**Problem:** single in-memory `airconState` in `db.js` — no persistence, no multi-unit support, no hardware mapping.

**Database changes applied:**
```sql
ALTER TABLE aircon_state
  ADD COLUMN ir_channel TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER device_id,
  ADD UNIQUE INDEX idx_aircon_ir_channel (ir_channel);

-- Seeded 2 existing AC units in devices + aircon_state
```

**New backend file:** `backend/services/airconService.js`  
All DB logic in one place — `getAll`, `getChannelConfig`, `addUnit`, `removeUnit`, `toggle`, `setMode`, `setTemp`, `applyAutoIR`, `setChannelMap/getChannelMap`.  
`routes/aircon.js` rewritten as thin controllers.

**New socket events:**

| Event | Direction | Purpose |
|-------|-----------|---------|
| `irConfig` | server → ESP32 | push enabled channel list |
| `irChannelMap` | ESP32 → server | GPIO assignments on every connect |
| `irCommand` | server → ESP32 | manual ON/OFF on specific channel |
| `irFired` | ESP32 → server | auto IR fired; triggers DB sync |
| `airconStatus` | server → browsers | single unit state update |
| `airconAutoUpdate` | server → browsers | all units set temp updated by auto IR |

**Firmware changes:**
- Replaced `irTx1/irTx2` with 4-channel array: `IR_CHANNEL_PINS[] = {25, 33, 32, 15}`
- `enabledChannels[]` updated at runtime via `irConfig` — no reflash to add/disable units
- Added mock `IR_POWER_ON[]` + `IR_POWER_OFF[]` arrays
- `irFired` emitted after auto zone-based IR fires; queued and retried if socket was down during warmup

**Frontend changes:**
- Add Aircon modal shows GPIO labels per channel from `irChannelMap` (IN USE / AVAILABLE)
- Manual **Turn On / Turn Off** button per card
- Delete button (admin only)
- `last_trigger = NULL` on registration (nothing was triggered yet)
- `triggered_by_user_id` set correctly on manual toggle; `NULL` on auto IR
- Removed `airconState`/`airconLog` from `data/db.js` — fully migrated to MySQL

---

### UI/UX Overhaul — Grafana Style

- `index.css`: full `--gf-*` token set, JetBrains Mono font, light mode overrides
- `Sidebar.tsx`: flat dark bg, SVG icon per nav item, GF active state (left blue border), theme toggle
- `Header.tsx`: slim 40px topbar, breadcrumb navigation (`CSPC-ICTU / Page Name`), live ping
- `Dashboard.tsx`: all panels use `--gf-*` tokens, `2px` radius, GF dividers
- `AirConditioner.tsx`: shared `RoomPanel` with temp + humidity gauges shown **once** at top (not per card); compact 5-column stat row per card; full GF styling

**Still pending:** ServerMetrics, History, Reports, Settings, UserManagement still use old `slate-*` classes.

---

### ESP32 Firmware — Other Fixes

- **Buzzer:** 8-bit → 10-bit LEDC resolution (8-bit caused hoarse sound); `buzzerOff()` now uses `ledcWrite(pin, 0)`
- **Timestamp:** NTP sync added after WiFi connect (`pool.ntp.org`, UTC+8); `getTimestamp()` tries RTC → NTP → uptime fallback (`UP HH:MM:SS`)
- **InfluxDB:** write client precision explicitly set to `"ms"`

---

### Bugs Fixed

| Bug | Fix |
|-----|-----|
| Aircon routes used `"staff"` not `"it_staff"` | Fixed in new `aircon.js` |
| `triggered_by_user_id` always NULL on toggle | Added to UPDATE query in `toggle()` |
| `last_trigger = 'manual'` on unit registration | Changed to `NULL` |
| ESP32 sends uptime as timestamp (`00:16:35`) | NTP sync added |
| InfluxDB precision not set | Set to `"ms"` in `influx.js` |

---

## SESSION 2 — 2026-06-05
**Branch:** `EnvironmentMonitor`
**Developer:** Mark Gregorio

---

### Auth — System Logs IP / User-Agent  *(resolves SESSION 1 to-do)*

- `system_logs` already had `ip_address` + `user_agent` columns — code just never populated them.
- Added `getClientInfo(req)` in `routes/auth.js` → `{ ip: req.ip, userAgent: req.get("user-agent") }`; spread into login + passed to logout.
- `authService.login` / `logout` now accept `{ ip, userAgent }` (default `null`) and write both into the `system_logs` INSERTs (login + logout).
- Relies on `trust proxy = 1` (already set) so `req.ip` honors `X-Forwarded-For`.

### Auth — Login switched from username → email

- `authService.login` now looks up `WHERE email = ?` (trimmed + lowercased); all error messages say "email".
- Frontend: `Login.tsx` now has an email field (`type="email"`), `api.login(email, password)` posts `{ email, password }`, `AuthContext` signature updated.
- Safe: `users.email` is `UNIQUE NOT NULL`, so it resolves to exactly one user.

### Rate Limiters

- **Login limiter** (`routes/auth.js`): fixed misleading message (said 5 min, window is 15); aligned `standardHeaders` to `draft-8`; now keyed per-account via `keyGenerator` = `ipKeyGenerator(req.ip, 56) + ":" + email` so a shared NAT can't lock out everyone and an attacker can't pivot accounts.
- **Global limiter** (`src/server.js`): `max` 200 → 500 (~33 req/min per IP) for multi-panel page loads.
- **Note:** the global Express limiter does **NOT** cover Socket.IO — socket.io intercepts `/socket.io/` before Express, so `changeRange` / `sensorData` events are unthrottled. Potential `changeRange` → InfluxDB DoS vector; per-socket throttle in `connectionHandler.js` still TODO.

### UI — Grafana Dashboard redesign (`Dashboard.tsx`)

- Real toolbar: working **Live/Pause** toggle (freezes ingestion via ref guard), time-range pill, refresh pill, live clock.
- `StatPanel`s with **sparkline backgrounds** (new `Sparkline` canvas), radial gauges (CPU/Mem), **gradient `BarGauge`** per host, server table, alert annotation rows, AC units grid.

### UI — Air Conditioner redesign (`AirConditioner.tsx`)

- Matched the new Dashboard language: toolbar (ESP32 ONLINE/OFFLINE pill, LIVE, clock, Add Aircon), stat-panel row with sparklines (Temp / Humidity / Units Online / Active Mode), shared `Panel` chrome for unit cards, activity-log annotation rows.
- **Bug fixed:** `next[+id] = [entry, ...next[+id]]` → `...(next[+id] ?? [])` (TS2488 under `noUncheckedIndexedAccess`).

### Timestamp fixes

- `Header.tsx` clock was computed once per render (stale) → now ticks every 1s via `useState` + `setInterval`.
- Pinned all clocks to `timeZone: "Asia/Manila"` (Header, AirConditioner, Dashboard) — `"en-PH"` only sets format, not zone.

### Notes

- Explored compacting the Environment top stat boxes (drop gauge + sparkline to match Dashboard); **reverted at request** — no net change to `Environment.tsx`.

---

## SESSION 3 — 2026-06-06
**Branch:** `EnvironmentMonitor`
**Developer:** Mark Gregorio

> Focus: finalize + commit the **Environment feature** (sensor pipeline + page). Other
> explorations this session (security audit, code-duplication audit, a Grafana restyle of
> the remaining slate pages) were **not** committed — the page restyle was reverted to the
> original UI at request; only the redundant page-header labels were removed.

### Environment feature — committed

- **InfluxDB bucket no longer hardcoded.** `config/influx.js` now exports `bucket`
  (from `INFLUX_BUCKET`); `querySensorHistoryHandler.js` interpolates it into both Flux
  queries (`from(bucket: "${bucket}")`). Reads + writes always target the same bucket — a
  change to `INFLUX_BUCKET` no longer silently breaks history.
- **Live data resumes after browser refresh** (`context/AuthContext.tsx`). The socket had
  `autoConnect:false` and was only connected inside `login()`, so a refresh left it
  disconnected (no live sensor data until re-login). Added a `useEffect` that connects the
  socket on mount when a session is restored from `sessionStorage`, and disconnects on logout.
- **Environment chart — mobile.** X-axis date renders as `mm/dd/yyyy` on narrow screens
  (`toNumericDate`), `maxTicksLimit` 7→4 and smaller font under 640px (`matchMedia`).
- **Custom time-range modal — mobile.** FROM/TO stack vertically (`grid-cols-1 sm:grid-cols-2`),
  dividers flip from right→bottom, modal scrolls (`max-h-[90vh] overflow-y-auto`).
- **Redundant page-header labels removed** (the global `Header` already shows the breadcrumb
  + live clock per route): Environment in-page breadcrumb (`CSPC-ICTU / Environment
  Monitoring / DHT11 · 2× MQ-2`), Dashboard time/interval/clock pills, AirConditioner
  LIVE pill + clock + title. (Dashboard/AirConditioner changes not part of the env commit.)
- **New:** `Environment.md` — full guide to the environment + IR/aircon system (hardware,
  sensor status logic, InfluxDB pipeline, socket events, dev tasks, gotchas).

### Repo hygiene

- `.gitignore`: added `backend/uploads/` (user-uploaded images were untracked and would
  otherwise be committed).
- Removed unused scaffolding created earlier this session: `components/ui/Panel.tsx`,
  `theme/gfTokens.ts`, `backend/utils/{auditLog,constants}.js`, and the `gf-*` color block
  in `tailwind.config.js`. (`utils/format.ts` kept — used by `ProfileModal`.)

### Still pending / not in this commit

- Mock NEC IR data in firmware still needs real captures (ignored for now).
- Security hardening (token_version session revocation, etc.) and the code-duplication
  cleanup are documented under `audits/` but **not** committed — they need the
  `token_version` DB migration to deploy, so they're staged for a separate change.
- 3 pre-existing TS type warnings in `Environment.tsx` chart code (non-blocking under Vite).

---

## SESSION 4 — 2026-06-06
**Branch:** `server-metrics`
**Developer:** Mark Gregorio

> Focus: new **Server Metrics** feature — a Go monitoring agent that collects system
> metrics and feeds the dashboard. Also recovered the Environment work on this branch
> (it had branched from `main` before that commit landed).

### Branch recovery (Environment data was "missing")

- `server-metrics` was branched from `main` at `e381439`, **before** the Environment
  commit `637bc48` existed — so live + smoke data appeared "gone" (working tree reverted
  to the old mock pipeline).
- `origin/main` already had `637bc48`; **fast-forwarded** `server-metrics` to it
  (`git merge --ff-only origin/main`) → Environment code (live + smoke) restored.
- ⚠️ **Still uncommitted:** a large Sessions 1–2 pile (airconService, `backend/server.js`
  → `src/server.js` move, Grafana UI overhaul, `env_monitor_v2.ino`, `CLAUDE.md`, schema
  rename — 42 staged files) lives only in the index, not in any commit. At-risk until committed.

### Server Metrics — Go agent (new `go-agent/`)

- Standalone Go program, module `cspc-ictu/go-agent`, Go 1.22, deps `gopsutil/v3` +
  `godotenv` only. Collects CPU (500ms blocking sample), mem, disk (`/` or `C:\`), net
  bytes, uptime, process count → POSTs snake_case JSON to `POST /api/servers/metrics`
  every 10s with a Bearer token. Retries 3× w/ backoff; never crashes on outage.
- Two modes: `--register` (enroll → poll `/api/agents/status` → write `agent.conf`) and
  normal loop. Cross-compiles via `make all`; systemd (`install.sh`) + Windows
  scheduled-task (`install.ps1`) installers. `agent.conf` (token) is gitignored.
- Verified: `go vet` clean, `gofmt` clean, **builds** (go1.26), runs (graceful on missing conf).

### Server Metrics — backend integration

- **New:** `middleware/agentAuth.js`, `services/agentService.js`,
  `handlers/serverMetricsHandler.js`, `routes/agents.js`. **Replaced:** `routes/servers.js`
  (real DB reads + `POST /metrics`). **Edited:** `src/server.js` (mount `/api/agents`,
  **removed the mock SNMP `setInterval`** that emitted fake `serverMetrics` every 5s).
- Adapted to the **actual V9 schema** (normalized `devices` + `server_specs` +
  `device_network` + `agent_tokens`), not the spec's flat `devices` columns → **no migration**.
- InfluxDB measurement `server_metrics` via the shared `writeClient`; server-side timestamp.
- Enrollment: register (install key) → admin approve (`requireRole("admin")`) → `AGT-…`
  token. `agent_tokens.last_used_at` is `NOT NULL` → set on insert.
- **`.env`:** added requirement for `AGENT_INSTALL_KEY` (shared install key).
- Verified: all 6 files pass `node --check` + import-resolution against `.env`.

### Server Metrics — frontend

- `api.ts`: added `getPendingAgents`, `approveAgent`, `rejectAgent`.
- `ServerMetrics.tsx`: real `getServers` mapping, single-device live `serverMetrics`
  merge (by id), and an **admin-only pending-approval panel** (hidden for it_staff via 403).
- Verified: `tsc --noEmit` shows **0 new errors** (only the 3 pre-existing `Environment.tsx` ones).

### New doc

- `server-metrics.md` — full guide (agent, enrollment/auth, data contract, socket events,
  MySQL tables, dev tasks, gotchas).

### Still pending / limitations

- Live end-to-end round-trip **not yet run** (needs MySQL + InfluxDB + the `.env` key + a
  running agent); code builds/type-checks at every layer.
- Per-server **history charts** in `ServerDetail.tsx` are still generated mock series —
  real history needs an Influx query endpoint for `server_metrics`.
- **No offline sweep** — a server stays `online` after approve/last metric; nothing flips
  it `offline` when its agent stops (a `last_seen` staleness check is the follow-up).
- Data contract duplicated in `go-agent/internal/collector/metrics.go` ↔
  `backend/handlers/serverMetricsHandler.js` (must stay in sync).

### Server Metrics — iterative fixes & UX (same session, after first live test)

**Now verified live** end-to-end on Windows (agent → backend → InfluxDB/MySQL → dashboard),
both manual run and the Scheduled-Task **service install** (runs as SYSTEM, survives terminal
close, auto-starts at boot; install.ps1 needs an **elevated** PowerShell).

Agent / enrollment UX:
- `--register` now **enrolls → waits for approval → continues straight into the metric loop**
  (one command, no separate run step). Added **`--register-only`** (enroll + exit) for installers.
- On removal (token revoked → **403**), the agent **deletes its own `agent.conf` and exits on
  the first 403** → re-adding is a clean `--register`. A rejected *pending* agent detects the
  **404** (token gone) and exits "rejected or removed".
- **Gateway + DNS** collected natively, **no new dependency** (`Get-NetRoute` / `/proc/net/route`,
  `Get-DnsClientServerAddress` / `/etc/resolv.conf`). Tried `jackpal/gateway` but it forced
  Go ≥1.26 — reverted to keep Go 1.22. Re-register refreshes host/network info.

Backend:
- **Live list = approved only** — `getServers` INNER JOINs `agent_tokens status='approved'`
  (pending/rejected no longer leak into the list).
- **Reject now deletes** the pending device (cascade) instead of marking it offline; register
  **and** reject emit **`agentPending`** so the pending panel updates live (no refresh).
- **Latest-metrics cache** in `agentService` → `GET /api/servers` returns current cpu/mem/disk
  immediately on refresh (no ~10s blank).
- **Remove server**: `DELETE /api/servers/:id` (admin) → cascade-delete + revoke token + emit
  `serverRemoved`.

Frontend:
- **Fixed white-screen every 10s**: `Dashboard.tsx` still consumed the old `{servers:[]}` shape;
  the emit changed to a single-device `{server}` when the mock SNMP loop was removed, so
  `data.servers` was `undefined` → `.map` crash. Now merges by id. (Same root cause as the
  earlier intermittent blank-screen reports.)
- ServerMetrics: admin **Remove** button + live `serverRemoved` / `agentPending` handlers.

Deployment / docs:
- Cross-compiled binaries bundled into USB folders **`cspc-ictu-agent-windows/`** +
  **`cspc-ictu-agent-linux/`** (binary + installer + `RUN-ME.txt`).
- `server-metrics.md` expanded: §2 run/test guide (same-PC, other machine via USB, service
  install w/ elevation), §2.6 remove/decommission, §2.7 **production checklist** (stable
  address, HTTPS, hardcoded endpoints, CORS, install key). `install.sh` → `Restart=on-failure`.

Design note: the agent self-deleting `agent.conf` on removal is a **convenience**, not a
security control — the real boundary is server-side token revocation (Remove → `agent_tokens`
row deleted → all POSTs `403`). Chosen deliberately over the more conventional "stop but keep
config" because it makes re-enrollment a clean one-shot `--register`.

### Server Metrics — real history, device events & Grafana UI (same session, later)

**Real per-server history (mock-charts limitation resolved):**
- New `GET /api/servers/:id/history?range=-1h|-6h|-24h` (`handlers/serverHistoryHandler.js`) —
  Flux query on `server_metrics` filtered by `device_id`, aggregated (20s/2m/10m windows).
- `ServerDetail.tsx` charts now plot **real timestamps** (replaced the `genHistory` mock) with a
  **range selector** + **live append** from the `serverMetrics` socket. Network I/O is **derived
  MB/s** from the cumulative byte counters (first point reads 0).

**Device event log (`device_logs`):**
- `agentService.logDevice` / `getDeviceLogs` / `checkThresholds` (+ `recordHeartbeat` returns
  `cameOnline`). Logs **registered** + **approved** (lifecycle) and CPU/Mem/Disk **warning ≥80% /
  critical ≥90%** crossings with a **70–80% hysteresis** band. **Recoveries are NOT logged** — keeps
  the table lean, so **no retention job is needed**.
- New `GET /api/servers/:id/logs`, a live **`deviceLog`** socket event, and a **"Recent events"**
  panel on `ServerDetail`. `agentPending` is emitted on register/reject for live pending updates.

**Mock data removed → server metrics is 100% real:**
- Deleted `frontend/src/data/mockData.ts` (entirely unused). Backend `data/db.js` servers + SNMP
  loop were already gone. Sources: list = MySQL, live = agent, history = InfluxDB.

**UI/UX overhaul:**
- `ServerMetrics.tsx` rebuilt as a **Grafana dashboard** — `--gf-*` tokens (matches `Dashboard.tsx`),
  StatPanels with live sparklines, per-host `BarGauge` panels, Grafana table with **click-to-expand
  drawer** (restored), responsive **mobile card** view, softened to `rounded-lg` boxes.
- `ServerDetail.tsx` — fixed **light-mode** InfoCard white-on-white text (broken `text-white …
  text-slate-900` pattern → proper `base + dark:`), mobile layout (truncation, top-row height), and
  removed the cluttered `0`/`100` radial-gauge labels.

**Verification:** backend `node --check` + import-resolution clean; frontend `tsc` shows only the 3
pre-existing `Environment.tsx` warnings.

**Open best-practice item:** set an **InfluxDB bucket retention policy** (e.g. 30–90 days) for
`server_metrics` — the only high-volume store. MySQL tables stay bounded/tiny. (Config, not code.)

### Chart smoothing + network-portable backend URL (same session, later)

**Smoother live charts:**
- Added a `smooth()` light moving-average (≈5-sample / ~15s window) so the **raw live**
  readings render as a flowing curve like the *aggregated* Server Detail charts.
- Applied to **Dashboard** (temp + humidity) and **Environment** (temp, humidity, **and both
  MQ-2 smoke lines**), and bumped Environment `tension: 0.3 → 0.4`. Smoke smoothing is
  **visual-only** — `smoke_status`/alerting is computed from raw values on the ESP32/backend.

**Backend URL no longer hardcoded (roam between networks with no edits):**
- New `frontend/src/config.ts` — single source of the backend URL. **Auto-detects** from the
  page's own host on port 3000 (`window.location`), so the dashboard follows whatever IP you
  open it from. Override with `VITE_API_URL` in `frontend/.env` (pin host / HTTPS).
- `api/client.ts` + `socket/socket.ts` now import `API_URL` from config (removed the hardcoded
  `192.168.100.9`). Added `vite-env.d.ts` (types) + `frontend/.env` / `.env.example`.
- Backend `src/server.js`: `WEB_ORIGIN` CORS now supports **`*`** (allow any origin) and is
  **crash-safe** — `(process.env.WEB_ORIGIN ?? "").trim() || <localhost+LAN default>`, so a
  missing **or blank** value falls back to the secure default instead of crashing / locking out.
  Startup log no longer prints a hardcoded IP.
- **Net effect:** set `WEB_ORIGIN=*` once in `backend/.env` → roaming networks needs **zero**
  IP edits (frontend auto-detects; backend accepts any origin). `CLAUDE.md` updated; ESP32
  firmware host is still hardcoded (separate device).

---

## SESSION 5 — 2026-06-07
**Branch:** `server-metrics`
**Developer:** Mark Gregorio

---

### Windows agent — service survives reboot on battery/UPS

- **Bug:** agent installed as a Scheduled Task stopped reporting after the host was shut
  down and reopened. Root cause = `New-ScheduledTaskSettingsSet` **defaults**
  (`DisallowStartIfOnBatteries`/`StopIfGoingOnBatteries` both true, 72h `ExecutionTimeLimit`):
  Windows won't start an `-AtStartup` task on battery and kills it when power flips to battery
  — which also hits a **server on a UPS** during an outage.
- **Fix:** both `install.ps1` (source + `dist/cspc-ictu-agent-windows/`) now register with
  `-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0`. Documented in
  `server-metrics.md` §2.4 + §10 (with an elevated `Set-ScheduledTask` one-liner to fix tasks
  made by an older installer) and the Windows `RUN-ME.txt`. Linux/systemd unaffected (no
  battery gating). Docs reworded "laptop" → "server"/UPS for the deployment audience.

### Offline detection (resolves the "no offline sweep" limitation)

- **Bug:** a stopped agent's server stayed **Online** forever on the Dashboard + Server Metrics
  pages. Status was only ever written `online` (on approve + each metric); nothing flipped it
  back, and the live UI only changes status via socket events.
- **Backend** (`services/agentService.js`): added `OFFLINE_AFTER_SEC = 30` + `isStale()`.
  `withLive()` now reports **Offline with zeroed live metrics** when `last_seen` is stale, so
  `GET /api/servers` is correct even right after a backend restart. New `sweepOffline()` flips
  approved+stale `online` rows to `offline`, clears the metric cache, re-arms `alertState`, and
  logs a `device_logs` "went offline" entry — returning only the rows that *just* transitioned.
- **`src/server.js`:** a 15s `setInterval` runs `sweepOffline()` and emits a new
  **`serverStatus` `{ id, status:"Offline" }`** event (+ `deviceLog`) so both pages update live.
- **Frontend:** `ServerMetrics.tsx` + `Dashboard.tsx` handle `serverStatus` (set Offline + zero
  cpu/mem/disk). Recovery is automatic — the next metric POST emits `serverMetrics` with
  `status:"Online"`. `StatusBadge`/`StatusDot` already render non-Online as red, no change.
- **Verified:** backend `node --check` clean; `tsc --noEmit` shows only the 3 pre-existing
  `Environment.tsx` warnings.

### Aircon — manual OFF now respected over auto IR

- **Bug:** turning an aircon OFF didn't stick — `applyAutoIR` set `is_on=1` for **all** units on
  every temperature zone change, and the frontend `airconAutoUpdate` forced `enabled:true` on all
  units, so a manually-off unit got silently switched back on by the next IR trigger.
- **Fix (`airconService.applyAutoIR`):** auto IR now only **re-targets the set temperature of
  units that are currently ON** (never touches `is_on`); on/off is **manual-only**. It returns the
  affected `deviceIds`. `connectionHandler` forwards them in `airconAutoUpdate`.
- **Fix (`airconService.toggle`):** also syncs **`devices.status`** to the power state
  (`online`/`offline`) — it was stuck `'online'` forever after register (only `aircon_state.is_on`
  flipped). Existing rows reconciled in-place (0 needed it — both units were on/consistent).
- **Fix (`AirConditioner.tsx`):** `airconAutoUpdate` updates only the returned `deviceIds` (no more
  blanket `enabled:true`), so an off unit stays off. Also keep the **Uptime** card field in step
  with on/off on toggle (`handleUnitToggled` + the `airconStatus` handler) so it no longer reads a
  stale duration until refresh. (Dashboard already ignored `airconAutoUpdate`, so it was unaffected.)
- **Verified:** backend `node --check` clean; `tsc` only the 3 pre-existing `Environment.tsx` warnings.

### Still pending / not done

- `ServerDetail.tsx` (drill-down) doesn't yet handle `serverStatus` live — its status is correct
  on open via `GET /api/servers/:id`, but won't flip to Offline while you're already viewing it.
- Live end-to-end of the offline flip not yet run (needs a real agent stop); code builds/types.
- Dashboard aircon cards don't live-update `setTemp` from auto IR (they don't listen to
  `airconAutoUpdate`); correct on refresh. On/off status is live and correct.

---

## SESSION 6 — 2026-06-08
**Branch:** `server-metrics`
**Developer:** Mark Gregorio

> Focus: documentation for the Go agent (for a Go-unfamiliar reader), standardizing the
> metric interval, making the Server Detail page fully live, and adding **auto-logout on
> JWT expiry** (a missing frontend reaction — the backend already rejected expired tokens).

### Server Detail page — now fully live  *(resolves SESSION 5 pending item)*

- **Bug:** the Server Detail gauges (CPU/Mem/Disk/uptime/status) were a **frozen snapshot**
  taken when "View" was clicked. `ServerMetrics.tsx` only updated its `servers` array on
  socket events, never `detailServer`, so the prop handed to `ServerDetail` never changed.
  Only the charts moved (they have their own `serverMetrics` listener); the gauges sat stale.
- **Fix (`ServerMetrics.tsx`):** `onMetrics` now also `setDetailServer((d) => d && d.id === id
  ? mergeLive(d, data.server) : d)` (reuses the same `mergeLive` mapping as the list), and
  `onStatus` applies one shared transform to **both** `servers` and `detailServer` so an
  offline flip zeroes the detail gauges live too. `id` is unchanged, so `ServerDetail`'s
  history effect doesn't re-fetch — only the values refresh. This also covers the SESSION 5
  "ServerDetail doesn't handle `serverStatus` live" gap.

### Metric interval standardized to **10s** (doc/comment drift removed)

- The agent code default was **already 10s** (`main.go` `flag.Int("interval", 10)`), but
  `RUN-ME.txt` (×2) and a few `agentService.js` comments said **30s** — confusing "why does
  it update every 30s?". Chose 10s (Telegraf default on an InfluxDB stack; Prometheus/Datadog
  ~15s) and removed the drift: fixed 3 comments in `agentService.js` and "every 30 seconds" →
  "every 10 seconds" in both `RUN-ME.txt`. The 30s **offline window** (`OFFLINE_AFTER_SEC`,
  ≈3 missed posts) is legitimate and left as-is.
- Note: a host already enrolled with `INTERVAL_SECONDS=30` keeps that until its `agent.conf`
  is edited (+ service restart) or it re-registers — config, not code.

### Auto-logout on session expiry (new — best-practice SPA pattern)

- **Gap:** an expired JWT did **not** log the user out. Backend correctly returns 403
  "Invalid or expired token." (`middleware/auth.js`), but the frontend had no response
  interceptor and `ProtectedRoute` gates on the `user` object (restored from `sessionStorage`),
  not token validity — so the UI stayed "logged in" and silently failed every request.
- **Reactive (`api/client.ts`):** added an axios **response interceptor** that emits a
  `cspc:session-expired` window event on **401** or **403 "Invalid or expired token."**
  Deliberately ignores **403 "Insufficient permissions."** (valid user, forbidden action) and
  the `/auth/login` + `/auth/logout` requests. One-shot guard collapses a burst of parallel
  401s; window event keeps the axios module free of React (no circular import).
- **Proactive (`context/AuthContext.tsx`):** decodes the JWT `exp` and schedules logout at the
  exact expiry, so an **idle tab** doesn't linger on a dead token. Added `clearLocalSession`
  (no server round-trip), a listener for `cspc:session-expired` (guarded on `cspc_user` so
  stray post-logout events no-op), and `decodeJwtExp`/`readToken` helpers. `login()` clears the
  notice flag + re-arms the interceptor guard. Setting `user=null` makes `AppShell` redirect to
  `/login` automatically.
- **Notice (`pages/auth/Login.tsx`):** amber "Your session expired. Please sign in again."
  banner after an auto-logout. **StrictMode bug fixed:** the flag was first read+removed inside
  the `useState` initializer; StrictMode double-invokes initializers in dev so the 2nd run wiped
  the flag → no banner. Now the initializer only **reads** (pure) and a `useEffect` clears it.
- **Verified:** all four touched frontend files report **0 diagnostics** (IDE TS server).

### Go agent documentation (`go-agent/README.md`)

- Rewrote the terse README into a **Go-beginner-friendly** reference: architecture + lifecycle
  diagrams (enroll → poll → approve → run; decommission 403 self-delete), a 5-min Go primer,
  the HTTP contract (endpoints/headers/auth/retries), the `ServerMetrics`/`HostInfo` data
  contracts, a file-by-file walkthrough, `agent.conf`, resilience rules, and "add a metric".
- Added **§10 "How it's compiled & shipped (build once, run anywhere)"** — what `go build` does
  (source + deps + runtime → one self-contained binary, proven with strings extracted from the
  shipped `.exe`), why a target needs no Go/source, why 3 OS/CPU binaries, why each installer
  folder bundles the binary, and how to peek inside (`go version` / `go tool nm`). Answers the
  recurring "what is the binary / install.ps1 vs the .exe / why no source on the target" Qs.

### Deployment docs — `RUN-ME.txt` (both folders)

- Added a **"downloaded from Google Drive / the internet"** path for Windows: run
  `Get-ChildItem -Recurse | Unblock-File` first (mark-of-the-web), plus the SmartScreen
  "More info → Run anyway" note for the unsigned `.exe`. Linux note: no unblock needed, the
  existing `chmod +x` restores the execute bit.
- Expanded the privacy note: keep the folder private on Drive too (share to specific people,
  **not** "Anyone with the link"), and **never upload `agent.conf`** (holds a device token).
- Clarified (in chat + matches the files) that `install.ps1` is a **setup script** that copies
  the binary into `C:\Program Files\cspc-agent\` and registers the service — you run **only**
  `install.ps1` (it runs the `.exe` for you), not both; the folder can live anywhere.

### Still pending / not done

- Auto-logout live end-to-end relies on a real 1h expiry; verified instead by corrupting
  `cspc_token` in DevTools (Console: `sessionStorage.setItem("cspc_token", '"broken"')`) +
  navigate → lands on `/login` with the banner. Optional follow-ups offered but not done:
  `.env`-configurable `JWT_EXPIRES_IN`, and a "session expiring soon — stay signed in?" prompt.
- `CLAUDE.md` socket table still lists the removed mock `serverMetrics` "every 5s (simulated
  SNMP)" row — stale, not updated this session.
- If the `dist/cspc-ictu-agent-*` folders are ever re-assembled from scratch, the updated
  `RUN-ME.txt` files must be copied back in (no script generates them).

---

## SESSION 7 — 2026-06-09
**Branch:** `server-metrics` → merged to `main`, then new branch `google-oauth`
**Developer:** Mark Gregorio

> Two parts: (1) reviewed + hardened the Server Metrics feature and shipped it (committed +
> merged to `main`); (2) started the **Google OAuth login** redesign on a fresh branch.

### Server Metrics — review fixes (committed in `5f5a084`, merged to `main`)

- **Agent POSTs off the browser rate-limit budget.** `/api/servers/metrics` got its own
  `metricsLimiter` (1000/15min/IP, `routes/servers.js`); the global limiter now `skip`s that
  path (`src/server.js`). Prevents a NAT'd fleet of agents from 429-ing the dashboard.
- **Offline servers no longer show stale uptime** — `withLive()` returns `uptime:null` when
  offline; the `serverStatus` Offline handlers in `ServerMetrics.tsx` + `Dashboard.tsx` zero it.
- **Accurate network history** — `serverHistoryHandler` aggregates the cumulative net counters
  with `last()` (split Flux: gauges use `mean`, counters use `last`) so derived MB/s is exact.
- **Unknown-host metric refetch** (`ServerMetrics.tsx`) + **fixed-interval (10s) aggregate
  sparkline sampling** (was per-socket-push, non-uniform) + **`:id` param validation** on the
  server detail/logs routes. InfluxDB retention documented as a one-time `influx` CLI step.
- **Committed the whole uncommitted Sessions 1–6 pile** (`git add -A`, 85 files) → `5f5a084`,
  pushed, **fast-forwarded `main`** (clean, no conflicts). Hygiene verified: no secrets/binaries.

### Google OAuth login — new feature (branch `google-oauth`, NOT yet committed)

**Decision:** login becomes **Google OAuth (OIDC) only** — password/bcrypt login retired.
Self-register → admin approve/reject, restricted to CSPC domains. Mirrors the Go-agent
enrollment approval pattern. Full design + setup in new **`google-oauth.md`**.

- **Backend:** `services/googleAuthService.js` (verify Google ID token via `google-auth-library`,
  enforce `@cspc.edu.ph`/`@my.cspc.edu.ph` + `email_verified`, login-or-create-pending). New
  `POST /api/auth/google` (the only login path; removed `/auth/login` + `loginLimiter`).
  `authService.issueSession()` extracted from the old `login()`. `userService` gained
  `findByEmail`/`registerGoogleUser`/`linkGoogleSub`/`listPending`/`approveUser`/`rejectUser`.
  `routes/users.js`: `GET /users/pending`, `POST /users/:id/approve` (role), `/reject` — emit
  `userPending`/`userApproved`.
- **DB migration** `migrations/2026-06-09_google_auth.sql` — `hash_password` nullable, `status`
  enum +`pending`/`rejected`, new `google_sub` + `auth_provider`, and a bootstrap `UPDATE` to
  flip the existing admin active (**edit the email placeholder before running**).
- **Frontend:** `@react-oauth/google` `GoogleOAuthProvider` in `main.tsx`; `Login.tsx` rewritten
  to a "Continue with Google" button with pending/rejected/disabled messaging;
  `AuthContext.loginWithGoogle()`; `api` calls; a **Pending registrations** panel in
  `UserManagement.tsx` (approve w/ role dropdown + reject, live via socket). `client.ts`
  interceptor ignore-list updated `/auth/login` → `/auth/google`.
- **Env:** `GOOGLE_CLIENT_ID` + `GOOGLE_ALLOWED_DOMAINS` (backend), `VITE_GOOGLE_CLIENT_ID`
  (frontend). Google Cloud project is **External + Testing** (not under CSPC Workspace, so no
  Internal) — only Test users can sign in until published.
- **Verified:** backend `node --check` + import-chain resolve clean; frontend `tsc` shows only
  the 3 pre-existing `Environment.tsx` warnings. **Live login NOT yet run** — needs the migration
  applied (with the admin email) + both servers restarted.

### Still pending / not done

- **Run the migration + restart servers + live-test** the Google login (admin login, then
  register a 2nd CSPC account → pending → approve).
- **Vestigial password UI** left in place (User Management "Add User"/"Reset PW", Profile
  "Change Password") — harmless under Google-only; flagged for removal.
- `google-oauth` branch is uncommitted.

---

## SESSION 8 — 2026-06-09  *(same day, cont. of Session 7)*
**Branch:** `google-oauth`
**Developer:** Mark Gregorio

> Took the Google OAuth feature from "builds/typechecks" to **verified-working on desktop**,
> then iterated heavily on the sign-in UX, a token-flow change, several bug fixes, and a Grafana
> restyle of the auth-related pages. Full guide kept current in `google-oauth.md`.

### "CSPC Mail" button → switched ID-token flow to access-token flow

- Google's **official** Sign-in button can't show custom text, so the login button couldn't say
  "CSPC Mail". Replaced `<GoogleLogin>` with a **custom button** wired to `useGoogleLogin`
  (implicit flow) → returns a Google **access token** (not an ID token).
- **Backend (`googleAuthService.authenticate`)** now verifies the **access token** via
  `client.getTokenInfo()`, **checks `aud === GOOGLE_CLIENT_ID`** (anti-replay), and fetches
  name + photo from the **`userinfo`** endpoint — instead of `verifyIdToken`. Still **no client
  secret / no Console change** (public client ID only). `routes/auth.js` reads `{ access_token }`;
  `api.ts` posts `access_token`; `AuthContext.loginWithGoogle(accessToken)`.

### Bug fix — "Your Google email is not verified" for everyone

- tokeninfo returns `email_verified` as the **string `"true"`**, not a boolean; the check
  `=== true` failed for all accounts (incl. the admin). Now accepts `true` **or** `"true"`.

### Bug fix — approved Google users showed no profile photo

- Backend stored the Google photo URL in `profile_image`, but every avatar render did
  `` `${API_URL}${profile_image}` `` (only valid for uploaded files) → broke the absolute Google
  URL. Added **`avatarUrl()`** in `utils/format.ts` (absolute URL → as-is; relative → prefix
  backend URL; empty → initials) and applied it in **Header, Sidebar, ProfileModal,
  UserManagement** (+ `referrerPolicy="no-referrer"` to avoid Google 403s).

### UserManagement — "Invited" status (resolves "always Active" complaint)

- An approved account showed green **Active** even before its first login (approve sets
  `status='active'`). `StatusBadge` now derives login state from `last_login`:
  active + never-logged-in → **"Invited"** (blue); flips to **Active** on first login. Disabled
  accounts still read **Inactive**, so the two stay distinct (no DB/semantic change).

### UI — Grafana restyle of auth pages

- **`Login.tsx`** rebuilt in `--gf-*` tokens (panel chrome, 2px radius, JetBrains Mono, status
  colors), Grafana-blue spinner, mobile-responsive (`sm:` breakpoints, full-width button). A
  first-time guide note was added then **removed at request**.
- **`UserManagement.tsx`** fully converted from `slate-*`/`dark:` to `--gf-*` (StatPanels,
  panel chrome table, status/role pills, gf-styled modals/toast). **Removed the "Add User"
  feature** entirely (button + modal + state + `handleAdd`) — meaningless under Google-only.

### Cleanup — `Environment.tsx` is now type-clean

- Fixed the **3 long-standing pre-existing TS warnings** (a possibly-undefined index in
  `parseLabelToISO`, and two Chart.js `ticks.color` callbacks returning a `[date,time]` color
  array the typings reject). `tsc --noEmit` is now **fully clean** across the frontend.

### Mobile testing via tunnel (explored, then reverted)

- Google sign-in won't run on a raw-IP / `http` origin, so phone login needs an HTTPS origin.
  Set up a **Cloudflare quick tunnel** (one tunnel + a Vite dev proxy for `/api` + `/socket.io`
  so a single HTTPS origin covers both servers) and verified mobile login worked.
  User found it too involved for now → **reverted** `vite.config.ts` (proxy/allowedHosts removed),
  `VITE_API_URL` back to blank, `WEB_ORIGIN` back to the localhost default. cloudflared stays
  installed but idle.

### Docs

- **`google-oauth.md`** rewritten to the access-token / custom-button reality (flow diagram,
  `getTokenInfo`+`aud`+`userinfo`, the `email_verified` gotcha, avatar handling, "Invited",
  origin_mismatch/cache troubleshooting, mobile note). **`CLAUDE.md`** auth section already
  covers the model.

### Verified

- Backend `node --check` + import-chain clean; frontend **`tsc --noEmit` fully clean (0 errors)**.
- **Live desktop login confirmed working** (admin account). Hit + fixed `origin_mismatch`
  (localhost not in authorized origins) and a browser-cache quirk (works in Incognito → clear
  site data for the normal window).

### Still pending / not done

- **Vestigial UI remaining:** User Management "Reset PW" + Profile "Change Password" (Add User
  already removed). Candidates for removal.
- **Live approval round-trip** with a real 2nd CSPC account not yet exercised (needs a second
  test-user Google account).
- `google-oauth` branch still **uncommitted**.

---

## SESSION 9 — 2026-06-10
**Branch:** `google-oauth`
**Developer:** Mark Gregorio

> Migrated the Google login from the **implicit / access-token** flow (Session 8) to the
> **authorization-code** flow with server-side code exchange + local ID-token verification —
> the current OAuth best practice (implicit is deprecated under OAuth 2.1 / RFC 9700). Net
> result is *less* backend code. Guide kept current in `google-oauth.md`.

### Auth flow — implicit (access token) → authorization-code (one-time code)

- **Why:** the implicit flow returns the token in the browser and is deprecated (OAuth 2.1 /
  RFC 9700). Auth-code keeps the token off the browser, and the returned **ID token already
  carries `email` + `email_verified` (real boolean) + `name` + `picture`** — so the separate
  `tokeninfo` **and** `userinfo` round-trips both go away. Two Google calls → one.
- **Frontend (`Login.tsx`):** `useGoogleLogin({ flow: "auth-code" })`; `onSuccess` now gets
  `resp.code` (a one-time auth code) instead of `resp.access_token`. The custom **CSPC Mail**
  button + label are unchanged.
- **Chain renamed `accessToken`/`access_token` → `code`:** `AuthContext.loginWithGoogle(code)`,
  `api.loginWithGoogle` posts `{ code }`, `routes/auth.js` reads `req.body.code`.
- **Backend (`services/googleAuthService.js`) — the core, now shorter:**
  - `OAuth2Client` constructed with `{ clientId, clientSecret, redirectUri: "postmessage" }`
    (`postmessage` = the magic redirect URI Google uses for the popup auth-code flow; needs **no**
    entry in "Authorized redirect URIs").
  - `client.getToken(code)` exchanges the code (server-to-server, authenticated with the secret)
    → `client.verifyIdToken({ idToken, audience: CLIENT_ID })` verifies the signature **locally**
    and enforces the audience (anti-replay) in one call.
  - **Deleted:** `getTokenInfo`, the manual `info.aud === CLIENT_ID` check (verifyIdToken does it),
    and the entire `fetchProfile()` / `userinfo` function. `email_verified` is now a plain
    `=== true` (no more string-`"true"` workaround — that was a tokeninfo quirk).

### Env / Google Cloud

- **New `GOOGLE_CLIENT_SECRET`** in `backend/.env` (the code exchange requires it). Confirmed
  `backend/.env` is **git-ignored** (`git check-ignore`) so the secret is never committed.
- **Gotcha hit live:** Google **no longer lets you view or download an existing client secret** —
  the Clients page shows only the last 4 chars (e.g. `…X3N8`). Had to click **"Add secret"** to
  mint a fresh one (shown once, `GOCSPX-…`). Documented in `google-oauth.md` §3.

### Bug fix — closing the Google popup left the button stuck on "Signing in…"

- **Symptom:** open the **CSPC Mail** popup, close it without signing in → the button stayed
  disabled showing "Signing in…", not clickable again.
- **Cause:** `handleClick` sets `loading=true`, and only `onError` reset it. But closing/blocking
  the popup is a **non-OAuth** error in `@react-oauth/google` → it fires **`onNonOAuthError`**
  (type `popup_closed` | `popup_failed_to_open`), which we didn't handle, so `loading` never reset.
- **Fix (`Login.tsx`):** added `onNonOAuthError` to `useGoogleLogin` — always `setLoading(false)`;
  a plain close just re-enables the button (no scary banner), a blocked popup
  (`popup_failed_to_open`) shows an "allow popups" hint. `tsc` clean.

### Docs updated

- **`google-oauth.md`** — §1 concept, §2 flow narrative + ASCII diagram (`getToken` +
  `verifyIdToken`), §3 setup + new ⚠️ "secret shown once / Add secret" callout, §4 env vars
  (+`GOOGLE_CLIENT_SECRET`), §6/§7 file tables, §9 troubleshooting (new "Could not verify… →
  missing/wrong secret" bullet; fixed a stale `getTokenInfo` reference), §12 code-trace steps.
- **`CLAUDE.md`** — env-var list (+`GOOGLE_CLIENT_SECRET`) and the auth-section description
  (implicit/ID-token wording → auth-code + `verifyIdToken`).

### Verified

- Frontend **`tsc --noEmit` clean** (root `tsconfig.json` includes `src`; covers the renamed
  `Login.tsx` / `AuthContext.tsx` / `api.ts`).
- **Backend wiring smoke-tested:** `POST /api/auth/google { code: "bogus" }` → **401**
  `{"error":"Could not verify your Google sign-in. Please try again."}` — confirms both env vars
  loaded, the `OAuth2Client` built, and the new `getToken` exchange path is live (a blank secret
  would instead say "not configured"). Dep versions support it: `google-auth-library` ^10.7,
  `@react-oauth/google` ^0.13.5.

### Still pending / not done

- **Live browser sign-in not yet run** on the new flow — needs a human Google popup login with the
  admin CSPC account (can't be automated). Smoke test covers the wiring up to the code exchange.
- Vestigial password UI (User Management "Reset PW", Profile "Change Password") still present.
- `google-oauth` branch still **uncommitted**.

---

## SESSION 10 — 2026-06-13
**Branch:** `email-popup-notifications` (off `main`)
**Developer:** Mark Gregorio

> Built the **notification system** end to end across three channels — **bell feed**, **in-app
> toast + OS popup**, and **email via Resend** — reusing the schema's already-present `alerts` /
> `alert_notifications` tables. Full design + a file-by-file study guide live in
> **`email-popup-notifications.md`** (read §12 to study the code). 7 commits.

### Data model (reuse, don't reinvent)
- `alerts` = the event (1 row); `alert_notifications` = per-user delivery/read row (the bell feed);
  `notification_prefs` = one row per user (missing row → defaults).
- **Migrations (run in phpMyAdmin):**
  - `2026-06-13_notifications.sql` — `is_read` default + `emailed` flag; `metric_value` nullable;
    `status` default; **new `notification_prefs`** table.
  - `2026-06-13_alerts_nullable_device.sql` — `alerts.device_id` NULL-able (room-level
    **environment** alerts have no device row).

### Backend (all new unless noted)
- **`services/notificationService.js`** — the core. `raiseAlert()` = cooldown check → INSERT alert
  → fan out one `alert_notifications` per active user → `io.to("user:<id>").emit("notification")` →
  severity-gated Resend email (mark `emailed=1`). Plus `listForUser` / `unreadCount` / `markRead` /
  `markAllRead` / `dismiss` / `clearAll` / `getPrefs` / `savePrefs` / `purgeOld`. `init(io)` once at
  startup. `toClient()` builds the camelCase payload shared by socket + REST.
- **`services/emailService.js`** — Resend wrapper; **no-op (warn once) if `RESEND_API_KEY` unset**.
- **`routes/notifications.js`** — `GET /` (feed+unread), `POST /read`, `POST /clear`, `GET`/`PUT /prefs`.
- **Edits:** `server.js` (mount route, `init(io)`, raiseAlert on offline sweep, **daily retention
  purge**), `sockets/connectionHandler.js` (browser joins room `user:<id>`),
  `services/agentService.js` (`checkThresholds` raises CPU/Mem/Disk alerts on band onset),
  `handlers/sensorHandler.js` (raises **environment** alert on status escalation).

### Frontend (all new unless noted)
- **`context/NotificationContext.tsx`** — single hub: fetch feed, subscribe to `notification`
  (prepend + badge++ + **sound** + **OS popup** + toast), `markRead`/`markAllRead`/`dismiss`/
  `clearAll`/`subscribe`. Wrapped around app in `App.tsx`.
- **`components/notifications/`** — `NotificationPanel.tsx` (bell dropdown: mark/clear/dismiss,
  sound mute, enable-desktop, click→navigate), `ToastHost.tsx` (corner toasts),
  `notificationUtils.ts` (`SEVERITY_COLOR`/`routeFor`/`relativeTime`), `NotificationPreferences.tsx`
  (Settings card: email on/off + min severity).
- **`utils/browserNotify.ts`** (Web Notifications API), **`utils/notificationSound.ts`** (Web Audio
  chime + mute).
- **Edits:** `Header.tsx` (clickable bell, real badge), `Dashboard.tsx` ("Alerts" panel + stat now
  read the real feed), `Settings.tsx` (mount prefs card), `api.ts` (7 notification methods),
  `ServerMetrics.tsx` (`?device=<id>` deep-link opens that server's detail), `index.css`
  (`--gf-shadow` token + `fadeIn`).

### New socket event
- `notification` → emitted to one user's room (`user:<id>`); camelCase payload (see §8 of the doc).

### Env (added to `backend/.env`, documented in CLAUDE.md)
`RESEND_API_KEY`, `RESEND_FROM`, `NOTIFY_EMAIL_MIN_SEVERITY` (default critical),
`NOTIFY_EMAIL_TO` (test override), `NOTIFY_COOLDOWN_MIN` (default 30), `NOTIFY_RETENTION_DAYS`
(default 30).

### Hardening (post-review)
- **Environment/smoke alerts** wired (were missing — the most important server-room alert).
- **Restart-proof de-dup cooldown** — same `device+type+severity` won't re-alert within
  `NOTIFY_COOLDOWN_MIN` (DB-based, survives `nodemon` restarts; damps flapping). Fixes the
  "always-critical server re-emails on every restart" Resend-quota risk.
- **Retention** purge + **clear/dismiss** actions so the tables don't grow unbounded.
- **Per-user prefs UI** on Settings (email controls; server-enforced).
- **Dashboard** unified onto the real feed; toast honours `prefers-reduced-motion`.

### Verified
- `node --check` (backend) + `tsc --noEmit` + `vite build` (frontend) clean throughout.
- Email path confirmed live by the user (received a real alert email from the always-critical server).

### Still pending / not done
- **Live end-to-end test** of the full stack (agent + ESP32 → bell/toast/email) not yet driven here.
- **Settings "Alert Thresholds" sliders are still mock** — server bands are hardcoded in
  `agentService.checkThresholds`; environment thresholds live in the ESP32 firmware. Making them
  web-configurable is a future task (backend `alert_rules`/`settings` + firmware runtime config).
- Optional **"view all" history page** (paginated) not built — bell shows latest 100 + clear/dismiss.
- **Phase 4:** UPS-on-battery / interface-down `raiseAlert` calls land when `router-ups-monitoring`
  merges (one call each).
- Branch not yet PR'd into `main`.

---

## SESSION 11 — 2026-06-14
**Branch:** `email-popup-notifications` (cont.)
**Developer:** Mark Gregorio

> Turned the **mock/hardcoded alerting** into a real, configurable system, then closed the loop on
> the alert lifecycle. Three features: (1) **configurable alert thresholds** (`alert_rules`) with a
> global-default + per-server-override model, (2) **firmware threshold unification** so the ESP32's
> LED/buzzer follow the dashboard's thresholds live, and (3) the **acknowledge/resolve lifecycle**
> (the `acknowledged_by`/`acknowledged_at`/`resolved_at` columns that were sitting unused). Directly
> delivers Session 10's "Alert Thresholds still mock" pending item. Full writeup in
> **`email-popup-notifications.md` §13**.

### 1) Configurable alert thresholds (`alert_rules`)
- **Migration `2026-06-14_alert_rules.sql`** — `alert_rules.device_id` made NULLABLE (NULL = global
  default; a real id = per-server override) + **seeds 12 global rules** from the old hardcoded values
  (cpu/mem/disk 80/90; temperature 29/32; gas 150/300; humidity 85/95) so day-one behavior is
  identical. Idempotent seed.
- **`services/alertRulesService.js`** (new) — in-memory cache (reload on startup + every mutation),
  `getEffectiveRules(deviceId, metric)` (device override else global), `worstBreach` + `nextBand`
  (hysteresis-aware band evaluation, 5% clear margin), and admin CRUD with validation.
- **`routes/alertRules.js`** (new) — `GET/POST/PUT/DELETE /api/alert-rules`, **admin-only**.
- **Refactors:** `agentService.checkThresholds` (dropped hardcoded `bandFor`; evaluates rules, stamps
  `alert_rule_id`) and `handlers/sensorHandler.js` (environment alerting is now **per-metric** —
  `temperature`/`gas`/`humidity` types instead of one `environment` type, fixing a cooldown
  collision). `notificationService.raiseAlert` accepts + persists `alert_rule_id`.
- **Fallback = rules-only:** a metric with no active rule raises nothing (seed prevents a blackout).
- **Frontend:** **Alert Rules** admin page (`pages/AlertRules.tsx`, sidebar nav) — table + add/edit/
  toggle/delete, global-vs-server scope; `api.ts` CRUD methods.

### 2) Firmware threshold unification (ESP32 ↔ dashboard)
- The 7 threshold `#define`s in `env_monitor_v2.ino` are now **mutable globals**; new **`envConfig`**
  socket event pushes the room-level rule thresholds to the device on connect + after any rule
  change (`connectionHandler` + `routes/alertRules.js` → `io.to("devices")`). The LED/buzzer/reported
  status all derive from these, so they track the dashboard with **no reflash**.
- `envConfig` sets `TEMP_DANGER = TEMP_CRITICAL` (collapses temp to warning/critical, matching the
  two dashboard severities). IR/AC comfort zones + `TEMP_COLD` intentionally **not** rule-driven.
- ⚠️ Firmware **not compiled here** (no toolchain) — must be flashed + tested on hardware.

### 3) Alert lifecycle — acknowledge / resolve
- **`services/alertsService.js`** (new) — `list` (`?status=` filter), `acknowledge`, `resolve`, and
  **`autoResolveMetric`** (auto-resolve open alerts when a metric recovers to normal — wired into
  `checkThresholds` + `sensorHandler`). Broadcasts **`alertUpdated`**; `init(io)`.
- **`routes/alerts.js`** — **replaced the mock** with the real lifecycle API (`GET /`,
  `POST /:id/acknowledge`, `POST /:id/resolve`), **admin + it_staff**.
- **FK fix `2026-06-14_alerts_rule_fk_setnull.sql`** (applied) — `alerts.alert_rule_id` FK changed
  `ON DELETE CASCADE → SET NULL` so deleting a rule no longer cascade-wipes historical alerts +
  bell rows. Verified live (`DELETE_RULE: CASCADE → SET NULL`).
- **Frontend:** new **Alerts** page (`pages/Alerts.tsx`) — filter tabs, severity/status badges,
  "by whom/when", Acknowledge/Resolve buttons, live via `alertUpdated`/`notification`. Both roles.
- **Model:** shared lifecycle (`alerts.status`, one row, same for everyone) — distinct from the
  per-user bell (`alert_notifications.is_read`). Acknowledge = manual; resolve = manual **or** auto.

### 4) Refinements (same session, post-build)
- **Sidebar "Alerts" badge** — live count of alerts needing attention (status ≠ resolved).
  `alertsService.openCount()` + `GET /api/alerts/count`; `NotificationContext.openAlertCount`
  (fetched on login, +1 on `notification`, refetched on `alertUpdated`, re-synced on reconnect);
  small red pill on the Alerts nav item in `Sidebar`.
- **Cooldown resets on resolve** — the de-dup query in `notificationService.raiseAlert` now adds
  `AND status <> 'resolved'`, so a **resolved** alert no longer suppresses; a genuine recurrence
  re-alerts immediately (standard incident behavior). Still restart-proof for *open* alerts; flapping
  is still damped by hysteresis + escalation-only raising.
- **`resolved_by` — added then reverted (by choice):** built separate resolve attribution
  (`resolved_by` column → "resolved by Y" / "auto-resolved"), but the user preferred the simpler
  single-name display, so the **code was reverted** to: resolve folds the handler into
  `acknowledged_by` and the UI shows one "by {acknowledger}" line. ⚠️ The `resolved_by` **column +
  its migration `2026-06-14_alerts_resolved_by.sql` remain applied but are now DORMANT** (NULL,
  unused by code) — kept harmlessly for possible future use, not dropped.

### New socket events
- `envConfig` (server → ESP32) — room-level thresholds; on connect + every rule change.
- `alertUpdated` (server → browsers) — broadcast on acknowledge/resolve/auto-resolve.

### Migrations (run in phpMyAdmin; all already applied to the dev DB this session)
- `2026-06-14_alert_rules.sql` (device_id nullable + seed) — *was already applied by the user.*
- `2026-06-14_alerts_rule_fk_setnull.sql` (FK → SET NULL) — *applied + verified this session.*
- `2026-06-14_alerts_resolved_by.sql` (adds `resolved_by`) — *applied, but the feature was reverted →
  the column is now DORMANT/unused; kept, not dropped.*

### Verified
- `node --check` (all changed backend files) + `tsc --noEmit` + `vite build` clean throughout.
- DB readiness confirmed via throwaway scripts (migration applied, 12 seeded rules, FK = SET NULL).

### Still pending / not done
- **Firmware flash + hardware test** of the `envConfig` unification (can't compile here).
- **Live end-to-end** of threshold firing + ack/resolve not yet driven here (needs running stack /
  go-agent). UI + backend verified by build/typecheck only.
- Minor: humidity-*critical* shows the device LED as **orange** (env_status DANGER), not red — buzzer
  still escalates; one-line `calcEnvironmentStatus` tweak for exact LED parity if wanted.
- Optional follow-ups offered, not built: configurable **AC comfort zones**, full alert **history
  pagination**, device-side "disable metric" sentinel when a rule is deleted.
- Branch still not PR'd into `main`.

---

## SESSION 12 — 2026-06-14  *(cont. of Session 11)*
**Branch:** `email-popup-notifications`
**Developer:** Mark Gregorio

> UI/UX + accountability polish on top of Session 11's alerting work, plus a best-practice
> hardening of User Management. Five threads: (1) a full Grafana redesign of the **Alert Rules**
> page with safety guards, (2) **alert-rule accountability** (who last edited a rule), (3) the
> **last-active-admin** guard (server-enforced) + admin role management in User Management,
> (4) **acknowledge/resolve now shows on the bell** notifications, and (5) the decision to **keep
> the two-role model** (no `super_admin`). Notification/alerting detail in
> `email-popup-notifications.md` §14.

### 1) Alert Rules page — full Grafana redesign (`pages/AlertRules.tsx`)
- Rebuilt flat table → Grafana dashboard: **stat panels** (Total / Active / Global defaults /
  Server overrides), a **filter toolbar** (search + metric + severity + scope + Clear), and rules
  **grouped by scope** into collapsible sections (Global defaults + one per server, globe/server
  icon, count badge, "Applies to all" / "Override" tag).
- **Metric icons + color accents** (cpu/mem/disk/temp/gas/humidity) + human-readable conditions
  ("when value ≥ 90%"). Add/edit moved to a **centered modal** (`--gf-shadow`, Esc/backdrop close)
  with a **live preview** sentence + severity segmented picker. Friendlier empty states; inline
  delete confirm with icon buttons. **"Add rule"** restyled Grafana (2px radius, 32px, hover).
- Removed the redundant per-group "+ Rule" buttons (kept the single header button + empty-state).

### 2) Guards on the Alert Rules page
- **Last-global-rule coverage guard.** Alerting is rules-only, so removing the last global rule for
  a metric silently disables it for every server without an override. Editing a global rule so it
  stops covering its metric (reassign to a server / change metric / pause) shows an amber warning +
  the Save button becomes **"Save anyway"**; deleting the last global shows an inline warning +
  **"Delete anyway"**. Coverage-aware (counts *active* globals only).
- **Server scope hides environment metrics.** temperature/gas/humidity are room-level (the ESP32
  isn't a `devices` row) → for a per-server scope the metric dropdown only offers cpu/mem/disk
  (auto-resets to cpu when switching Global→server).

### 3) Alert-rule accountability (who last edited a rule)
- **Migration `2026-06-14_alert_rules_updated_by.sql`** (NEW — must be run) — adds
  `alert_rules.updated_by` (FK → users, **ON DELETE SET NULL**) + index.
- `alertRulesService.create/update` stamp `updated_by` (the acting admin) + bump `updated_at = NOW()`
  (incl. the activate/pause toggle); `list`/`getById` join users → `updatedByName`; `toClient`
  exposes `updatedBy`/`updatedByName`. `routes/alertRules.js` passes `req.user.id`.
- Each rule row shows **"edited by {name} · {when}"** (Manila time) or **"system default"** (seeded).

### 4) User Management — admin role + last-active-admin guard (best practice)
- **Edit role select** now offers **Admin** (was IT Staff only) → promote/demote via the modal.
- **Edit enabled for admin rows** (was hidden for all admins): Edit now shows for everyone except
  yourself (self uses the Profile modal). Demotion is safe via the guard below.
- **Last-active-admin invariant — server-enforced** (`services/userService.js`): the system must
  always retain ≥1 active admin. New `countOtherActiveAdmins` + `lastAdminError` (400) back guards in
  **`deleteUser`**, **`updateUserStatus`** (also blocks **self-disable**; route now passes
  `req.user.id`), and **`updateUser`** (demote/disable). The UI button-hiding is now just a
  convenience layer on top.
- **Removed the `id === 1` hardcode** in `UserManagement.tsx`: `isProtected` = self || last active
  admin (derived from the live list). Two admins are now **symmetric** (each can manage the other);
  neither can remove the final admin or themselves. Badge shows **"last admin"/"you"**;
  `handleDelete` now honors the API result (was assuming success).
- **Error surfacing fixed** (`src/server.js`): the global handler now includes `error` for **4xx**
  (the frontend reads `data.error`, so guard messages actually show); **5xx stays generic**.

### 5) Decision — no `super_admin` role
- `admin` already has full access; a 3rd tier would duplicate it across an ENUM migration + ~25
  `requireRole` sites + 3 `validRoles` arrays + frontend config for **no distinct capability**.
  Real-world best practice = the last-admin invariant (thread 4), implemented instead.

### 6) Bell notifications — show acknowledge / resolve  *(detail: email-popup §14.3)*
- `services/notificationService.js`: the notification payload + both queries (live push +
  `listForUser`) now carry the shared lifecycle (`status`, `acknowledgedByName`, `acknowledgedAt`,
  `resolvedAt`) via a users join. **No migration** — `alerts` already has these columns.
- `context/NotificationContext.tsx`: `AppNotification` gained the fields; the **`alertUpdated`**
  handler patches matching bell items by `alertId` (live), plus the existing count refresh.
- `components/notifications/NotificationPanel.tsx`: each item shows **"✓ Resolved by {name}"** (green)
  or **"● Acknowledged by {name}"** (accent) once past `active`; auto-resolve shows "Resolved".

### 7) Sidebar nav badges — pending approvals (admin)
- **Server Metrics** nav shows a count badge when servers (agents) await approval; **User
  Management** nav shows one for new user registrations — styled like the existing **Alerts** badge
  (accent blue vs the alerts' red). Admin-only (stays 0 / hidden for it_staff).
- `context/NotificationContext.tsx` gains `pendingAgentCount` + `pendingUserCount` (fetched on login
  via `getPendingAgents`/`getPendingUsers`, **admin-gated** to avoid 403s; live on `agentPending`/
  `agentApproved`/`userPending`/`userApproved`; re-synced on reconnect). `Sidebar.tsx` renders them
  via a shared **`NavBadge`** (the Alerts badge was refactored onto it too).
- **Burger / reopen-sidebar badge** (`Header.tsx`): when the sidebar is hidden (mobile burger or the
  desktop collapsed reopen button), the badge now aggregates **alerts + pending agents + pending
  users** (was alerts-only) so a hidden sidebar still surfaces all of it — red when any alert is
  open, else accent.

### Migrations (run in phpMyAdmin)
- `2026-06-14_alert_rules_updated_by.sql` — **NEW, must be run** before restarting the backend (the
  Alert Rules list query joins `updated_by`).

### Verified
- Backend `node --check` (all changed files) + frontend `tsc --noEmit` clean throughout.

### Still pending / not done
- **Phantom `super_admin` bug** flagged but NOT fixed: `pages/Reports.tsx:18`
  `canGenerate = ["super_admin","it_staff"]` → a plain **admin can't "Generate" reports** in the UI
  (should be `["admin","it_staff"]`); stale comment at `api.ts:111`. One-line fix when wanted.
- Live end-to-end of the new guards / bell ack-resolve not driven here (build/typecheck only).
- Branch still not PR'd into `main`.

---

## SESSION 13 — 2026-06-15
**Branch:** `email-popup-notifications` (cont.)
**Developer:** Mark Gregorio

> Polish + UX on the alerting/notification stack, plus a new **configurable auto-cooling (AC IR)
> thresholds** feature. The alerting-related parts (re-arm on resolve, bell filter, `acConfig`)
> are also written up to study from in `email-popup-notifications.md §15`.

### 1) Email for critical environment alerts — verified, no code change
- Code-traced that critical-severity environment alerts (temperature/gas/humidity) ALREADY email
  via the shared `notificationService.raiseAlert` path — the email gate is **severity-based, not
  type-based**. "Only server emails seen" was because the room rarely reaches the *critical*
  threshold (warnings don't email by default; `NOTIFY_EMAIL_MIN_SEVERITY=critical`).

### 2) Per-user personal Settings page (it_staff now included)
- **Bug:** notification prefs lived only on the Settings page, which it_staff couldn't reach
  (`"settings"` wasn't in their `roleConfig.pages`) → it_staff had no notification prefs. The
  backend `/api/notifications/prefs` was already per-user; purely a UI-access gap.
- `data/users.ts`: added `"settings"` to it_staff. `permissionService.js`: added `view:settings`
  to it_staff (kept `manage:settings` admin-only).
- **`pages/Settings.tsx` rebuilt** as a real **per-user personal** settings page (gf-styled):
  **Profile** (reuses ProfileModal), **Notification Preferences**, **Appearance** (theme). Removed
  the mock cards (backend connection inputs, alert-threshold sliders, fake Save).
- `Sidebar.tsx`: moved the **Settings** nav item to the **bottom**.

### 3) Removed the non-working "Reset Password" (Google-only auth)
- Under Google OAuth the admin reset only wrote a `hash_password` login never checks. Removed end
  to end: `UserManagement.tsx` (state/handlers/`⟳ Reset PW` button/modal), `api.ts`
  (`resetPassword`), `routes/users.js` (`PATCH /:id/reset-password`), `userService.js`
  (`resetPassword()`; kept `bcrypt` — still used by other methods).

### 4) Alerting — re-arm on resolve (still-breaching metric re-alerts)
- **Problem:** resolving an alert whose metric was *still* critical didn't re-alert. Root cause =
  the **escalation guard** (raise only on band onset) whose in-memory band tracker wasn't reset on
  resolve — so the metric "stayed critical" and never re-escalated. (The cooldown's
  `status <> 'resolved'` was a red herring; `raiseAlert` was never even reached.)
- **New `services/alertBandState.js`** — shared in-memory band per `(deviceId, metric)`
  (`getBand`/`setBand`/`resetBand`/`resetDevice`). `agentService.checkThresholds` (dropped its
  private `alertState` Map) + `handlers/sensorHandler.js` (dropped `envBand`) now use it; the three
  lifecycle clears (reject / offline-sweep / remove) call `resetDevice`.
- **`alertsService.resolve` + `autoResolveMetric`** call `resetBand(deviceId, type)` → a still-true
  condition re-escalates → **one** fresh alert on the next reading (then the cooldown re-engages).
  PagerDuty/Opsgenie-style. **Acknowledge** still silences (no re-arm).

### 5) Bell notifications — All / Unread filter
- `NotificationPanel.tsx`: a 2-tab filter (All (N) / Unread (N)) over the loaded feed (client-side,
  instant). Empty-state adapts. Mark-all-read / Clear-all still act on the whole feed.

### 6) Configurable auto-cooling (AC IR) thresholds — NEW feature
- The firmware `getIRZone` comfort-zone boundaries (22/24/27/29 °C) are now admin-configurable with
  **no reflash**, mirroring the `envConfig` pattern. **Decision: kept SEPARATE from Alert Rules** —
  cooling must ramp *before* the alarm; target temps per zone are fixed (captured IR codes), so only
  the boundaries are configurable. Detail: `email-popup-notifications.md §15.4`.
- **Migration `2026-06-15_aircon_ir_config.sql`** (NEW, must run) — single-row `aircon_ir_config`
  (cold_below/normal_max/acceptable_max/near_crit_max + updated_by/at), seeded with firmware defaults.
- **Backend:** `airconService` (getIRConfig/saveIRConfig/getDeviceIRConfig); `routes/aircon.js`
  (`GET /api/aircon/ir-config` both roles, `PUT` admin → push `acConfig`); `connectionHandler`
  emits `acConfig` on device connect.
- **Firmware (`env_monitor_v2.ino`):** boundaries → mutable globals + new `acConfig` handler.
  ⚠️ Must be **re-flashed** to take effect (no toolchain here).
- **Frontend:** `api.ts` (get/saveAirconIRConfig); `AirConditioner.tsx` **Auto-Cooling Thresholds**
  panel (zone map + editable boundaries for admin, read-only for it_staff, "edited by" footer).

### New socket event
- `acConfig` (server → ESP32) — IR zone boundaries; on connect + after any Auto-Cooling change.

### Migrations (run in phpMyAdmin)
- `2026-06-15_aircon_ir_config.sql` — **NEW, required** for the AC thresholds feature.

### Verified
- Backend `node --check` (all changed files) + import-resolution; frontend `tsc --noEmit` +
  `vite build` clean throughout.

### Still pending / not done
- **Re-flash `env_monitor_v2.ino`** (activates both `acConfig` and the earlier `envConfig`) + run
  the new migration.
- Live end-to-end of re-arm-on-resolve and the AC-threshold push not driven here (build/typecheck only).
- **Phantom `super_admin` bug** (`pages/Reports.tsx:18`) still unfixed — carried over from SESSION 12.
- Branch still not PR'd into `main`.

---

## SESSION 14 — 2026-06-18
**Branch:** `pip-widget`
**Developer:** Mark Gregorio

> Four threads, mostly server-identity + alerting UX on the side of the PiP work:
> (1) **admin server rename / display label** — tell apart two boxes that report the same
> hostname; (2) a PiP **"Server list" tile** so the pop-out widget names servers (not just
> counts); (3) a **server online/reconnect alert** to match the existing offline alert; and
> (4) a **blue count badge** on the Alerts page "Acknowledged" tab. The rename keeps the
> agent-supplied hostname and lets an admin set a friendly label on top of it.

### Server rename / display label (NEW)
- **Model:** new nullable `devices.display_name`. The agent's hostname stays in `device_name`
  (never overwritten — still shown for reference). Effective name everywhere =
  `COALESCE(NULLIF(display_name,''), device_name)`. Blank label → falls back to the hostname.
  Survives re-registration (`refreshHostInfo` never touches it).
- **Migration `2026-06-18_server_display_name.sql`** (NEW, must run) — adds the column.
- **Backend:** `agentService.renameServer(id, displayName)` (existence-checked separately so
  renaming to the *current* label isn't a false 404 on MySQL `affectedRows = 0`); `SERVER_SELECT`
  now returns effective `name` + `hostname` + `displayName`; `validateToken` carries
  `display_name` so the live `serverMetrics` broadcast uses the effective label (InfluxDB
  `device_name` tag stays the real hostname — no time-series re-keying on rename).
  **`PATCH /api/servers/:id`** (admin-only) validates (string, ≤100, trimmed), logs a
  `device_logs` entry, and emits the new **`serverRenamed`** event.
- **Frontend:** `api.renameServer`; **ServerMetrics** — admin **Rename** action (table + mobile
  card) opens a gf-styled `RenameModal`; table/card show the real hostname as a subtitle when a
  custom label is set; live `serverRenamed` handler patches list + open detail. **ServerDetail**
  shows the hostname subtitle. **Dashboard** patches server labels live via `serverRenamed`.
- **New socket event:** `serverRenamed` (server → browsers) `{ id, name, displayName, hostname }`.

### PiP widget — new "Server list" tile (shows servers by name)
- The pop-out widget only summarized servers (counts + worst CPU/mem); it didn't name them.
  Added a **`servers.list`** tile (`pip/tiles/catalog.tsx`) — each server **by name** + a
  status dot + CPU/mem. Names use the effective display label and stay live:
  `LiveSummaryContext` now also handles **`serverRenamed`**.
- **UI/UX iteration (best-practice glance surface):** settled on **one line per server** (not a
  3-line block) so the tile stays bounded/glanceable without scrolling — divider between rows,
  a once-only `CPU·MEM / LOAD` header, exact `cpu·mem` numbers + a single **LOAD bar** = worst of
  the two (full breakdown is one click away on the Dashboard), and **problem-first sort** (offline
  on top, then busiest). Rationale: a tiny always-on-top widget answers "is anything down/hot?" at
  a glance; per-metric dual gauges per server pushed it toward detailed-dashboard altitude + height.
- Added to `DEFAULT_LAYOUT` (replacing `servers.summary` in the default) + the backend
  allow-list (`widgetPrefsService.ALLOWED_TILES` + its `DEFAULT_LAYOUT`, kept in sync).
- ⚠️ Existing users have a **saved** layout, so they must add the tile from
  **Settings → Customize Widget** ("Server list (names)" under Servers). Only brand-new
  layouts get it automatically.

### Server online/reconnect alert (symmetry with the offline alert)
- **Problem:** going offline raised an alert; coming back online (reconnect or a brand-new
  first connect) raised nothing.
- **`serverMetricsHandler` (cameOnline path):** now auto-resolves the open `offline` incident,
  raises an **`info` "Server online"** alert (`type: "online"`), then **immediately
  auto-resolves it** — it's a point-in-time event, so it lands in the bell feed + Alerts
  history without inflating the open-alert badge (only the real "offline" condition counts as
  open). Immediate-resolve also means every reconnect re-fires (the open-alert de-dup no longer
  suppresses it).
- **`agentService.approve()`:** now leaves a freshly-approved server **`offline`** (was forced
  `online`). It only flips online on its first real metric POST → that offline→online
  transition is what fires the alert, so a **new connect** is announced just like a reconnect.
  The offline sweep only touches `status='online'` rows, so a not-yet-reporting approved server
  is never falsely alerted offline. (Trade-off: a just-approved server shows Offline for up to
  one agent interval until it reports — which is accurate.)
- `info` severity → no email by default (`NOTIFY_EMAIL_MIN_SEVERITY=critical`); bell + toast only.
- Known trade-off: a rapidly **flapping** server produces an offline+online alert each cycle
  (the online auto-resolve clears the offline de-dup). Acceptable — flapping is alert-worthy; a
  dedicated flap-damper would be a future follow-up.

### Alerts page — blue count badge on the "Acknowledged" filter tab
- The Alerts page loads only the selected filter, so the acknowledged count is tracked
  separately (`loadAckCount` → `api.getAlerts("acknowledged").length`), refreshed on mount +
  `alertUpdated`/`notification` + after acknowledge/resolve. The **Acknowledged** tab shows a
  blue (`--gf-accent`) pill with the count when > 0.

### Verified
- Backend `node --check` (agentService / serverMetricsHandler / routes/servers /
  widgetPrefsService) clean; frontend `tsc --noEmit` exit 0 across all changed files
  (api.ts, Alerts, Dashboard, ServerDetail, ServerMetrics, LiveSummaryContext, catalog).

### Still pending / not done
- **Run `migrations/2026-06-18_server_display_name.sql`** in phpMyAdmin before restarting the
  backend (the server queries select `display_name`).
- Live end-to-end of the rename round-trip not driven here (build/typecheck only).
- Rename is **list-only** (Server Metrics list) by design; the detail page shows the hostname
  read-only. Carry-overs from S13 (PiP migration `2026-06-17_widget_prefs.sql`, firmware
  re-flash, `super_admin` Reports bug) still open.

---

