# CSPC-ICTU · Server Infrastructure Monitoring & Control System

Server-room monitoring for the CSPC ICT Unit. Collects **environment** (temperature,
humidity, gas), **server** (CPU/memory/disk/network), **network** (router interfaces,
MikroTik) and **UPS** (battery, runtime, load) telemetry, raises configurable alerts to a
bell feed + email, and controls the room's air conditioners over IR.

> **Detailed docs live in separate files** — this README is the map. See
> [`CLAUDE.md`](CLAUDE.md) for the full architecture reference,
> [`DOCUMENTATION.md`](DOCUMENTATION.md), and the per-feature guides listed in
> [Documentation index](#documentation-index).

---

## Data sources

Three ingest paths converge on one alerting pipeline:

| Source | Direction | Transport | Cadence |
|--------|-----------|-----------|---------|
| **ESP32** (DHT11 + 2× MQ-2 + IR TX + RGB LED) | push | Socket.IO | ~3 s |
| **Go agents** (one per monitored server) | push | HTTP POST | ~10 s (per-agent) |
| **SNMP poller** (routers via IF-MIB, UPS via UPS-MIB) | pull | SNMP v2c | 60 s |
| **MikroTik poller** (campus router) | pull | RouterOS API | 30 s |

---

## Project structure

```
├── backend/                          ← Node.js + Express (ESM) + Socket.IO
│   ├── src/server.js                 ← entry point (routes, sweeps, pollers, retention)
│   ├── config/                       ← env.js, mysql.js (pool), influx.js (read+write)
│   ├── routes/                       ← one file per resource, mounted at /api/<resource>
│   ├── services/                     ← business logic (see "Key services" below)
│   ├── handlers/                     ← ingest + history: sensor, serverMetrics, network, ups
│   ├── middleware/                   ← auth.js (JWT + requireRole), agentAuth.js (AGT- tokens)
│   ├── sockets/connectionHandler.js  ← all socket events, device vs browser segregation
│   ├── utils/                        ← asyncHandler.js, httpErrors.js
│   ├── tests/                        ← `npm test` — node --test, no MySQL/InfluxDB needed
│   └── scripts/mailCheck.js          ← `npm run mail:check` — verify SMTP credentials
│
├── frontend/                         ← React 18 + TypeScript + Vite + Tailwind
│   └── src/
│       ├── App.tsx                   ← route tree + ProtectedRoute
│       ├── config.ts                 ← backend URL (auto-detects host:3000)
│       ├── api/{client.ts,api.ts}    ← Axios instance + all calls (ApiResult<T>)
│       ├── context/                  ← Auth, Theme, Notification
│       ├── components/               ← layout/, notifications/, ui/
│       └── pages/                    ← one file per page
│
├── go-agent/                         ← standalone Go agent (enroll → approve → POST metrics)
├── iot/esp32/env_monitor_v2.ino      ← firmware (active)
├── ops/                              ← db-backup + offsite-backup (rclone) scripts
├── dev-snmpsim/                      ← SNMP simulator for local router/UPS testing
└── v13_cspc-ictu-monitoring-system.sql ← full schema (single file, no migration chain)
```

### Key services

| Service | Responsibility |
|---------|----------------|
| `alertRulesService` | configurable thresholds (`alert_rules`) + hysteresis-aware `nextBand()` |
| `alertBandState` | per-(device, metric) severity band; onset-only escalation + recovery confirmation |
| `notificationService` | `raiseAlert()` → dedup → `alerts` row → per-user fan-out → socket + email |
| `alertsService` | shared alert lifecycle (acknowledge/resolve/auto-resolve) |
| `deviceAlerts` | router/UPS/MikroTik threshold + event alerting (shared by both pollers) |
| `agentService` | Go-agent enrollment, heartbeat, offline sweep, server threshold checks |
| `snmpPollerService` / `mikrotikPollerService` | the two pull-based collectors |
| `backupService` | on-site NDJSON mirror of every sample + integrity manifest |
| `reportService` | async report build → CSV + PDF on disk |
| `googleAuthService` | Google OAuth code exchange, domain gate, login-or-create-pending |

---

## Setup & run

**Prerequisites:** Node.js 18+, MySQL 8.0+ (or MariaDB 10.4+), InfluxDB 2.x, and a Google
OAuth web client. Go 1.21+ only if building the agent.

```bash
# 1. Database — load the schema
mysql -u root -p < v13_cspc-ictu-monitoring-system.sql
```

```bash
# 2. Backend
cd backend
npm install
# create backend/.env by hand — see "Environment variables" below
npm run dev                 # nodemon src/server.js → http://localhost:3000
```

```bash
# 3. Frontend
cd frontend
npm install
# create frontend/.env by hand — see "Environment variables" below
npm run dev                 # → http://localhost:5173
```

> ⚠️ **First sign-in on a fresh database lands `pending` with nobody able to approve it** —
> the schema seeds no admin row. Promote your account by hand once, then use the UI. See
> [`deployment-guide.md`](deployment-guide.md) §4.3.

> ⚠️ **Google allows only `localhost` or HTTPS as a JavaScript origin**, so a raw
> `http://<LAN-IP>:5173` cannot sign in. On-prem needs an HTTPS hostname before go-live.

### Environment variables

`backend/.env` is documented in full in [`CLAUDE.md`](CLAUDE.md). The essentials:

| Variable | Purpose |
|----------|---------|
| `PORT`, `JWT_SECRET` | server + session signing |
| `DB_*`, `INFLUX_*` | MySQL and InfluxDB connections |
| `GOOGLE_CLIENT_ID` / `_SECRET` | OAuth — login fails for everyone without these |
| `DEVICE_SECRET` | ESP32 socket auth — must match the firmware constant |
| `AGENT_INSTALL_KEY` | shared key Go agents present at enrollment |
| `MIKROTIK_ENC_KEY` | **required for MikroTik** — 64 hex chars, AES-256-GCM |
| `SMTP_*`, `MAIL_FROM` | alert/report email; blank disables email cleanly |
| `WEB_ORIGIN` | allowed dashboard origins, or `*` for a roaming LAN |

`frontend/.env`:

| Variable | Purpose |
|---|---|
| `VITE_GOOGLE_CLIENT_ID` | **required for login** — same client ID as the backend's `GOOGLE_CLIENT_ID` |
| `VITE_API_URL` | pin a backend (different host / HTTPS). Blank = auto-detect from the page host on port 3000 |
| `VITE_APP_NAME` | short name in the UI; blank = `CSPC-ICTU` |
| `VITE_APP_FULL_NAME` | full institution name; blank = `Camarines Sur Polytechnic Colleges …` |
| `VITE_APP_SUBTITLE` | sidebar subtitle; blank = `MONITORING` |
| `VITE_APP_TAGLINE` | system tagline; blank = `SERVER INFRASTRUCTURE MONITORING SYSTEM` |
| `VITE_LOGO_TEXT` | logo initials; blank = `CC` |
| `VITE_LOGO_SRC` | logo image in `frontend/public/`, e.g. `/logo.png`; blank = text initials |

Defaults live in `frontend/src/branding.ts`. Vite inlines `VITE_*` at **build time** —
restart `npm run dev` (or rebuild) after any change.

### Tests

```bash
cd backend && npm test      # node --test — pure unit tests, no DB required
```

Includes `contract.test.js`, which parses `go-agent/internal/collector/metrics.go` and fails
if its JSON tags drift from the backend's validator.

---

## Authentication

**Google OAuth (OIDC) only — the password login was removed.** The dashboard runs the
authorization-code flow and posts a one-time code to `POST /api/auth/google`; the backend
exchanges it server-side, verifies the ID token, enforces the CSPC domains
(`@cspc.edu.ph` / `@my.cspc.edu.ph`), then issues a 1 h JWT.

New accounts self-register as `pending`; an admin approves or rejects them from **User
Management**. JWTs carry a `tv` (token_version) claim, so logout, disable and role change
revoke active sessions server-side. Full guide: [`google-oauth.md`](google-oauth.md).

---

## API endpoints

All routes require a Bearer JWT unless marked otherwise. Roles: **A** = admin,
**S** = it_staff.

### Auth
| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/google` | public | Exchange Google auth code → JWT session |
| GET | `/api/auth/me` | A S | Current authenticated user |
| POST | `/api/auth/logout` | A S | Log out (bumps token_version) |

### Users
| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| GET | `/api/users` | A | List users |
| GET | `/api/users/pending` | A | Pending registrations |
| GET | `/api/users/:id` | A | Get one user |
| POST | `/api/users` | A | Create user *(vestigial — login is Google-only)* |
| PATCH | `/api/users/:id` | A | Update username / role / status |
| PATCH | `/api/users/:id/status` | A | Enable or disable an account |
| POST | `/api/users/:id/approve` | A | Approve a pending registration |
| POST | `/api/users/:id/reject` | A | Reject a pending registration |
| DELETE | `/api/users/:id` | A | Delete a user |
| PATCH | `/api/users/me` | A S | Update own profile (**username only**) |
| PATCH | `/api/users/me/password` | A S | Change own password *(vestigial)* |

### Servers & agents
| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| POST | `/api/agents/register` | install key | First-run agent enrollment |
| GET | `/api/agents/status` | pending token | Agent polls until approved |
| GET | `/api/agents/pending` | A | Enrollments awaiting approval |
| POST | `/api/agents/:id/approve` \| `/reject` | A | Approve / reject an agent |
| POST | `/api/servers/metrics` | agent token | Live metric ingest |
| POST | `/api/servers/metrics/batch` | agent token | Backfill of buffered samples |
| GET | `/api/servers` | A S | All servers with live metrics |
| GET | `/api/servers/:id` | A S | One server + specs |
| GET | `/api/servers/:id/history` | A S | Time-series (presets or `?start=&stop=`) |
| GET | `/api/servers/:id/logs` | A S | Device event log |
| POST | `/api/servers/:id/maintenance` | A | Park / resume for planned downtime |
| DELETE | `/api/servers/:id` | A | Decommission (revokes the agent token) |

### Network, MikroTik & UPS
| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| GET | `/api/network` · `/api/ups` · `/api/mikrotik` | A S | List devices with live values |
| POST | `/api/network` · `/api/ups` · `/api/mikrotik` | A | Register a device |
| DELETE | `/api/{network,ups,mikrotik}/:id` | A | Decommission |
| GET | `/api/{network,ups,mikrotik}/:id/history` | A S | Time-series |
| GET | `/api/{network,ups,mikrotik}/:id/logs` | A S | Device event log |
| PATCH | `/api/network/:id/interfaces` | A | Set a port's location label |
| GET/PUT | `/api/mikrotik/:id/interfaces` | A S / A | Read / save port labels |
| PUT | `/api/mikrotik/:id/connection` | A | Save API credentials (password encrypted) |
| POST | `/api/mikrotik/test` · `/:id/test` | A | Test a connection before saving |

### Environment & aircon
| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| GET | `/api/environment/daily` | A S | Per-day summary from InfluxDB |
| GET | `/api/environment/sensor-status` | A S | ESP32 liveness |
| POST | `/api/environment/calibrate-gas` | A | Ask the ESP32 to re-measure MQ-2 baseline |
| GET | `/api/aircon` | A S | AC units + state |
| GET | `/api/aircon/ir-config` · PUT | A S / A | Auto-cooling IR zone thresholds |
| POST | `/api/aircon` | A S | Register an AC unit |
| PATCH | `/api/aircon/:id/toggle` · `/name` | A S | Toggle power / rename |
| DELETE | `/api/aircon/:id` | A | Remove an AC unit |

### Alerts, rules, notifications & reports
| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| GET | `/api/alerts` | A S | Alert history (`?status=`) |
| GET | `/api/alerts/count` | A S | Open-alert count → sidebar badge |
| POST | `/api/alerts/:id/acknowledge` · `/resolve` | A S | Lifecycle transitions |
| GET/POST/PUT/DELETE | `/api/alert-rules` | A | Configurable threshold CRUD |
| GET | `/api/notifications` | A S | Per-user bell feed |
| POST | `/api/notifications/read` · `/clear` | A S | Mark read / dismiss |
| GET/PUT | `/api/notifications/prefs` | A S | Per-user email + popup preferences |
| GET | `/api/reports` | A S | List reports (shared across users) |
| GET | `/api/reports/scope-options` | A S | Devices a report type can scope to |
| POST | `/api/reports` | A S | Generate (async — returns 202) |
| GET | `/api/reports/:id/download?format=csv\|pdf` | A S | Download a saved file |
| POST | `/api/reports/:id/email` | A S | Email the PDF |
| DELETE | `/api/reports/:id` | A | Delete row + files |
| GET | `/api/history` · `/api/history/actors` | A S | Audit trail (`system_logs`) |

---

## Role access matrix

| Page | Admin | IT Staff |
|------|:-----:|:--------:|
| Dashboard | ✅ | ✅ |
| Server Metrics | ✅ | ✅ |
| Network Monitoring | ✅ | ✅ |
| MikroTik Network | ✅ | ✅ |
| UPS Monitoring | ✅ | ✅ |
| Environment | ✅ | ✅ |
| Air Conditioner | ✅ | ✅ |
| Alerts | ✅ | ✅ |
| History & Logs | ✅ | ✅ |
| Reports | ✅ | ✅ |
| Settings | ✅ | ✅ |
| User Management | ✅ | ❌ |
| Alert Rules | ✅ | ❌ |

Source of truth: `frontend/src/data/users.ts` (`roleConfig`) and `requireRole(...)` on
each route.

---

## In development (unmerged branches)

> ⚠️ **Neither feature is on `main`.** Both are built and working on their own branches but
> sit ~88 commits behind, and they touch files `main` has since rewritten
> (`agentService`, `alertRulesService`, plus `deviceAlerts.js`, which didn't exist when they
> were branched). Expect a **hand-merge**, not a clean `git merge` — this is how the
> `email-popup-notifications` branch was landed. Their design docs live on the branches, not
> here.

### Predictive Analytics — branch `predictive-analytics`

Turns the collected time-series into **foresight** instead of only reactive threshold
alerts. Pure Node, no Python service, fully explainable.

| Technique | Used for | Kind |
|-----------|----------|------|
| **Linear regression** (train/test split, R² + MAE) | **disk-full ETA** — "Server X hits 100% in ~9 days" | genuinely ML |
| EWMA + Holt's linear projection | short-horizon metric trends | statistics |
| Per-hour-of-day z-score + global IQR fences | anomaly detection | statistics |
| p50 / p95 / p99 | threshold recommendations vs current `alert_rules` | statistics |

> **Honesty note for a defense:** linear regression *is* supervised ML. Holt/EWMA and
> z-score are statistics, not ML. The branch doc is explicit about not overselling this.

**Adds** `backend/services/analyticsService.js` (806 lines), `backend/routes/analytics.js`,
`frontend/src/pages/Analytics.tsx` (1,213 lines) — no schema change.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/analytics/forecast/disk` · `/disk/:id` | Disk-full ETA, fleet-wide or per server |
| GET | `/api/analytics/trends/:metric` | EWMA + Holt projection with a per-hour table |
| GET | `/api/analytics/anomalies` | Outlier readings vs the metric's own baseline |
| GET | `/api/analytics/recommendations` | Suggested warn/crit thresholds (admin can apply) |
| GET | `/api/analytics/alerts/summary` | Alert-volume analytics |
| GET | `/api/analytics/forecast/ups-battery` | Battery-replacement ETA from runtime decay |
| GET | `/api/analytics/forecast/link-saturation` | Uplink-saturation ETA from utilization |

Page has four lazy-loaded tabs — **Forecasts**, **Trends & Anomalies**, **Alerts**,
**Recommendations** — over temperature, humidity, gas, CPU, memory, disk and MikroTik
CPU/memory/clients. Available to **both roles**.

> **Caveat:** the UPS and link forecasts are dev-verified against
> `backend/scripts/seed-analytics-history.js` (synthetic trending data on device ids
> 9001/9002/9101) because `dev-snmpsim` emits flat values and forecasting needs weeks of
> slope. Real ETAs need real history.

### Pop-out Live Widget — branch `pip-widget`

A floating always-on-top window — the kind Google Meet pops out — showing a compact,
**user-customizable** live status panel while working in other apps. Uses the **Document
Picture-in-Picture API** (arbitrary DOM, unlike the video-only PiP API), so it is
**Chromium-only** and must be opened by a user gesture.

The key design move: the widget is `createPortal`'d into `pipWindow.document.body` and stays
part of the **main app's React tree** — so `AuthContext`, `NotificationContext`, the shared
socket and theme all work for free. Only CSS doesn't cross the document boundary and must be
cloned in. (`AuthContext` on `main` already accounts for this: its "watching" check treats an
open PiP window as active, so popping out a tile keeps you signed in.)

**Tiles** — temperature, humidity, gas, servers summary, server list, open alerts, latest
alert, aircon, clock — arranged by drag-and-drop (`@dnd-kit`) in a builder on **Settings**,
with a live preview. Layout persists per user.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/widget-layout` | This user's saved tile layout (defaults if none) |
| PUT | `/api/widget-layout` | Save layout; unknown/duplicate tile ids dropped server-side |

The branch also carries an admin-settable **server display name** (a friendly label separate
from the agent-reported hostname, for racks where several boxes report `unknown-server`).

> **Both schema changes now ship in `v13_cspc-ictu-monitoring-system.sql`** — the
> `widget_prefs` table (`migrations/2026-06-17_widget_prefs.sql`) and the
> `devices.display_name` column (`migrations/2026-06-18_server_display_name.sql`). A fresh
> install needs neither migration run by hand. Only an *existing* database created before
> those dates does; without `widget_prefs`, layouts fall back to a localStorage cache and
> don't sync across devices.

---

## Data stores

| Data | Where |
|------|-------|
| Users, devices, aircon, alerts, reports, audit logs | **MySQL** |
| Environment time-series (`sensor_environment`) | **InfluxDB** |
| Server metrics (`server_metrics`, `server_volumes`) | **InfluxDB** |
| Router/UPS (`router_metrics`, `network_traffic`, `ups_metrics`) | **InfluxDB** |
| Independent backup copy of every sample | **NDJSON files** on `BACKUP_DIR` |
| Generated reports | MySQL row + CSV/PDF under `backend/reports/` |

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS v3 · Grafana `--gf-*` design tokens · JetBrains Mono |
| Charts | Chart.js + react-chartjs-2 (+ zoom plugin) |
| Realtime | Socket.IO (client + server) |
| Backend | Node.js + Express (ESM, `"type": "module"`) |
| Auth | Google OAuth 2.0 / OIDC (`google-auth-library`) + JWT |
| Databases | mysql2 · @influxdata/influxdb-client |
| Polling | net-snmp (IF-MIB / UPS-MIB) · node-routeros (RouterOS API) |
| Email | nodemailer over SMTP |
| Reports | pdfkit |
| Agent | Go + gopsutil |
| Firmware | ESP32 (Arduino) — DHT11, 2× MQ-2, IR TX ×2, WS2812B, DS3231 |

---

## Documentation index

| Document | Covers |
|----------|--------|
| [`CLAUDE.md`](CLAUDE.md) | Full architecture reference + every env var |
| [`deployment-guide.md`](deployment-guide.md) | On-prem campus deployment, nginx, HTTPS |
| [`google-oauth.md`](google-oauth.md) | OAuth setup, domain gate, approval flow |
| [`server-metrics.md`](server-metrics.md) | Go agent pipeline, offline windows |
| [`router-ups-monitoring.md`](router-ups-monitoring.md) | SNMP poller design |
| [`mikrotik-monitoring.md`](mikrotik-monitoring.md) | RouterOS API integration |
| [`email-popup-notifications.md`](email-popup-notifications.md) | Alerting + notification pipeline |
| [`report-page.md`](report-page.md) | Report generation and storage |
| [`backup-storage.md`](backup-storage.md) | On-site + offsite backup strategy |
| [`Environment.md`](Environment.md) | ESP32 sensor pipeline |
| [`SESSION_NOTES.md`](SESSION_NOTES.md) | Per-session development log |

**On the feature branches only** (not present on `main` — check out the branch to read them):

| Document | Branch | Covers |
|----------|--------|--------|
| `predictive-analytics.md` | `predictive-analytics` | Forecasting blueprint + the math, taught from scratch |
| `predictive-analytics-study-guide.md` | `predictive-analytics` | Study/defense companion |
| `analytics-regression-example.html` | `predictive-analytics` | Standalone disk-full ETA regression walkthrough |
| `pip-widget.md` | `pip-widget` | PiP architecture, tile catalog, phased build log |
