# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

---

## Development Commands

### Backend
```bash
cd backend
npm install
nodemon src/server.js   # dev (watch mode)
node src/server.js      # production
```
> Entry point is `backend/src/server.js`. The root-level `server.js` was deleted.

### Frontend
```bash
cd frontend
npm install
npm run dev      # Vite dev server → http://localhost:5173
npm run build
```

### Environment Variables (`backend/.env`)
```
PORT=
DEVICE_SECRET=     # shared secret for ESP32 socket auth — must match firmware constant
JWT_SECRET=
DB_HOST=
DB_USER=
DB_PASSWORD=
DB_NAME=
DB_PORT=
INFLUX_URL=
INFLUX_TOKEN=
INFLUX_ORG=
INFLUX_BUCKET=
AGENT_INSTALL_KEY= # shared key the Go agents present at enrollment (POST /api/agents/register)
WEB_ORIGIN=        # allowed dashboard origins, comma-separated — or * for any (roaming LAN); blank = localhost+LAN default
GOOGLE_CLIENT_ID=       # Google OAuth web client ID (public). Login verifies ID tokens against it. Must match frontend VITE_GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=   # Google OAuth web client SECRET. Required: the auth-code flow exchanges the code server-side
GOOGLE_ALLOWED_DOMAINS= # comma-separated CSPC domains allowed to sign in; blank = cspc.edu.ph,my.cspc.edu.ph
RESEND_API_KEY=         # Resend API key for alert emails. BLANK = email channel off (bell + toast still work). See email-popup-notifications.md
RESEND_FROM=            # sender, e.g. "CSPC ICTU Monitoring <alerts@your-verified-domain>"; blank = Resend test sender (onboarding@resend.dev)
NOTIFY_EMAIL_MIN_SEVERITY= # min severity that triggers an email: info|warning|critical; blank = critical. Per-user override in notification_prefs
NOTIFY_EMAIL_TO=        # optional: force ALL alert emails to this address (testing); blank = send to each active user's real email
NOTIFY_COOLDOWN_MIN=    # de-dup window in minutes — same device+type+severity won't re-alert within it (restart-proof); blank = 30
NOTIFY_RETENTION_DAYS=  # alerts older than this are purged daily (feed rows cascade); blank = 30
```

Frontend also needs `VITE_GOOGLE_CLIENT_ID` in `frontend/.env` (same client ID; restart `npm run dev` after changing). See `google-oauth.md`.

### Backend address (no longer hardcoded in the dashboard)
The dashboard's backend URL is centralized in `frontend/src/config.ts`, which **auto-detects**
from the page's own host on port 3000 — so it follows whatever IP you open the dashboard from
and **changing networks needs no edit**. To pin a specific backend (different host / HTTPS),
set `VITE_API_URL` in `frontend/.env` (then restart `npm run dev`). Backend CORS is driven by
`WEB_ORIGIN` in `backend/.env` — set `WEB_ORIGIN=*` to allow any origin on a roaming LAN.

Still hardcoded (firmware only): `iot/esp32/env_monitor_v2.ino` — `host`, `port`, `deviceSecret`.

---

## Architecture

Server room environment monitoring system for CSPC-ICTU.  
ESP32 (DHT11 + 2× MQ-2 + IR TX array + RGB LED) → Node.js + Socket.IO → React dashboard.

### Tech Stack
- **Backend:** Node.js + Express (ESM, `"type": "module"`), Socket.IO, mysql2, @influxdata/influxdb-client, resend (alert email)
- **Frontend:** React 18 + TypeScript + Vite + Tailwind CSS, JetBrains Mono font
- **Database:** MySQL (users, devices, aircon, agent tokens, logs) + InfluxDB (environment **and** server-metric time-series)
- **Hardware:** ESP32, DHT11, MQ-2 ×2, passive piezo buzzer, WS2812B RGB LED ×20, IR TX ×4, DS3231 RTC (optional)

---

## Repository Layout

```
backend/src/server.js           ← Entry point
backend/config/
  env.js                        ← dotenv loader — imported first in every config file
  mysql.js                      ← mysql2 pool, exported as `db` (promise API)
  influx.js                     ← InfluxDB write (precision: ms) + query clients
backend/routes/                 ← One file per resource, mounted at /api/<resource>
backend/services/
  authService.js                ← login, JWT, bcrypt
  userService.js                ← user CRUD
  permissionService.js          ← static role-based permissions
  airconService.js              ← all aircon DB logic (getAll, toggle, applyAutoIR, etc.) + **configurable auto-cooling IR zone thresholds** (`aircon_ir_config`: getIRConfig/saveIRConfig/getDeviceIRConfig) pushed to the ESP32 via the `acConfig` socket event — sets WHEN IR fires (target temps per zone stay fixed = captured IR codes). See Air Conditioner System + `email-popup-notifications.md`
  agentService.js               ← Go-agent + server-device DB logic (devices + server_specs + device_network + agent_tokens); enroll/approve/reject, offline sweep, device_logs
  notificationService.js        ← raiseAlert() → de-dup cooldown (NOTIFY_COOLDOWN_MIN, restart-proof, **open-alert-scoped** — a resolved alert no longer suppresses, so recurrences re-alert) → writes `alerts` (incl. `alert_rule_id` when rule-driven) + fans out `alert_notifications` per active user + pushes `notification` to each user room + severity-gated email; listForUser/unreadCount/markRead. `init(io)` once at startup. Triggers: server CPU/mem/disk + **environment** temperature/gas/humidity (both via configurable `alert_rules` — see alertRulesService) + offline (not rule-based). See `email-popup-notifications.md`
  alertsService.js              ← alert LIFECYCLE (shared, not per-user): list/acknowledge/resolve/openCount + auto-resolve when a metric recovers (called from checkThresholds + sensorHandler); broadcasts `alertUpdated`; `init(io)` once. Backs the now-real `routes/alerts.js`. Distinct from the per-user bell (`alert_notifications.is_read`)
  alertRulesService.js          ← configurable alert thresholds (`alert_rules`). In-memory cache (reload on startup + every mutation) + `getEffectiveRules(deviceId, metric)` resolver (per-server override else global `device_id=NULL`) + `nextBand()` hysteresis-aware evaluation + admin CRUD. Rules-only: no matching rule = no alert. metric_name: cpu/mem/disk + temperature/gas/humidity. See `email-popup-notifications.md`
  emailService.js               ← Resend wrapper: sendAlertEmail(to, alert) (inline-styled HTML). No-op if RESEND_API_KEY unset. NOTIFY_EMAIL_TO forces all mail to one address (testing)
  reportService.js              ← REAL reports (MySQL `reports` + on-disk CSV/PDF per report under backend/reports/). generate() builds the dataset live from InfluxDB (sensor_environment / server_metrics) + MySQL (alerts / aircon_logs) per type, writes both files, flips status pending→generated (or failed). list/fileFor(download name = title + period)/remove. Types: environment|server|alerts|aircon. Backs the now-real `routes/reports.js`. See `report-page.md`
  reportRenderer.js             ← turns a normalized report ({summary, table}) into CSV + PDF (pdfkit). Store-agnostic — layout only
backend/handlers/
  sensorHandler.js              ← validates, writes InfluxDB, broadcasts to browsers + raises per-metric room-level alerts (temperature/gas/humidity) on band escalation, evaluated against `alert_rules` (alertRulesService) — replaces the old firmware-status escalation
  querySensorHistoryHandler.js  ← Flux queries, emits sensorHistory
  offlineDataHandler.js         ← SD card batch flush from ESP32
  serverMetricsHandler.js       ← agent metric POST → InfluxDB (`server_metrics`) + broadcast `serverMetrics`
  serverHistoryHandler.js       ← Flux query on `server_metrics` for GET /api/servers/:id/history
backend/sockets/connectionHandler.js  ← all socket events, device vs browser segregation
backend/data/db.js              ← in-memory mock: alerts, environment history — NOT persisted (servers + reports are now real: MySQL + InfluxDB)
backend/middleware/
  auth.js                       ← authMiddleware, requireRole(...roles), JWT_SECRET export
  agentAuth.js                  ← Bearer `AGT-…` token auth for agent metric POSTs
  upload.js                     ← multer: JPEG/PNG/WebP, 2 MB cap

frontend/src/
  index.css                     ← Grafana --gf-* design tokens + JetBrains Mono
  App.tsx                       ← route tree + ProtectedRoute
  config.ts                     ← backend URL: auto-detects from page host:3000, VITE_API_URL override
  api/
    client.ts                   ← Axios instance, auto-attaches Bearer token (baseURL from config.ts)
    api.ts                      ← all API calls, all return ApiResult<T>
  components/layout/
    Sidebar.tsx                 ← Grafana-style nav, SVG icons, theme toggle
    Header.tsx                  ← 40px topbar, breadcrumb navigation
  context/
    AuthContext.tsx             ← login/logout, manages socket connect/disconnect
    ThemeContext.tsx            ← dark/light mode
  socket/socket.ts              ← shared Socket.IO client, autoConnect: false
  data/users.ts                 ← roleConfig: role → { label, color, allowed pages[] }
  pages/                        ← one file per page

iot/esp32/env_monitor_v2.ino    ← current firmware (active)
go-agent/                       ← standalone Go monitoring agent (enroll → approve → POST metrics); see server-metrics.md + go-agent/README.md
SESSION_NOTES.md                ← per-session work log
```

---

## Data Stores

| Data | Where | Notes |
|------|-------|-------|
| Users, system_logs | MySQL | fully implemented |
| Devices, aircon_state, aircon_logs | MySQL | fully implemented |
| Servers (devices + server_specs + device_network + agent_tokens), device_logs | MySQL | fully implemented — Go-agent enrollment |
| Environment time-series | InfluxDB | measurement: `sensor_environment`, precision: ms |
| Server-metric time-series | InfluxDB | measurement: `server_metrics` |
| Reports | MySQL `reports` + on-disk CSV/PDF (`backend/reports/`) | fully implemented — built live from InfluxDB + MySQL on generate. See reportService.js |
| **legacy alerts array, environment history/logs** | `data/db.js` in-memory | **mock — not persisted**, resets on restart (`/api/environment`). NB: real alerting uses the `alerts` table |

---

## Authentication & Authorization

- **Login is Google OAuth (OIDC) only** — the custom "CSPC Mail" button runs the **authorization-code flow** (`@react-oauth/google`, `flow: "auth-code"`) and sends a one-time **code** to `POST /api/auth/google`. `services/googleAuthService.js` exchanges the code with Google (server-side, using `GOOGLE_CLIENT_SECRET`), verifies the returned **ID token** with `verifyIdToken` (`google-auth-library` — audience enforced), enforces the CSPC domains (`@cspc.edu.ph` / `@my.cspc.edu.ph`, exact match + `email_verified`), then issues the app JWT via `authService.issueSession`. The old password/bcrypt login (`/auth/login`) was **removed**. Full guide: `google-oauth.md`.
- **Self-register → admin approve/reject.** A first-time Google sign-in creates a `users` row with `status='pending'`; an admin approves it (assigning `admin` or `it_staff`) or rejects it (`status='rejected'`) from **User Management → Pending registrations**. Pending/rejected/inactive accounts can never obtain a session (`authMiddleware` requires `status='active'`). Multiple admins are allowed. DB migration: `migrations/2026-06-09_google_auth.sql`.
- JWT signed with `JWT_SECRET`, expires 1 h, stored in `sessionStorage` as `cspc_token`. Carries a `tv` (token_version) claim; `authMiddleware` rejects the token when `users.token_version` / `status` no longer match (logout, disable, role change bump it — server-side session revocation)
- Socket.IO: browsers send JWT in `socket.handshake.auth.token`; ESP32 device key is read from `socket.handshake.auth.deviceKey` (preferred) or `.query.deviceKey` (legacy EIO3 fallback — firmware still sends it here)
- Go agents authenticate metric POSTs with a Bearer `AGT-…` token (`middleware/agentAuth.js`); first-run enrollment uses the shared `AGENT_INSTALL_KEY`
- `socket.isDevice = true` for ESP32, `false` for browsers

| Role | DB value | Access |
|------|----------|--------|
| Admin | `admin` | all pages + user management (approves registrations) + alert rules (configurable thresholds) |
| IT Staff | `it_staff` | dashboard, server metrics, environment, aircon, **alerts (acknowledge/resolve)**, history, reports |

> Login no longer uses passwords. `users.hash_password` is now nullable; `users.status` gained `pending`/`rejected`; new columns `google_sub` + `auth_provider`. The User Management "Add User"/"Reset PW" and Profile "Change Password" UIs are now vestigial.

### Mock endpoints (still `data/db.js`, not real)
- `routes/environment.js` GET `/history` + `/logs` return mock random data, **not** InfluxDB — real sensor history comes via Socket.IO `changeRange` → `sensorHistory`
- **`routes/reports.js` is now REAL** (no longer mock): `services/reportService.js` persists to the `reports` table and writes a CSV **and** PDF per report under `backend/reports/` (git-ignored). `POST /api/reports` (admin + it_staff) builds the dataset **live** from the stores per `type` (environment → InfluxDB `sensor_environment`; server → InfluxDB `server_metrics`; alerts → MySQL `alerts`; aircon → MySQL `aircon_logs`) for the chosen `{periodStart, periodEnd}`, then `GET /api/reports/:id/download?format=csv|pdf` streams the saved file (download name = title + period) and `DELETE /api/reports/:id` (admin) removes the row + files. UI = **Reports** page (`pages/Reports.tsx`, Grafana-styled: type cards + range picker modal, per-row CSV/PDF download). Needs the `pdfkit` dep. Full guide: `report-page.md`. **Note:** the **notifications** feature (`routes/notifications.js` + `services/notificationService.js`) writes the **real** `alerts` + `alert_notifications` tables, and both the bell feed and the **Dashboard "Alerts" panel** render that real per-user feed (via `NotificationContext`). See `email-popup-notifications.md`.
- **`routes/alerts.js` is now REAL** (no longer mock): `services/alertsService.js` backs the shared alert **lifecycle** — `GET /api/alerts` (history, `?status=` filter), `POST /api/alerts/:id/acknowledge`, `POST /api/alerts/:id/resolve`, `GET /api/alerts/count` (open-alert count → sidebar **Alerts badge**), all admin + it_staff. Sets `alerts.status` + `acknowledged_by`/`acknowledged_at`/`resolved_at`. **Auto-resolves** open alerts when the metric recovers to normal (wired into `checkThresholds` + `sensorHandler`). Broadcasts `alertUpdated`. UI = **Alerts** page (`pages/Alerts.tsx`) + live unresolved-count badge on the nav (`NotificationContext.openAlertCount`). Shared incident state, distinct from the per-user bell (`is_read`). **Resolve attribution:** single "by {acknowledger}" (resolve folds into `acknowledged_by`); a `resolved_by` column exists from `migrations/2026-06-14_alerts_resolved_by.sql` but is **DORMANT/unused** (separate-resolver UI was built then reverted — see `email-popup-notifications.md` §13.8).

> The `reports.js` generate gate uses `requireRole("admin", "it_staff")`; the **Reports page** mirrors this (Generate button = admin/it_staff, Delete = admin). The old `super_admin` role check in the page was fixed to `admin`.

> **Configurable alert thresholds (real, not mock).** The previously-unused `alert_rules` table now drives all threshold alerting. `routes/alertRules.js` (`GET/POST/PUT/DELETE /api/alert-rules`, **admin-only**) + `services/alertRulesService.js` manage them; the **Alert Rules** admin page (`pages/AlertRules.tsx`, sidebar nav, admin-only) is the UI. Scope = global default (`device_id=NULL`) + optional per-server override; fallback = rules-only (no rule → silent). Seed/migration: `migrations/2026-06-14_alert_rules.sql` (must be applied or alerting is silent). Old hardcoded 80/90 (servers) + firmware env thresholds are removed in favor of these rules.

---

## Socket.IO Events

### ESP32 → Server (device only)
| Event | Purpose |
|-------|---------|
| `sensorData` | live reading every ~3s → InfluxDB write + broadcast |
| `offlineData` | SD card replay → InfluxDB write, no broadcast |
| `irChannelMap` | GPIO assignments on every connect → stored in airconService, forwarded to browsers |
| `irFired` | auto IR fired → applyAutoIR() updates DB + broadcasts airconAutoUpdate |

### Browser → Server
| Event | Purpose |
|-------|---------|
| `changeRange` | quick range string or `{start, stop}` ISO → emits `sensorHistory` back |

### Server → Browsers
| Event | When |
|-------|------|
| `sensorData` | on every ESP32 reading |
| `sensorHistory` | response to `changeRange` |
| `serverMetrics` | on each Go agent metric POST (~10s/host) — see `server-metrics.md` |
| `serverStatus` | offline sweep flips a stale server → `{ id, status: "Offline" }` |
| `serverRemoved` | admin removes a server → `{ id }` |
| `agentApproved` / `agentPending` | agent approved / registered-or-rejected (admin pending list) |
| `userPending` / `userApproved` | user self-registered-or-rejected / approved (admin Pending registrations panel) |
| `deviceLog` | new `device_logs` entry (lifecycle + CPU/Mem/Disk threshold crossings) |
| `notification` | new alert raised → pushed to **one user's** room (`user:<id>`) → bell feed + badge + corner **toast** (`ToastHost`) + opt-in **OS popup** (Web Notifications API, tab-backgrounded only). Persisted (`alerts` + `alert_notifications`). See `email-popup-notifications.md` |
| `alertUpdated` | an alert's lifecycle changed (manual acknowledge/resolve, or auto-resolve on metric recovery) → Alerts page refreshes live |
| `airconStatus` | manual toggle/mode/temp change |
| `airconAutoUpdate` | ESP32 auto IR zone change |
| `irChannelMap` | forwarded from ESP32 on connect |

### Server → ESP32
| Event | When |
|-------|------|
| `irConfig` | on ESP32 connect + after any add/remove/toggle |
| `irCommand` | manual Turn On/Off from dashboard |
| `envConfig` | on ESP32 connect + after any **Alert Rules** change → room-level `alert_rules` thresholds (`{tempWarn,tempCrit,gasWarn,gasCrit,humWarn,humCrit}`, null fields omitted). Firmware applies them at runtime so its **LED/buzzer/reported status** match the dashboard's alert thresholds (no reflash). See alertRulesService + `email-popup-notifications.md` |
| `acConfig` | on ESP32 connect + after any **Auto-Cooling Thresholds** change (AirConditioner page, admin) → IR zone **boundaries** (`{coldBelow,normalMax,acceptableMax,nearCritMax}` °C). Firmware's `getIRZone` uses them at runtime so **WHEN IR fires** tracks the dashboard (no reflash). Target temps per zone are fixed (captured IR codes). Separate from `envConfig`/alerts on purpose — cooling should ramp *before* the alarm thresholds. Backed by `aircon_ir_config` (airconService). See `email-popup-notifications.md` |

---

## Air Conditioner System

Each AC unit is a row in `devices` (type=`'aircon'`) with a linked row in `aircon_state`.  
`ir_channel` (1-based) maps to `IR_CHANNEL_PINS[ir_channel-1]` in the firmware.

### `aircon_state` semantics
| Scenario | `last_trigger` | `triggered_by_user_id` |
|----------|---------------|----------------------|
| Unit registered | `NULL` | `NULL` |
| Staff toggle via dashboard | `manual` | user's ID |
| ESP32 auto IR zone change | `auto` | `NULL` |

### IR Zone → Set Temperature
| Room Temp | Zone | Set Temp | Fan |
|-----------|------|----------|-----|
| < 22°C | TOO_COLD (0) | 28°C | Auto |
| 22–24°C | NORMAL (1) | 26°C | Auto |
| 25–27°C | ACCEPTABLE (2) | 24°C | Auto |
| 28–29°C | NEAR_CRIT (3) | 22°C | High |
| > 29°C | CRITICAL (4) | 20°C | High |

> **The "Room Temp" boundaries (22/24/27/29) are now CONFIGURABLE** — the **Auto-Cooling
> Thresholds** card on the AirConditioner page (admin edit, both roles view) writes
> `aircon_ir_config` and pushes `acConfig` to the ESP32, so an admin can retune **when IR
> fires** with no reflash. The **Set Temp** column stays fixed (each is a captured raw IR
> code). Migration: `migrations/2026-06-15_aircon_ir_config.sql`. This is deliberately
> separate from the Alert Rules temperature thresholds (cooling should ramp *before* the
> alarm). Default boundaries match the firmware's original compiled values.

> **Power is manual-only.** `applyAutoIR` (on `irFired`) only re-targets the set
> temperature of units that are **currently ON** — it never changes `is_on`. A unit a user
> turned OFF stays OFF when IR fires. It returns/emits the affected `deviceIds` so the
> dashboard updates exactly those units (`airconAutoUpdate` no longer force-enables all).

> **All IR raw data is currently mock NEC.** Replace `IR_28C_AUTO`, `IR_26C_AUTO`, `IR_24C_AUTO`, `IR_22C_HIGH`, `IR_20C_HIGH`, `IR_POWER_ON`, `IR_POWER_OFF` with real captures from the Carrier remote using `IRrecvDumpV2`.

---

## UI Design System (Grafana Style)

All pages use `--gf-*` CSS variables. Do **not** add `slate-*` or `dark:` Tailwind classes to new code.

```css
--gf-bg            #111217      page background
--gf-panel         #181B1F      card background
--gf-panel-border  rgba(255,255,255,0.07)
--gf-header        #1a1d23      topbar
--gf-divider       rgba(255,255,255,0.07)
--gf-text-primary  #D9D9D9
--gf-text-muted    #6B7280
--gf-text-dim      #4B5563
--gf-accent        #5794F2      Grafana blue
--gf-accent-dim    rgba(87,148,242,0.12)
--gf-hover         rgba(255,255,255,0.05)
--gf-hover-strong  rgba(255,255,255,0.10)
```

Panel border-radius: `2px` (not `rounded-xl`). Font: `'JetBrains Mono', monospace`.

### Status Colors
| Status | Color |
|--------|-------|
| NORMAL / Online | `#73BF69` |
| WARNING | `#FF780A` |
| DANGER | `#F2495C` |
| CRITICAL | `#E02F44` |
| TOO_COLD | `#5794F2` |

### Page Style Status
| Page | Style |
|------|-------|
| Dashboard, Environment, AirConditioner, ServerMetrics, AlertRules, Alerts, Reports, Sidebar, Header | ✅ Grafana tokens |
| History, Settings, UserManagement | ⚠️ still use old `slate-*` classes |
| ServerDetail | hybrid: `slate-*` base + `dark:` overrides (light/dark adapted, not `--gf-*`) |

---

## ESP32 Firmware Notes

- Active file: `iot/esp32/env_monitor_v2.ino`
- `#define SD_ENABLED false` — set `true` only when SD module is physically connected
- `deviceSecret` must match `DEVICE_SECRET` in `backend/.env`
- IR fires only on temperature **zone change**, not every loop tick
- `enabledChannels[]` updated at runtime via `irConfig` socket event — no reflash needed to add/disable AC units
- **Alarm thresholds are runtime-configurable** (`WARNING_PPM`/`DANGER_PPM`/`TEMP_WARNING`/`TEMP_DANGER`/`TEMP_CRITICAL`/`HUM_WARNING`/`HUM_DANGER` are now mutable globals, not `#define`) — updated via the `envConfig` socket event from the dashboard's Alert Rules. The LED, buzzer and reported status all derive from these, so they track the dashboard's thresholds without reflashing. `envConfig` sets `TEMP_DANGER = TEMP_CRITICAL` (collapsing temp to warning/critical). `TEMP_COLD` (LED "too cold") is intentionally **not** rule-driven. A metric with no rule keeps its compiled default on the device (dashboard goes silent, device retains its last threshold).
- **IR/AC comfort-zone boundaries are runtime-configurable** (`IR_TEMP_COLD_BELOW`/`IR_TEMP_NORMAL_MAX`/`IR_TEMP_ACCEPT_MAX`/`IR_TEMP_NEARCRIT_MAX` are now mutable globals, not literals in `getIRZone`) — updated via the **`acConfig`** socket event from the dashboard's **Auto-Cooling Thresholds** card (separate from `envConfig`/Alert Rules — cooling ramps *before* the alarm). The per-zone target temps stay fixed (captured raw IR codes). No reflash needed to retune *when* IR fires.
- Timestamp priority: DS3231 RTC → NTP (UTC+8, `pool.ntp.org`) → uptime fallback (`UP HH:MM:SS`)
- Backend overrides ESP32 timestamp with `new Date()` for all InfluxDB writes and broadcasts
- Buzzer: 10-bit LEDC resolution; `ledcWrite(pin, 0)` to silence (not `ledcWriteTone(pin, 0)`)
