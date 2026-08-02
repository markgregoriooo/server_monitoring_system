# CSPC-ICTU — Server & Environment Monitoring System

Full technical documentation for the CSPC-ICTU server-room monitoring and control
platform. This is the canonical reference; deep-dives for individual subsystems live in
their own files (see [Related Documentation](#13-related-documentation)).

> **Doc status:** reflects the `google-oauth` branch (login is Google OAuth only, server
> metrics are real, environment is live). The older `README.md` is out of date — prefer
> this file.

---

## Table of Contents

1. [Overview](#1-overview)
2. [System Architecture](#2-system-architecture)
3. [Tech Stack](#3-tech-stack)
4. [Repository Layout](#4-repository-layout)
5. [Getting Started](#5-getting-started)
6. [Environment Variables](#6-environment-variables)
7. [Authentication & Authorization](#7-authentication--authorization)
8. [Data Stores](#8-data-stores)
9. [REST API Reference](#9-rest-api-reference)
10. [Socket.IO Events](#10-socketio-events)
11. [Subsystems](#11-subsystems)
12. [Frontend](#12-frontend)
13. [Related Documentation](#13-related-documentation)
14. [Known Limitations & Mock Endpoints](#14-known-limitations--mock-endpoints)

---

## 1. Overview

A monitoring and control system for the CSPC-ICTU server room. It tracks two things:

- **Environment** — temperature, humidity, and smoke/gas, read by an **ESP32** (DHT11 +
  2× MQ-2). The ESP32 also drives an **IR transmitter array** that controls the room's air
  conditioners automatically based on temperature zones.
- **Server health** — CPU, memory, disk, network, and uptime of physical/virtual servers,
  collected by a standalone **Go agent** installed on each host.

Both feed a real-time **React dashboard** (Grafana-styled) over a **Node.js + Socket.IO**
backend. Time-series data is stored in **InfluxDB**; everything relational (users, devices,
aircon, agent tokens, logs) is in **MySQL**.

**Primary users:** ICTU administrators and IT staff. Login is restricted to CSPC Google
accounts and gated by admin approval.

---

## 2. System Architecture

```
   ┌──────────────┐  Socket.IO (device key)   ┌───────────────────────────┐
   │   ESP32      │ ────sensorData / irFired──▶│                           │
   │ DHT11+2×MQ2  │ ◀──irConfig / irCommand────│      Node.js Backend      │
   │ IR TX ×4     │                            │  Express + Socket.IO      │
   └──────────────┘                            │                           │
                                               │  ┌─────────────────────┐  │
   ┌──────────────┐  HTTPS POST (AGT- token)   │  │ routes / services / │  │
   │  Go Agent    │ ──/api/servers/metrics────▶│  │ handlers / sockets  │  │
   │ (per server) │ ◀──enroll / approve────────│  └─────────────────────┘  │
   └──────────────┘                            │      │            │       │
                                               └──────┼────────────┼───────┘
                                                      │            │
                                          ┌───────────▼──┐   ┌─────▼────────┐
                                          │   MySQL      │   │  InfluxDB    │
                                          │ relational   │   │ time-series  │
                                          └──────────────┘   └──────────────┘
                                                      ▲            ▲
   ┌──────────────┐   REST (JWT) + Socket.IO          │            │
   │ React SPA    │ ─────────────────────────────────▶│ (via backend, never direct)
   │ (dashboard)  │ ◀──live: sensorData / serverMetrics / serverStatus / deviceLog …
   └──────────────┘
```

**Key boundaries**

- The ESP32 and Go agents **never** touch the databases directly — all writes go through the
  backend, which is the single InfluxDB/MySQL writer.
- Browsers authenticate with a **JWT**; the ESP32 uses a **shared device secret**; Go agents
  use a per-device **Bearer `AGT-…` token**. Three distinct auth paths, one server.
- Live updates are pushed over Socket.IO; the REST API is used for initial loads, history,
  and mutations.

---

## 3. Tech Stack

| Layer        | Technology |
|--------------|------------|
| Frontend     | React 18 + TypeScript + Vite + Tailwind CSS v3, JetBrains Mono |
| Charts       | Chart.js + react-chartjs-2 + chartjs-plugin-zoom |
| Realtime     | Socket.IO (client + server) |
| Backend      | Node.js + Express (ESM, `"type": "module"`) |
| Auth         | Google OAuth (OIDC, auth-code flow) via `google-auth-library` + `@react-oauth/google`; app sessions via JWT (`jsonwebtoken`) |
| Relational   | MySQL 8 via `mysql2` (promise pool) |
| Time-series  | InfluxDB 2.x via `@influxdata/influxdb-client` |
| Rate limiting| `express-rate-limit` |
| Uploads      | `multer` (profile images: JPEG/PNG/WebP, 2 MB cap) |
| Agent        | Go 1.22, `gopsutil/v3` + `godotenv` |
| Firmware     | ESP32 (Arduino/C++) — DHT11, 2× MQ-2, WS2812B RGB, IR TX ×4, optional DS3231 RTC |

---

## 4. Repository Layout

```
server-infrastructure-monitoring-system-webSystem/
├── backend/
│   ├── src/server.js               ← Entry point (Express + Socket.IO + offline sweep)
│   ├── config/
│   │   ├── env.js                  ← dotenv loader (imported first everywhere)
│   │   ├── mysql.js                ← mysql2 pool, exported as `db`
│   │   └── influx.js               ← InfluxDB write (ms precision) + query clients, `bucket`
│   ├── routes/                     ← one file per resource, mounted at /api/<resource>
│   │   ├── auth.js                 ← POST /google (only login), GET /me, POST /logout
│   │   ├── users.js                ← user CRUD + pending-registration approve/reject
│   │   ├── servers.js              ← server list/detail/history/logs + agent metric POST
│   │   ├── agents.js               ← Go-agent enroll / status / approve / reject
│   │   ├── aircon.js               ← AC units: list, add, remove, toggle, mode, temp
│   │   ├── environment.js          ← (mock) history + logs
│   │   ├── alerts.js               ← (mock) alerts + audit log
│   │   └── reports.js              ← (mock) reports
│   ├── services/
│   │   ├── authService.js          ← issueSession (JWT), getMe, logout
│   │   ├── googleAuthService.js    ← Google code exchange + ID-token verify + domain gate
│   │   ├── userService.js          ← user CRUD, findByEmail, register/approve/reject
│   │   ├── permissionService.js    ← static role → permission map
│   │   ├── airconService.js        ← all aircon DB logic + IR channel map
│   │   └── agentService.js         ← server-device DB logic, enroll/approve, offline sweep, device_logs
│   ├── handlers/
│   │   ├── sensorHandler.js        ← validate → InfluxDB write → broadcast sensorData
│   │   ├── querySensorHistoryHandler.js ← Flux queries → sensorHistory
│   │   ├── offlineDataHandler.js   ← ESP32 SD-card batch flush
│   │   ├── serverMetricsHandler.js ← agent POST → InfluxDB (server_metrics) + broadcast
│   │   └── serverHistoryHandler.js ← Flux query on server_metrics for /history
│   ├── middleware/
│   │   ├── auth.js                 ← authMiddleware, requireRole(...), JWT_SECRET
│   │   ├── agentAuth.js            ← Bearer AGT-… token auth for agent POSTs
│   │   └── upload.js               ← multer config
│   └── sockets/connectionHandler.js← all socket events, device vs browser segregation
│
├── frontend/
│   └── src/
│       ├── App.tsx                 ← route tree + ProtectedRoute
│       ├── config.ts               ← backend URL (auto-detect host:3000, VITE_API_URL override)
│       ├── api/{client.ts,api.ts}  ← Axios instance + all API calls (ApiResult<T>)
│       ├── context/{AuthContext,ThemeContext}.tsx
│       ├── socket/socket.ts        ← shared Socket.IO client (autoConnect:false)
│       ├── data/users.ts           ← roleConfig: role → allowed pages
│       ├── components/layout/      ← Sidebar, Header, ProfileModal
│       └── pages/                  ← Dashboard, ServerMetrics, ServerDetail, Environment,
│                                     AirConditioner, History, Reports, Settings,
│                                     UserManagement, auth/{Login,Unauthorized}
│
├── go-agent/                       ← standalone Go monitoring agent (see go-agent/README.md)
├── iot/esp32/env_monitor_v2.ino    ← active firmware
├── migrations/2026-06-09_google_auth.sql
├── V10cspc-ictu-monitoring-system-schema.sql ← current full MySQL schema
│
└── docs: CLAUDE.md, README.md, Environment.md, server-metrics.md,
         google-oauth.md, go-agent/README.md, SESSION_NOTES.md
```

---

## 5. Getting Started

### Prerequisites

- Node.js 18+
- MySQL 8.0+
- InfluxDB 2.x
- (For live environment data) ESP32 + DHT11 + 2× MQ-2
- (For server metrics) the Go agent installed on each monitored host
- A Google Cloud OAuth **Web** client (see `google-oauth.md`)

### 1. Database

Create the MySQL schema and apply the Google-auth migration:

```bash
mysql -u root -p < V10cspc-ictu-monitoring-system-schema.sql
mysql -u root -p server_monitoring_system < migrations/2026-06-09_google_auth.sql
```

> Edit the admin-email placeholder in the migration's bootstrap `UPDATE` **before** running
> it — that statement flips your first admin account to `active` so you can log in.

Provision an InfluxDB org + bucket and an API token with write/read on that bucket.

### 2. Backend

```bash
cd backend
npm install
# create backend/.env (see section 6)
npm run dev        # nodemon src/server.js (watch mode) → http://localhost:3000
# or: node src/server.js   (production)
```

> Entry point is `backend/src/server.js`. It binds `0.0.0.0:3000` (all interfaces).

### 3. Frontend

```bash
cd frontend
npm install
# create frontend/.env with VITE_GOOGLE_CLIENT_ID (and optional VITE_API_URL)
npm run dev        # Vite → http://localhost:5173
npm run build      # production bundle
```

The dashboard's backend URL **auto-detects** from the page host on port 3000
(`frontend/src/config.ts`), so roaming between networks needs no edits. Pin a specific
backend with `VITE_API_URL` in `frontend/.env` (then restart `npm run dev`).

### 4. Go agent (per monitored server)

See `server-metrics.md` and `go-agent/README.md`. In short: `--register` enrolls the host,
an admin approves it in **Server Metrics → pending**, and the agent then POSTs metrics every
~10s. Pre-built installer folders ship under `dist/cspc-ictu-agent-{windows,linux}/`.

---

## 6. Environment Variables

### Backend (`backend/.env`)

| Variable | Purpose |
|----------|---------|
| `PORT` | API port (default 3000) |
| `JWT_SECRET` | Signing secret for app session JWTs |
| `DEVICE_SECRET` | Shared secret for ESP32 socket auth — must match the firmware constant |
| `DB_HOST` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` / `DB_PORT` | MySQL connection |
| `INFLUX_URL` / `INFLUX_TOKEN` / `INFLUX_ORG` / `INFLUX_BUCKET` | InfluxDB connection (reads + writes target the same bucket) |
| `AGENT_INSTALL_KEY` | Shared key Go agents present at enrollment (`POST /api/agents/register`) |
| `WEB_ORIGIN` | Allowed dashboard origins, comma-separated — or `*` for any (roaming LAN); blank = localhost + LAN default |
| `GOOGLE_CLIENT_ID` | Google OAuth web client ID (public). Audience for ID-token verification. Must equal frontend `VITE_GOOGLE_CLIENT_ID` |
| `GOOGLE_CLIENT_SECRET` | Google OAuth web client **secret** — required; the auth-code flow exchanges the code server-side |
| `GOOGLE_ALLOWED_DOMAINS` | Comma-separated CSPC domains allowed to sign in; blank = `cspc.edu.ph,my.cspc.edu.ph` |

### Frontend (`frontend/.env`)

| Variable | Purpose |
|----------|---------|
| `VITE_GOOGLE_CLIENT_ID` | Same client ID as backend `GOOGLE_CLIENT_ID` (restart `npm run dev` after changing) |
| `VITE_API_URL` | Optional explicit backend URL override (production / HTTPS / different host) |

> `backend/.env` is git-ignored — secrets are never committed. Firmware constants (`host`,
> `port`, `deviceSecret`) are still hardcoded in `iot/esp32/env_monitor_v2.ino`.

---

## 7. Authentication & Authorization

### Login — Google OAuth (OIDC) only

The custom **"CSPC Mail"** button runs the **authorization-code flow**
(`@react-oauth/google`, `flow: "auth-code"`) and posts a one-time **code** to
`POST /api/auth/google`. The flow:

```
Browser (CSPC Mail button)                 Backend                         Google
  │ useGoogleLogin(auth-code)                  │                              │
  │───── POST /api/auth/google { code } ──────▶│                              │
  │                                            │── getToken(code) ───────────▶│  (exchange,
  │                                            │◀──── id_token + tokens ──────│   authed by secret)
  │                                            │── verifyIdToken(audience) ───│  (local verify)
  │                                            │   enforce CSPC domains +     │
  │                                            │   email_verified === true    │
  │◀──── { token (JWT), user } | pending ──────│                              │
```

- `services/googleAuthService.js` builds an `OAuth2Client` with
  `{ clientId, clientSecret, redirectUri: "postmessage" }` (the magic popup redirect — needs
  no Console entry), exchanges the code, verifies the ID token's signature **and audience**
  locally, then enforces the allowed CSPC domains + `email_verified`.
- On success it issues the app JWT via `authService.issueSession`.
- The old password/bcrypt login was **removed**; `users.hash_password` is now nullable.

### Self-register → admin approve/reject

- A first-time Google sign-in creates a `users` row with `status='pending'` (returns
  `pending_created`; a `userPending` socket event nudges open admin dashboards).
- An admin approves (assigning `admin` or `it_staff`) or rejects (`status='rejected'`) from
  **User Management → Pending registrations**.
- `pending` / `rejected` / `inactive` accounts can never obtain a session.

### Session / JWT

- Signed with `JWT_SECRET`, **expires 1 h**, stored in `sessionStorage` as `cspc_token`.
- Carries a `tv` (token_version) claim. `authMiddleware` rejects the token when
  `users.token_version` or `status` no longer match — i.e. **server-side session
  revocation**: logout, disable, or role change bumps `token_version`.
- The frontend auto-logs-out on JWT expiry: an axios response interceptor reacts to 401 /
  403 "Invalid or expired token", and `AuthContext` proactively schedules logout at `exp`.

### Auth paths summary

| Client | Mechanism | Where |
|--------|-----------|-------|
| Browser (REST) | `Authorization: Bearer <JWT>` | `middleware/auth.js` |
| Browser (Socket.IO) | JWT in `socket.handshake.auth.token` | `src/server.js` `io.use(...)` |
| ESP32 (Socket.IO) | device key in `handshake.auth.deviceKey` (or `.query` legacy) vs `DEVICE_SECRET` | `src/server.js` |
| Go agent (REST) | `Authorization: Bearer AGT-…` | `middleware/agentAuth.js` |
| Go agent enrollment | shared `AGENT_INSTALL_KEY` (constant-time compare) | `routes/agents.js` |

### Roles

| Role | DB value | Access |
|------|----------|--------|
| Admin | `admin` | All pages + Settings + User Management (approves registrations) |
| IT Staff | `it_staff` | Dashboard, Server Metrics, Environment, Aircon, History, Reports |

Frontend page access is enforced by `roleConfig` (`frontend/src/data/users.ts`) +
`ProtectedRoute`; backend enforces with `requireRole(...roles)`.

---

## 8. Data Stores

### MySQL (`server_monitoring_system`)

Full DDL in `V10cspc-ictu-monitoring-system-schema.sql`. Tables in active use:

| Table | Purpose |
|-------|---------|
| `users` | Accounts. `google_sub`, `auth_provider`, `status` (`pending`/`active`/`inactive`/`rejected`), `token_version`, `last_login` |
| `devices` | All devices (`aircon`, `server`, `ups`, `router`, `esp32`) — the join hub |
| `server_specs` | Per-server OS/kernel/cores/memory/disk/uptime/agent_version + `last_seen` (offline detection) |
| `device_network` | Per-server gateway/dns/segment/mac (collected natively by the agent) |
| `agent_tokens` | Go-agent enrollment: `token` (pending), `approved_token` (`AGT-…`), `status` |
| `aircon_state` | Per-AC `ir_channel`, `is_on`, `mode`, `set_temperature`, `last_trigger`, `triggered_by_user_id` |
| `aircon_logs` | AC action history (manual/auto/schedule) |
| `device_logs` | Server lifecycle + CPU/Mem/Disk threshold-crossing events |
| `system_logs` | Auth/audit log (incl. `ip_address`, `user_agent`) |
| `ir_commands` | Stored IR raw signals (schema present) |

Other tables exist in the schema for planned features (`alerts`, `alert_rules`,
`alert_notifications`, `reports`, `settings`, `suggestions`, `ups_details`,
`mikrotik_devices`, `network_interfaces`, `device_metrics_config`, `sensor_backup_batches`)
but are **not** all wired to live code yet — see [section 14](#14-known-limitations--mock-endpoints).

### InfluxDB

| Measurement | Source | Notes |
|-------------|--------|-------|
| `sensor_environment` | ESP32 via `sensorHandler` | temp, humidity, 2× MQ-2; precision `ms` |
| `server_metrics` | Go agent via `serverMetricsHandler` | CPU, mem, disk, net counters, uptime, procs |

Reads and writes always target the same `INFLUX_BUCKET`. Recommended: set a retention policy
(e.g. 30–90 days) on the bucket — `server_metrics` is the only high-volume store.

### In-memory mock (`data/db.js`) — **gone**

There is no longer any mock store. `alerts` moved to the real `alerts` +
`alert_notifications` tables, environment `history`/`logs` to InfluxDB
(`environmentService`), and `reports` to the real `reports` table plus on-disk CSV/PDF
(`reportService` — see `report-page.md`). `reports` was the last consumer, so
`backend/data/` was deleted outright.

---

## 9. REST API Reference

All endpoints are under `/api`. ✅ = requires a valid JWT (`authMiddleware`). Roles in
parentheses use `requireRole(...)`.

### Auth — `/api/auth`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/auth/google` | Public (rate-limited) | The only login. Body `{ code }` → `{ token, user }`, or `pending`/`rejected`/`disabled` outcomes |
| GET | `/auth/me` | ✅ | Current authenticated user |
| POST | `/auth/logout` | ✅ | Log out (writes audit log) |

> Sign-in limiter: 30 failed attempts / 15 min / IP (successful sign-ins are skipped).

### Users — `/api/users`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/users` | ✅ (admin) | List all users |
| GET | `/users/pending` | ✅ (admin) | Registrations awaiting approval |
| GET | `/users/:id` | ✅ (admin) | Single user |
| POST | `/users/:id/approve` | ✅ (admin) | Approve a pending registration, body `{ role }` → emits `userApproved` |
| POST | `/users/:id/reject` | ✅ (admin) | Reject a pending registration → emits `userPending` |
| PATCH | `/users/:id` | ✅ (admin) | Update a user |
| PATCH | `/users/:id/status` | ✅ (admin) | Enable/disable an account |
| DELETE | `/users/:id` | ✅ (admin) | Delete a user |
| PATCH | `/users/me` | ✅ | Update own profile (multipart, optional `profile_image`) |
| PATCH | `/users/me/password` | ✅ | Change own password *(vestigial under Google-only login)* |
| POST | `/users` | ✅ (admin) | Create user *(vestigial — UI removed)* |
| PATCH | `/users/:id/reset-password` | ✅ (admin) | Reset a password *(vestigial)* |

### Servers — `/api/servers`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/servers/metrics` | Agent token | Go-agent metric ingestion → InfluxDB + broadcast `serverMetrics`. Own limiter (1000/15min/IP) |
| GET | `/servers` | ✅ | Approved servers + cached live metrics (offline servers report zeroed/`null`) |
| GET | `/servers/:id` | ✅ | Single server detail |
| GET | `/servers/:id/history?range=-1h\|-6h\|-24h` | ✅ | Real metric history from InfluxDB (gauges via `mean`, counters via `last`) |
| GET | `/servers/:id/logs` | ✅ | `device_logs` entries for a server |
| DELETE | `/servers/:id` | ✅ (admin) | Decommission: cascade-delete + revoke token → emits `serverRemoved` |

### Agents — `/api/agents`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/agents/register` | Install key | First-run enrollment (body `{ install_key, hostname, … }`) → pending token + emits `agentPending` |
| GET | `/agents/status?pending_token=…` | Public | Agent polls for approval → `{ status, approved_token, device_id }` |
| GET | `/agents/pending` | ✅ (admin) | Servers awaiting approval |
| POST | `/agents/:id/approve` | ✅ (admin) | Approve → emits `agentApproved` + `deviceLog` |
| POST | `/agents/:id/reject` | ✅ (admin) | Reject (deletes pending device) → emits `agentPending` |

### Air Conditioner — `/api/aircon`

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/aircon` | ✅ | All AC units + state + channel map |
| GET | `/aircon/channels` | Public | ESP32 boot-time IR channel config fetch |
| POST | `/aircon` | ✅ (admin, it_staff) | Add a unit (body `{ name, ir_channel: 1–4 }`). `409` if the name or channel is already taken |
| DELETE | `/aircon/:id` | ✅ (admin) | Remove a unit |
| PATCH | `/aircon/:id/toggle` | ✅ (admin, it_staff) | Turn ON/OFF → emits `airconStatus` + fires `irCommand` |
| PATCH | `/aircon/:id/name` | ✅ (admin, it_staff) | Rename a unit (body `{ name }`, 1–100 chars, unique among aircon; `409` if taken) → emits `airconStatus` + logs to `aircon_logs` |

### Formerly-mock endpoints — all now real

| Method | Endpoint | Notes |
|--------|----------|-------|
| GET | `/environment/daily` | Real InfluxDB per-day summary (`environmentService`). The old random-data `/history` + `/logs` are **removed**; live history comes via the `changeRange` socket event |
| GET/POST | `/alerts` · `/alerts/:id/acknowledge` · `/resolve` | Real `alerts` table + shared lifecycle (`alertsService`) |
| GET/POST | `/reports` · `/reports/:id/download\|email` | Real `reports` table + CSV/PDF on disk (`reportService`). Generation is async: POST returns `202` and the result arrives over Socket.IO. See `report-page.md` |

Global rate limit: 500 requests / 15 min / IP (the agent metrics path is exempt).

---

## 10. Socket.IO Events

Browsers send the JWT in `handshake.auth.token`; the ESP32 sends its device key in
`handshake.auth.deviceKey` (or `.query.deviceKey` legacy EIO3). `socket.isDevice`
distinguishes them.

### ESP32 → Server (device only)

| Event | Purpose |
|-------|---------|
| `sensorData` | Live reading (~3s) → InfluxDB write + broadcast |
| `offlineData` | SD-card replay → InfluxDB write, no broadcast |
| `irChannelMap` | GPIO assignments on connect → stored + forwarded to browsers |
| `irFired` | Auto IR fired → `applyAutoIR()` updates DB + broadcasts `airconAutoUpdate` |

### Browser → Server

| Event | Purpose |
|-------|---------|
| `changeRange` | Quick range string or `{start, stop}` ISO → emits `sensorHistory` back |

### Server → Browsers

| Event | When |
|-------|------|
| `sensorData` | Every ESP32 reading |
| `sensorHistory` | Response to `changeRange` |
| `serverMetrics` | Each Go-agent metric POST (~10s/host) |
| `serverStatus` | Offline sweep flips a stale server → `{ id, status: "Offline" }` |
| `serverRemoved` | Admin removes a server → `{ id }` |
| `agentApproved` / `agentPending` | Agent approved / registered-or-rejected |
| `userPending` / `userApproved` | User self-registered-or-rejected / approved |
| `deviceLog` | New `device_logs` entry (lifecycle + threshold crossings) |
| `airconStatus` | Manual on/off toggle, rename, or power-on re-sync |
| `airconAutoUpdate` | ESP32 auto IR zone change (only affected `deviceIds`) |
| `irChannelMap` | Forwarded from ESP32 on connect |

### Server → ESP32

| Event | When |
|-------|------|
| `irConfig` | On connect + after any add/remove/toggle |
| `irCommand` | Manual Turn On/Off from dashboard |

---

## 11. Subsystems

### 11.1 Environment monitoring (ESP32)

ESP32 reads DHT11 (temp/humidity) + 2× MQ-2 (smoke/gas) every ~3s and emits `sensorData`.
The backend overrides the device timestamp with `new Date()`, writes to InfluxDB
(`sensor_environment`, ms precision), and broadcasts to browsers. History is served by Flux
queries via the `changeRange` → `sensorHistory` socket round-trip (not the mock REST
endpoint). Full guide: **`Environment.md`**.

Firmware notes (`iot/esp32/env_monitor_v2.ino`):

- **No SD card / on-device buffer** — removed; durability lives on the backend (`backupService`). The `offlineData` handler remains but is dormant.
- `deviceSecret` must match `DEVICE_SECRET` in `backend/.env`.
- Timestamp priority: DS3231 RTC → NTP (UTC+8) → uptime fallback.
- Buzzer uses 10-bit LEDC; `ledcWrite(pin, 0)` to silence.

### 11.2 Air conditioner control (IR)

Each AC unit is a `devices` row (`type='aircon'`) with a linked `aircon_state` row.
`ir_channel` (1-based) maps to `IR_CHANNEL_PINS[ir_channel-1]` in firmware. The ESP32 fires
IR **only on temperature zone change**:

| Room Temp | Zone | Set Temp | Fan |
|-----------|------|----------|-----|
| < 22 °C | TOO_COLD (0) | 28 °C | Auto |
| 22–24 °C | NORMAL (1) | 26 °C | Auto |
| 25–27 °C | ACCEPTABLE (2) | 24 °C | Auto |
| 28–29 °C | NEAR_CRIT (3) | 22 °C | High |
| > 29 °C | CRITICAL (4) | 20 °C | High |

**Power is manual-only.** Auto IR (`applyAutoIR`) only re-targets the set temperature of
units that are **currently ON** — it never flips `is_on`, so a unit a user turned off stays
off. All seven IR arrays are **real Carrier captures** (no mock data remains), but none has
yet driven a physical unit — see `Environment.md` §8 for the two things to verify on the
hardware and the re-capture procedure.

### 11.3 Server metrics (Go agent)

A standalone Go program (`go-agent/`, module `cspc-ictu/go-agent`) collects CPU, memory,
disk, network bytes, uptime, and process count, then POSTs snake_case JSON to
`/api/servers/metrics` every ~10s with a Bearer token.

**Lifecycle:** `--register` (enroll with `AGENT_INSTALL_KEY` → poll `/api/agents/status` →
write `agent.conf`) → admin approves in the dashboard → metric loop. On token revocation
(403) the agent self-deletes `agent.conf` and exits, so re-adding is a clean `--register`.

**Offline detection:** a 15s backend sweep flips approved servers whose `last_seen` is stale
(`OFFLINE_AFTER_SEC = 30`) to `offline`, zeroes their live metrics, and emits `serverStatus`
+ `deviceLog`. Recovery is automatic on the next metric POST. Full guide:
**`server-metrics.md`** and **`go-agent/README.md`**.

---

## 12. Frontend

### Routing & pages

`App.tsx` defines the route tree; `ProtectedRoute` checks `roleConfig[role].pages` against
the current path and renders `Unauthorized` otherwise. `/login` is the only public route;
any unauthenticated access redirects there.

| Route | Page | Roles |
|-------|------|-------|
| `/` | Dashboard | admin, it_staff |
| `/server-metrics` | ServerMetrics (+ ServerDetail drawer) | admin, it_staff |
| `/environment` | Environment | admin, it_staff |
| `/air-conditioner` | AirConditioner | admin, it_staff |
| `/history` | History | admin, it_staff |
| `/reports` | Reports | admin, it_staff |
| `/settings` | Settings | admin |
| `/user-management` | UserManagement | admin |

### State & data flow

- `AuthContext` manages login/logout, restores the session from `sessionStorage` on mount,
  and connects/disconnects the shared Socket.IO client.
- `api/client.ts` is the Axios instance (baseURL from `config.ts`, auto-attaches the Bearer
  token, response interceptor for session expiry). `api/api.ts` wraps every call and returns
  `ApiResult<T>`.
- The Socket.IO client (`socket/socket.ts`) has `autoConnect: false` and is driven by
  `AuthContext`.

### Design system (Grafana style)

All new code uses `--gf-*` CSS variables (defined in `index.css`) — **not** `slate-*` or
`dark:` Tailwind classes. Panel radius `2px`, font `'JetBrains Mono', monospace`.

| Token | Value | Use |
|-------|-------|-----|
| `--gf-bg` | `#111217` | Page background |
| `--gf-panel` | `#181B1F` | Card background |
| `--gf-accent` | `#5794F2` | Grafana blue |
| `--gf-text-primary` | `#D9D9D9` | Primary text |
| `--gf-text-muted` | `#6B7280` | Muted text |

Status colors: Online/NORMAL `#73BF69`, WARNING `#FF780A`, DANGER `#F2495C`,
CRITICAL `#E02F44`, TOO_COLD `#5794F2`.

**Style status:** Dashboard, Environment, AirConditioner, ServerMetrics, Sidebar, Header,
Login, UserManagement use `--gf-*`. History, Reports, Settings still use legacy `slate-*`
classes; ServerDetail is a `slate-*` + `dark:` hybrid.

---

## 13. Related Documentation

| File | Covers |
|------|--------|
| `CLAUDE.md` | Authoritative quick reference / build & architecture guide for contributors |
| `Environment.md` | Environment + IR/aircon subsystem deep-dive (hardware, sensor logic, InfluxDB pipeline) |
| `server-metrics.md` | Server-metrics feature: agent, enrollment/auth, data contract, deployment, production checklist |
| `go-agent/README.md` | Go-agent internals, build/ship model, file-by-file walkthrough |
| `google-oauth.md` | Google OAuth setup + flow narrative + troubleshooting |
| `SESSION_NOTES.md` | Per-session development log |
| `README.md` | Original project README (⚠️ partially out of date — this file supersedes it) |

---

## 14. Known Limitations

- ~~**Mock data:** `/api/environment/history|logs`, `/api/alerts`, `/api/reports`~~ — **FIXED.**
  No mock store remains; `backend/data/` was deleted when Reports went real.
- **Report layout is not a client-approved template.** The PDF header, section order and
  the absence of a signature block were chosen by the dev team, not supplied by CSPC-ICTU.
  See `reports-client-questionnaire.md`.
- **Vestigial password UI:** with Google-only login, the User Management "Reset PW" and
  Profile "Change Password" controls (and the `POST /users` / reset-password endpoints) are
  no longer meaningful. Flagged for removal.
- ~~**`routes/auth.js` missing import**~~ — FIXED. `authService` is imported (`routes/auth.js:3`),
  so `GET /auth/me` and `POST /auth/logout` work. Entry kept only so the old note isn't
  re-derived from a stale copy of this file.
- **IR data captured but unverified:** all seven arrays are real Carrier captures — no mock
  data remains — but none has driven a physical AC yet. Two open questions to settle on the
  hardware: `IR_20C_HIGH` may be the wrong fan setting (bits 53–55 read 010 vs 000 on
  `IR_22C_HIGH`), and `IR_POWER_OFF` has a one-bit header difference from all six others.
  See `Environment.md` §8.
- **Unplanned schema tables:** several schema tables (UPS, MikroTik, suggestions, alert
  rules/notifications, settings, network interfaces, metrics config) are defined but not yet
  wired to live code.
- **InfluxDB retention:** not enforced in code — set a bucket retention policy manually.
```
