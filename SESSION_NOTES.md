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

## SESSION 11 — 2026-06-12
**Branch:** `router-ups-monitoring`
**Developer:** Mark Gregorio

> Built the **Router & UPS SNMP monitoring** feature from the existing design doc
> (`router-ups-monitoring.md`, committed earlier on this branch). One **pull**-based SNMP
> poller covers both classes (routers via IF-MIB, UPS via UPS-MIB / RFC 1628) — the mirror of
> the push-based Go agents. Built in increments, each verified without real hardware via a
> loopback SNMP simulator. **Increments 1–4 done; Increment 5 (seed migration) is a template
> blocked on the device facts.**

### Key schema finding — v2c only
- `device_network` stores `snmp_community` + `snmp_port` but has **no v3 columns** (no auth
  user/protocol/priv), so the DB models **SNMP v2c only**. The design's "v2c or v3?" open
  question is settled by the schema: v2c now; v3 needs a follow-up migration. `snmpClient` has a
  single marked v3 extension point.

### Increment 1 — `snmpClient.js` (thin net-snmp wrapper)
- New dep **`net-snmp@3.26.3`** (the only new backend dep — SNMP-only). `services/snmpClient.js`:
  **standard** OID maps (MIB-II system, IF-MIB, UPS-MIB), v2c session open/close, `get`,
  `walkColumn`, value normalize (OctetString→string, **Counter64→BigInt** precision-safe).
- OIDs are IETF/IANA constants (same on every vendor) — **not** mock like the IR NEC codes.
  Defaults (`161`, `"public"`, timeouts) are real, overridden per-device from `device_network`.
- **Verified live** on a loopback net-snmp agent: get + walkColumn + Counter64 BigInt + UPS decode.

### Increment 2 — poller + handlers + simulator
- `services/snmpPollerService.js`: `loadDevices` (routers/ups + connection info), pure
  `collectRouter`/`collectUps` collectors (SNMP→sample, no DB/Influx), per-interface
  utilization from the counter delta, status flips (poll IS the heartbeat — no separate sweep),
  threshold logging (interface-down, UPS on-battery / low-battery — onset only, reuses
  `agentService.logDevice`).
- `handlers/networkMetricsHandler.js` → `router_metrics` + per-iface `network_traffic`
  (cumulative **uint** counters; BigInt via `point.uintField`) + `networkMetrics` broadcast.
  `handlers/upsMetricsHandler.js` → `ups_metrics` + `upsMetrics` broadcast.
- `scripts/snmpSim.js`: reusable loopback router (3 ifaces, one DOWN, advancing Counter64) +
  UPS — develop/test with **no hardware**. Prints ready-to-run seed SQL.
- `src/server.js`: gated 60s `pollAll` interval (no-op until a router/ups is registered);
  `SNMP_POLL_INTERVAL_MS` env (default 60000).
- **Verified:** `node --check` all; import-chain resolves; **collectors run live against the
  simulator** (router IF-MIB + UPS-MIB shaped correctly, utilization computed from real deltas).

### Increment 3 — read APIs
- Poller gained a per-device **latest cache** (mirrors `agentService.latestMetrics`) +
  `getNetworkDevices`/`getUpsDevices` (overlay cache on MySQL; `monitored` flag marks
  ping-only/USB devices). `handlers/networkHistoryHandler.js` (Flux: per-iface `last` →
  `derivative` → grouped `sum` = total throughput) + `handlers/upsHistoryHandler.js` (gauge
  means). `routes/network.js` + `routes/ups.js`: `GET /` , `:id/history`, `:id/logs` (JWT).
  Mounted `/api/network` + `/api/ups`. **Verified:** `node --check` + import-chain clean.

### Increment 4 — frontend pages
- `pages/NetworkMonitoring.tsx` (router list, per-iface utilization bars + up/down, throughput
  history chart w/ range selector, live `networkMetrics`/`networkStatus`) and
  `pages/UpsMonitoring.tsx` (battery/load/runtime/voltage cards, **on-battery banner**, history
  chart, live `upsMetrics`/`upsStatus`). All Grafana `--gf-*`. `api.ts`: 6 new methods.
  Wired routes `/network` + `/ups` in `App.tsx`, nav items + icons in `Sidebar.tsx`, role access
  (admin + it_staff) in `data/users.ts`. **Verified:** `tsc --noEmit` fully clean.

### Docs + Increment 5 template + client questionnaire
- **`CLAUDE.md`** updated: `SNMP_POLL_INTERVAL_MS` env, repo layout (new files), data-stores
  table (router/ups MySQL + `network_traffic`/`router_metrics`/`ups_metrics` Influx), socket
  events (`networkMetrics`/`upsMetrics`/`networkStatus`/`upsStatus`), role + page-style tables.
- **`router-ups-monitoring.md`** updated: status banner → "IMPLEMENTED — seeding pending", §8 file
  table (Status column, simulator row later removed), §10 Q3 settled (v2c), §11 status rewritten.
- **`migrations/2026-06-12_router_ups_devices.sql`** — Increment 5 **template** (commented
  INSERTs + placeholders) to register the real routers/UPS.
- **Client questionnaire** — `router-ups-client-questionnaire.md` **+ a Word `.docx`** (generated
  with `python-docx`) that collects the §10 device facts (Q1 UPS SNMP cards, Q6 managed routers,
  Q9 firewall/UDP 161, + per-device IP/model/community) in plain language for the CSPC-ICTU team.
  Filled when the client responds, then drives the seed migration. (Verdict given: feasible, low
  technical risk — remaining work is operational, not code.)

### Still pending / not done
- **Increment 5 is blocked on the device facts** (router-ups-monitoring.md §10): Q1 UPS SNMP
  cards?, Q6 managed routers?, Q9 firewall allows UDP 161? — answers decide which rows to seed.
- **Full live stack test not yet run** (needs MySQL + InfluxDB up + seeded devices + a reachable
  SNMP target): the route responses, Influx history, and pages rendering live data. Up to the
  SNMP collection layer it was proven during the session against a loopback agent.
- **Loopback SNMP simulator removed at request** — `backend/scripts/snmpSim.js` (built this
  session to verify Increments 1–2 with no hardware) was deleted afterward, and its references in
  the docs / migration / page empty-states cleaned up. Re-add if a no-hardware harness is wanted
  again (it's a standalone `net-snmp` agent script — nothing in the app imported it).
- **ICMP-ping fallback** for unmanaged/no-community routers is a **separate module not built** —
  such routers are currently skipped by `loadDevices` (returned with `monitored:false`).
- `router-ups-monitoring` branch still **uncommitted**.

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

## SESSION 15 — 2026-06-20
**Branch:** `mikrotik-monitoring` (created off `main`, then re-pointed onto `router-ups-monitoring`)
**Developer:** Mark Gregorio

> Built **MikroTik network monitoring** (architecture data source **B**) end to end — a RouterOS
> **pull** collector + a dashboard page — reusing this branch's (`router-ups-monitoring`) network
> foundation. **Full study guide: `mikrotik-monitoring.md §13`.**
>
> Note on numbering: this `SESSION_NOTES.md` is the `router-ups-monitoring` lineage, so it lacks
> `main`'s SESSION 14 (the `pip-widget` session, 2026-06-18) — that lives on the `main`/`pip-widget`
> line and will reconcile on merge. This entry is labeled 15 to continue `main`'s sequence.

### Housekeeping (start of session)
- Pushed `pip-widget` + `router-ups-monitoring` to origin; committed the MySQL Workbench `.mwb`
  model to `main` (`d1ecc80`).

### Decision — branch base = B (stacked branch)
- The feature reuses `router-ups-monitoring`'s shared network code (the `network_traffic` /
  `router_metrics` InfluxDB measurements, `writeNetworkSample`, `networkMetrics`/`networkStatus`,
  `network_interfaces`, `NetworkMonitoring.tsx`). That branch isn't merge-ready, so merging it to
  `main` first (option A) was rejected; instead **re-pointed `mikrotik-monitoring` onto
  `router-ups-monitoring`** (`git branch -f`) and stacked on top. (Option C = duplicate, rejected.)

### Docs (committed `59f5309`)
- `mikrotik-monitoring.md` — design of record + **§13 study guide** (runtime flow, file map, REST
  surface, operational flow, what changed from the plan).
- `mikrotik-feature-questionnaire.md` + `.docx` — client info request (campus MikroTik); `.docx`
  generated via `python-docx`.
- `mikrotik-dev-setup.md` + `.docx` — RouterOS dev-box setup (enable API, read-only user, reach test).

### Schema (migration `2026-06-20_mikrotik_device.sql`, NEW — must run)
- **Key finding:** the V10 schema **already has `mikrotik_devices`** (1:1 detail table off `devices`,
  same pattern as `server_specs`/`ups_details`) — kept it; did NOT fold into `device_network`.
- `devices.device_type` is an **ENUM** lacking `'mikrotik'` → migration `ALTER`s to add the value.
- Adds `mikrotik_devices.use_tls`; drops the unused `firmware_version`. `api_password VARCHAR(255)`
  holds AES-GCM ciphertext (base64) — no column change. Plus a commented seed template.

### Backend (committed `9ce4108`; `12996ba` removed mock; `de2c251` add-flow)
- `services/mikrotikCrypto.js` — AES-256-GCM for the API password (`MIKROTIK_ENC_KEY`, 32-byte hex).
- `services/mikrotikClient.js` — RouterOS API reads (`/system/resource`, `/interface print stats`,
  `/interface/ethernet`, DHCP lease count) → the **shared sample shape**; lazy-loads `node-routeros`.
- `services/mikrotikPollerService.js` — the core poller (mirror of `snmpPollerService`): loadDevices
  (type='mikrotik'), collect + utilization deltas, `setReachable`→`networkStatus`, reuse
  `writeNetworkSample`, port-down logging, + `getMikrotikDevices` / `createDevice` / `saveConnection`
  / `testConnection`.
- `routes/mikrotik.js` — `GET /` list, `POST /` add (admin), `PUT /:id/connection` (admin),
  `POST /:id/test` (admin), `/:id/history`, `/:id/logs`.
- `src/server.js` — mount `/api/mikrotik` + a 30s `setInterval` poll (self-gating until a device exists).
- **Dependency added:** `node-routeros` (required once mock was removed).

### Frontend (committed `8b6c104` page; `12996ba` modal; `de2c251` add)
- `pages/MikrotikMonitoring.tsx` — single-router dashboard: stat row, throughput history chart,
  **per-port = per-building** rows (utilization bars + link state), device summary (CPU / mem /
  clients / RouterOS version / board / uptime). Live via the shared `networkMetrics`/`networkStatus`
  (filtered to `type=mikrotik`). **AddModal** (+ Add MikroTik) and **ConnectionModal** (Configure +
  Test) — admin-only.
- `api.ts` — getMikrotikDevices / addMikrotik / saveMikrotikConnection / testMikrotik / history / logs.
- Wired route `/mikrotik`, sidebar nav item + icon, `roleConfig` access (admin + it_staff).
- `NetworkMonitoring.tsx` — ignores `type=mikrotik` in its live merge (kept on separate pages).

### Removed — mock mode
- `MIKROTIK_MOCK` (synthetic data) was built during scaffolding then **dropped at request** — live
  RouterOS only. Removed from poller / client / server + the page empty state.

### `.env`
- Added `MIKROTIK_ENC_KEY` (generated) + `MIKROTIK_POLL_INTERVAL_MS=30000` to `backend/.env`
  (gitignored — not committed).

### Verified
- `node --check` + backend import-resolution clean; frontend `tsc --noEmit` exit 0 throughout.

### Still pending / not done
- **Run the migration** + **restart backend** + a **live end-to-end test** against the dev MikroTik
  (the RouterOS command words in `mikrotikClient` are best-effort — confirm on hardware).
- **Port → building labeling UI** (labels come from `network_interfaces`, currently SQL-seeded).
- Full **alert_rules** wiring (link_util / CPU / mem + bell/email) — today only port-down +
  offline/online are logged to `device_logs`.
- PiP `network.summary` tile. Branch `mikrotik-monitoring` not pushed yet.

---
## SESSION 16 — 2026-06-27
**Branch:** `history-page` (off `main`)
**Developer:** Mark Gregorio

> New feature: a real, unified **History page** — a focused, accountable **activity / audit
> log**, replacing the old mock (`data/db.js` historyLogs, the hardcoded March-2025 rows). Built
> on a fresh branch off `main` so it's independent of the in-flight `predictive-analytics`
> (S14/S15, not on this branch's notes) and the network/UPS branches. **No DB migration needed**
> — every source table already exists.

### Decision / scope
- **History = a unified, accountable audit log.** Merge the four append-only log tables the
  system already writes — `system_logs`, `aircon_logs`, `alerts`, `device_logs` — into one
  normalized event stream, each event tagged with an **actor: Admin / Staff / System**
  (`users.role`, or NULL = automated).
- **Accountability gap closed:** several admin actions weren't logged anywhere → added audit
  writes so they show in History.
- **Scope evolution (decided with the user):** daily **Environment** + **Servers** metric
  summary tabs were prototyped (incl. InfluxDB aggregation + a bar chart) but **cut** — real-world
  an audit log is its own focused concern, and metric history already lives (better, with live
  charts) on the **Environment** and **Server Detail** pages. Shipped = activity log only. The
  InfluxDB summary services/routes/api methods were removed with them.

### Backend (new)
- **`services/auditService.js`** — `audit({userId, module, action, description, level, ip,
  userAgent})` appends to `system_logs`; **best-effort** (swallows its own errors so a log
  failure never breaks the action). `clientInfo(req)` helper for ip/user-agent.
- **`services/historyService.js`** — the engine. `getHistory()` = a **UNION ALL** across the
  four tables, normalized to one shape (id/source/category/ts/actor/severity/action/message/
  device), joined to `users` (name+role) + `devices` (name), newest-first, **paginated +
  filtered** (days/category/severity/actorType/search) with a one-scan **summary** (counts by
  severity + actor). Injection-safe: numeric inputs clamped + inlined, every value filter a
  bound `?` (same posture as `serverHistoryHandler`). Pure MySQL — no InfluxDB.
- **`routes/history.js`** — `GET /api/history`; `authMiddleware` +
  `requireRole("admin","it_staff")` (read-only insight, both roles).
- **`src/server.js`** — mount `/api/history`.

### Backend (audit logging added — accountability)
`system_logs` writes via `auditService.audit` at the previously-unlogged actions, each with the
acting user + ip/ua:
- `routes/users.js` — approve / reject / update / disable-enable / delete (module `users`).
- `routes/alertRules.js` — create / update / delete (module `alerts`, human-readable rule desc).
- `routes/agents.js` — server approve / reject (module `devices`).
- `routes/servers.js` — server remove (module `devices`; name captured before delete).
- `routes/alerts.js` — acknowledge / resolve (module `alerts`) → alert lifecycle now attributed.

### Frontend
- **`pages/History.tsx`** — full rewrite, Grafana `--gf-*` tokens (was old `slate-*`). Single
  **activity log**: stat tiles (total/critical/warnings/by-admin/by-staff/by-system); table with
  **actor badges** (Admin purple / Staff blue / System slate `#6E7B91`), severity dots, category
  chips, expandable detail; server-side pagination.
- **Filters:** search · **time range** (24h/7d/14d/30d presets **+ Custom date range** with
  from→to pickers) · **category** pills · **severity** pills · a single **Actor** dropdown.
- **Actor filter (consolidated):** one dropdown — All / by role (Admin, Staff, System) / by
  person (each user who appears in the history). Replaced an earlier two-control design (actor-type
  pills + a separate user dropdown) that could **contradict** each other (e.g. Actor=Staff +
  User=an admin → 0 rows); merging them removes the conflict while keeping every capability
  (System events can't be expressed by a user filter; a specific person can't by role pills).
- **Realtime, no Refresh button** — auto-updates while on page 1: socket events (notification,
  alertUpdated, deviceLog, aircon*, user/agent/server lifecycle) for instant updates + a **10s
  poll backstop** for events that don't broadcast (login/logout, alert-rule changes). Background
  refreshes are **silent** (no "Loading…" flash; `silentRef` guard); a green **Live** dot shows
  while page 1 is auto-updating.
- **`api/api.ts`** — `getHistory(params)` (days | start/end, category, severity, actorType,
  userId, search, page) + `getHistoryActors()`; removed the mock `getHistoryLogs`. (Mock
  `routes/environment.js` `/logs` + `data/db.js historyLogs` left in place but no longer used.)
- **Backend filter support:** `getHistory` resolves a time window — a strict `YYYY-MM-DD`
  custom range (validated → safe to inline) else clamped "last N days" — plus `userId` and
  `actorType` filters; `getActors()` + `GET /api/history/actors` list the people who appear.

### Verified
- Backend `node --check` + import-resolution clean; service shape = `getHistory` only; **live
  boot probe**: unauthenticated `GET /api/history` → **401** (route mounted + auth-gated).
  Frontend **`tsc --noEmit` clean**.
- Nodemon dev server hot-reloaded the changes during testing (dev stack was running).

### Notes / findings
- **Duplicate "MSI" server** surfaced while prototyping the (since-removed) server summary:
  the same machine is enrolled+approved twice (id 22 Online, id 23 Offline since 2026-06-16) —
  visible on the live Server Metrics page too (no MAC/hostname dedup on this branch; that fix is
  on `predictive-analytics`). Cleanup = Remove the offline duplicate id 23 there.
- **Flux tz gotcha (for future InfluxDB work):** this InfluxDB build lacks IANA tzdata, so
  `timezone.location(name:"Asia/Manila")` throws "unknown time zone" at runtime — use
  `timezone.fixed(offset: 8h)` (PH is UTC+8 year-round).

### Still pending / not done
- **Live end-to-end** with a logged-in session (feed render, filters, pagination, realtime
  auto-update, new audit rows after an admin action) not driven here — verified by
  build/types/boot probe.
- SESSION 14/15 (predictive-analytics) entries are **not** in this branch's copy of these notes
  (different branch) → there's an intentional S13→S16 gap here; resolves on merge.
- Branch not PR'd into `main`.

---

## SESSION 17 — 2026-08-06
**Branch:** `smtp-email` (off `main`)
**Developer:** Mark Gregorio

> Replaced the alert/report email transport: **Resend → SMTP (nodemailer)**, Resend removed
> entirely. Plus **recovery confirmation** for alert auto-resolve. Re-applied onto `main` from the
> abandoned `email-popup-notifications` branch (see "Branch note" below).

### Why the transport swap
Email carries no proof of sender, so receivers check **SPF/DKIM** DNS records on the sending
domain. A third-party sending API must be authorized by adding *its* records to `cspc.edu.ph` — a
DNS change on the live campus domain that ICTU is unlikely to grant a student project. Until then
Resend only delivers to the Resend account owner's own address, so real per-user fan-out was
impossible. Sending through a **real Workspace mailbox** needs no DNS work at all (Google already
publishes SPF/DKIM for the domain) and delivers to anyone.

### Changes
- **`services/emailService.js`** — rewritten on nodemailer. **`sendReportEmail` preserved** and
  ported (nodemailer takes the PDF Buffer directly; Resend needed base64), so `reportService` is
  untouched. Both senders now share one `send()` helper. Adds `verify()`/`close()`, a pooled
  transporter (the per-user fan-out is concurrent), plain-text alternatives alongside the HTML,
  and whitespace stripping on `SMTP_PASS` (Google displays App Passwords in spaced groups).
- **`scripts/mailCheck.js`** + `npm run mail:check [recipient]` — **new.** Connects/authenticates
  on demand, optionally sends a real test. Exists because `raiseAlert` swallows email failures by
  design, so a bad credential is otherwise invisible.
- **Recovery confirmation** — an alert now auto-resolves only after `ALERT_RECOVERY_SAMPLES`
  (default 3) *consecutive* normal readings; the previous band is held meanwhile.
  `alertBandState` gained `confirmRecovery`/`breakRecovery`; `agentService.checkThresholds` and
  `handlers/sensorHandler.js` both use it, so they cannot drift.
  **The bug it fixes:** a RESOLVED alert deliberately stops suppressing duplicates (so genuine
  recurrences re-alert), which meant one premature auto-resolve let the next swing raise a fresh
  alert — an alert/email storm for a metric oscillating around its threshold. The 5% hysteresis
  alone was the only thing standing against it. Escalation is unaffected and still instant.
- **`.env`** — `RESEND_API_KEY`/`RESEND_FROM` out; `SMTP_HOST/PORT/USER/PASS`, `MAIL_FROM`,
  `ALERT_RECOVERY_SAMPLES` in. `npm uninstall resend && npm install nodemailer`.
- **`ictu-email-account-request.md`** — **new.** The request to ICTU for a production sending
  mailbox (`ictusupport@cspc.edu.ph`): reasoning, copy-paste email, objections, fallbacks.
- **`email-popup-notifications.md`** — condensed 691 → ~215 lines and brought up to `main`'s scope
  (router/UPS/MikroTik triggers via `deviceAlerts.js`, report email). Design history stays here.

### Branch note (important)
The old `email-popup-notifications` branch is **abandoned, do not merge it.** Its feature is
already in `main` (commit `8e558dd`), and it sat 82 commits behind — merging would have reverted
`main`'s newer `agentService` (+150), `alertRulesService` (+60), `emailService.sendReportEmail`
(+59) and dropped `deviceAlerts.js` entirely. Today's three commits were re-applied by hand onto
`main`'s files instead; that branch now holds nothing unique.

### Verified
- `npm test` → **66/66 pass** (60 pre-existing + 6 new in `tests/alertBandState.test.js`, incl.
  ten oscillation cycles asserting recovery is never confirmed). `node --check` on every changed
  file. `reportService` import resolves; `emailService` still exports `sendReportEmail`.
- **Live:** an App Password on `magregorio@my.cspc.edu.ph` (a CSPC Workspace *student* account)
  authenticated against `smtp.gmail.com:587` and delivered to both a CSPC address and an external
  non-CSPC address → **App Passwords are not disabled tenant-wide**, the main risk to this approach.

### Still pending / not done
- **Send the ICTU request** for `ictusupport@cspc.edu.ph`. Not a deploy blocker — blank SMTP
  credentials disable email cleanly while bell/toast/OS popup keep working.
- Report email not re-tested end to end after the transport swap (code path verified, not driven).
- Full alert pipeline not yet run with mail enabled; multi-user fan-out untested (one real account).
- Revoke the old Resend API key at resend.com — uninstalling the package does not invalidate it.
- **`popup_enabled` pref is dead code** — stored and exposed in the API type, but nothing reads it;
  users cannot actually disable OS popups from Settings.
- **`alert_notifications.emailed`** is written but never read or displayed.
- No paginated "view all" notification history; the bell shows the latest 30.

---

## SESSION 18 — 2026-06-22  *(Predictive Analytics Phase 1 — logged as Session 14 on the `predictive-analytics` branch)*
**Branch:** `predictive-analytics` (off `origin/main`)
**Developer:** Mark Gregorio

> New feature: **Predictive Analytics**. Phase 1 built end to end — **disk-full ETA**
> (supervised linear regression, validated) + **alert analytics**. Branched off `main`
> on purpose so it's independent of the in-flight `router-ups-monitoring` /
> `mikrotik-monitoring` work (network/UPS analytics are deferred until those merge).
> Blueprint + study guide: **`predictive-analytics.md`** (the math is in §2–4).

### Decision / scope
- **Technique = linear regression** (least squares) as the core — the one method that is
  both genuinely useful *and* legitimately ML (supervised regression), runs in pure Node
  (no Python service), and is fully explainable. EWMA/Holt-Winters/z-score (later phases)
  are statistics, not ML — documented honestly so it isn't oversold for a defense.
- **Flagship = disk-full ETA.** Scope this phase: servers + environment + alerts (all on
  `main`). Network/UPS forecasting waits on the router/mikrotik branches (same engine,
  additive). Phasing/strategy in `predictive-analytics.md` §8.

### Backend (new)
- **`services/analyticsService.js`** — the engine. `linearRegression()` (slope/intercept +
  in-sample R²/MAE), `score()` (out-of-sample), `splitTrainTest()` (chronological 80/20 —
  time series must train on the past). `forecastDiskFull()` pulls hourly-avg `disk_percent`
  per server from InfluxDB (whitelisted Flux, no injection — mirrors `serverHistoryHandler`),
  fits the line, computes **ETA to 100%**, validates on a held-out tail, and gates a
  confidence label on R² (high/medium/low). `alertSummary()` = MTTR, severity mix, per-day
  volume, noisiest devices/types over the real MySQL `alerts` table.
- **`routes/analytics.js`** — `GET /api/analytics/forecast/disk`, `/forecast/disk/:id`,
  `/alerts/summary`; `authMiddleware` + `requireRole("admin","it_staff")` (read-only insight,
  so both roles, unlike admin-only Alert Rules).
- **`src/server.js`** — import + `app.use("/api/analytics", analyticsRoutes)`.

### Frontend (new + wiring)
- **`pages/Analytics.tsx`** — Grafana `--gf-*` styled. **Disk-Full Forecast** table (current %,
  trend/day, ETA, "full by" date, confidence badge, R²·MAE, 7/14/30-day lookback switch) +
  **Alert Analytics** (total/open/MTTR tiles, severity & noisiest-source bars, type chips,
  daily-volume sparkline).
- **Wiring:** `api.ts` (`getDiskForecast`, `getAlertSummary`), `App.tsx` (route + title),
  `data/users.ts` (added `"analytics"` to **both** roles), `Sidebar.tsx` (nav item + icon).

### Verified
- Backend `node --check` (service, route, server.js) clean; frontend **`tsc --noEmit` clean**.
- Fixed one TS error: `CONF_COLOR` was `Record<string,string>` → under `noUncheckedIndexedAccess`
  indexing returned `string | undefined`; typed it to the exact `"high"|"medium"|"low"` union.
- Backend boots + route is mounted: unauthenticated `GET /api/analytics/*` → **401** (not 404).

### Still pending / not done
- **Forecasts need history to be meaningful** — disk ETA is noisy until ~1–2 weeks of
  `server_metrics` exist; the R² gate shows "Need more data"/low-confidence until then (by
  design). Alert analytics is useful immediately.
- **Phases 2–4 not started:** trend charts + EWMA projection, anomaly detection, threshold
  **recommendations** → Alert Rules. Network/UPS forecast deferred to after router-ups +
  mikrotik merge (then rebase). See `predictive-analytics.md` §8.
- Live end-to-end with real agent data not driven here (build/typecheck + boot/route probe only).
- Branch not PR'd into `main`.

---

## SESSION 19 — 2026-06-22  *(Predictive Analytics Phases 2–4 — logged as Session 15 on the `predictive-analytics` branch)*

Built the remaining server/environment analytics phases on top of Session 14's engine.

### Shared engine
- **`services/analyticsService.js`** — added a `METRICS` registry mapping the `alert_rules`
  vocabulary (`cpu`/`mem`/`disk`, `temperature`/`humidity`/`gas`) to its InfluxDB source, plus
  one `fetchMetricSeries()` (server `server_metrics` w/ optional device filter; env
  `sensor_environment`; `gas` = `max(mq2_1_ppm, mq2_2_ppm)` to match `sensorHandler`). Window +
  ids clamped before touching Flux (injection-safe, same posture as `serverHistoryHandler`).

### Phase 2 — trend + projection
- `ewma()`, `holtLinear()` (double-exponential = non-seasonal Holt-Winters), `forecastTrend()`
  (EWMA-smoothed history + Holt's-linear horizon, bounded for % metrics) → `GET
  /api/analytics/trends/:metric?deviceId=&hours=&horizon=`.
- Frontend: metric/server selector + inline-SVG `TrendChart` (actual + EWMA + dashed projection,
  forecast region shaded, non-scaling strokes).

### Phase 3 — anomaly detection
- `percentile()`, `mean`/`stddev`, `detectAnomalies()` — 24-bucket per-hour-of-day baseline
  (local hour, UTC+8), flags `|z| > 3` (configurable 2–5), adds global Tukey IQR fences →
  `GET /api/analytics/anomalies?metric=&deviceId=&days=&z=`.
- Frontend: stat tiles + recent-anomaly table (shares the metric selector with Phase 2).

### Phase 4 — threshold recommendations
- `recommendThresholds()` — p50/p95/p99 per metric (server metrics pooled across all servers =
  global rule scope) → suggested warn=p95/crit=p99, compared to current global `alert_rules`
  (via `alertRulesService.getEffectiveRules`) → `GET /api/analytics/recommendations?days=`.
- Frontend: recommendation table; **admin-only Apply** upserts the global rule (reuses
  `createAlertRule`/`updateAlertRule`, comparison `>`); read-only note for it_staff.

### Verified
- Backend `node --check` (service + route) clean; frontend **`tsc --noEmit` clean** (fixed
  `noUncheckedIndexedAccess` nits in `TrendChart` / device auto-pick).
- Route already mounted from Session 14 (`app.use("/api/analytics", …)`).

### Still pending / not done
- **Maturity:** trend/anomaly need ~1 week of history; recommendations ~2 weeks. Until then the
  panels show "need more data" (by design).
- **Holt-Winters seasonality** is intentionally *not* a separate seasonal model — the daily
  cycle is handled by Phase 3's per-hour baseline; Phase 2 is Holt's linear trend only.
- **Network/UPS forecast (§8 row 2b/3b)** still deferred until router-ups + mikrotik merge.
- Live end-to-end with real data not driven here (build/typecheck only); branch not PR'd.

---


## SESSION 20 — 2026-08-09
**Branch:** `analytics-integration` (new — `main` + `predictive-analytics` merged)
**Developer:** Mark Gregorio

> Merged the long-stale `predictive-analytics` branch with `main`, then **finished** the
> feature on the merged tree: the forecasts now run on live SNMP/MikroTik/agent data,
> disk forecasting matches how disk alerting actually works, every device is identifiable
> by name + class, and the math is unit-tested.

### The merge
- `predictive-analytics` was 15 commits ahead of a branch point that `main` had since
  moved **125 commits** past. Created `analytics-integration` off `main` and merged the
  analytics branch into it (that direction means `main` can later fast-forward).
- Only **4 conflicts**: `backend/src/server.js` (kept both route sets),
  `Sidebar.tsx` (main's collapsible nav groups won; Analytics placed in *Operations*),
  `deployment-guide.md` (add/add — took main's 1068-line superset, dropped its
  "analytics is unmerged" roadmap entry, added an Analytics checklist item),
  `SESSION_NOTES.md` (both sides had a Session 14 **and** 15 — kept main's, appended the
  analytics ones as 18/19 noting their original numbers).
- Fixed a `ReferenceError` the analytics branch had introduced: its own refactor moved
  `mac` into `findExistingEnrollment()` but left `register()` still referencing it, so a
  **first-time** agent enrollment threw and rolled back. `main` was never affected —
  it declares `const mac` inside `register()`.

### Live data (closes `predictive-analytics.md` §12 item 8)
Verified field-by-field that the pollers on `main` write exactly what the forecasts read:
`ups_metrics.runtime_remaining_min`, `network_traffic.utilization_pct` + `interface_name`
tag, `router_metrics.cpu_percent`/`mem_percent`/`connected_clients`. **No forecast code
needed changing** — the seeded schema had matched the real handlers all along.
`seed-analytics-history.js` is now a dev convenience only.

### Device identity (`predictive-analytics.md` §14)
- **Names now resolve from MySQL at query time**, not the InfluxDB `device_name` tag.
  The tag is frozen at write time, and since forecasts group by `device_id` and read the
  name off the first row, a renamed device was showing its **oldest** label.
  `fetchDeviceIdentities()` uses `COALESCE(NULLIF(display_name,''), device_name)` — the
  same rule as `agentService` — plus `device_type` and `location`. Devices with no MySQL
  row (dev-seed ids, decommissioned) fall back to the tag.
- **Interfaces** resolve `network_interfaces.location_label` via `fetchInterfaceLabels()`,
  for the same reason. Grouping stays on `interface_name` alone — grouping on the label
  would split a port's history the moment someone relabels it.
- Every forecast row now carries `name` / `hostname` / `deviceType` / `typeLabel` /
  `location`.

### Disk forecast now matches disk alerting
`forecastDiskFull()` regresses **every volume** (`server_volumes`, per `mount`) and
headlines the fastest-filling one. Previously it regressed root-only `disk_percent` while
`main`'s `checkThresholds` alerts on the worst volume — so a server filling `D:` raised a
Disk alert while the forecast beside it read "Stable". Servers with no per-volume history
still fall back to the root series. Note the headline picks **soonest ETA**, not fullest —
a 40% volume climbing fast beats a static 88% one — falling back to fullest when nothing
has a trustworthy ETA.

### Math extracted + unit-tested (`predictive-analytics.md` §15)
- New **`services/analyticsMath.js`** — import-free, like `serverMetricUtils.js` and
  `historyRange.js`. Holds `linearRegression`, `score`, `splitTrainTest`, `validate`,
  `percentile`, `ewma`, `holtLinear`, `forecastSeries`, `projectToBound`,
  `worstVolumeForecast`, the ETA gates and the advisory copy. `analyticsService.js` now
  imports and re-exports them, so its public surface is unchanged.
- New **`backend/tests/analyticsMath.test.js`** — 48 tests. `npm test` went 66 → **114
  passing**. Covers the confidence gate explicitly: a noisy series must produce **no ETA**,
  and R² must go **negative** when the model is worse than the mean.

### Analytics page rework
- Three near-identical forecast tables collapsed into one **`<ForecastPanel>`** fed by a
  shared `ForecastRow` shape, so disk/UPS/link can no longer drift apart in how they
  colour an ETA or phrase a status. `TrendCell` knows which direction is *bad* per metric
  (disk/link rising, UPS runtime falling).
- New **`<DeviceLabel>`** = name + colour-coded class badge (Server / MikroTik / Router /
  UPS) + a sub-line (hostname when renamed, building for interfaces, location for UPS).
  Device dropdowns are class-prefixed.
- Link rows lead with the **building label**, port as sub-line.
- Multi-volume servers show per-volume chips under the name.
- New **Action Needed** panel gathers every advisory across all three forecasts, most
  urgent first, so the page opens with what's wrong instead of three tables to scan.
- Live refresh now also listens to `networkMetrics` / `upsMetrics`.

### Verified
- `npm test` **114/114**; `node --check` on every backend `.js`; frontend
  `tsc --noEmit` clean and `vite build` clean.

### Still pending / not done
- **Maturity, not code:** ETAs stay "Stable"/"need more data" until ~1–2 weeks of history
  accrues per source. By design (R² gate).
- **Not pushed.** `analytics-integration` is local-only; `main` has not been
  fast-forwarded and `predictive-analytics` has not been deleted.
- Deliberately **not** built (additions, not finishing): `ups_metrics.battery_status`
  (RFC 1628 enum) as a second degradation signal, recommendations surfaced on the Alert
  Rules page, an `analytics` report type for PDF export.
- No live end-to-end against real hardware in this session — build/typecheck/tests only.

---

## SESSION 21 — 2026-08-15 / 2026-08-16
**Branch:** `feat/agent-install-keys` (off `feat/privacy-terms-and-session-fixes`)
**Developer:** Mark Gregorio

> Consultant review round. Two of his suggestions built, one deferred; his catch on the
> forecast turned out to be a real modelling bug. Dashboard rebuilt around per-device
> charts. Four commits, none pushed.

### Consultant suggestion 1 — install keys (BUILT)
`AGENT_INSTALL_KEY` moved out of `.env` into `agent_install_keys`: admin-minted, labelled,
optional expiry, revocable, audited. Stored as a SHA-256 hash (enrollment lookup) **and**
an AES-256-GCM ciphertext (so the install command can be re-opened later) — encrypted
because `ops/db-backup` dumps MySQL onto the drive the offsite rclone job syncs.
`agent_tokens.install_key_id` records which key enrolled each agent, so a revoke can
optionally cut that fleet off (opt-in, never implicit, and reversible).

Two installer bugs found while testing end to end: `install.ps1`/`install.sh` silently
skipped registration when `agent.conf` existed (so a re-run ignored the `-InstallKey` it
demanded), and `register()` never re-stamped the owning key on an existing enrollment —
so `.env`-era servers could never be adopted. Both fixed; `-ReEnroll` / `--re-enroll` added.

### Consultant suggestion 2 — multi-site (DEFERRED — decision needed)
Per-branch admins seeing only their own campus. **The install-key half is done. The
access-scoping half is designed but unbuilt** — `sites`, `devices.site_id`, `user_sites`,
plus a site filter on ~15 device queries and a rule for who receives room-level alerts
(`device_id = NULL` has no site).

**Blocked on two answers from ICTU:**
1. Is a second campus actually coming, or is this hypothetical?
2. If real — is there a VPN / routed private network between campuses?

Answer 2 decides the shape: **push crosses a WAN, pull does not.** Go agents POST outbound
and work from anywhere; the SNMP and MikroTik pollers dial IN and need a routed link.

Two things not to get wrong when it is built:
- **Do not derive access from the install key.** The key is used once at enrollment;
  access is checked every request. Keying access off it makes moving a server between
  branches a reinstall.
- **One backend with site scoping, not a backend per campus** — separate backends mean
  separate `users` tables, so a head admin gets two logins and no combined view, which
  defeats the whole request.

⚠️ Scope limit: the environment/aircon half assumes exactly ONE server room (single
`aircon_ir_config` row, globally-unique `aircon_state.ir_channel`, room-level alerts with
`device_id = NULL`). Multi-site should cover **servers only** unless that is refactored.

### Consultant suggestion 3 — the forecast was wrong (FIXED)
He reported: 11 PM, room at 30 °C, projection opened at 32.44 °C then declined 0.17 °C/h
for twelve hours — through dawn into midday, which is when that room is hottest. Both
halves were real.

The projector was Holt's **linear** method — one straight line, which cannot turn around.
Reproduced on a synthetic room: by 11 AM it predicted 24.7 °C where the room reaches
32.8 °C. ~8 °C out, in the *opposite* direction. Now full additive Holt-Winters (hour-of-
day shape removed, Holt fits the remainder, shape added back): 12 h MAE **1.72 °C → 0.05 °C**.
The opening jump was separate — EWMA was being fed to Holt, so the projection started from
a doubly-lagged level. EWMA is display-only now, and the projection is anchored to the last
observation with the correction fading over 3 h.

**It also now refuses to forecast from unusable data.** The live DB had 53 readings over
6.4 days with a 117-hour gap and only 12 of 24 hours ever recorded — the sensor had never
observed a morning and was being asked to predict one. Four gates (span / hours covered /
largest gap / coverage) withhold the projection and say which failed.

### Dashboard rebuild
2×2 grid of same-shaped panels (Servers | Network, MikroTik | UPS), all `PANEL_H` tall,
each a picker + one chart. Average CPU/memory gauges removed (a mean across two hosts at
10% and 90% describes neither); that space now holds **Active Alerts**, which the page
never had. Dashboard now listens for `esp32Status` — a dead sensor used to leave the three
environment tiles frozen and still labelled LIVE.

### Charts break on gaps now (all 10)
`utils/seriesGaps` — a gap is any interval > 2.5× the series' **median** spacing (median,
because a mean would be dragged far enough by a long outage to hide it). Three bugs fell
out: `UpsDetail` had `spanGaps: true` (bridging missing data on the one chart whose job is
showing an outage); `?? 0` everywhere turned missing readings into a crash to 0% / 0 °C;
and throughput derived across a gap collapsed hours of traffic onto one timestamp.

### Bug sweep (2026-08-16)
1. **MikroTik `link_util` summed rx+tx** while the SNMP poller takes the busier direction.
   Both feed the same global rule, so the MikroTik tripped the 80% warning at ~40% real
   load. Now uses the shared `computeUtilizationPct`.
2. **`ups_load` and `router_clients` had no seeded rules** — evaluated by `deviceAlerts`,
   listed in CLAUDE.md, silent forever (alerting is rules-only). `ups_load` seeded 80/90
   active; `router_clients` seeded 200/300 **inactive**, because the right number is
   site-specific and a guess would either page constantly or never.
3. **Deleting a user destroyed history.** `alerts.acknowledged_by` and `system_logs.user_id`
   were `ON DELETE CASCADE` — removing a user deleted every alert they had acknowledged
   (i.e. exactly the ones someone took responsibility for) and their entire audit trail,
   including policy-acceptance evidence. Both now `SET NULL`.

### State
- 179 backend tests pass; frontend typechecks and builds.
- Migrations applied to the dev DB: `2026-08-15_agent_install_keys`,
  `2026-08-15b_install_key_reveal`, `2026-08-16_missing_alert_rules`,
  `2026-08-16_preserve_history_on_user_delete`. All folded into v13.
- **Not pushed.** Four commits on `feat/agent-install-keys`, local only.
- **Not verified on screen.** Everything this session is build/typecheck/test only —
  the Dashboard layout, the chart gaps and the install-key flow have not been watched
  running. That is the first job next session.

### Next session — 2026-08-16

**Main agenda item: PLAN MULTI-SITE.** Not build it — plan it. Agreed at the end of
Session 21 to sit down and work the design through properly.

What that session needs to settle, roughly in order:

1. **Is it real?** Second campus confirmed, planned, or hypothetical? This decides whether
   the outcome is a build or a Future Work chapter — and either is a fine answer, but the
   design differs.
2. **Is there a routed link between campuses?** Push crosses a WAN, pull does not: Go
   agents POST outbound and work from anywhere, while the SNMP and MikroTik pollers dial
   IN and need a VPN or a routed private network. Without one, multi-site covers **servers
   only** and the other campus's routers/UPS/environment stay invisible centrally.
3. **Scope: servers only, or everything?** Strong recommendation servers only. The
   environment/aircon half assumes exactly ONE server room — single `aircon_ir_config`
   row, globally-unique `aircon_state.ir_channel`, room-level alerts keyed on
   `device_id = NULL`. Widening that is its own project.
4. **Who receives a room-level alert?** The unsolved design question. Temperature, gas,
   humidity, ESP32-offline, backup health and forecast alerts all carry `device_id = NULL`,
   so they have no site to filter by. Either `alerts` gains a `site_id`, or site-less
   alerts deliberately go to everyone. Needs a decision before any code.
5. **How many admins does ICTU actually have?** If it is two or three people in one unit,
   site scoping may be solving a problem they do not have — worth asking before spending
   the effort. The install keys already solve the problem they *do* have today.

Design constraints already settled (do not relitigate):
- **Access is NOT derived from the install key.** The key is used once at enrollment;
  access is checked every request. Keying access off it makes moving a server between
  branches a reinstall.
- **One backend with site scoping, not a backend per campus.** Separate backends mean
  separate `users` tables, so a head admin gets two logins and no combined view — which
  defeats the request that started this.
- Shape: `sites` table, `devices.site_id`, `user_sites` join table, one shared "sites this
  user may see" helper applied to ~15 device queries. `agent_install_keys.site_id` decides
  where a newly enrolled server LANDS; ownership afterwards is editable.

**Before the discussion, also:**

6. **Verify the UI on screen** — everything in Session 21 is build/typecheck/test only.
7. **Leave the ESP32 running 2–3 continuous days** (incl. overnight) so the forecast gate
   opens — the caption should change from "Holt's linear" to "Holt + daily cycle".
8. **Update the `.mwb` model** — see `erd-update-guide.md` (5 items). The manuscript's ER
   diagram comes from it, and it is now behind the schema again.

**Still open, unscheduled:**
- Firmware has committed WiFi credentials + `DEVICE_SECRET`, and still sends the device key
  in the Socket.IO **URL query** (F-04, open since the 2026-06-05 threat model).
- `/api/agents/status` returns the permanent agent token via a query string.
- README still describes Analytics and the PiP widget as unmerged branches, and still says
  the model is "current as of v13 (24 tables, 24 figures, 30 relationships)".
- Deliberately not built: Dashboard click-through beyond the alerts panel, and an analytics
  "upcoming risks" strip on the Dashboard.

---

## SESSION 22 — 2026-08-16
**Branch:** `feat/agent-install-keys` → merged to `main`, branch deleted
**Developer:** Mark Gregorio

> Session 21's agenda was to PLAN multi-site. It got settled — as a "no", with a better
> answer behind it. Then the three oldest security items were fixed, the model and the
> DFDs were brought current, and everything on the branch was merged and pushed.

### Multi-site — SETTLED. Separate deployment per campus, not site scoping.

The missing fact arrived: CSPC has two campuses, the client is on the main one, and
**campus 2 has no server room at all yet**. The consultant's question was "what if ICTU
builds one there in a year?"

That is not the hypothetical the Session 21 notes assumed, and it flips the answer:

**The system is LAN-bound by design, so a second campus needs its own backend regardless.**
The SNMP and MikroTik pollers dial *into* device IPs; the ESP32 holds a Socket.IO
connection to a host on its own network. Neither crosses a WAN without a VPN. Go agents
POST outbound and would work from anywhere, but they are one of four ingest paths.

Once a backend exists at campus 2 — which it must — **the isolation the consultant asked
for arrives for free, and in a stronger form.** Site scoping is isolation by *policy*: 50
device-query sites across 12 service files (not the ~15 Session 21 estimated), each needing
the filter, each a place to leak main campus's data. Separate deployment is isolation by
*architecture*: campus 2's admin cannot see main campus because that data is not in their
database. Nothing to bypass, nothing to get wrong.

It is also the safer failure mode. Environment monitoring is the smoke and heat alarm; it
must not depend on a link between campuses.

**Cost, accepted:** two logins, no combined dashboard. If ICTU wants one view later that is
a small read-only rollup, not a merge of the two systems.

**Do not restart the `sites` / `user_sites` design.** It only makes sense with one backend
holding both campuses, which is precisely what the LAN constraint rules out. The work is
now a Future Work chapter, not a build.

Two things that pushed the same way, worth keeping:
- A "server room" at campus 2 means a second **ESP32**, and the environment half assumes
  exactly ONE room: a single `aircon_ir_config` row, a globally-unique
  `aircon_state.ir_channel`, one shared `DEVICE_SECRET`, no `devices` row for the ESP32,
  and `sensor_environment` written with **no device or room tag at all** — only the three
  status tags. Two rooms would merge into one indistinguishable series. Session 21 filed
  the environment side as a corner case to dodge; under this scenario it was the main
  problem. Separate deployments make it moot.
- The consultant was picturing a **multi-tenant product** (Grafana Cloud, Datadog): many
  customers, each bringing their own servers. This is single-tenant — one ICTU team, one
  server room, and alerts fan out to every active user *on purpose* so whoever is on duty
  responds. Per-user scoping would let an alert fire with nobody watching it.

### Security — the three oldest open items, fixed (F-04 and the agent token)

All three were the same shape: a secret sitting somewhere that gets copied or logged.

1. **Firmware secrets were committed.** `env_monitor_v2.ino` carried a real WiFi password
   and the real `DEVICE_SECRET` as literals, so every clone had them. Now in
   `iot/esp32/env_monitor_v2/secrets.h` (gitignored) with `secrets.h.example` as the
   template. The sketch also moved into `env_monitor_v2/` — the Arduino IDE relocates a
   sketch into a folder named after it, and `secrets.h` must sit beside the `.ino` to
   compile. ⚠️ **Both values remain in git history since `5f5a084`, and `main` is now
   pushed to GitHub. The split stops new exposure; it does not undo the old one. ROTATE
   BOTH** — the WiFi password, and `DEVICE_SECRET` in `backend/.env` + `secrets.h` +
   a reflash.
2. **The device key travelled in the Socket.IO URL** (`?deviceKey=…`), which a proxy or web
   server writes verbatim into its access log on every reconnect. Now an `X-Device-Key`
   header via `setExtraHeaders`. EIO3 has no `auth` payload — that arrived in Socket.IO v3
   — so a header is the equivalent. The handshake reads `auth → x-device-key → query`; the
   query fallback stays until every ESP32 is reflashed, then delete it.
   ⚠️ **Not verified on hardware.** If the library version does not apply the header to the
   upgrade request the box will fail auth. Rollback is one line.
3. **`GET /api/agents/status` handed out the permanent token off a query string.** The
   agent polls it every 10s while waiting for approval, so the pending token — which is
   exchanged for the permanent `AGT-…` — landed in the access log dozens of times per
   enrollment. Now `POST` with the token in the body. No rate limiter added: the token is
   24 random bytes, so there is nothing to guess, and `enrollLimiter`'s budget would cut
   off a legitimate agent long before an admin approved it. Only newly-installed agents
   call `/status`, so rebuilding the binary is enough.

### Install keys panel — label removed, light mode fixed

The **label was dropped end to end.** It was a second name for something the key already
had; a key is identified by its prefix and its dates, which are facts. Gone from the create
form and the table (the prefix takes the first column and carries the `by <creator>` line); the
revoke and delete dialogs name keys by prefix. `agent_install_keys.label` is NOT NULL and
the audit trail reads through it, so the server writes `Issued <date>` when none is given —
the API still accepts one, so it can come back with no backend change.

**Light mode was broken, not merely untuned:** the code wells hardcoded
`rgba(0,0,0,0.25)`, painting a near-black block onto a white panel. They use `--gf-bg` now.
Type that sat on `--gf-accent` moved to `--gf-accent-text` — `#5794F2` is 2.76:1 on the
light background, fine as a fill and unreadable as an 11px label.

Green is gone from the panel except the `active` status badge, which is the design system's
Online/NORMAL and shared with every other page. (Noted: that green measures ~2.2:1 on a
white panel — weak in light mode, app-wide, not introduced here.) Copy buttons are now the
two-sheets clipboard icon; failure still shows text, because the dashboard is served over
plain HTTP on the LAN where `navigator.clipboard` does not exist.

### ERD + DFDs

- **`.mwb` brought level with v13** (the five changes in `erd-update-guide.md`). The guide
  gained the cardinality each relationship is drawn with — all three new ones are
  one-to-many and optional — plus the Workbench trap behind the count: the 1:n **toolbar
  tool creates a column**, so using it would add a `users_user_id` beside the `created_by`
  that already exists. Constraints go in the table editor's Foreign Keys tab; the lines
  draw themselves. Two FKs to `users` = two lines, which is why connections go 30 → **33**.
- **DFDs committed** (`docs/dfd/`, level 0 + level 1, Gane–Sarson). Install-key management
  is drawn on process **1.0 Authenticate & Authorise**, not 2.0: minting a key grants a
  machine the right to enrol, the same act as approving a person's registration, and 2.0 is
  where the key is *spent* (already carried by the agent-token flow). Band 1.0 had no free
  corridor, so it was reflowed — every existing flow keeps its exact absolute y. Balance is
  now **26 boundary flows (8/8/4/2/3/1)** into 15 level-0 composites. Four superseded
  drafts deleted.

### State

- 179 backend tests pass; frontend typechecks and builds.
- **Merged to `main` as a fast-forward** (99 files, +9129/−2144) and **pushed** —
  `9e64114..b86bcec`, 25 commits. `feat/agent-install-keys` deleted.
- `feat/privacy-terms-and-session-fixes` still exists locally: fully merged into main, but
  10 commits ahead of its own remote, so `git branch -d` refuses it. Needs `-D`.
- `environment-monitoring` is genuinely NOT merged and its upstream is gone. It holds
  commits that exist nowhere else, incl. the standalone SD-card test sketch. Look before
  deleting.
- **Ops note:** a login failure this session was `ECONNREFUSED` on MySQL — XAMPP's MySQL is
  not registered as a Windows service here, so it does not survive a reboot and must be
  started from the Control Panel. Nothing to do with the code. Worth installing it as a
  service before the defense.

### Next session

1. **ROTATE the WiFi password and `DEVICE_SECRET`** (see above) — the one item with real
   exposure behind it, now that `main` is on GitHub.
2. **Reflash and watch the serial log** — the `X-Device-Key` header is the only change this
   session that has not run on hardware.
3. Write the multi-campus **Future Work** section into the manuscript while the reasoning
   above is fresh.
4. README is still stale: Analytics and the PiP widget described as unmerged branches, and
   the model still called "current as of v13 (24 tables, 24 figures, 30 relationships)" —
   now 25 tables and 33 relationships.

**Still open, unscheduled:**
- Firmware still ships WiFi credentials in a gitignored file rather than a provisioning
  flow — fine for a capstone, worth naming as a limitation.
- Deliberately not built: Dashboard click-through beyond the alerts panel, and an analytics
  "upcoming risks" strip on the Dashboard.

---

## SESSION 23 — 2026-08-22
**Branch:** `feat/router-ups-completion` (off `main`, **not yet merged**)
**Developer:** Mark Gregorio

> The client returned the Router & UPS questionnaire. Reading it changed what the feature
> had to be: CSPC owns **no non-MikroTik managed router at all**, so the SNMP half had
> nothing to point at. Building the long-deferred **ICMP fallback** turned it from a
> feature with zero devices into one with a real device. Along the way, a UPS on BYPASS
> turned out to be reported as perfectly healthy.

### The questionnaire, and what it actually said

Transcribed to `router-ups-client-answers.md`; photos kept in
`router&ups_questionnaire_answers/`.

**Policy answers all landed.** v2c confirmed (§10 Q3 closed), **no firewall** between the
backend and the devices (Q9 closed), a read-only community string already in use, and a
named admin ("Sir Alex" — first name only, no contact).

**Device answers did not, and one reshaped the feature:**

- **Section 2 asked for non-MikroTik routers and three of its four rows are MikroTik
  CloudCore.** Those are data source B, already polled over the RouterOS API. Registering
  them here would double-count one physical router as two `devices` rows with two InfluxDB
  series. That leaves **one in-scope router: the ISP-owned PLDT DMZ box** — and its
  Managed/Basic checkbox is the one they left blank. Its IP reads `10.233.200.18` but could
  be `10.253.200.18`; confirm before registering.
- **All three UPS rows claim an SNMP card and none carries an IP.** A later nameplate photo
  (PHOENIX **TTN-V 2K VA RT UNITY IoT**, 2000 VA, 6 x 12 V 7 Ah) shows a **MAC address**,
  which proves a network interface — so the "Yes" answers are credible after all. Still
  open: whether that interface speaks **RFC 1628** or only the vendor's `UNITY IoT` cloud
  app. One `snmpwalk 1.3.6.1.2.1.33` settles it. Brand mismatch on record: the form says
  KEDOS / NewStar Industrial, the nameplate says PHOENIX, and nobody knows which row it is.
- **Fix the source `.docx` before reusing the form**: the UPS header prints as
  `Has a network/ SNMP card?` with *"Has a network"* struck through. The respondent read a
  malformed question.

### ICMP fallback — built (router-ups-monitoring.md §11's last open item)

A router now needs only an IP: with a community it is polled over SNMP, without one it
falls back to ICMP. The add form drops its community requirement for routers accordingly;
a **UPS still requires one** — pinging a battery tells you its management card has power.

ICMP also runs **alongside** every SNMP and RouterOS poll, filling `latency_ms` /
`packet_loss_pct` — fields `networkMetricsHandler` was always ready to write and both
collectors always returned as `null`. They say what SNMP structurally cannot: a walk either
answers or times out, so a link dropping 40% of packets reads as perfectly healthy right up
until it flips to a flat Offline. On the SNMP failure path the two verdicts are combined, so
the log finally distinguishes a dead router from a wrong community or a blocked UDP 161.

Two decisions worth keeping:

- **We shell out to the OS `ping`, not raw sockets.** `net-ping` needs Administrator on
  Windows and root on Linux; running the whole backend elevated is a far worse trade than
  parsing text, on a box that also holds `JWT_SECRET` and every device credential.
- **The parser reads numbers, `ms` and `=`/`<` — never English words.** `ping` is localized
  (German `Zeit=15ms`, French `temps=14,7 ms`), and a word-matching parser works on the dev
  machine then silently reports 100% loss on a differently-localized server —
  indistinguishable from a dead device. A reply line is identified as "carries BOTH an
  address and an RTT", which separates it from every summary line on every platform and
  correctly rejects Windows' *"Reply from 10.0.0.1: Destination host unreachable"*.
  18 tests over 5 platform/locale fixtures in `tests/pingOutput.test.js`.

The ping path **writes its sample even when the device is DOWN** — `reachable` +
`packet_loss_pct` are the only two things a no-SNMP router ever gives, so dropping the point
during an outage would blank the chart exactly when it is worth reading.

### UPS on BYPASS — a silent gap, now alerted

`upsOutputSource` has named `bypass(4)` since `snmpClient.js` was written, but its only
interpreter was `isOnBattery`, which tests `battery(5)`. **A UPS on bypass reported
`onBattery: false` and read as perfectly normal** — green tile, no alert — in front of a
rack with **zero** seconds of runtime. Exactly backwards from the risk: on-battery is loud
and gives you minutes; bypass was silent and gives you none.

The enum and its interpreters moved to the pure `snmpUtils.js` (`upsOutputState()` folds all
seven RFC 1628 values into normal | battery | **bypass** | off | avr | unknown). Bypass and
output-off now raise their own **critical** alerts, with their own banners and wording
everywhere — ordered above on-battery, because it is the state with no clock behind it.

Booster/reducer (AVR) deliberately raises nothing: the load is still protected and
`ups_input_voltage` already alerts on the bad mains that causes it. It reaches the dashboard
as `outputState: "avr"` so it can still be seen.

`isProtected` is written as "**not** one of the three we KNOW are unprotected", never as an
allow-list. A UPS reporting `other(1)` has told us nothing, and turning that silence into an
outage would page someone over a firmware quirk. A test asserting exactly that caught the
allow-list version.

### The ICMP metrics reach alerting, reports and analytics

- **`router_latency` / `router_loss`** evaluated in `deviceAlerts.checkRouter` against the
  configurable `alert_rules` (migration `2026-08-22_icmp_alert_rules.sql`, folded into v13).
  **`router_loss` ships ACTIVE** at 5% / 20% — loss is not site-specific, 0% is healthy on
  every link everywhere. **`router_latency` ships INACTIVE** at 100/300 ms: a rack switch
  answers in under 1 ms and an ISP CPE in 20-40 ms and *both are healthy*, so one global
  number would either page constantly or never fire.
  With the default `PING_COUNT=3` the only possible loss values are 0/33/67/100, so both
  bands trip on the first lost echo. **`PING_COUNT=10` is now set in `backend/.env`**, giving
  10% steps so warning and critical mean different things.
- **Reports:** a ping-only router had a **blank row in every column** — no CPU, memory,
  clients, interfaces or traffic. The network report now queries the ICMP fields; the Devices
  table gains Avg ms / Max ms / Loss %, plus a **Worst packet loss** summary line.
- **Analytics:** both metrics added to the registry. `router_latency` carries a new
  **`recommend: "scoped"`** marker — recommendable per device and never fleet-wide, for the
  same reason its rule ships inactive. That closes the loop the rule was designed around:
  instead of "watch it for a few days and pick 2-3x", the p95/p99 of what *this* link does is
  computed and applied in one click.

### Three bugs I introduced, and one I found

- **My history merge shattered every throughput line.** I merged `network_traffic` and
  `router_metrics` into one row per timestamp so a ping-only router would have something to
  chart. They do not share timestamps — `derivative()` lands the throughput series one window
  later than the raw gauge reads. Measured live: **`-1h` (20s windows) had ZERO shared
  timestamps** out of 56/57 rows, so every merged row was half-null and the client (which
  draws a null as a gap, deliberately) never drew a line at all; `-6h` (2m windows) shared 46
  of 47 and merely looked chopped up. Returned as **two arrays** now — nothing ever needed
  them interleaved, since a chart draws throughput *or* ICMP, never both on one axis.
- **Ping-only routers were missing from their own Analytics picker.** The device list was
  derived from `linkForecasts` — devices that report *interface* traffic — so a ping-only
  router never appeared, making Latency and Packet Loss unreachable for the one device whose
  only metrics those are. Same class of bug on the Threshold Recommendations picker, which
  offered servers only.
- **Latency and loss were invisible on the pages that own the device.** Both detail pages
  showed them only in ping mode, so an operator could get a "Latency high" alert and find
  nothing on that router's page. The MikroTik path needed more: `pollDevice` measured ICMP but
  never put it in the `latest` cache, so `GET /api/mikrotik` did not carry the fields at all.
- **Found, not introduced:** the Dashboard's focus charts went permanently blank after a
  session rotation. The interceptor correctly refused to log out over a replaced session's
  403 — but it also **dropped the request**, and those charts fetch once from an effect keyed
  on `[device, range]`. Now retried once under the current token; safe for any method, since
  auth rejects before the route handler runs.

### Verified on live data

`npm run probe -- <ip> [community] [port]` was added because `router-ups-monitoring.md` §9
tells you to run `snmpwalk` before registering a device, and **snmpwalk does not ship with
Windows** — the step was effectively dead. It runs the same `snmpClient` / `icmpPing` code
the poller runs, touches no DB, and prints a verdict naming the form to fill in.

| Device | Type | ICMP points (30 min) |
|---|---|---|
| Campus MikroTik | mikrotik | 51 |
| Huawei Router (ISP-owned) | router, **ping-only** | 29 |
| Dev Router (simulator) | router, SNMP | 29 |

A real ISP-owned home router probed exactly as the PLDT box is expected to: reachable at
1 ms, SNMP timed out, verdict **ping mode**. The dev simulator's UPS and router both probe
correctly, and bypass / battery / off were verified by flipping `upsOutputSource` in the
`.snmprec`. 212 tests pass; `tsc` and the production build are clean.

### Documentation

`CLAUDE.md` (env vars, the two new services, and why each odd choice),
`router-ups-monitoring.md` (§8, §10 Q1/Q2, §11), `report-page.md`,
`predictive-analytics.md`, `pip-widget.md`, and the new `router-ups-client-answers.md`.
**No ERD change** — this branch adds zero structural SQL: the new rules are *rows* in
`alert_rules`, and `device_network.snmp_community` was already nullable.

### Next session

1. **Merge `feat/router-ups-completion` to `main`** — 19 commits, nothing merged yet.
2. **DFD: one label, both files.** In `docs/dfd/dfd-level0-clean.drawio` and
   `dfd-level1-clean.drawio`, the arrow to **Router / MikroTik** reads `SNMP / RouterOS
   query`; it should read `SNMP / RouterOS / ICMP query`. **Leave the UPS arrow alone**
   (`SNMP query` stays correct — there is no ping fallback for a battery).
3. **Campus visit** — the only remaining blockers, none of them code:
   - 3 UPS IPs from the MikroTik's DHCP leases (match the nameplate MAC — the photo cuts it
     off after `00`), then `npm run probe` each one
   - the community string from Sir Alex, plus his contact
   - `npm run probe` the PLDT router; blank community if SNMP is locked
   - **DHCP reservations before registering** — the poller keys on IP, and a moved lease
     reads as Offline with nothing on screen explaining why
   - the management VLAN's ID/subnet, and confirmation the backend has a leg on it

**Still open, unscheduled:**
- **No real UPS has ever been polled.** Bypass, battery-fault and the rest work against the
  simulator, which returns clean textbook values for every OID. Real units routinely omit
  optional ones (temperature, battery voltage) or return sentinels. The code handles that
  (`inRange` to null, conditional fields) but it is reasoned-about, not observed.
- An unreachable MikroTik writes **no** sample at all, ICMP included, because the API call
  throws first. Consistent with the SNMP path, but it means no latency data at the moment you
  would most want it. Deliberate for now.
- Alert-type chips in Analytics still render raw names (`router_loss - 4`). Cosmetic, and it
  predates this session.

---

## SESSION 24 — 2026-08-25 / 2026-08-26
**Branch:** `main`
**Developer:** Mark Gregorio

> Twenty audits in two waves — nine quality reviews, then eleven security ones — each ending
> in applied fixes rather than a report. The last of them found a **live credential readable
> in git history**, which turned the session's closing act into a history rewrite and a
> force-push. The audit reports themselves live in `audits/`; this entry records what
> changed and what is still open.

### Wave 1 — nine quality reviews (2026-08-25)

Architecture, design patterns, SOLID, resilience, error handling, error flow,
naming/readability, code complexity, code duplication, testing. Reports in `dccb682`, the
fixes they produced in `94ae6cc`, the tests in `6a77089`.

### Wave 2 — eleven security audits (2026-08-26)

Secrets management, session/cookie, auth flow, authorization, API/infra, database, file
handling, logging/monitoring, business logic (+ a threat model), project structure, and the
consolidated `SECURITY-REPORT-2026-08-25.md`. Landed with their fixes in `c891471`.

**New code the audits forced into existence:**

- **`npm run rekey`** (`backend/scripts/rekeySecrets.js`) — the rotation path that did not
  exist. Four columns held AES-GCM ciphertext and the documented answer to "how do I change
  the key?" was "you don't", which is not a security property. Rotation decrypts and
  re-encrypts every row **in memory before writing any of them**: a half-finished rotation
  leaves rows split across two keys and then neither key opens the table.
- **`services/communityCrypto.js`** — SNMP communities were cleartext in `device_network`,
  and that column feeds the nightly MySQL dump, which rclone copies offsite. Every
  router/UPS credential on campus was on Backblaze in the clear.
- **`services/handshakeLimiter.js`** — the Express limiter **cannot see `/socket.io/`**
  (Socket.IO answers those on the HTTP server; Express is never invoked), so the one
  endpoint accepting `DEVICE_SECRET` had no attempt limit at all.
- **`middleware/securityHeaders.js`**, **`utils/logSafe.js`**, an `ops/systemd` unit.
- Four migrations: agent token hashing (`2026-08-25` + `2026-08-25b` — the *pending* token
  mattered as much as the permanent one), alert-rule scope uniqueness, SNMP community at rest.

**Tests: 212 → 357.**

### Applied to the live system, not just to the repo

Rotated `DEVICE_SECRET` on both sides (`backend/.env` + `secrets.h`, verified identical to
each other and different from the burned value), applied the SNMP migration against
MariaDB 10.4.32, encrypted the 2 live communities, round-trip-verified all 5
`device_network` rows against a pre-change snapshot, then destroyed the snapshot — it held
the communities in the clear.

### The history rewrite — 2026-08-26

`audits/secrets-management-2026-08-26.md` S-01/S-02/S-03: three credentials sat in blobs
that the removal commits never deleted — the ESP32 `DEVICE_SECRET`, the home WiFi PSK, and
a real `AGENT_INSTALL_KEY` that lived in `server-metrics.md` for 66 days. All three are
already dead (rotated / unset), so this was hygiene before the repo is ever made public,
not an active breach.

Two `git filter-repo` passes:

1. `--replace-text` — the three values replaced with `REDACTED-*` placeholders across all
   291 commits.
2. `--path backend/uploads --invert-paths` — **12 profile photos** of real people, which
   pass 1 could not touch (`--replace-text` swaps text, it does not delete files). Both
   commits that touched them also touched other files, so no commit went empty.

Then force-pushed with `--force-with-lease` pinned to the pre-rewrite remote SHA.

**Verified after the push:** all three secrets return **0 commits** across every ref; zero
`backend/uploads` commits remain; 283 commits intact, none dropped; local and remote in
sync; 357 tests pass. A full pre-rewrite bundle was taken first.

⚠️ **A rewrite reaches this repository only** — not forks, not existing clones, not
anyone's reflog, and GitHub keeps orphaned commits reachable by direct SHA until Support
GCs them. That is why all three values were rotated *first*, and why the SHA-256 denylist
entry in `backend/config/env.js` (`3257818`) stays permanently: it is what keeps the burned
secret dead if it is ever pasted back in. **Any other clone of this repo must be
re-cloned, not pulled.**

### ICMP made visible — 2026-08-27

`networkHistoryHandler` has always returned both halves of a router's history in one
response (`{ history, icmp }`), for every router. Neither detail page ever read the second
one, so latency and packet loss existed as two static tiles with no trend behind them —
and a ping-only router, which writes nothing to `network_traffic`, had **no chart at all**.

- **`pages/NetworkDetail.tsx` + `pages/MikrotikDetail.tsx`** — an `IcmpChart` panel, drawn
  in BOTH modes rather than only for ping-only devices. ICMP runs alongside every SNMP
  walk and every RouterOS API call, and it reports the two things those structurally
  cannot: a walk answers or times out, so a link dropping a third of its packets reads as
  perfectly healthy until it flips to Offline. Two axes (ms left, % right) — the
  Dashboard's single shared axis is a compromise for a 120px panel, not the shape to copy
  at this size. Both axes use `beginAtZero` + `suggestedMax` (20 ms / 10 %) rather than a
  bare auto-scale: a rack switch answers in under a millisecond, and an axis fitted to
  0.9-1.2 ms turns that healthy flat line into a mountain range. `suggestedMax` is a FLOOR,
  so an ISP CPE at 40 ms still gets an axis that fits. Loss is deliberately not pinned to
  0-100 either — a real 2 % would be two pixels off the floor, identical to the healthy
  zero it is not.
- **`components/dashboard/NetworkFocus.tsx`** — on a MikroTik and an SNMP router the two
  figures join the legend as BADGES (`Latency 4 ms` / `Loss 0%`) beside In/Out, not as
  chart lines: bytes/sec, ms and percent share no axis, and two more lines would bury the
  throughput the panel exists to show. A ping-only router keeps them as lines, where they
  ARE the chart. The badges read the LIVE device row, not `history` — the same call
  ServerFocus makes for its tiles, since the chart may be on a 30-day range whose last
  aggregated point is hours old.

### The MikroTik poller threw its own ping away — 2026-08-27

Found while verifying the above. `mikrotikPollerService.pollDevice` started an ICMP probe,
then `await collect(...)` **threw before `await icmpPromise` was ever reached** — so a ping
that had already been sent and answered was discarded on every failed poll.

Three consequences, all of which hid exactly what the new chart is for:

1. No `latency_ms` / `packet_loss_pct` stored for the whole outage. Campus MikroTik's API
   was down 2026-08-25 04:04 → 2026-08-27 02:37 and left **three ICMP points in thirty
   days**; the chart is blank across the window worth reading.
2. The log said a flat `"MikroTik unreachable — no API response"` whether or not the box
   answered ping — two states needing opposite fixes, reported identically.
3. A **critical** unreachable alert against a router that may be up and 2 ms away.

`snmpPollerService.pollRouter` has drawn this distinction since it was written ("but the
host ANSWERS ICMP … so SNMP is the problem"); this poller simply never did. The catch now
awaits the probe, honours `icmp.probeError` (a missing `ping` binary is the absence of a
measurement, not an outage), builds a verdict for `device_logs` via a new `reason`
argument on `setReachable`, writes an ICMP-only sample so the series stays continuous, and
keeps the figures in the `latest` cache. It no longer rethrows — `pollAll`'s catch calls
`setReachable`, which would reset that cache entry.

⚠️ The sample passes **`reachable: false`, not `icmp.reachable`**. `writeNetworkSample`
derives both the stored flag and the broadcast status from it ("Online" unless exactly
false), so handing it the ICMP verdict would emit `networkMetrics {status:"Online"}`
immediately after `networkStatus {status:"Offline"}` — every dashboard flipping between
the two on each poll. Nothing is lost: the record now reads "unreachable, yet answering in
2.3 ms with no loss", which is a sharper diagnostic than a bare `reachable:true`.

Also: `node-routeros` can reject a failed connect with an **empty** `err.message` (verified
against a closed port), which left the log line blank where the cause belongs — there is
now a fallback through `code`/`errno`.

**Verified:** reproduced the exact shape against `127.0.0.1` (answers ICMP in 1 ms, nothing
on 8728) with no DB or InfluxDB writes — `collect()` rejects, the probe resolves reachable,
the API-down-but-pingable branch is taken. 357 tests pass; `tsc --noEmit` and the
production build are clean. Not yet exercised against the real router, which is currently
healthy — to do that, block TCP 8728 to it and watch the log line and the chart.

### S-04 and S-11 closed — 2026-08-27

**S-04, the last of it.** `root`/empty was already refused and the backend already ran as
`cspc-ictu_app@localhost` with no DDL, but that account's grant was
`SELECT, INSERT, UPDATE, DELETE ON *.*` — every schema on the server, not just this one.
Confirmed it could read `mysql.user`, where two accounts still carry 41-char
`mysql_native_password` hashes, so the credential in `backend/.env` reached far past the
monitoring data and any injection bug in the app would have inherited that reach.

Scoped it, as root:

```sql
REVOKE ALL PRIVILEGES ON *.* FROM `cspc-ictu_app`@`localhost`;
GRANT SELECT, INSERT, UPDATE, DELETE ON `cspc-ictu-monitoring-system`.* TO `cspc-ictu_app`@`localhost`;
FLUSH PRIVILEGES;
```

Left as `GRANT USAGE ON *.*` (connect only) plus the one schema. Checked first that no app
code touches `information_schema`, another schema, or any DDL — migrations are `.sql` files
applied by hand, so they never run as this user. Verified after: the app user still reads
and writes its own schema, `mysql.user` is now `ER_TABLEACCESS_DENIED_ERROR`, all five
dashboard endpoints answer 200, and both pollers kept writing.

**S-11.** `SECRET_ENC_KEY` set, and the three general columns re-wrapped under it with
`npm run rekey -- --from-key <MIKROTIK_ENC_KEY> --suite general --apply` (dry run first —
4 values, 0 unreadable). `mikrotik_devices.api_password` stays pinned to
`MIKROTIK_ENC_KEY` and was deliberately untouched.

Backend stopped for the rotation and restarted through nodemon, per the script's own
procedure — the pollers decrypt every cycle and would have read rows mid-rotation.

**Verified cryptographically, not just by "it started".** Pre-rotation ciphertext was
dumped first, then each value was decrypted under the OLD key and compared against the
current value decrypted under the NEW one: **5/5 identical plaintext**, 4 re-wrapped and
`api_password` correctly unchanged. This mattered because the live path could not be
exercised — both devices holding an SNMP community (Dev Router 66 and the UPS) are
currently offline, so a broken community would not have shown up as anything.

⚠️ **Two secrets were exposed to a terminal session doing this work** and should be
rotated: the MySQL `root` password, and `MIKROTIK_ENC_KEY` (npm echoes the `--from-key`
argument into its command banner). The second is now a supported operation rather than a
dead end — `npm run rekey -- --from-key <current> --suite mikrotik --apply` — which is the
whole reason the rotation path was built.

### Still outstanding

1. **Reflash the ESP32** — it holds the old secret and cannot connect until it is reflashed.
2. **Rotate the two secrets named above** — the MySQL `root` password, and
   `MIKROTIK_ENC_KEY` via `--suite mikrotik`.
3. **Two MySQL accounts still use `mysql_native_password`** (41-char hashes, seen in
   `mysql.user` before the grant was scoped). Worth moving to a modern auth plugin.

---

## SESSION 25 — 2026-09-17
**Branch:** `main`
**Developer:** Mark Gregorio

> The MQ-2 gas sensors became managed data, both DFDs were re-balanced around the flows that
> change brought, and the **DHT11 was replaced with a DHT22** — a swap whose interesting part
> was not the name but the several comments whose reasoning depended on the old sensor's
> coarseness.

### DHT11 → DHT22

The firmware was already correct (`#define DHTTYPE DHT22`, `DHT dht(DHTPIN, DHTTYPE)`); only
the labels and the reasoning around them were stale. 36 plain label occurrences swapped across
`CLAUDE.md`, `DOCUMENTATION.md`, `Environment.md`, `README.md`, four frontend files and the
sketch's own comments.

**Nothing functional broke.** `sensorHandler` only type-checks temperature/humidity — no bound
assumed the DHT11's 0–50 °C / 20–80 %RH range, so the DHT22's wider range needed no change.
`npm test` 469/469.

⚠️ **Six passages were arguments, not labels**, and a name swap would have left them false:

- `services/envPersistPolicy.js` — the header justified throttling persistence with "1°C / 1%
  resolution and ±2°C accuracy … consecutive samples differ by quantisation noise". A DHT22
  resolves 0.1 °C at ±0.5 °C, so the *mechanism* changed even though the conclusion held.
- `envPersistPolicy.DEFAULTS.tempDeadband` (0.5 °C) was documented as "anything it can actually
  report crosses this" — true of a 1 °C sensor, **false** of a 0.1 °C one. This is a real
  behaviour change: under the DHT11 any reportable temperature move forced an immediate store;
  under the DHT22 sub-0.5 °C drift now waits for the 30 s heartbeat. The deadbands went from
  near-unreachable formalities to the thing actually keeping the write rate down, so the policy
  is **more** load-bearing after the upgrade, not less.
- Same argument restated in `CLAUDE.md` (×2), `README.md` and `handlers/sensorHandler.js`.
- `Environment.md` §10 said "DHT11 is low-resolution — fine for zone logic, not for precise
  readings", which is now the opposite of true. Replaced with the DHT22 spec plus a note that
  it samples at **0.5 Hz** (once per 2 s) against the DHT11's 1 Hz — the 3 s `LOG_INTERVAL`
  still clears it, with less margin than before.
- `frontend/.../landing/photos.ts` (×2) — public landing-page captions asserting "1 °C and
  1 %RH resolution" and "does not move 1 °C in three seconds". That file's own header warns
  that `detail` makes factual claims a hardware swap can invalidate; it was right.

Historical mentions of the DHT11 were **kept on purpose** where they explain why something is
the way it is: `envPersistPolicy.js` (×2), `CLAUDE.md` (×2), `Environment.md` §10, and the
dated note added to `audits/architecture-report-2026-08-25.md`. That audit's ASCII diagram was
updated to `DHT22·MQ-2×2` (same character width, so the box borders still align) under a note
recording that only the diagram was refreshed and the findings still describe 2026-08-25.

⚠️ The quoted breadcrumb in SESSION 1 above (`… / DHT11 · 2× MQ-2`) is left as written: it
quotes UI copy that genuinely said DHT11 on 2026-06-04 and was deleted in that same session.
Editing it would falsify a quote rather than correct a fact.

### Gas sensors as managed data

`migrations/2026-09-17_gas_sensors.sql` — one row per physical MQ-2 channel (`channel` PK,
1-based, mapping to the firmware's `MQ2_PINS[channel-1]` exactly as `aircon_state.ir_channel`
already does), with `location_label`, `enabled`, a remembered `gpio`, and `updated_by →
users.user_id`. Seeded with four channels: 1 and 2 enabled (the sensors already running — a
migration must not silently switch off working smoke detection), 3 and 4 present but disabled
on the free ADC1 pins. The 4-channel ceiling is **hardware, not schema**: ADC2 is unusable
while WiFi is on and GPIO 32/33 are reserved for IR channels 3 and 4.

### DFDs re-balanced

Both diagrams in `docs/dfd/` updated for the flows the above introduced, then verified by
parsing the files rather than by eye:

```
Level 0 flows              : 15 → 16   (new: system → Server Room, "gas-sensor configuration")
Level 1 boundary flows     : 26 → 29   (2.0 went 8 → 11)
External entities          : 9 vs 9, identical sets
VERDICT                    : BALANCED
```

Level 1 gained an `Admin *` symbol and a `D10 gas_sensors` store in band 2, plus the band-2
`D6 system_logs *` the audit write had always needed. Band 2 grew 500 → 700 px and everything
below shifted 200 px, including the three cross-band corridors' hardcoded waypoints and the
legend. All 18 band-2 connection-point fractions were recomputed so every flow stays a straight
line with its own anchor.

**New:** `docs/dfd/README.md` and `docs/dfd/dfd-narrative.docx` — the Figure 3 and Figure 4
manuscript narratives, the notation (what `*` means, why entities are counted by name), the
balance record, and the PDF export settings. ⚠️ The balance figures now live in three places:
both `.drawio` legends and those two docs. A feature adding a boundary flow has to update all
of them.

### Still outstanding

1. **Figure 4's narrative is written; Level 1's own legend note** and the two docs must be
   re-checked together the next time a boundary flow is added.
2. **`dfd-narrative.docx` has never been rendered** — no LibreOffice or pandoc on this machine,
   so its structure is verified but its layout is not. Open it in Word before relying on it.
3. **Level 1 prints at ~4.5 pt labels** on folio. Use A3 or a fold-out for the printed
   manuscript.

---

## SESSION 26 — 2026-09-21
**Branch:** `feat/mobile-layout-and-account-emails`
**Developer:** Mark Gregorio

> Registering a device that is wrong or unreachable produced **no indication at all**, on
> every form that registers one. The device was created, its first poll failed into the
> server console, and the card said "Offline" — which is also what a perfectly healthy
> device that has not been polled yet says. So the admin sat waiting for something that
> was never going to arrive.

### What was actually broken

Three separate silences, all reading the same way on screen:

1. **No pre-flight check** on Add router or Add UPS. The MikroTik form had a *Test
   connection* button (`POST /api/mikrotik/test`) since it was built; the two SNMP forms
   never got one, even though `npm run probe` had been answering exactly that question
   from a terminal for weeks.
2. **The first poll's verdict went nowhere.** All three routes already call
   `pollDeviceNow` immediately on registration — added in `213f96a` precisely so a wrong
   IP would show as Offline in a second rather than a minute. But it is fire-and-forget
   (correctly: the response must not be held behind an SNMP timeout), so its result was
   `console.error`'d and dropped. The one person who could fix the community string was
   the one person not told it was wrong.
3. **The toast lied.** "Router added — polling starts within a minute." is reassuring, and
   it was printed identically whether the device answered or not.

Plus a fourth, different in mechanism: an approved **server** whose agent has never once
reached the backend rendered as a flat "Offline", indistinguishable from a box that was
working yesterday. `approve()` deliberately leaves the row `offline` and the sweep skips
it, so there was no status to read it off.

### Pre-flight probe, shared with the CLI

`services/deviceProbe.js` (I/O) + `services/deviceProbeVerdict.js` (PURE) — the same
split as pingOutput/icmpPing and snmpUtils/snmpClient.

`scripts/probeDevice.js` was **rewritten to consume them** rather than having the logic
copied. Its own header has always claimed "no second implementation to drift", and a probe
that disagreed with the form would be worse than no probe at all. The script is now the
presentation layer and nothing else.

New: `POST /api/network/test` and `POST /api/ups/test` (admin, declared before every
`/:id` route). Nothing is persisted. Both run the same SNMP/ICMP code the poller runs, so
a pass means the poller will succeed for the same reasons.

⚠️ **The verdict is judged against what is being registered, not in the abstract.** The
identical measurement — answers ping, ignores SNMP — is a **PASS** on the Add router form
with a blank community (that is ICMP monitoring, the only way to watch ISP-owned CPE) and
a **FAILURE** on the Add UPS form, because a UPS has no ping-only mode: pinging a battery
only proves its management card has power. Hence `expect`, and hence a test that pins both
directions.

⚠️ A blank community is passed through as blank rather than defaulting to `public`. On the
form a blank community *is* the ICMP-monitoring choice, so what has to be verified is ICMP;
guessing a community behind the admin's back would report a capability the saved device is
never going to use. The CLI keeps its `public` default because there you are exploring an
unknown address, not validating a form.

### The first poll now reports back

`pollDeviceNow` returns `{ ok, reason }` instead of a bare boolean in both pollers, and all
three routes forward it as a new `deviceFirstPoll` socket event — addressed to
**`user:<id>`**, the admin who did the registering, not broadcast. Other dashboards already
get the device itself through `networkMetrics`/`networkStatus`; this is feedback on one
person's action.

⚠️ `ok` is not derivable from the card, which is why `mode` rides along: a ping-mode router
that answers ICMP is a **success** and will never report interfaces, so an empty port list
must not be read as a failure.

### UI

- `components/devices/DeviceProbe.tsx` — `useProbe()` + `<ProbeResultPanel>`, shared by
  both SNMP forms. It shows the **measurements** as well as the verdict: "replies to ping
  in 2 ms, ignores SNMP on UDP 161" is a sentence somebody can take to the network team,
  where "test failed" is not.
- ⚠️ **Editing any field the probe depends on clears the result.** A green tick sitting
  beside an address that has since been retyped is worse than no tick — it vouches for a
  value nothing ever tested. Applied to the MikroTik form too, which did not do this.
- **A failed probe never blocks the save**, on any of the three forms. A device can
  legitimately be registered before it is reachable — cabled next week, or behind a
  firewall rule somebody else has to open — and refusing would just teach people to skip
  the test. It states the consequence instead ("it will show as Offline until…").
- Toasts grew a **tone**. A registration whose first poll failed is not a success and must
  not appear in the same green box; the warning variant wraps and stays up 9s rather than
  3, because it carries a reason and a next step.
- ServerMetrics: `awaitingFirstReport` (backend `withLive`, from `last_seen IS NULL`)
  renders as an amber **"Never reported"** instead of a red "Offline". The two need
  opposite reactions — Offline means go and look at a machine that was working; this means
  the agent has not reached the backend even once (wrong `-server` URL, a firewall, or a
  service installed and never started).

### Verified

`npm test` **508/508** (14 new in `tests/deviceProbeVerdict.test.js`, including a
combinatorial pass asserting every input combination yields a title and a detail — a branch
returning a partial object would print "undefined" at exactly the moment somebody is trying
to diagnose a device). `tsc --noEmit` clean, production build clean.

The probe itself was exercised against three real shapes: `127.0.0.1` (answers ICMP in
1 ms, nothing on UDP 161 → `ping_only`, which correctly passes as a router with a blank
community, fails as a router with one, and fails as a UPS either way), `192.0.2.77`
(TEST-NET-1, nothing answers → `unreachable`), and malformed input (bad IPv4 and port
99999 → `{ok:false,error}`, not a throw).

### Still outstanding

1. **Not yet exercised against a device that actually answers SNMP** — no router or UPS on
   this machine's network does. The `snmp_router` / `snmp_bare` / `ups` verdict branches
   are covered by unit tests but have not been seen end to end. `dev-snmpsim/` is the way
   to close that.
2. The three Add forms now share a contract but not a component — MikroTik keeps its own
   test UI because its probe is a RouterOS API login, not SNMP, and answers with different
   fields. Worth revisiting only if a fourth device type appears.

### Three bugs found in the above, same day

**1. The success toast lied — `ok` meant "did not throw", not "answered".**

`pollDeviceNow` inferred success from the absence of an exception. But two poll paths
**handle their own failure and resolve normally**, by design:

- `mikrotikPollerService.pollDevice` catches a failed `collect()` because rethrowing would
  let `pollAll`'s catch reset the cache and wipe the ICMP figures it just measured.
- `snmpPollerService.pollRouterByPing` never throws at all — for a ping-only router
  `reachable:false` is a legitimate *measurement*, written and broadcast like any other.

So a MikroTik added with a wrong password, and a ping-only router added on a wrong IP,
both toasted **"now polling"**. Confirmed the precondition against real endpoints:
`collect()` rejects with `Username or password is invalid` on a bad password and `-4078`
on a closed API port — the branch was running, its verdict was just being discarded.

Fixed at the source rather than by widening the catch: `pollDevice` now **returns**
`{reachable, reason}` from each of its three exits, and the SNMP side reads the live cache
(`latestNetwork`/`latestUps`), which is the one thing every path sets — including the ones
that handle their own failure. The toast now carries the real reason, which for the API
case is the full verdict: *"…but the host ANSWERS ICMP, so RouterOS is up and the API is
the problem: service disabled, wrong port, credentials rejected, or an address-list rule"*.

**2. A deleted device came back.**

A poll takes up to the full API/SNMP timeout — and takes the *full* timeout precisely when
the device is misconfigured, which is the one most likely to be deleted. Delete it inside
that window and the in-flight poll still completed: it wrote a `router_metrics` point for a
device that no longer existed and broadcast `networkMetrics` for it. The dashboards treat
an unknown id as a NEW device and append it (`idx === -1 → [...prev, …]`), so the row that
had just been removed reappeared and stayed until a reload.

⚠️ Note this was **never only a UI glitch** — the stray InfluxDB point is the worse half,
and a client-side ignore-list would have hidden it rather than fixed it. So the guard is in
both pollers: `removeDevice` records a **tombstone**, and `setReachable` plus all four
sample writes consult it. Time-bounded (5 min) so the map cannot grow for the life of the
process.

**3. "API not configured" was only visible inside the drawer.**

A MikroTik with no RouterOS login has never been polled, so its `status` is `"Offline"` —
wrong in the way that matters: the router is not down, nobody has told us how to log in,
and the fix is an admin action rather than a trip to the rack. The sentence correcting that
lived one click away, inside the expandable drawer. New `MkStatus` puts an amber **"API not
configured"** in the Status cell itself (and on the mobile card), which is where the status
it corrects already is; the drawer keeps the expanded half — what to actually do about it.

**Verified:** 508/508, `tsc --noEmit` clean, build clean. ⚠️ Bugs 1 and 2 are fixed in code
and their preconditions confirmed against live endpoints, but the end-to-end paths were not
re-run — doing so would have written metrics and possibly raised alerts on the real
database. Worth confirming by hand: add a MikroTik with a wrong password (expect a warning
toast naming the reason), and delete a device mid-poll (expect it to stay gone).

---

## 2026-10-03 — Environment report: one gas line per sensor

The environment report's gas chart drew ONE line, "Peak gas" = the higher of the two
sensors in each bucket, so the PDF could not show which sensor rose and a 3rd/4th MQ-2
would never appear. It now reads `sensor_gas` grouped by `channel` (`fluxTimeSeries` takes
`{ points, fn, by }` — `by: "channel"`), one line per sensor, labelled `MQ2-n · <location>`
from `gasSensorService.labelFor` and coloured like the Environment page's `GAS_SERIES`. A
period from before `sensor_gas` existed falls back to `mq2_1_ppm`/`mq2_2_ppm` as channels
1 and 2. The PDF legend now wraps onto a second row instead of running off the page, and
`chartHeight` reserves room for it. Verified: 515/515, plus a rendered 4-sensor PDF.
⚠️ Not run against live InfluxDB (it was down on the dev machine) — generate an environment
report once to confirm.

## 2026-10-03 — Forecast report: every disk volume, not just the headline

The forecast report's **Disk capacity** table printed one row per server — the headline
volume from `worstVolumeForecast` — so `/boot` (or `D:\`) never appeared in the record,
although `forecastDiskFull` had already projected it. It now prints one row per volume
(`d.volumes`, which now also carries each volume's `advice`), so "Action needed" names the
partition that is filling and "Volumes projected to fill" counts volumes rather than
servers. A server with no per-volume history still prints its root row. The Analytics
page is unchanged: one row per server with the volumes listed beneath. 515/515.

## 2026-10-05 — Server Console (pre-oral panel recommendation)

Panel RSC: *"Integrate a user-friendly interface or shortcuts into the system to seamless
control without relying on the command prompt."* Today staff open PowerShell and `ssh` into
a server. Built on branch **`server-console`**: a **Console** tab on ServerDetail with

- **Quick Actions** — buttons, no typing: system overview, top processes, disk, network,
  failed / running services, recent errors, agent status, service status (info — admin +
  IT staff); restart a service, restart the monitoring agent, reboot in 1 min (control —
  admin, confirm dialog). Fixed commands per OS (`services/consoleCommands.js`); the
  browser sends an action id, never a command.
- **Web Terminal** — xterm.js ⇄ Socket.IO ⇄ ssh2. Linux login shell; Windows opens
  PowerShell. Admin only.

Both Linux and Windows. Windows targets need **OpenSSH Server** enabled (one-time, built into
Server 2019+; the console shows the three commands). Nothing changes on the Go agent.

Security: target = the registered IP only; password typed per page visit, never stored; SSH
host key pinned on first login (`server_ssh_hosts`) and a changed key refused; failed-login
throttle (10 / 15 min per user+server); every action + terminal open/close in History
(keystrokes not recorded — they include sudo passwords).

**Verified:** 526/526 tests (11 new), `tsc --noEmit` clean, build clean. End-to-end against a
throwaway local `ssh2` server that runs exec through cmd.exe like Windows OpenSSH: wrong
password rejected, key pinned then a changed key refused, throttle trips at 10, every
Windows info action ran for real on this laptop, interactive PowerShell worked. Linux info
commands ran on WSL Ubuntu. ⚠️ **Not yet tried against a real ICTU server**, and the Linux
`sudo -S` path (restart/reboot as a non-root user) has only been checked for shell syntax —
try "Restart service" on a harmless service once on a real box before relying on it.
⚠️ Apply `migrations/2026-10-05_server_ssh_hosts.sql` on any existing database (already in v13).

**Follow-ups the same day (branch `server-console`):**
- Usernames may contain a space (Windows local accounts, e.g. "Mark Gregorio").
- SSH login failures answer **422, not 502**: Cloudflare replaces an origin 502 with its own
  HTML page, so behind the tunnel the reason never reached the admin ("Cannot connect to server").
- **SSH address override.** The VirtualBox VM `srv-core` reports `10.0.2.15` (NAT — unreachable
  from the host) while SSH is reachable on its host-only adapter `192.168.56.101`. An admin can
  now set a per-server SSH host/port in the Console ("change" next to "connects to …"), stored in
  `server_console_settings` (migration `2026-10-06_…`, in v13) because the agent rewrites
  `devices.ip_address`. Verified: with the override set, the VM's sshd answered (a deliberately
  wrong password was rejected by it); the override was then cleared again so the admin sets it.
