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
- **Backend:** Node.js + Express (ESM, `"type": "module"`), Socket.IO, mysql2, @influxdata/influxdb-client
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
  airconService.js              ← all aircon DB logic (getAll, toggle, applyAutoIR, etc.)
  agentService.js               ← Go-agent + server-device DB logic (devices + server_specs + device_network + agent_tokens); enroll/approve/reject, offline sweep, device_logs
  notificationService.js        ← raiseAlert() → writes `alerts` + fans out `alert_notifications` per active user + pushes `notification` to each user room; listForUser/unreadCount/markRead. `init(io)` once at startup. See `email-popup-notifications.md`
backend/handlers/
  sensorHandler.js              ← validates, writes InfluxDB, broadcasts to browsers
  querySensorHistoryHandler.js  ← Flux queries, emits sensorHistory
  offlineDataHandler.js         ← SD card batch flush from ESP32
  serverMetricsHandler.js       ← agent metric POST → InfluxDB (`server_metrics`) + broadcast `serverMetrics`
  serverHistoryHandler.js       ← Flux query on `server_metrics` for GET /api/servers/:id/history
backend/sockets/connectionHandler.js  ← all socket events, device vs browser segregation
backend/data/db.js              ← in-memory mock: alerts, reports, environment history — NOT persisted (servers are now real: MySQL + InfluxDB)
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
| **alerts, reports, environment history/logs** | `data/db.js` in-memory | **mock — not persisted**, resets on restart (`/api/alerts`, `/api/reports`, `/api/environment`) |

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
| Admin | `admin` | all pages + user management (approves registrations) |
| IT Staff | `it_staff` | dashboard, server metrics, environment, aircon, history, reports |

> Login no longer uses passwords. `users.hash_password` is now nullable; `users.status` gained `pending`/`rejected`; new columns `google_sub` + `auth_provider`. The User Management "Add User"/"Reset PW" and Profile "Change Password" UIs are now vestigial.

### Mock endpoints (still `data/db.js`, not real)
- `routes/environment.js` GET `/history` + `/logs` return mock random data, **not** InfluxDB — real sensor history comes via Socket.IO `changeRange` → `sensorHistory`
- `routes/alerts.js` (`alerts`, `auditLog`) and `routes/reports.js` (`reports`) serve in-memory arrays that reset on restart, even though real `alerts` / `reports` tables exist in the schema. **Note:** the new **notifications** feature (`routes/notifications.js` + `services/notificationService.js`) does write the **real** `alerts` + `alert_notifications` tables — the bell feed is persisted (only the legacy `/api/alerts` Dashboard panel is still the mock). See `email-popup-notifications.md`.

> The `reports.js` role gate is **fixed** — it now uses `requireRole("admin", "it_staff")` (previously referenced a non-existent `super_admin`, which 403'd admins).

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
| `airconStatus` | manual toggle/mode/temp change |
| `airconAutoUpdate` | ESP32 auto IR zone change |
| `irChannelMap` | forwarded from ESP32 on connect |

### Server → ESP32
| Event | When |
|-------|------|
| `irConfig` | on ESP32 connect + after any add/remove/toggle |
| `irCommand` | manual Turn On/Off from dashboard |

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
| Dashboard, Environment, AirConditioner, ServerMetrics, Sidebar, Header | ✅ Grafana tokens |
| History, Reports, Settings, UserManagement | ⚠️ still use old `slate-*` classes |
| ServerDetail | hybrid: `slate-*` base + `dark:` overrides (light/dark adapted, not `--gf-*`) |

---

## ESP32 Firmware Notes

- Active file: `iot/esp32/env_monitor_v2.ino`
- `#define SD_ENABLED false` — set `true` only when SD module is physically connected
- `deviceSecret` must match `DEVICE_SECRET` in `backend/.env`
- IR fires only on temperature **zone change**, not every loop tick
- `enabledChannels[]` updated at runtime via `irConfig` socket event — no reflash needed to add/disable AC units
- Timestamp priority: DS3231 RTC → NTP (UTC+8, `pool.ntp.org`) → uptime fallback (`UP HH:MM:SS`)
- Backend overrides ESP32 timestamp with `new Date()` for all InfluxDB writes and broadcasts
- Buzzer: 10-bit LEDC resolution; `ledcWrite(pin, 0)` to silence (not `ledcWriteTone(pin, 0)`)
