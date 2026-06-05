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

