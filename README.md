# CSPC-ICTU · Server Infrastructure Monitoring & Control System

Server-room monitoring for the CSPC ICT Unit. Collects **environment** (temperature,
humidity, gas), **server** (CPU/memory/disk/network), **network** (router interfaces,
MikroTik) and **UPS** (battery, runtime, load) telemetry, raises configurable alerts to a
bell feed + email, forecasts what is about to break (disk full, UPS battery, link
saturation), and controls the room's air conditioners over IR.

> **Detailed docs live in separate files** — this README is the map. See
> [`CLAUDE.md`](CLAUDE.md) for the full architecture reference,
> [`DOCUMENTATION.md`](DOCUMENTATION.md), and the per-feature guides listed in
> [Documentation index](#documentation-index).

---

## Data sources

Four collectors converge on one alerting pipeline:

| Source | Direction | Transport | Cadence |
|--------|-----------|-----------|---------|
| **ESP32** (DHT22 + MQ-2 ×4 channels, 2 wired + IR TX + RGB LED) | push | Socket.IO | ~3 s (stored ~30 s — see below) |
| **Go agents** (one per monitored server) | push | HTTP POST | ~10 s (per-agent) |
| **SNMP poller** (routers via IF-MIB, UPS via UPS-MIB) | pull | SNMP v2c | 60 s |
| **MikroTik poller** (campus router) | pull | RouterOS API | 30 s |

> **Sampling rate and storage rate are separate for the ESP32.** Every 3 s reading is
> validated, broadcast to the dashboards and evaluated against the alert rules — the live
> view and alerting are unchanged. Only *storage* is throttled: a ~30 s heartbeat plus an
> immediate write whenever a gas reading moves past its deadband, a status band changes, or
> temperature/humidity actually shifts. The DHT22 resolves 0.1 °C and a server room does not
> move measurably in three seconds, so storing every reading was recording sensor noise;
> smoke keeps 3 s effective resolution because a real rise trips the deadband on the tick
> that sees it. Tunable via `ENV_PERSIST_*` in `backend/.env`, `0` restores per-reading
> storage. See `backend/services/envPersistPolicy.js`.

---

## Project structure

```
├── backend/                          ← Node.js + Express (ESM) + Socket.IO
│   ├── src/server.js                 ← entry point (routes, sweeps, pollers, retention)
│   ├── config/                       ← env.js, mysql.js (pool), influx.js (read+write)
│   ├── routes/                       ← one file per resource, mounted at /api/<resource>
│   ├── services/                     ← business logic (see "Key services" below)
│   ├── handlers/                     ← ingest + history: sensor, serverMetrics, network, ups
│   ├── middleware/                   ← auth.js (JWT + requireRole + policy gate),
│   │                                   agentAuth.js (AGT- tokens), securityHeaders.js
│   ├── sockets/connectionHandler.js  ← all socket events, device vs browser segregation
│   ├── utils/                        ← asyncHandler.js, httpError.js, logSafe.js
│   ├── tests/                        ← `npm test` — node --test, no MySQL/InfluxDB needed
│   ├── scripts/                      ← probe · link:check · analytics:check · rekey · mail:check
│   ├── assets/branding/              ← bundled letterhead marks (committed fallback)
│   ├── branding/                     ← uploaded logos (gitignored, runtime data)
│   ├── reports/                      ← generated CSV/PDF (gitignored)
│   └── backups/                      ← default BACKUP_DIR (gitignored)
│
├── frontend/                         ← React 18 + TypeScript + Vite + Tailwind
│   └── src/
│       ├── App.tsx                   ← route tree + ProtectedRoute + the public /privacy page
│       ├── config.ts · branding.ts   ← backend URL (auto-detects host:3000) + UI naming
│       ├── api/{client.ts,api.ts}    ← Axios instance + all calls (ApiResult<T>)
│       ├── context/                  ← Auth, Theme, Notification
│       ├── pip/                      ← pop-out live widget: host, context, tiles, builder
│       ├── socket/socket.ts          ← shared Socket.IO client (autoConnect: false)
│       ├── chart/ChartConfig.ts      ← one-time Chart.js registration
│       ├── hooks/ · utils/ · data/   ← room thresholds, colour helpers, roleConfig
│       ├── components/               ← dashboard/ devices/ environment/ landing/ layout/
│       │                               legal/ notifications/ servers/ session/ ui/
│       └── pages/                    ← one file per page (auth/ and legal/ nested)
│
├── agent/                            ← standalone Go agent (enroll → approve → POST metrics)
├── iot/esp32/env_monitor_v2/env_monitor_v2.ino      ← firmware (active)
├── ops/                              ← db-backup, offsite-backup (rclone), systemd, stress-test
├── dev-snmpsim/                      ← SNMP simulator for local router/UPS testing
├── migrations/                       ← dated SQL, all folded into v13 (for existing databases)
├── audits/                           ← security, authorization and architecture audits
├── docs/dfd/                         ← data-flow diagrams
├── v13_cspc-ictu-monitoring-system.sql ← full schema (single file, no migration chain)
└── cspc-ictu-monitoring-system.mwb     ← MySQL Workbench EER model (the ER DIAGRAM)
```

> ⚠️ **The `.mwb` is documentation, not the schema source of truth** — that is
> `v13_cspc-ictu-monitoring-system.sql`. Never forward-engineer a deployment schema from
> the model: it was untracked once (`dbc0177`) precisely because a stale copy was used that
> way and produced a database missing eight migrations. It is current as of v13 (24 tables,
> 24 figures, 30 relationships). **Apply every future schema change to the SQL first, then
> back to the model**, or untrack it again rather than let it drift. A migration under
> `migrations/` that is not also folded into v13 is missing from every fresh install.

### Key services

| Service | Responsibility |
|---------|----------------|
| `alertRulesService` | configurable thresholds (`alert_rules`) + hysteresis-aware `nextBand()` |
| `alertBandState` | per-(device, metric) severity band; onset-only escalation + recovery confirmation |
| `notificationService` | `raiseAlert()` → dedup → `alerts` row → per-user fan-out → socket + email |
| `alertsService` | shared alert lifecycle (acknowledge/resolve/auto-resolve) |
| `deviceAlerts` | router/UPS/MikroTik threshold + event alerting (shared by both pollers) |
| `linkAlertPolicy` | when a port with no carrier is a **fault** rather than an empty socket |
| `agentService` | Go-agent enrollment, heartbeat, offline sweep, server threshold checks |
| `installKeyService` | `AIK-` enrollment keys: mint, reveal, revoke, and what each key enrolled |
| `snmpPollerService` / `mikrotikPollerService` | the two pull-based collectors |
| `icmpPing` / `pingOutput` | the ICMP half — latency and packet loss, which SNMP structurally cannot report |
| `deviceProbe` / `deviceProbeVerdict` | can this device be monitored, and how — behind both **Test connection** and `npm run probe` |
| `envPersistPolicy` | when an ESP32 reading is worth **storing** (as opposed to acting on) |
| `backupService` | on-site NDJSON mirror of every sample + integrity manifest |
| `reportService` / `reportRenderer` / `reportTemplate` | async report build → CSV + PDF, and how they look |
| `reportBrandingService` | letterhead, paper size, signatories, uploaded logos |
| `availabilityMath` | uptime/downtime/incidents for the Server Availability section — from `alerts`, not the agent's reboot counter |
| `analyticsService` / `analyticsMath` | forecasts, anomalies, recommendations (I/O half + pure math) |
| `analyticsAlerts` | the every-6-h job that turns a forecast into a real alert |
| `googleAuthService` | Google OAuth code exchange, domain gate, login-or-create-pending |
| `policyService` | Privacy Notice acceptance + the audit row that **is** the evidence |
| `socketSessions` | re-validates connected sockets, so revoking an account also cuts its live stream |
| `secretCrypto` / `mikrotikCrypto` / `communityCrypto` | AES-256-GCM for the secrets that must be read back, not merely verified |

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
| `DEVICE_SECRET` | ESP32 socket auth — must match the firmware constant. **Validated at boot**: the backend refuses to start on a value known to have been published, or on anything under 24 chars |
| `AGENT_INSTALL_KEY` | *deprecated* — bootstrap fallback only. Enrollment keys are minted on **Server Metrics → Agent install keys**; blank this once you have one |
| `MIKROTIK_ENC_KEY` | **required for MikroTik** — 64 hex chars, AES-256-GCM of the stored RouterOS password |
| `SECRET_ENC_KEY` | 64 hex chars for every other secret read back rather than verified (install keys, agent tokens, SNMP communities); blank falls back to `MIKROTIK_ENC_KEY` |
| `TRUST_PROXY` | how many proxy hops may be believed when they claim a client address; blank = 2. A security control — set 0 when nothing is in front |
| `SESSION_MAX_HOURS` | ceiling on one sign-in; blank = 12 |
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

Includes `contract.test.js`, which parses `agent/internal/collector/metrics.go` and fails
if its JSON tags drift from the backend's validator.

### Operational scripts

Each of these answers a question the dashboard cannot, usually because the healthy answer
and the broken answer look identical from outside.

```bash
cd backend
npm run probe -- <ip> [community] [port]   # can this device be monitored, and HOW? Run it
                                           # BEFORE registering anything. Same code as the
                                           # Test connection button; replaces snmpwalk,
                                           # which does not ship with Windows
npm run link:check                         # per-port interface-down verdict for every
                                           # MikroTik — WHY each port is alerting or silent
npm run analytics:check                    # DRY RUN of the predictive-alerting job: what it
                                           # WOULD raise. Raises nothing
npm run rekey                              # which secrets at rest are encrypted, which are
                                           # still readable. `-- --encrypt-plaintext`
                                           # encrypts the stragglers; `-- --from-key <old>
                                           # --apply` rotates the encryption key
npm run mail:check [recipient]             # verify the SMTP credentials actually send
```

> `npm run rekey` is the rotation path that did not used to exist. Stop the backend and back
> up the database first; it is a dry run unless you pass `--apply`.

---

## Authentication

**Google OAuth (OIDC) only — the password login was removed.** The dashboard runs the
authorization-code flow and posts a one-time code to `POST /api/auth/google`; the backend
exchanges it server-side, verifies the ID token, enforces the CSPC domains
(`@cspc.edu.ph` / `@my.cspc.edu.ph`), then issues a 1 h JWT.

New accounts self-register as `pending`; an admin approves or rejects them from **User
Management**, and **both outcomes email the person** — until that existed an approved user
had no way to find out. JWTs carry a `tv` (token_version) claim, so logout, disable and
role change revoke active sessions server-side, and a sweep re-validates connected sockets
every 30 s so a disabled account's open dashboard stops streaming too. The session slides
(the token is re-issued past its half-life) but is **bounded**: `SESSION_MAX_HOURS`
(blank = 12) caps one sign-in, measured from the `ist` claim, so a renewed — or stolen —
token cannot live forever. Full guide: [`google-oauth.md`](google-oauth.md).

**The Privacy Notice & Terms is a blocking gate after sign-in**, not a login checkbox:
before the Google round-trip nobody has identified themselves, so a checkbox there could
not be attributed to a person. `AppShell` renders the gate *instead of* the dashboard until
the user's accepted version matches the one in force, and the server enforces the same
thing on **mutating** requests (403 `policy_not_accepted`) — a client-side gate never
decided what the token could do. The document lives in one component, rendered by both the
gate and the public `/privacy` page, because the text someone agrees to must be the text
anyone can read without an account. Full guide: [`privacy-policy.md`](privacy-policy.md).

---

## API endpoints

All routes require a Bearer JWT unless marked otherwise. Roles: **A** = admin,
**S** = it_staff. Mutating requests (POST/PUT/PATCH/DELETE) additionally require the
signed-in user to have accepted the current Privacy Notice, or they answer **403
`policy_not_accepted`** — `/api/policy/*` and `/api/auth/*` are exempt, or accepting would
be impossible.

### Auth & policy
| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| POST | `/api/auth/google` | public | Exchange Google auth code → JWT session |
| GET | `/api/auth/me` | A S | Current authenticated user |
| POST | `/api/auth/logout` | A S | Log out (bumps token_version) |
| GET | `/api/policy/version` | public | Privacy Notice version in force — so `/privacy` can stamp itself without an account |
| POST | `/api/policy/accept` | A S | Record acceptance + the `system_logs` evidence row (one transaction) |

### Users
| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| GET | `/api/users` | A | List users |
| GET | `/api/users/pending` | A | Pending registrations |
| GET | `/api/users/:id` | A | Get one user |
| PATCH | `/api/users/:id` | A | Update username / role / status |
| PATCH | `/api/users/:id/status` | A | Enable or disable an account |
| POST | `/api/users/:id/approve` | A | Approve a pending registration (emails the user) |
| POST | `/api/users/:id/reject` | A | Reject a pending registration (emails the user) |
| DELETE | `/api/users/:id` | A | Delete a user |
| PATCH | `/api/users/me` | A S | Update own profile (**username only**) |

> There is no create-user and no change-password endpoint. Both were **removed** — login is
> Google-only, every `hash_password` is NULL, and a live auth route nobody calls or tests is
> where a real vulnerability survives. Accounts arrive by exactly one route: Google
> self-registration → admin approval.

### Servers & agents
| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| POST | `/api/agents/register` | install key | First-run agent enrollment (rate-limited) |
| POST | `/api/agents/status` | pending token (body) | Agent polls until approved |
| GET | `/api/agents/pending` | A | Enrollments awaiting approval |
| POST | `/api/agents/:id/approve` \| `/reject` | A | Approve / reject an agent |
| GET | `/api/agents/install-keys` | A | List enrollment keys (prefix only — the key itself is hashed) |
| POST | `/api/agents/install-keys` | A | Mint a key; the plaintext is returned **once** |
| GET | `/api/agents/install-keys/:id/reveal` | A | Show a key again (decrypts `key_cipher`; **audited**) |
| GET | `/api/agents/install-keys/:id/servers` | A | Servers this key enrolled that are still reporting |
| POST | `/api/agents/install-keys/:id/revoke` | A | Withdraw a key; `{revokeAgents:true}` also stops the servers it enrolled |
| DELETE | `/api/agents/install-keys/:id` | A | Remove a **revoked** key from the list (400 while still active) |
| POST | `/api/servers/metrics` | agent token | Live metric ingest |
| POST | `/api/servers/metrics/batch` | agent token | Backfill of buffered samples |
| GET | `/api/servers` | A S | All servers with live metrics |
| GET | `/api/servers/:id` | A S | One server + specs |
| GET | `/api/servers/:id/history` | A S | Time-series (presets or `?start=&stop=`) |
| GET | `/api/servers/:id/logs` | A S | Device event log |
| PATCH | `/api/servers/:id` | A | Set / clear the display label (`devices.display_name`) |
| POST | `/api/servers/:id/maintenance` | A | Park / resume for planned downtime |
| DELETE | `/api/servers/:id` | A | Decommission (revokes the agent token) |

### Network, MikroTik & UPS
| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| GET | `/api/network` · `/api/ups` · `/api/mikrotik` | A S | List devices with live values |
| POST | `/api/network/test` · `/api/ups/test` | A | **Test connection** before registering — ping, then MIB-II / IF-MIB / UPS-MIB asked independently, then a verdict naming the form to use |
| POST | `/api/network` · `/api/ups` · `/api/mikrotik` | A | Register a device |
| DELETE | `/api/{network,ups,mikrotik}/:id` | A | Decommission |
| GET | `/api/{network,ups,mikrotik}/:id/history` | A S | Time-series |
| GET | `/api/{network,ups,mikrotik}/:id/logs` | A S | Device event log |
| PATCH | `/api/network/:id/interfaces` | A | Set a port's location label |
| GET/PUT | `/api/mikrotik/:id/interfaces` | A S / A | Read / save port labels |
| PUT | `/api/mikrotik/:id/connection` | A | Save API credentials (password encrypted) |
| POST | `/api/mikrotik/test` · `/:id/test` | A | Test a RouterOS connection before saving |

> The two test routes and `npm run probe` are one implementation
> (`backend/services/deviceProbe.js`) on purpose — a probe that disagreed with the form
> would be worse than no probe. A router registered with a **blank** community is monitored
> by ICMP only (up/down, latency, packet loss — no interfaces), which is the only way to
> watch ISP-owned CPE. A UPS has no ping-only mode: pinging a battery only proves its
> management card has power.

### Environment, gas sensors & aircon
| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| GET | `/api/environment/daily` | A S | Per-day summary from InfluxDB |
| GET | `/api/environment/sensor-status` | A S | ESP32 liveness |
| GET | `/api/environment/thresholds` | A S | Room-level alert thresholds — what the dashboards colour temperature, humidity and gas against |
| POST | `/api/environment/calibrate-gas` | A | Ask the ESP32 to re-measure the MQ-2 clean-air baseline |
| GET | `/api/gas-sensors` | A S | The four MQ-2 channels — which are wired, and each one's label |
| PATCH | `/api/gas-sensors/:channel` | A | Label / enable a channel (pushes `gasConfig` to the ESP32) |
| GET | `/api/aircon` | A S | AC units + state |
| GET | `/api/aircon/ir-config` · PUT | A S / A | Auto-cooling IR zone thresholds |
| POST | `/api/aircon` | A S | Register an AC unit |
| PATCH | `/api/aircon/:id/toggle` · `/name` | A S | Toggle power / rename |
| DELETE | `/api/aircon/:id` | A | Remove an AC unit |

### Alerts, rules & notifications
| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| GET | `/api/alerts` | A S | Alert history (`?status=`) |
| GET | `/api/alerts/count` | A S | Open-alert count → sidebar badge |
| POST | `/api/alerts/:id/acknowledge` · `/resolve` | A S | Lifecycle transitions |
| GET/POST/PUT/DELETE | `/api/alert-rules` | A | Configurable threshold CRUD |
| GET | `/api/notifications` | A S | Per-user bell feed |
| POST | `/api/notifications/read` · `/clear` | A S | Mark read / dismiss |
| GET/PUT | `/api/notifications/prefs` | A S | Per-user email + popup preferences |

### Reports
| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| GET | `/api/reports` | A S | List reports (shared across users) |
| GET | `/api/reports/scope-options` | A S | Devices a report type can scope to |
| POST | `/api/reports` | A S | Generate (async — returns 202) |
| GET | `/api/reports/:id/download?format=csv\|pdf` | A S | Download a saved file |
| POST | `/api/reports/:id/email` | A S | Email the PDF |
| DELETE | `/api/reports/:id` | A | Delete row + files |
| GET | `/api/reports/template` | A S | Letterhead, default paper size, signatories, logos — the Generate modal needs the size options |
| PUT | `/api/reports/template/paper-size` | A | Default paper size (**folio, 8.5×13in** — not A4, not US Legal) |
| PUT | `/api/reports/template/unit-name` | A | Letterhead unit line |
| PUT | `/api/reports/template/signatories` | A | Prepared by / Noted by / Approved by |
| POST | `/api/reports/template/logo/:slot` | A | Upload a logo — **raw** image body, and the leading bytes decide what the file is |
| DELETE | `/api/reports/template/logo/:slot` | A | Revert a slot to the bundled mark |

### Analytics, history & widget layout
| Method | Endpoint | Role | Description |
|--------|----------|------|-------------|
| GET | `/api/analytics/forecast/disk` · `/disk/:id` | A S | Disk-full ETA, fleet-wide or per server |
| GET | `/api/analytics/forecast/ups-battery` | A S | Battery-replacement ETA from runtime decay |
| GET | `/api/analytics/forecast/link-saturation` | A S | Uplink-saturation ETA from utilization |
| GET | `/api/analytics/trends/:metric` | A S | Holt-Winters projection with a per-hour table |
| GET | `/api/analytics/anomalies` | A S | Outlier readings vs the metric's own baseline |
| GET | `/api/analytics/recommendations` | A S | Suggested warn/crit thresholds (admin can apply) |
| GET | `/api/analytics/accuracy` | A S | Rolling-origin backtest — how far off past forecasts actually were |
| GET | `/api/analytics/alerts/summary` | A S | Alert-volume analytics, MTTR |
| GET | `/api/history` · `/api/history/actors` | A S | Audit trail (`system_logs`) |
| GET/PUT | `/api/widget-layout` | A S | This user's pop-out widget tiles (unknown/duplicate ids dropped server-side) |

> `alertRules`, `alerts`, `analytics` and `history` gate at `router.use(...)` rather than
> per route, so a new route added to those files inherits the guard — and a per-route grep
> will wrongly report them as open.

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
| Analytics | ✅ | ✅ |
| History & Logs | ✅ | ✅ |
| Reports | ✅ | ✅ |
| Settings | ✅ | ✅ |
| User Management | ✅ | ❌ |
| Alert Rules | ✅ | ❌ |

Source of truth: `frontend/src/data/users.ts` (`roleConfig`) and `requireRole(...)` on
each route.

---

## Predictive analytics

Turns the collected time-series into **foresight** instead of only reactive threshold
alerts. Pure Node, no Python service, fully explainable. Page: **Analytics**
(`frontend/src/pages/Analytics.tsx`), available to **both roles**.

| Technique | Used for | Kind |
|-----------|----------|------|
| **Linear regression** (chronological train/test split, R² + MAE) | **disk-full ETA** — "Server X hits 100% in ~9 days" — plus UPS battery and link saturation | genuinely ML |
| Additive Holt-Winters (daily hour-of-day shape + Holt drift) | short-horizon metric trends | statistics |
| Per-hour-of-day z-score + global IQR fences | anomaly detection | statistics |
| p50 / p95 / p99 | threshold recommendations vs current `alert_rules` | statistics |
| Rolling-origin backtest | forecast accuracy — how far off past forecasts actually were | evaluation |

> **Honesty note for a defense:** linear regression *is* supervised ML. Holt-Winters, EWMA
> and z-score are statistics, not ML. Say it that way — `predictive-analytics.md` is
> explicit about not overselling this.

Four lazy-loaded tabs — **Forecasts**, **Trends & Anomalies**, **Alerts**,
**Recommendations** — over temperature, humidity, gas, CPU, memory, disk, MikroTik
CPU/memory/clients and ICMP latency/packet loss. An admin can push a p95/p99
recommendation straight into `alert_rules`.

A **background job** (`services/analyticsAlerts.js`, every `ANALYTICS_ALERT_INTERVAL_H`
hours) raises real alerts from the same forecasts — a disk ETA inside
`ANALYTICS_ALERT_CRITICAL_DAYS` pages someone before the disk is full. It correctly raises
nothing on a healthy system, so `npm run analytics:check` exists to dry-run it and print
what it *would* raise.

> **Caveat:** the UPS and link forecasts are dev-verified against
> `backend/scripts/seed-analytics-history.js` (synthetic trending data on device ids
> 9001/9002/9101) because `dev-snmpsim` emits flat values and forecasting needs weeks of
> slope. Real ETAs need real history.

Full guide: [`predictive-analytics.md`](predictive-analytics.md) (math §2–§4, device
identity §14, tests §15, accuracy §17) + the
[study guide](predictive-analytics-study-guide.md).

---

## Pop-out live widget

A floating always-on-top window — the kind Google Meet pops out — showing a compact,
**user-customizable** live status panel while working in other apps. Uses the **Document
Picture-in-Picture API** (arbitrary DOM, unlike the video-only PiP API), so it is
**Chromium-only** and must be opened by a user gesture.

The key design move: the widget is `createPortal`'d into `pipWindow.document.body` and stays
part of the **main app's React tree** — so `AuthContext`, `NotificationContext`, the shared
socket and theme all work for free. Only CSS doesn't cross the document boundary and must be
cloned in. `AuthContext`'s "watching" check treats an open PiP window as active, so popping
out a tile keeps you signed in.

**Tiles** (`frontend/src/pip/tiles/catalog.tsx`) — temperature, humidity, gas, servers
summary, server list, UPS battery, UPS list, network ports, router list, open alerts,
latest alert, aircon, clock — arranged by drag-and-drop (`@dnd-kit`) in a builder on
**Settings**, with a live preview. Layout persists per user in `widget_prefs`; without
that row it falls back to a localStorage cache that doesn't sync across devices.

Full guide: [`pip-widget.md`](pip-widget.md).

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
| Report letterhead (paper size, unit line, signatories, logos) | MySQL `settings` + uploaded files under `backend/branding/` |

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + TypeScript + Vite |
| Styling | Tailwind CSS v3 · Grafana `--gf-*` design tokens · JetBrains Mono |
| Charts | Chart.js + react-chartjs-2 (no zoom plugin — the range picker owns the window) |
| Realtime | Socket.IO (client + server) |
| Backend | Node.js + Express (ESM, `"type": "module"`) |
| Auth | Google OAuth 2.0 / OIDC (`google-auth-library`) + JWT |
| Databases | mysql2 · @influxdata/influxdb-client |
| Polling | net-snmp (IF-MIB / UPS-MIB) · node-routeros (RouterOS API) |
| Email | nodemailer over SMTP |
| Reports | pdfkit |
| Agent | Go + gopsutil |
| Firmware | ESP32 (Arduino) — DHT22, MQ-2 ×4 channels (2 wired), IR TX ×2, WS2812B, DS3231, micro SD |

---

## Documentation index

| Document | Covers |
|----------|--------|
| [`CLAUDE.md`](CLAUDE.md) | Full architecture reference + every env var |
| [`DOCUMENTATION.md`](DOCUMENTATION.md) | Long-form system documentation |
| [`deployment-guide.md`](deployment-guide.md) | On-prem campus deployment, nginx, HTTPS |
| [`google-oauth.md`](google-oauth.md) | OAuth setup, domain gate, approval flow |
| [`privacy-policy.md`](privacy-policy.md) | Privacy Notice & Terms, the acceptance gate, RA 10173 |
| [`server-metrics.md`](server-metrics.md) | Go agent pipeline, offline windows |
| [`router-ups-monitoring.md`](router-ups-monitoring.md) | SNMP poller design |
| [`mikrotik-monitoring.md`](mikrotik-monitoring.md) | RouterOS API integration |
| [`email-popup-notifications.md`](email-popup-notifications.md) | Alerting + notification pipeline |
| [`report-page.md`](report-page.md) | Report generation, storage, and the ICTU template |
| [`predictive-analytics.md`](predictive-analytics.md) | Forecasting blueprint + the math, taught from scratch |
| [`predictive-analytics-study-guide.md`](predictive-analytics-study-guide.md) | Study / defense companion |
| [`pip-widget.md`](pip-widget.md) | PiP architecture, tile catalog, phased build log |
| [`backup-storage.md`](backup-storage.md) | On-site + offsite backup strategy |
| [`Environment.md`](Environment.md) | ESP32 sensor pipeline |
| [`esp32-wifi-provisioning.md`](esp32-wifi-provisioning.md) | Captive-portal WiFi setup for the firmware |
| [`cloudflare-tunnel-setup.md`](cloudflare-tunnel-setup.md) | Reaching the dashboard over HTTPS before the campus hostname exists |
| [`agent-vm-testing.md`](agent-vm-testing.md) | Host-only VM networking for agent testing |
| [`erd-update-guide.md`](erd-update-guide.md) | Keeping the `.mwb` model in step with the SQL |
| [`docs/dfd/`](docs/dfd/) | Data-flow diagrams |
| [`audits/`](audits/) | Security, authorization and architecture audits |
| [`SESSION_NOTES.md`](SESSION_NOTES.md) | Per-session development log |
