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
npm test                # node --test — pure unit tests, no MySQL/InfluxDB needed
npm run link:check      # per-port interface-down verdict for every MikroTik — prints WHY each
                        # port is alerting or silent (empty socket / disabled / muted / down).
                        # Link alerting is mostly silence by design, so "broken" and "nothing
                        # to report" look identical without this.
npm run analytics:check # DRY RUN of the predictive-alerting job — prints what it WOULD raise, raises nothing.
                        # The job runs every 6h and correctly raises nothing on a healthy system, which makes
                        # "alerting is broken" and "nothing to alert about" look identical. This tells them apart.
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
SERVER_OFFLINE_AFTER_SEC= # FLOOR for the per-agent offline window; blank = 30. The real window is max(this, agent's reported interval x 3), capped at 1h — so a `-interval 60` agent no longer flaps Offline. See server-metrics.md §4.3
SNMP_POLL_INTERVAL_MS= # router/UPS SNMP poll cadence; blank = 60000 (60s). Per-device community/port live in device_network, not here
MIKROTIK_ENC_KEY=      # ⚠️ REQUIRED for MikroTik. 64 hex chars (32 bytes) for AES-256-GCM of mikrotik_devices.api_password. Saving credentials THROWS without it. Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
MIKROTIK_POLL_INTERVAL_MS= # RouterOS API poll cadence; blank = 30000 (30s). Lighter than SNMP walks, so 10-15s is fine for one router
MIKROTIK_API_TIMEOUT_MS=   # per-call connect/read timeout; blank = 5000
MIKROTIK_TLS_VERIFY=       # true = verify the router's certificate when use_tls is on. Blank/false = encrypted but unverified (RouterOS ships a SELF-SIGNED cert, so strict verification fails on a stock router)
MIKROTIK_TLS_CA=           # optional path to a CA file, used only when MIKROTIK_TLS_VERIFY=true
BACKUP_ENABLED=        # false disables the on-site NDJSON backup writer; blank = enabled. See backup-storage.md
BACKUP_DIR=            # where the NDJSON/dump files land (micro SD / USB drive); blank = backend/backups
BACKUP_FLUSH_MS=       # buffered-write flush interval; blank = 5000. Larger = kinder to flash endurance, larger worst-case loss on a hard cut
BACKUP_RETENTION_DAYS= # dated backup files older than this are purged daily; blank = 30
BACKUP_OFFSITE_ENABLED=      # true turns on the offsite-staleness check (reads a local marker only, no cloud dependency); blank = off
BACKUP_OFFSITE_MARKER=       # path the rclone job stamps on each successful upload; blank = <BACKUP_DIR>/.last_offsite_sync
BACKUP_OFFSITE_MAX_AGE_HOURS= # warn if no successful offsite sync within this many hours; blank = 26
WEB_ORIGIN=        # allowed dashboard origins, comma-separated — or * for any (roaming LAN); blank = localhost+LAN default
GOOGLE_CLIENT_ID=       # Google OAuth web client ID (public). Login verifies ID tokens against it. Must match frontend VITE_GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=   # Google OAuth web client SECRET. Required: the auth-code flow exchanges the code server-side
GOOGLE_ALLOWED_DOMAINS= # comma-separated CSPC domains allowed to sign in; blank = cspc.edu.ph,my.cspc.edu.ph
SMTP_HOST=              # alert/report email over SMTP; blank = smtp.gmail.com. See email-popup-notifications.md §8
SMTP_PORT=              # 587 (STARTTLS) or 465 (implicit TLS); blank = 587
SMTP_USER=              # FULL mailbox address. Dev: your own Gmail/CSPC account. Prod: ICTU's ictusupport@cspc.edu.ph. BLANK = email channel off (bell + toast still work)
SMTP_PASS=              # 16-char Google App Password, NOT the account password (needs 2-Step Verification on the account). Spaces are stripped automatically. ⚠️ Revoked when the account's main password changes
MAIL_FROM=              # "Name <addr@domain>"; blank = SMTP_USER. Sets the DISPLAY NAME — Gmail rewrites the address to the authenticated mailbox unless it's a verified "Send mail as" alias
NOTIFY_EMAIL_MIN_SEVERITY= # min severity that triggers an email: info|warning|critical; blank = critical. Per-user override in notification_prefs
NOTIFY_EMAIL_TO=        # optional: force ALL alert emails to this address (testing); blank = send to each active user's real email
NOTIFY_COOLDOWN_MIN=    # de-dup window in minutes — same device+type+severity won't re-alert within it (restart-proof); blank = 30
ALERT_RECOVERY_SAMPLES= # consecutive "normal" readings required before an alert AUTO-RESOLVES; blank = 3. Stops a metric oscillating around its threshold from producing an alert/resolve storm. Escalation is unaffected (still instant). Applies to servers, the environment, AND routers/MikroTik/UPS (deviceAlerts evalMetric + evalEvent — the boolean events too, since a link up/down has no threshold to hang hysteresis on). ⚠️ Counts SAMPLES, not seconds — wall-clock = count x that source's interval: ~30s for a default Go agent (`-interval 10`, but it's per-agent, so an `-interval 60` server takes 3 MINUTES), ~9s for the ESP32 (`LOG_INTERVAL 3000`), ~3 min on the 60s SNMP poll, ~1.5 min on the 30s MikroTik poll. Device offline/unreachable (`device_offline`) is NOT streak-gated — the poller's own status transition guards it, so an outage still surfaces on the first failed poll. See alertBandState.confirmRecovery
ANALYTICS_ALERT_INTERVAL_H=   # how often the PREDICTIVE alerting job runs, in hours; blank = 6. Each pass is several Flux queries over weeks of history, so this is deliberately slow — a multi-week regression doesn't move between two agent posts. See services/analyticsAlerts.js
ANALYTICS_ALERT_CRITICAL_DAYS= # forecast ETA at/below this many days raises a CRITICAL alert; blank = 7
ANALYTICS_ALERT_WARNING_DAYS=  # ETA at/below this raises a WARNING; beyond it nothing is raised (nothing to act on yet); blank = 30
ANALYTICS_ALERT_COOLDOWN_MIN=  # de-dup window for FORECAST alerts specifically; blank = 1440 (24h). The 30-min NOTIFY_COOLDOWN_MIN default suits a live metric flapping at a threshold, not a projection that moves over days
ANALYTICS_ALERT_DISK_DAYS=     # lookback for the alerting job's disk forecast; blank = 30
ANALYTICS_ALERT_LINK_DAYS=     # lookback for link saturation; blank = 90
ANALYTICS_ALERT_UPS_DAYS=      # lookback for UPS battery; blank = 180 (battery ageing needs months — see predictive-analytics.md §16.1)
ANALYTICS_ANOMALY_ALERTS=      # false disables anomaly ALERTS (the Analytics page still shows them); blank = enabled
ANALYTICS_ANOMALY_DAYS=        # baseline window for the alerting job's anomaly scan; blank = 14
AIRCON_MAX_IR_CHANNELS= # fallback IR-channel count used ONLY while the ESP32 has never connected; blank = 2. Normally the limit comes from the device itself — the ESP32 reports its pin pool on connect (sendChannelMap), so adding an AC unit is wiring a transmitter + registering it, with no constant to edit
NOTIFY_RETENTION_DAYS=  # alerts older than this are purged daily (feed rows cascade); blank = 30
REPORT_RETENTION_DAYS=  # generated reports older than this are purged daily — MySQL row AND both files under backend/reports/; blank = 90. Longer than the alerts default on purpose: a report is an artifact someone deliberately generated. See report-page.md
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
Three ingest paths: ESP32 (push, Socket.IO), Go agents (push, HTTP), and an SNMP
poller (**pull** — routers via IF-MIB, UPS via UPS-MIB). See `router-ups-monitoring.md`.

### Tech Stack
- **Backend:** Node.js + Express (ESM, `"type": "module"`), Socket.IO, mysql2, @influxdata/influxdb-client, nodemailer (alert/report email over SMTP), net-snmp
- **Frontend:** React 18 + TypeScript + Vite + Tailwind CSS, JetBrains Mono font
- **Database:** MySQL (users, devices, aircon, agent tokens, logs) + InfluxDB (environment, server-metric, **and** router/UPS time-series)
- **Hardware:** ESP32, DHT11, MQ-2 ×2, passive piezo buzzer, WS2812B RGB LED ×20, IR TX ×2 (GPIO 25/33), DS3231 RTC (optional)

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
  authService.js                ← JWT session issue (`issueSession`), `recordSignInDenied` audit, getMe/logout
  googleAuthService.js          ← Google OAuth login: code exchange → ID-token verify → domain gate → login-or-create-pending. See `google-oauth.md`
  googleDomain.js               ← PURE, dependency-free domain allow-list (domainOf/parseAllowedDomains/isAllowedDomain) — the CSPC sign-in gate, kept in one readable place
  userService.js                ← user CRUD + Google account matching (`findByGoogleSub` → `findByEmail`), `syncGoogleProfile`, pending approve/reject
  permissionService.js          ← static role-based permissions
  airconService.js              ← all aircon DB logic (getAll, toggle, applyAutoIR, etc.) + **configurable auto-cooling IR zone thresholds** (`aircon_ir_config`: getIRConfig/saveIRConfig/getDeviceIRConfig) pushed to the ESP32 via the `acConfig` socket event — sets WHEN IR fires (target temps per zone stay fixed = captured IR codes). See Air Conditioner System + `email-popup-notifications.md`
  agentService.js               ← Go-agent + server-device DB logic (devices + server_specs + device_network + agent_tokens); enroll/approve/reject, offline sweep, device_logs, **renameServer** (admin display label: `devices.display_name`, NULL = fall back to hostname; effective name = `COALESCE(display_name, device_name)`; migration `2026-06-18_server_display_name.sql`). `recordHeartbeat` **auto-resolves the open `offline` alert** on an offline→online transition (servers now match routers/UPS — see deviceAlerts.checkReachability). `checkThresholds` evaluates the `disk` rule against the **worst volume**, not the root. `setMaintenance(id, enabled)` parks a server for planned downtime (sweep skips it, thresholds suppressed, heartbeat won't clobber the status); `refreshHostInfo` is also called from the metric path so static facts don't freeze at enrollment. See `server-metrics.md`
  notificationService.js        ← raiseAlert() → de-dup cooldown (NOTIFY_COOLDOWN_MIN, restart-proof, **open-alert-scoped** — a resolved alert no longer suppresses, so recurrences re-alert) → writes `alerts` (incl. `alert_rule_id` when rule-driven) + fans out `alert_notifications` per active user + pushes `notification` to each user room + severity-gated email; listForUser/unreadCount/markRead. `init(io)` once at startup. Triggers: server CPU/mem/disk + **environment** temperature/gas/humidity (both via configurable `alert_rules` — see alertRulesService) + offline (not rule-based) + **online/reconnect** (info, raised on the first metric after a server was offline — auto-resolves the offline incident, then self-resolves since it's an event, not an open condition). See `email-popup-notifications.md`
  alertsService.js              ← alert LIFECYCLE (shared, not per-user): list/acknowledge/resolve/openCount + auto-resolve when a metric recovers (called from checkThresholds + sensorHandler); broadcasts `alertUpdated`; `init(io)` once. Backs the now-real `routes/alerts.js`. Distinct from the per-user bell (`alert_notifications.is_read`)
  alertRulesService.js          ← configurable alert thresholds (`alert_rules`). In-memory cache (reload on startup + every mutation) + `getEffectiveRules(deviceId, metric)` resolver (per-server override else global `device_id=NULL`) + `nextBand()` hysteresis-aware evaluation + admin CRUD. Rules-only: no matching rule = no alert. metric_name: cpu/mem/disk + temperature/gas/humidity + router_cpu/router_mem/router_clients/link_util/ups_charge/ups_runtime/ups_load (router/UPS/MikroTik, via deviceAlerts.js — the last two are lower-is-worse, use `<=`). See `email-popup-notifications.md`
  emailService.js               ← **SMTP (nodemailer)**: sendAlertEmail(to, alert) + sendReportEmail(to, report, pdfBuffer) (inline-styled HTML + plain-text alternative; the report one attaches the stored PDF as a Buffer) + verify()/close(). Sending from a mailbox ON the target domain means Google's existing SPF/DKIM already authorize it — **no DNS work to request from ICTU** — and it delivers to any recipient. Pooled connections (the per-user fan-out is concurrent). No-op if SMTP_USER/SMTP_PASS unset. NOTIFY_EMAIL_TO forces all mail to one address (testing). Check it with `npm run mail:check [recipient]`
  snmpClient.js                 ← thin net-snmp wrapper: standard OID maps (IF-MIB/UPS-MIB), v2c session, get/walkColumn, value normalize (Counter64→BigInt)
  snmpPollerService.js          ← router/UPS poll loop (load devices → SNMP collect → counter diff → handlers → status/threshold logs); + getNetworkDevices/getUpsDevices reads
  deviceAlerts.js               ← shared router/UPS/MikroTik threshold + event alerting (checkRouter/checkUps), called by the SNMP **and** MikroTik pollers. Evaluates metrics against configurable `alert_rules` (alertRulesService.nextBand, band tracked in alertBandState) → raises REAL alerts via notificationService.raiseAlert (bell/email/Alerts page) + device_logs; auto-resolves on recovery (alertsService). Boolean events (interface down, UPS on-battery, device offline/unreachable via checkReachability) raise directly like server offline. Replaced the old device-log-only poller checks. **Interface-down is gated by `linkAlertPolicy`** — see below
  alertBandState.js             ← in-memory per-(device,metric) severity band tracker shared by deviceAlerts (onset-only escalation + recovery)
  linkAlertPolicy.js            ← PURE, import-free rule for WHEN a port with no carrier is a FAULT. An empty socket is down forever and is not news, so four gates must all pass: `monitored` (admin's per-port opt-out, `network_interfaces.monitor_link`) + `adminUp` (not `disabled=yes` in RouterOS / ifAdminStatus≠down — a port switched off on purpose used to be the LOUDEST alert) + `linkUp === false` (an unknown is never escalated into an outage) + `everUp` (`network_interfaces.ever_up`, set by the pollers the first time the port carries a link). Replaces an in-memory first-sighting baseline whose outcome depended on what the cables were doing at backend start — that is why one empty port alerted and three identical ones didn't. Tested in `tests/linkAlertPolicy.test.js`; `npm run link:check` prints the live verdict per port. Migration `2026-08-09_link_alert_gate.sql`
  backupService.js              ← on-site backup writer: mirrors EVERY ingested sample (env/server/router/MikroTik/UPS) to rotating NDJSON files on `BACKUP_DIR` (a micro SD / USB drive on the backend) — an independent copy that survives a DB wipe + a power outage. Buffered flush + synchronous flush on shutdown (UPS low-battery SIGTERM) + daily retention purge. `init()` once at startup. See `backup-storage.md`
  reportService.js              ← REAL reports (MySQL `reports` + on-disk CSV/PDF per report under backend/reports/). **Async**: create() records a `pending` row (route answers 202), build() gathers the data live from InfluxDB (sensor_environment / server_metrics / router_metrics + network_traffic / ups_metrics) + MySQL (alerts / aircon_logs), writes both files, flips status → generated|failed and pushes `reportUpdated` to `user:<id>` (`init(io)` once at startup). build() NEVER throws — it runs fire-and-forget after the response. Types: environment|server|network|ups|alerts|aircon. **Per-device scope** via `device_id` (migration `2026-08-02_report_device_scope.sql`), gated by `SCOPE_TYPES` which also drives GET /scope-options; environment is campus-wide and rejects a scope. Also list/fileFor(download name = title + period)/remove/email(PDF via emailService)/purgeOld(REPORT_RETENTION_DAYS, row + files). Backs `routes/reports.js`. See `report-page.md`
  reportRenderer.js             ← turns a normalized report ({summary, table} or {summary, tables:[…]}) into CSV + PDF (pdfkit). Store-agnostic — layout only
  auditService.js               ← audit(): append a user action to `system_logs` (module: auth|aircon|users|alerts|reports|devices|network) — the trail the **History** page reads. Best-effort BY DESIGN: an audit-write failure never breaks the action. Report generate/download/email/delete all log here
  serverMetricUtils.js          ← PURE helpers for the server-metric path (NUMERIC_FIELDS, validateSample, sanitizeVolumes, sanitizeInterval, formatUptime, offlineWindowSec, backfillTimestamp). **Deliberately import-free** so `backend/tests/` runs with no MySQL/InfluxDB/.env. Imported by serverMetricsHandler + agentService
  historyRange.js               ← PURE range resolver shared by the history endpoints: presets (`-1h/-6h/-24h/-7d/-30d`, each window sized to ~150-200 points) **plus a custom absolute window** (`?start=&stop=` ISO, `stop` defaults to now). Sizes a custom window's aggregate from its span so any range draws at the same density. Owns the Flux-injection guarantee — presets are whitelisted and custom bounds are re-serialised from `Date`, so no user text reaches the query; a malformed CUSTOM window is a 400 while an unknown PRESET still falls back to `-1h`. Also **import-free** (tested in `tests/historyRange.test.js`). Used by serverHistoryHandler; networkHistoryHandler + upsHistoryHandler have the identical shape and should adopt it
  analyticsMath.js              ← PURE predictive-analytics math — `linearRegression`/`score` (R²/MAE), `splitTrainTest`/`validate` (CHRONOLOGICAL 80/20 — never shuffle a time series), `percentile`, `ewma`, `holtLinear`, `forecastSeries` (project to a ceiling → disk ETA), `projectToBound` (down to a floor for UPS runtime, up to a ceiling for link util), `worstVolumeForecast`, plus the ETA gates (`MIN_ETA_R2` 0.4 / `MAX_ETA_DAYS` 365 / `MIN_POINTS` 6) and the advisory copy. **Import-free** like serverMetricUtils/historyRange, so `tests/analyticsMath.test.js` runs it with no MySQL/InfluxDB/.env. See `predictive-analytics.md` §15
  analyticsService.js           ← the I/O half of Predictive Analytics: InfluxDB reads + MySQL reads + result shaping (the math is in analyticsMath.js). `forecastDiskFull` regresses **every volume** (`server_volumes`, per `mount`) and headlines the fastest-filling one — matching agentService's worst-volume alerting; `forecastUpsBattery` (`ups_metrics.runtime_remaining_min` → replacement ETA), `forecastLinkSaturation` (`network_traffic.utilization_pct` per interface → saturation ETA), `forecastTrend` (EWMA + Holt's linear + threshold-crossing advice from `alert_rules`), `detectAnomalies` (per-hour-of-day z-score + IQR), `recommendThresholds` (p95/p99 vs current global rules), `alertSummary` (MTTR etc. over MySQL `alerts`). **Device names resolve from MySQL** (`COALESCE(NULLIF(display_name,''), device_name)` + `device_type` + `network_interfaces.location_label`) — NOT the frozen InfluxDB `device_name` tag, so a renamed device reads the same here as everywhere else (`predictive-analytics.md` §14). Backs `routes/analytics.js`
backend/tests/                  ← `npm test` (`node --test`, zero deps). `contract.test.js` PARSES `go-agent/internal/collector/metrics.go` and fails if its json tags drift from NUMERIC_FIELDS — the guard for the hand-duplicated Go↔Node metric contract. `analyticsMath.test.js` pins the regression/ETA behaviour, incl. the confidence gate (a noisy series must yield NO ETA)
backend/handlers/
  sensorHandler.js              ← validates, writes InfluxDB, broadcasts to browsers + raises per-metric room-level alerts (temperature/gas/humidity) on band escalation, evaluated against `alert_rules` (alertRulesService) — replaces the old firmware-status escalation
  querySensorHistoryHandler.js  ← Flux queries, emits sensorHistory
  offlineDataHandler.js         ← SD card batch flush from ESP32
  serverMetricsHandler.js       ← agent metric POST → InfluxDB (`server_metrics` + per-volume `server_volumes`) + broadcast `serverMetrics`; also routes the agent's hourly optional `host` object to agentService.refreshHostInfo and skips threshold alerting while the server is in maintenance. Exports `serverMetricsBatchHandler` too (POST /metrics/batch) — **backfill of samples the agent buffered during an outage: InfluxDB + backup ONLY, no heartbeat/status/alerting/broadcast**
  serverHistoryHandler.js       ← Flux query on `server_metrics` for GET /api/servers/:id/history. Range presets + the **custom absolute window** (`?start=&stop=` ISO) come from `services/historyRange.js`
  networkMetricsHandler.js      ← router sample → InfluxDB (`router_metrics` + per-iface `network_traffic`) + broadcast `networkMetrics`
  upsMetricsHandler.js          ← UPS sample → InfluxDB (`ups_metrics`) + broadcast `upsMetrics`
  networkHistoryHandler.js      ← Flux on `network_traffic` (derived throughput) for GET /api/network/:id/history
  upsHistoryHandler.js          ← Flux on `ups_metrics` for GET /api/ups/:id/history
backend/sockets/connectionHandler.js  ← all socket events, device vs browser segregation
backend/middleware/
  auth.js                       ← authMiddleware, requireRole(...roles), JWT_SECRET export
  agentAuth.js                  ← Bearer `AGT-…` token auth for agent metric POSTs

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
| Routers/UPS (devices + device_network + ups_details + network_interfaces) | MySQL | SNMP poller; devices are registered from the dashboard (**Add router / Add UPS**, admin) — the old seed-SQL template is gone |
| Environment time-series | InfluxDB | measurement: `sensor_environment`, precision: ms |
| Server-metric time-series | InfluxDB | measurements: `server_metrics` + `server_volumes` (one point per fixed volume per sample, tagged by `mount` — the root-only `disk_*` fields stay on `server_metrics`) |
| Router/UPS time-series | InfluxDB | measurements: `network_traffic` (per-iface, cumulative uint counters), `router_metrics`, `ups_metrics` — tagged by `device_id` |
| **On-site backup copy (all streams)** | flat files under `BACKUP_DIR` | independent NDJSON backup of every sample (env/server/router/MikroTik/UPS), one file per stream per day, on a micro SD / USB drive on the backend. Survives DB wipe + power outage. See `backup-storage.md` |
| **Reports** | MySQL `reports` + on-disk CSV/PDF (`backend/reports/`, git-ignored) | fully implemented — built live from InfluxDB + MySQL at generate time, then frozen into the saved files. See `reportService.js` + `report-page.md` |

> **No mocks remain.** `backend/data/` was deleted when Reports went real — `reports` was
> its last consumer. Every feature is now backed by MySQL, InfluxDB or the backup writer.

---

## Authentication & Authorization

- **Login is Google OAuth (OIDC) only** — the custom "CSPC Mail" button runs the **authorization-code flow** (`@react-oauth/google`, `flow: "auth-code"`) and sends a one-time **code** to `POST /api/auth/google`. `services/googleAuthService.js` exchanges the code with Google (server-side, using `GOOGLE_CLIENT_SECRET`), verifies the returned **ID token** with `verifyIdToken` (`google-auth-library` — audience enforced), enforces the CSPC domains (`@cspc.edu.ph` / `@my.cspc.edu.ph`, exact match + `email_verified`), then issues the app JWT via `authService.issueSession`. The old password/bcrypt login (`/auth/login`) was **removed**. Full guide: `google-oauth.md`.
- **Self-register → admin approve/reject.** A first-time Google sign-in creates a `users` row with `status='pending'`; an admin approves it (assigning `admin` or `it_staff`) or rejects it (`status='rejected'`) from **User Management → Pending registrations**. Pending/rejected/inactive accounts can never obtain a session (`authMiddleware` requires `status='active'`). Multiple admins are allowed. Schema ships in `v13_cspc-ictu-monitoring-system.sql` — which seeds **no admin row**, so the first sign-in on a fresh database lands `pending` with nobody able to approve it. Promote it by hand (`deployment-guide.md` §4.3) or you are locked out.
- **Account matching is `google_sub` first, email as fallback** (`userService.findByGoogleSub` → `findByEmail`). `sub` is the immutable Google account id; email-only matching would turn a CSPC address rename into a duplicate `pending` row and a unique-index collision. Name/photo are re-synced from the ID token on every login (`syncGoogleProfile`), and **denied** sign-ins (bad domain, unverified email, pending/rejected/disabled, failed token exchange) are audited to `system_logs` as `action='login_denied'` via `authService.recordSignInDenied` — `issueSession` only ever logged successes.
- ⚠️ **Google allows only `localhost` or HTTPS as a JavaScript origin**, so a raw `http://<LAN-IP>:5173` cannot sign in. The on-prem dashboard needs an HTTPS hostname before go-live — ICTU publishes `monitoring.cspc.edu.ph`. See `deployment-guide.md` §6 and `google-oauth.md` §3/§10.
- JWT signed with `JWT_SECRET`, expires 1 h, stored in `sessionStorage` as `cspc_token`. Carries a `tv` (token_version) claim; `authMiddleware` rejects the token when `users.token_version` / `status` no longer match (logout, disable, role change bump it — server-side session revocation)
- Socket.IO: browsers send JWT in `socket.handshake.auth.token`; ESP32 device key is read from `socket.handshake.auth.deviceKey` (preferred) or `.query.deviceKey` (legacy EIO3 fallback — firmware still sends it here)
- Go agents authenticate metric POSTs with a Bearer `AGT-…` token (`middleware/agentAuth.js`); first-run enrollment uses the shared `AGENT_INSTALL_KEY`
- `socket.isDevice = true` for ESP32, `false` for browsers

| Role | DB value | Access |
|------|----------|--------|
| Admin | `admin` | all pages + user management (approves registrations) + alert rules (configurable thresholds) |
| IT Staff | `it_staff` | dashboard, server metrics, network, ups, environment, aircon, **alerts (acknowledge/resolve)**, history, reports |

> Login no longer uses passwords. `users.hash_password` is now nullable; `users.status` gained `pending`/`rejected`; new columns `google_sub` + `auth_provider`. The User Management "Add User"/"Reset PW" and Profile "Change Password" UIs are now vestigial.

> **Profile editing is username-only.** `name`, `email` and `profile_image` belong to Google — `googleAuthService` re-syncs them from the ID token on **every** sign-in (`userService.syncGoogleProfile`), so an edit would silently revert at the next login, and `email` is the identity key the login matches on. Both the **My Profile** modal (`components/layout/ProfileModal.tsx`) and the admin **Edit User** modal show them read-only; the avatar **upload** path is gone (`PATCH /users/me` no longer takes multipart, and `middleware/upload.js` has been deleted). `userService.updateOwnProfile` accepts `username` only, and `updateUser` accepts `username`/`role`/`status` only — the latter now uses `COALESCE` so an omitted field can never blank a column.

### Formerly-mock endpoints (all now real)
- `routes/environment.js` is **no longer mock.** GET `/history` + `/logs` (random data / five rows hardcoded to March 2025) are **removed**; `GET /daily` returns a real InfluxDB-backed per-day summary via `services/environmentService.js`, and live sensor history remains a Socket.IO concern (`changeRange` → `sensorHistory`). The file also serves `POST /calibrate-gas` and `GET /sensor-status` (see ESP32 Firmware Notes).
- **`routes/reports.js` is now REAL** (the last mock, now gone): `services/reportService.js` persists to the `reports` table and writes a CSV **and** PDF per report under `backend/reports/` (git-ignored). `POST /api/reports` (admin + it_staff) builds the dataset **live** from the stores per `type` (environment → InfluxDB `sensor_environment`; server → InfluxDB `server_metrics`; **network → InfluxDB `router_metrics` + `network_traffic`, covering SNMP routers *and* the MikroTik**; **ups → InfluxDB `ups_metrics`**; alerts → MySQL `alerts`; aircon → MySQL `aircon_logs`) for the chosen `{periodStart, periodEnd}`, then `GET /api/reports/:id/download?format=csv|pdf` streams the saved file (download name = title + period) and `DELETE /api/reports/:id` (admin) removes the row + files. UI = **Reports** page (`pages/Reports.tsx`, Grafana-styled: type cards + range picker modal, per-row CSV/PDF download). Needs the `pdfkit` dep. Full guide: `report-page.md`. **Note:** the **notifications** feature (`routes/notifications.js` + `services/notificationService.js`) writes the **real** `alerts` + `alert_notifications` tables, and both the bell feed and the **Dashboard "Alerts" panel** render that real per-user feed (via `NotificationContext`). See `email-popup-notifications.md`.
- **`routes/alerts.js` is now REAL** (no longer mock): `services/alertsService.js` backs the shared alert **lifecycle** — `GET /api/alerts` (history, `?status=` filter), `POST /api/alerts/:id/acknowledge`, `POST /api/alerts/:id/resolve`, `GET /api/alerts/count` (open-alert count → sidebar **Alerts badge**), all admin + it_staff. Sets `alerts.status` + `acknowledged_by`/`acknowledged_at`/`resolved_at`. **Auto-resolves** open alerts when the metric recovers to normal (wired into `checkThresholds` + `sensorHandler`). Broadcasts `alertUpdated`. UI = **Alerts** page (`pages/Alerts.tsx`) + live unresolved-count badge on the nav (`NotificationContext.openAlertCount`). Shared incident state, distinct from the per-user bell (`is_read`). **Resolve attribution:** single "by {acknowledger}" (resolve folds into `acknowledged_by`); a `resolved_by` column exists in the schema but is **DORMANT/unused** (separate-resolver UI was built then reverted — see `email-popup-notifications.md` §13.8).

> The `reports.js` generate gate uses `requireRole("admin", "it_staff")`; the **Reports page** mirrors this (Generate button = admin/it_staff, Delete = admin). The old `super_admin` role check in the page was fixed to `admin`.

> **Predictive Analytics (real, live data).** `services/analyticsMath.js` (pure math) +
> `services/analyticsService.js` (Influx/MySQL reads) + `routes/analytics.js`
> (`GET /api/analytics/forecast/disk[/:id]`, `/forecast/ups-battery`,
> `/forecast/link-saturation`, `/trends/:metric`, `/anomalies`, `/recommendations`,
> `/alerts/summary` — all `requireRole("admin","it_staff")`, read-only insight) power the
> **Analytics** page (`pages/Analytics.tsx`, sidebar nav under Operations, both roles).
> Supervised **linear regression** with a chronological train/test split and an R² gate is
> the ML centrepiece — a noisy series reports "Stable" rather than a bogus date; EWMA /
> Holt's linear / z-score / percentiles are **statistics**, not ML (say it that way in a
> defense). Forecast ETAs run on **live** data from the Go agents, the SNMP poller and the
> MikroTik poller. Admin can push a p95/p99 **recommendation** straight into `alert_rules`.
> Full guide: `predictive-analytics.md` (math §2–§4, device identity §14, tests §15) +
> `predictive-analytics-study-guide.md`.

> **Configurable alert thresholds (real, not mock).** The previously-unused `alert_rules` table now drives all threshold alerting. `routes/alertRules.js` (`GET/POST/PUT/DELETE /api/alert-rules`, **admin-only**) + `services/alertRulesService.js` manage them; the **Alert Rules** admin page (`pages/AlertRules.tsx`, sidebar nav, admin-only) is the UI. Scope = global default (`device_id=NULL`) + optional per-server override; fallback = rules-only (no rule → silent). The rules ship **pre-seeded** in `v13_cspc-ictu-monitoring-system.sql`; alerting is rules-only, so an empty `alert_rules` table means silence. Old hardcoded 80/90 (servers) + firmware env thresholds are removed in favor of these rules.

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
| `serverStatus` | offline sweep flips a stale server → `{ id, status: "Offline" }`, **or** an admin parks/resumes one → `{ id, status: "Maintenance" \| "Online" \| "Offline" }` |
| `serverRemoved` | admin removes a server → `{ id }` |
| `serverRenamed` | admin sets/clears a server's display label → `{ id, name, displayName, hostname }` → list/detail/Dashboard update the label live |
| `networkMetrics` | on each router SNMP poll (~60s) → `{ device }` (interfaces, utilization, uptime) |
| `upsMetrics` | on each UPS SNMP poll (~60s) → `{ ups }` (battery %, runtime, load, on-battery) |
| `networkStatus` / `upsStatus` | poller marks a router/UPS unreachable → `{ id, status: "Offline" }` |
| `agentApproved` / `agentPending` | agent approved / registered-or-rejected (admin pending list) |
| `userPending` / `userApproved` | user self-registered-or-rejected / approved (admin Pending registrations panel) |
| `deviceLog` | new `device_logs` entry (lifecycle + CPU/Mem/Disk threshold crossings) |
| `notification` | new alert raised → pushed to **one user's** room (`user:<id>`) → bell feed + badge + corner **toast** (`ToastHost`) + opt-in **OS popup** (Web Notifications API, tab-backgrounded only). Persisted (`alerts` + `alert_notifications`). See `email-popup-notifications.md` |
| `alertUpdated` | an alert's lifecycle changed (manual acknowledge/resolve, or auto-resolve on metric recovery) → Alerts page refreshes live |
| `reportCreated` / `reportUpdated` / `reportDeleted` | report lifecycle → **broadcast to every dashboard** (the reports list is shared — `GET /api/reports` returns everyone's). A row appears as `pending`, flips to `generated`/`failed` when the background build ends, and disappears on delete — no refresh, on any open page. `POST /api/reports` returns 202 immediately; this is how the result arrives. The toast is creator-only (page compares `generatedBy`). See `report-page.md` §11–12 |
| `airconStatus` | manual on/off toggle, or a **rename** (`{ aircon: { id, name }, entry }`) |
| `airconAutoUpdate` | ESP32 auto IR zone change |
| `irChannelMap` | forwarded from ESP32 on connect |

### Server → ESP32
| Event | When |
|-------|------|
| `irConfig` | on ESP32 connect + after any add/remove/toggle |
| `irCommand` | manual Turn On/Off from dashboard |
| `envConfig` | on ESP32 connect + after any **Alert Rules** change → room-level `alert_rules` thresholds (`{tempWarn,tempCrit,gasWarn,gasCrit,humWarn,humCrit}`, null fields omitted). Firmware applies them at runtime so its **LED/buzzer/reported status** match the dashboard's alert thresholds (no reflash). See alertRulesService + `email-popup-notifications.md` |
| `calibrateGas` | admin asks the ESP32 to re-measure the MQ-2 **clean-air baseline** (Ro) and save it to NVS flash. Ro is measured once per location and reused on every boot — deliberately NOT re-measured each boot, since a reboot during a gas event would record polluted air as "clean" and permanently under-report smoke. Replaces hand-editing `RO_CLEAN_AIR_*` + reflashing when the box moves. Air must be clean when triggered; out-of-range results are rejected, not stored |
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
> code). Table ships in `v13_cspc-ictu-monitoring-system.sql`. This is deliberately
> separate from the Alert Rules temperature thresholds (cooling should ramp *before* the
> alarm). Default boundaries match the firmware's original compiled values.

> **Power is manual-only.** `applyAutoIR` (on `irFired`) only re-targets the set
> temperature of units that are **currently ON** — it never changes `is_on`. A unit a user
> turned OFF stays OFF when IR fires. It returns/emits the affected `deviceIds` so the
> dashboard updates exactly those units (`airconAutoUpdate` no longer force-enables all).

> **Power-on re-sync.** Because auto IR fires **only on a zone change**, a unit that was
> OFF at that moment is skipped by both `applyAutoIR` (DB) and the firmware blast (its
> channel is disabled via `irConfig`) — and would then stay stale until the room next
> crossed a zone boundary. Switching a unit back ON therefore re-applies the current
> zone: the firmware sends the zone's IR code right after `IR_POWER_ON` (`irCommand`
> handler, using the shared `zoneIRData()`), and `airconService.toggle` writes the
> matching `set_temperature` + an `auto` `aircon_logs` row ("Re-synced to N°C"). The
> backend's zone comes from `lastZone`, cached in-memory from `irFired`; if the backend
> restarted since the last zone change it is null and only the hardware re-syncs.

> **All seven IR arrays are real captures from the Carrier remote** (2026-07-31 / 2026-08-01,
> 38 kHz, 131 values each, captured with `IRLearner.ino`). No mock IR data remains, and
> `zoneIRData()` no longer refuses any zone. The protocol decodes as UNKNOWN, so there is no
> library encoder — they are replayed verbatim with `sendRaw()`. Each frame verifies as
> exactly 64 bits with clean timing clusters, and all seven satisfy the structural invariant
> the family obeys (bits 61–63 are the complement of bits 53–55).
>
> ⚠️ **Captured is not the same as verified against the AC — nothing here has driven a real
> unit yet.** Two things to confirm on the hardware: (1) `IR_20C_HIGH` reads 010 at bits
> 53–55 where `IR_22C_HIGH` reads 000, so if that field is fan speed this may be the wrong
> button — check the unit displays 20 °C / fan High; (2) `IR_POWER_OFF` has `byte[0] = 04`
> where the other six have `14`, likely a genuine power-state bit but it is the one frame
> with no sibling to cross-check. Firmware compiles clean against ESP32 core 3.3.7 at **94%
> of program storage** — worth knowing before adding anything to this sketch.

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
| Dashboard, Environment, AirConditioner, ServerMetrics, AlertRules, Alerts, Analytics, NetworkMonitoring, UpsMonitoring, Reports, Sidebar, Header | ✅ Grafana tokens |
| History, Settings, UserManagement | ⚠️ still use old `slate-*` classes |
| ServerDetail | hybrid: `slate-*` base + `dark:` overrides (light/dark adapted, not `--gf-*`) |

---

## ESP32 Firmware Notes

- Active file: `iot/esp32/env_monitor_v2.ino`
- **No SD card / on-device buffer** — the offline log was removed. Every monitored link is on a UPS, so the device doesn't drop; durability is the backend's job (`backupService`). A reading taken while WiFi is down is logged to serial and dropped. The backend's `offlineData` handler still exists but is dormant — nothing emits it
- `deviceSecret` must match `DEVICE_SECRET` in `backend/.env`
- IR fires only on temperature **zone change**, not every loop tick
- `enabledChannels[]` updated at runtime via `irConfig` socket event — no reflash needed to add/disable AC units
- **Alarm thresholds are runtime-configurable** (`WARNING_PPM`/`DANGER_PPM`/`TEMP_WARNING`/`TEMP_DANGER`/`TEMP_CRITICAL`/`HUM_WARNING`/`HUM_DANGER` are now mutable globals, not `#define`) — updated via the `envConfig` socket event from the dashboard's Alert Rules. The LED, buzzer and reported status all derive from these, so they track the dashboard's thresholds without reflashing. `envConfig` sets `TEMP_DANGER = TEMP_CRITICAL` (collapsing temp to warning/critical). `TEMP_COLD` (LED "too cold") is intentionally **not** rule-driven. A metric with no rule keeps its compiled default on the device (dashboard goes silent, device retains its last threshold).
- **IR/AC comfort-zone boundaries are runtime-configurable** (`IR_TEMP_COLD_BELOW`/`IR_TEMP_NORMAL_MAX`/`IR_TEMP_ACCEPT_MAX`/`IR_TEMP_NEARCRIT_MAX` are now mutable globals, not literals in `getIRZone`) — updated via the **`acConfig`** socket event from the dashboard's **Auto-Cooling Thresholds** card (separate from `envConfig`/Alert Rules — cooling ramps *before* the alarm). The per-zone target temps stay fixed (captured raw IR codes). No reflash needed to retune *when* IR fires.
- Timestamp priority: DS3231 RTC → NTP (UTC+8, `pool.ntp.org`) → uptime fallback (`UP HH:MM:SS`)
- Backend overrides ESP32 timestamp with `new Date()` for all InfluxDB writes and broadcasts
- Buzzer: 10-bit LEDC resolution; `ledcWrite(pin, 0)` to silence (not `ledcWriteTone(pin, 0)`)
