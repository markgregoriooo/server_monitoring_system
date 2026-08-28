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
npm run rekey           # secrets at rest: report / encrypt-plaintext / ROTATE the encryption key.
                        # With no flags it prints which reversibly-stored values (MikroTik API password,
                        # install-key + agent-token ciphers, SNMP communities) are encrypted and which are
                        # still readable. `-- --encrypt-plaintext` encrypts the stragglers.
                        # `-- --from-key <old 64-hex> [--apply]` re-encrypts everything under the key now
                        # in .env — the answer to "MIKROTIK_ENC_KEY leaked", which used to be "you can't".
                        # DRY RUN unless --apply. Stop the backend first; back up the DB first.
npm run probe -- <ip> [community] [port]  # "can this device be monitored, and HOW?" — the one check to run
                        # BEFORE registering anything. Pings it, then tries MIB-II / IF-MIB / UPS-MIB
                        # independently, then prints a VERDICT naming the form to use: register as a UPS,
                        # as an SNMP router, or as a PING-only router (blank community). Replaces the
                        # `snmpwalk` step in router-ups-monitoring.md §9 — snmpwalk is a net-snmp CLI
                        # tool that does NOT ship with Windows. Runs the same snmpClient/icmpPing code the
                        # poller runs, and touches no DB/InfluxDB, so it works before anything is set up.
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
DEVICE_SECRET=     # shared secret for ESP32 socket auth — must match the firmware constant in
                   # iot/esp32/env_monitor_v2/secrets.h. ⚠️ VALIDATED AT BOOT (config/env.js): the backend
                   # REFUSES TO START on a value known to have been published, and on anything shorter than
                   # 24 chars. `REDACTED-ROTATED-DEVICE-SECRET` was committed in the .ino at 5f5a084 and removed
                   # at 219f36e — still readable in the history of a pushed remote, so it authenticates
                   # nobody. Presenting it makes a socket `isDevice`, i.e. able to write environment
                   # readings, replay backfill under its own timestamps and drive the IR state — enough to
                   # fabricate the record this system exists to keep. Rotating is TWO-SIDED: same new value
                   # in backend/.env AND secrets.h, then reflash the ESP32. Compared with timingSafeEqual
                   # (src/server.js matchesDeviceSecret), matching installKeyService's legacy-key compare.
                   # Blank = every device handshake is rejected (logged once at boot)
JWT_SECRET=
DB_HOST=
DB_USER=
DB_PASSWORD=
DB_NAME=
DB_PORT=
DB_POOL_SIZE=          # mysql2 pool size; blank = 10. Three workloads share it — the SNMP/MikroTik pollers,
                       # agent metric POSTs, and every dashboard request
DB_STATEMENT_TIMEOUT_SEC= # server-side statement timeout, applied per pooled connection; blank = 30.
                       # There was NO query timeout at either layer: mysql2 has no per-query option and the
                       # server's own limit was off (verified `MAX_STATEMENT_TIME = 0`). One runaway query
                       # therefore held 1/10th of the pool forever, and with `queueLimit: 0` the pool QUEUES
                       # rather than erroring — the symptom is "the dashboard is slow", never an error anyone
                       # can search for. Enough of them and the pollers stall behind a SELECT. Set as
                       # `max_statement_time` (MariaDB, SECONDS) AND `max_execution_time` (MySQL 5.7+, ms),
                       # both fire-and-forget so either server works. ⚠️ Deliberately generous — a backstop
                       # against a query that will never finish, not a performance budget. See config/mysql.js
INFLUX_URL=
INFLUX_TOKEN=
INFLUX_ORG=
INFLUX_BUCKET=
AGENT_INSTALL_KEY= # ⚠️ DEPRECATED bootstrap fallback. (The agent reads a key from the CSPC_INSTALL_KEY
                   # ENV VAR now, not `-install-key` — a flag is visible in `ps`, in shell history and in
                   # 4688/execve auditing. The flag still works and warns; the env var wins if both are set.) Enrollment keys are now MANAGED DATA (`agent_install_keys`,
                   # minted/revoked by an admin on Server Metrics → Agent install keys). This is still accepted
                   # at POST /api/agents/register, but only AFTER the table misses, and every use logs a warning.
                   # It exists because a fresh database has no keys AND no admin to mint one (the schema seeds
                   # neither), so requiring the UI would deadlock a first install. Create a managed key, then
                   # BLANK this and restart. A revoked/expired managed key is never silently rescued by it.
                   # See services/installKeyService.js
SERVER_OFFLINE_AFTER_SEC= # FLOOR for the per-agent offline window; blank = 30. The real window is max(this, agent's reported interval x 3), capped at 1h — so a `-interval 60` agent no longer flaps Offline. See server-metrics.md §4.3
SNMP_POLL_INTERVAL_MS= # router/UPS SNMP poll cadence; blank = 60000 (60s). Per-device community/port live in device_network, not here
PING_COUNT=            # ICMP echoes per router per poll; blank = 3. Fewer than 3 makes packet_loss_pct too coarse to mean anything (1 packet = 0% or 100%)
PING_TIMEOUT_MS=       # per-reply ICMP timeout; blank = 2000. ⚠️ The OS `ping` flag units DIFFER — Windows -w is ms, Linux -W is SECONDS, macOS -W is ms — services/pingOutput.js converts; don't hand-write the flags
                       # A router registered with NO snmp_community is polled by ICMP only (up/down + latency + loss, no interfaces). We shell out to the OS `ping` rather than open a raw socket: net-ping needs Administrator on Windows and root on Linux, and running the backend elevated is a far worse trade than parsing text on a box holding JWT_SECRET. See services/icmpPing.js
MIKROTIK_ENC_KEY=      # ⚠️ REQUIRED for MikroTik. 64 hex chars (32 bytes) for AES-256-GCM of mikrotik_devices.api_password. Saving credentials THROWS without it. Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
                       # ⚠️ Do not change this casually — every stored password was encrypted under it. It is
                       # now RECOVERABLE rather than terminal: `npm run rekey -- --from-key <old>` re-encrypts
                       # every reversibly-stored secret under the new key (dry run by default). Changing it
                       # WITHOUT that step still leaves the poller failing to log in with no obvious cause
SECRET_ENC_KEY=        # optional, 64 hex chars. General AES-256-GCM key (services/secretCrypto.js) used for agent_install_keys.key_cipher, which is what lets an admin re-open a key's install command. Blank = falls back to MIKROTIK_ENC_KEY, so an existing deployment gets this with no new config; blank AND no MikroTik key = keys still enrol fine but can't be shown again
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
RATE_LIMIT_MAX=        # global request cap, **per USER** where the request carries a valid JWT and per IP otherwise
                       # (`userOrIpKey` in src/server.js); blank = 3000. Keying on IP alone was a self-inflicted DoS:
                       # every ICTU staffer sits behind the same campus NAT, so one person hard-refreshing would lock
                       # out everyone else. The token is VERIFIED, not decoded — `jwt.decode` would let anyone claim
                       # any `id` and either mint themselves a fresh budget or exhaust someone else's. ⚠️ The IP
                       # fallback goes through `ipKeyGenerator`, never raw `req.ip`: returning a raw IP silently
                       # discards `ipv6Subnet`, and any IPv6 /64 could then rotate addresses for unlimited budget. ⚠️ Size this from what ONE DASHBOARD LOAD costs, not
                       # from intuition. A single Dashboard mount fires ~19 requests (AuthContext, NotificationContext,
                       # useRoomThresholds, useWidgetLayout, the six panels, and LiveSummaryContext re-fetching five of
                       # the same endpoints for the PiP widget) — DOUBLED by React StrictMode in dev, plus ~10 more from
                       # the socket `connect` handler on every reconnect/HMR reload. So a dev page load is 50-70 requests.
                       # The old 500 was ~8 loads, i.e. a few minutes of work, and then the whole UI went blank: every
                       # panel 429s at once, which reads as a crash rather than as a limit. Agent metric POSTs are
                       # exempt (they have their own limiter in routes/servers.js). A 429 now logs `[RATE]` server-side
RATE_LIMIT_WINDOW_MIN= # the window those requests are counted over, in minutes; blank = 15
TRUST_PROXY=            # how many proxy hops in front of the backend may be BELIEVED when they claim a client's
                       # address via X-Forwarded-For; blank = 2 (ICTU's edge → campus nginx, deployment-guide §5).
                       # ⚠️ A SECURITY CONTROL, not a formality. Set higher than the real hop count and the surplus
                       # entries are attacker-supplied: a client sending `X-Forwarded-For: a, b, c` picks its own
                       # `req.ip`, hence its own bucket in every IP-keyed limiter (sign-in 30/15min, agent enrollment
                       # 30/15min, metric ingest) and its own value in `system_logs.ip_address` — the row that IS the
                       # evidence for a Privacy Notice acceptance. Set TRUST_PROXY=0 when nothing is in front.
                       # The backend listens on 0.0.0.0:3000 for the ESP32 and the Go agents, so :3000 stays directly
                       # reachable on the LAN whatever nginx does — firewall it to the agent subnets. See audits/api-infra-security-2026-08-25.md
JSON_BODY_LIMIT=       # max JSON request body; blank = 100kb. The agent batch cap (MAX_BATCH 60, serverMetricsHandler)
                       # is sized to fit inside it — raise both together or a post-outage backfill 413s silently
HSTS_MAX_AGE_SEC=      # Strict-Transport-Security max-age; blank = 15552000 (180d), 0 disables. Only ever sent over a
                       # real TLS connection (`req.secure` via X-Forwarded-Proto) — sending it on a plain-HTTP LAN
                       # deployment would pin http://<ip>:3000 to HTTPS in every staff browser and lock them out of a
                       # host with no certificate. Deliberately no `preload`/`includeSubDomains`: neither is ours to
                       # commit cspc.edu.ph to. See middleware/securityHeaders.js
SOCKET_HANDSHAKE_MAX_FAILURES= # FAILED Socket.IO handshakes allowed per client address per 15 min; blank = 50.
                       # The global Express limiter CANNOT see /socket.io/ — Socket.IO answers it on the HTTP server
                       # and Express is never invoked — so the one endpoint accepting DEVICE_SECRET had no attempt
                       # limit at all. Counts failures ONLY, and a success clears the counter, because behind nginx
                       # every browser socket shares one address and a plain connection cap would lock out the campus.
                       # See services/handshakeLimiter.js
SOCKET_MAX_PAYLOAD_BYTES= # Socket.IO frame cap; blank = 1000000 (the library default, ~1000x the largest real frame)
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
SESSION_MAX_HOURS=      # absolute ceiling on ONE sign-in, in hours; blank = 12. The JWT slides — authMiddleware
                       # re-issues a fresh 1h token past each one's half-life — and a sliding window with no
                       # ceiling is not a session, it is a permanent credential that rewrites itself. This
                       # dashboard polls constantly and can sit on a wall display, so a token renewed forever
                       # and a STOLEN one could be kept alive indefinitely by simply using it. Measured from
                       # the `ist` claim (stamped once at sign-in, preserved across renewals), so it is the
                       # age of the SESSION, not of the current token. Past the cap the backend stops
                       # RENEWING rather than 401-ing, so the token dies at its own exp and the client's
                       # existing expiry path handles it — worst case a session lives this + 1h. Lower it for
                       # an internet-facing deployment. See middleware/auth.js maybeRenewToken
SOCKET_REVOKE_SWEEP_MS= # how often connected BROWSER sockets are re-validated against `users` (status + token_version); blank = 30000 (30s). `io.use` authenticates once at the handshake and never re-checks, so without this a socket opened with a valid token keeps streaming after the account is disabled or revoked. A sweep, not a push from each token_version bump site, because there are four such sites and a sweep cannot miss a fifth (or a hand-edited row). Does NOT check the token's `exp` — HTTP sessions slide, so an active session legitimately outlives the token its socket opened with. See services/socketSessions.js
SYSTEM_LOG_RETENTION_DAYS= # `system_logs` (the audit trail) rows older than this are purged daily; blank = 365. This table holds ip_address + user_agent — the most personal data in the schema — and had NO purge before, so it grew forever. The Privacy Notice commits to this period; changing it means changing the notice (and bumping POLICY_VERSION). Longer default than alerts/reports on purpose: an audit trail is what you go looking for months after an incident. See auditService.purgeOld
ENV_PERSIST_INTERVAL_MS= # how often an ESP32 reading is STORED (InfluxDB + backup); blank = 30000 (30s). 0 stores every reading (the old behaviour). ⚠️ Does NOT change how often the ESP32 SENDS (`LOG_INTERVAL` 3000, firmware) or how often a reading is ACTED ON — validation, the online heartbeat, the live dashboard broadcast and the alert evaluation all still run on every 3s reading. Only persistence is throttled. The DHT11 resolves 1°C/1%RH and a server room does not move 1°C in 3s, so most readings were storing quantisation noise: ~28,800 samples/day, about 1.7 servers' worth of writes, and the same number of appends to the micro SD the backup writer lives on. See services/envPersistPolicy.js
ENV_PERSIST_DEADBAND_GAS=  # ppm a single MQ-2 must move to force an immediate store; blank = 15. This is what keeps a smoke event captured on the 3s tick that sees it rather than waiting for the heartbeat — the two sensors are judged separately, since one rising while the other doesn't is what two sensors are for
ENV_PERSIST_DEADBAND_TEMP= # °C to force an immediate store; blank = 0.5 (the DHT11 resolves 1°C, so anything it can actually report crosses this)
ENV_PERSIST_DEADBAND_HUM=  # %RH to force an immediate store; blank = 2
REPORT_MAX_PERIOD_DAYS= # widest period ONE report may cover; blank = 366. `start < end` alone accepted
                       # periodStart=2000-01-01, i.e. Flux queries over 26 years — and because the build is
                       # ASYNCHRONOUS (the route already answered 202) and build() never throws, the request
                       # looked fine while a long query held one of ten shared pool connections and wrote a
                       # file sized by whatever came back. A year is wider than anything retained here
                       # (alerts 30d / reports 90d / system_logs 365d), so this refuses only spans that could
                       # never have been fully populated. REJECTED, not clamped: silently narrowing the range
                       # would produce a report whose title says one period and whose contents are another
REPORT_RETENTION_DAYS=  # generated reports older than this are purged daily — MySQL row AND both files under backend/reports/; blank = 90. Longer than the alerts default on purpose: a report is an artifact someone deliberately generated. See report-page.md
```

Frontend also needs `VITE_GOOGLE_CLIENT_ID` in `frontend/.env` (same client ID; restart `npm run dev` after changing). See `google-oauth.md`.

### Backend address (no longer hardcoded in the dashboard)
The dashboard's backend URL is centralized in `frontend/src/config.ts`, which **auto-detects**
from the page's own host on port 3000 — so it follows whatever IP you open the dashboard from
and **changing networks needs no edit**. To pin a specific backend (different host / HTTPS),
set `VITE_API_URL` in `frontend/.env` (then restart `npm run dev`). Backend CORS is driven by
`WEB_ORIGIN` in `backend/.env` — set `WEB_ORIGIN=*` to allow any origin on a roaming LAN.

Firmware config lives in **`iot/esp32/env_monitor_v2/secrets.h`** (gitignored) — `WIFI_SSID`, `WIFI_PASSWORD`,
`BACKEND_HOST`, `BACKEND_PORT`, `DEVICE_SECRET`. Copy `secrets.h.example` to `secrets.h` and fill
it in; the sketch `#include`s it. These were literals in the `.ino` until 2026-08-16, which put a
real WiFi password and the real device secret into every clone. ⚠️ Both values are still in git
**history** (since commit `5f5a084`) — the split stops new exposure, it does not undo the old one,
so rotate anything that was committed.

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
- **Hardware:** ESP32, DHT11, MQ-2 ×2, passive piezo buzzer, WS2812B RGB LED ×20, IR TX ×2 (GPIO 25/33), DS3231 RTC + coin cell, micro SD (SPI, offline buffer)

---

## Repository Layout

```
backend/src/server.js           ← Entry point (the BACKEND one — the repo has FIVE runtimes: this, `frontend/src/main.tsx`, `agent/cmd/agent/main.go`, `iot/esp32/env_monitor_v2/*.ino`, and the `ops/` backup scripts). ⚠️ Middleware ORDER is deliberate: `x-powered-by` off → `securityHeaders` → `cors` → `trust proxy` → **`globalLimiter`** → `express.json` → routers → 404 → error handler. The limiter sits BEFORE the body parser on purpose — it used to sit after, so a request about to be 429'd had already had 100 kB of JSON parsed on its behalf. Safe because the limiter reads only the Authorization header and `req.path`. See audits/project-structure-audit-2026-08-25.md — PS-01
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
  secretCrypto.js               ← general AES-256-GCM for secrets that must be READ BACK rather than only verified (`createCipherSuite(envNames)` → isConfigured/encrypt/decrypt; format `[iv(12)|tag(16)|ciphertext]` base64). `mikrotikCrypto.js` is now a thin binding of it pinned to `MIKROTIK_ENC_KEY` — pinned deliberately, since accepting the `SECRET_ENC_KEY` fallback there would make every already-stored RouterOS password undecryptable the day someone sets it. Use a HASH (installKeyUtils.hashKey) whenever you only need to answer "is this the same value?"; this is only for the cases where a human must see the original again
  communityCrypto.js            ← SNMPv2c community strings, encrypted at rest in `device_network.snmp_community`. A community IS the credential — no user, no challenge, no transport security — and this column fed `ops/db-backup/dump-mysql.sh` → `ops/offsite-backup/sync-offsite.sh`, i.e. every router/UPS credential on campus was on Backblaze nightly, in the clear. Exactly the argument the agent-token and install-key migrations make; this column was just never revisited, while `mikrotik_devices.api_password` one table over has been AES-GCM since day one. Encryption, NOT a hash: the poller must PRESENT the value on every cycle. Stored as `gcm1:` + base64 — the prefix is what makes an in-place migration of a live column safe, since Node's base64 decoder will happily "decode" `dev-router` and a wrong guess silently destroys a working community. An unprefixed value is read as plaintext **permanently**, not for a migration window (dev-snmpsim's seed inserts plaintext; a row hand-fixed during an incident must not stop the poller). Decrypt failure returns "" and fails `connFor`'s guard for that ONE device rather than the cycle. ⚠️ `assertEndpointFree` therefore compares communities in JS, not SQL — a random IV means `snmp_community = ?` matches nothing, which would silently turn the duplicate-device guard into a no-op. Migration `2026-08-26_snmp_community_at_rest.sql` + `npm run rekey -- --encrypt-plaintext`. Tested in `tests/communityCrypto.test.js`
  installKeyUtils.js            ← PURE (only `node:crypto`) install-key format + usability rules: generateKey (`AIK-` + 24 random bytes, matching the `AGT-` token width), hashKey, prefixOf, looksLikeKey, keyRejection/isUsable/keyStatus. **SHA-256, deliberately not bcrypt**: the value is 192 bits of CSPRNG output so there is no dictionary to slow an attacker down with, while a salted slow hash would force the enrollment path to scan every key row instead of one indexed lookup. `keyRejection` returns WHICH of unknown/revoked/expired applied — the HTTP reply stays one generic message, but a rollout that fails needs the server log to say whether to re-issue or extend. Tested in `tests/installKeyUtils.test.js`
  installKeyService.js          ← the DB half: `resolveKey` (enrollment lookup, hash → row → usability; falls back to the deprecated `.env` `AGENT_INSTALL_KEY` **only when the table misses**, so a revoked managed key is never silently rescued by a matching `.env` value), `noteUsed` (best-effort use_count/last_used_at, never awaited — a failed counter must not fail an enrollment that already succeeded), list/create/revoke. Revoke is SOFT: the row stays, because "this key enrolled 4 servers and was withdrawn by X" is the history the feature exists to provide. Migration `2026-08-15_agent_install_keys.sql`
  agentService.js               ← Go-agent + server-device DB logic (devices + server_specs + device_network + agent_tokens); enroll/approve/reject, offline sweep, device_logs,
                                  **The `AGT-` token is NEVER stored readable** (since 2026-08-25): `approved_token_hash` (SHA-256 via the shared `installKeyUtils.hashKey`) is the lookup path on every metric POST, and `approved_token_cipher` (AES-256-GCM) exists **only** because the token must be DELIVERABLE more than once — `agent/cmd/agent/main.go` enrolls only when `config.Load` fails, so every `/api/agents/register` call is a machine that lost its `agent.conf`, and `register()` answers by handing back the same pending token to exchange at `/api/agents/status`. That one path carries both agent.conf recovery AND the ADOPT workflow, so storing only a hash breaks both — silently, since the agent loops on `approved but token missing; retrying`. `approve()` THROWS 503 if no encryption key is configured rather than falling back to plaintext (that fallback is how the plaintext column existed). Migration `2026-08-25_agent_token_hash.sql` drops the old `approved_token`; ⚠️ never change `SECRET_ENC_KEY`/`MIKROTIK_ENC_KEY` afterwards or re-delivery breaks (running agents are unaffected — lookup is by hash). Tested in `tests/agentTokenHash.test.js`, which parses the migration so the Node↔SQL hash contract cannot drift. **renameServer** (admin display label: `devices.display_name`, NULL = fall back to hostname; effective name = `COALESCE(display_name, device_name)`; migration `2026-06-18_server_display_name.sql`). `recordHeartbeat` **auto-resolves the open `offline` alert** on an offline→online transition (servers now match routers/UPS — see deviceAlerts.checkReachability). `checkThresholds` evaluates the `disk` rule against the **worst volume**, not the root. `setMaintenance(id, enabled)` parks a server for planned downtime (sweep skips it, thresholds suppressed, heartbeat won't clobber the status); `refreshHostInfo` is also called from the metric path so static facts don't freeze at enrollment. See `server-metrics.md`
  notificationService.js        ← raiseAlert() → de-dup cooldown (NOTIFY_COOLDOWN_MIN, restart-proof, **open-alert-scoped** — a resolved alert no longer suppresses, so recurrences re-alert) → writes `alerts` (incl. `alert_rule_id` when rule-driven) + fans out `alert_notifications` per active user + pushes `notification` to each user room + severity-gated email; listForUser/unreadCount/markRead. `init(io)` once at startup. Triggers: server CPU/mem/disk + **environment** temperature/gas/humidity (both via configurable `alert_rules` — see alertRulesService) + offline (not rule-based) + **online/reconnect** (info, raised on the first metric after a server was offline — auto-resolves the offline incident, then self-resolves since it's an event, not an open condition). See `email-popup-notifications.md`
  alertsService.js              ← alert LIFECYCLE (shared, not per-user): list/acknowledge/resolve/openCount + auto-resolve when a metric recovers (called from checkThresholds + sensorHandler); broadcasts `alertUpdated`; `init(io)` once. Backs the now-real `routes/alerts.js`. Distinct from the per-user bell (`alert_notifications.is_read`)
  alertRulesService.js          ← configurable alert thresholds (`alert_rules`). In-memory cache (reload on startup + every mutation) + `getEffectiveRules(deviceId, metric)` resolver (per-server override else global `device_id=NULL`) + `nextBand()` hysteresis-aware evaluation + admin CRUD. **Create/update enforce TWO scope-level rules** (`alertRuleValidation.scopeConflictError`). (1) **No duplicate severity** — a second `temperature`/`warning` row in one scope is not additive, it is ignored: `getRoomThresholds` resolves a severity with `.find()`, so which row reaches the ESP32 as `tempWarn` is decided by row order and editing the losing row changes nothing. Also enforced by the DB (`uq_alert_rules_scope_severity`, migration `2026-08-26_alert_rule_scope_uniqueness.sql`, folded into v13) — ⚠️ built on two PERSISTENT generated columns (`scope_device`/`scope_iface`) that fold NULL to `-1`/`''`, because a UNIQUE index treats NULLs as DISTINCT and a global rule is *precisely* one with `device_id IS NULL`; the obvious four-column unique key permits unlimited duplicate global rules (verified on MariaDB 10.4.32). (2) **The severity LADDER** (`severityOrderError`): info < warning < critical, and two severities may never share a threshold — at equal values the milder rule is unreachable, since `worstBreach` always returns the more severe band, so it is a row that looks like a setting and changes nothing. ⚠️ Direction is read from `comparison`, never assumed: `ups_runtime`/`ups_charge` are `<=` where warning 20 / critical 10 is the CORRECT ladder, so a hard-coded "critical is the bigger number" would forbid the UPS rules outright. Scope is matched with `<=>` (null-safe) because a global rule's `device_id` is NULL and `NULL = NULL` is never true — with plain `=` the guard would find no siblings for exactly the global temperature/gas/humidity rules it exists for. The check is skipped when a payload touches none of threshold/comparison/severity, so the activate/pause toggle still works on a scope that is already inconsistent (legacy data, or a row edited straight in SQL) — otherwise an admin would be trapped with no way to fix the rules being complained about. Rules-only: no matching rule = no alert. metric_name: cpu/mem/disk + temperature/gas/humidity + router_cpu/router_mem/router_clients/link_util/link_errors/**router_latency/router_loss**/ups_charge/ups_runtime/ups_load (router/UPS/MikroTik, via deviceAlerts.js — ups_runtime/ups_charge are lower-is-worse, use `<=`). ⚠️ `router_latency`/`router_loss` come from **ICMP**, not SNMP, and are collected on ping-only AND SNMP routers alike: they are the only two things an SNMP walk structurally cannot report (it answers or times out, so a link dropping a third of its packets reads as perfectly healthy), and the only numeric metrics a ping-only router has at all. `router_loss` ships ACTIVE (0% is healthy everywhere); `router_latency` ships INACTIVE because the right number is a property of the link — a rack switch answers in <1 ms and an ISP CPE in 20-40 ms, both healthy — so it is put in front of an admin to set per device. Migration `2026-08-22_icmp_alert_rules.sql`. See `email-popup-notifications.md`
  emailService.js               ← **SMTP (nodemailer)**: sendAlertEmail(to, alert) + sendReportEmail(to, report, pdfBuffer) (inline-styled HTML + plain-text alternative; the report one attaches the stored PDF as a Buffer) + verify()/close(). Sending from a mailbox ON the target domain means Google's existing SPF/DKIM already authorize it — **no DNS work to request from ICTU** — and it delivers to any recipient. Pooled connections (the per-user fan-out is concurrent). No-op if SMTP_USER/SMTP_PASS unset. NOTIFY_EMAIL_TO forces all mail to one address (testing). Check it with `npm run mail:check [recipient]`
  snmpClient.js                 ← thin net-snmp wrapper: standard OID maps (IF-MIB/UPS-MIB), v2c session, get/walkColumn, value normalize (Counter64→BigInt). The `upsOutputSource` enum + its interpreters live in snmpUtils.js and are re-exported here (imported, not `export … from`, since the default-export object needs local bindings)
  snmpUtils.js                  ← PURE, import-free helpers for the SNMP path: validation (badRequest/numOrNull/inRange/UPS_BOUNDS/normalizePort/isValidIp/networkSegment), `computeUtilizationPct` (BUSIER DIRECTION ÷ link speed — full-duplex, so summing rx+tx reads a 100 Mb link at 60+60 as 120%), `counterDelta`, **and the UPS output-source vocabulary**: `UPS_OUTPUT_SOURCE` + `upsOutputState()` folding RFC 1628's seven values into normal|battery|**bypass**|off|avr|unknown, plus isOnBattery/isOnBypass/isOutputOff/isProtected. ⚠️ `isProtected` is written as "NOT one of the three we know are unprotected", never as an allow-list — a UPS reporting other(1) has told us nothing, and turning that silence into an outage pages someone over a firmware quirk (a test asserts exactly this). Tested in `tests/snmpUtils.test.js`
  pingOutput.js                 ← PURE, import-free `ping`-output parser + argv builder for the ICMP fallback. **Reads NUMBERS, `ms` and `=`/`<` — never English words**: `ping` is localized (German `Zeit=15ms`, French `temps=14,7 ms`), and a word-matching parser works on the dev machine then silently reports 100% loss on a differently-localized server — indistinguishable from a dead device. A reply line is identified as "carries BOTH an address and an RTT", which separates it from every summary line on every platform and correctly rejects Windows' "Reply from 10.0.0.1: Destination host unreachable" (an intermediate router, not the target). ⚠️ Timeout flag UNITS differ per platform: Windows `-w` ms, Linux `-W` **seconds**, macOS `-W` ms. Tested in `tests/pingOutput.test.js`
  icmpPing.js                   ← the I/O half: spawns the OS `ping` (argv ARRAY, no shell; host re-validated as an IP first), kills it on a deadline, parses via pingOutput. **Never throws and never rejects** — total packet loss is a legitimate measurement, not an error, unlike collectRouter() which throws because an SNMP timeout leaves no partial sample. A non-zero exit is NOT treated as failure (every platform exits non-zero on any loss, i.e. on exactly the degraded links this exists to measure)
  snmpPollerService.js          ← router/UPS poll loop (load devices → SNMP collect → counter diff → handlers → status/threshold logs); + getNetworkDevices/getUpsDevices reads. **A router needs only an IP**: with a community it is polled over SNMP, without one it falls back to ICMP (`mode: 'ping'` — up/down + latency + loss, no interfaces), which is the only way to watch ISP-owned CPE. ICMP also runs ALONGSIDE each SNMP walk to fill latency_ms/packet_loss_pct (SNMP answers or times out, so a link dropping 40% of packets reads as healthy until it flips to a flat Offline), and on the SNMP failure path the two verdicts are combined so the log distinguishes a dead router from a wrong community / blocked UDP 161. ⚠️ The ping path writes its sample even when the device is DOWN — `reachable` + `packet_loss_pct` are the only two things a no-SNMP router gives, so dropping the point during an outage blanks the chart exactly when it's worth reading. A **UPS** still requires a community (no ping fallback: pinging a battery tells you its management card has power)
  deviceAlerts.js               ← shared router/UPS/MikroTik threshold + event alerting (checkRouter/checkUps), called by the SNMP **and** MikroTik pollers. ⚠️ **UPS output source is three separate events**: `ups_on_battery` (mains lost — powered, protected, clock running), `ups_on_bypass` (⚠️ load on RAW MAINS around the inverter — powered, **zero** protection, no clock; was silent until 2026-08-22 because `isOnBattery` tests only battery(5), so bypass(4) read as a healthy UPS) and `ups_output_off`. All three critical. Booster/reducer (AVR) deliberately raises nothing — the load is still protected and `ups_input_voltage` already alerts on the bad mains causing it. Evaluates metrics against configurable `alert_rules` (alertRulesService.nextBand, band tracked in alertBandState) → raises REAL alerts via notificationService.raiseAlert (bell/email/Alerts page) + device_logs; auto-resolves on recovery (alertsService). Boolean events (interface down, UPS on-battery, device offline/unreachable via checkReachability) raise directly like server offline. Replaced the old device-log-only poller checks. **Interface-down is gated by `linkAlertPolicy`** — see below
  alertBandState.js             ← in-memory per-(device,metric) severity band tracker shared by deviceAlerts (onset-only escalation + recovery)
  envPersistPolicy.js           ← PURE, import-free rule for WHEN an ESP32 reading is worth STORING (not when it is worth acting on — every reading is still broadcast live and evaluated against the alert rules at the full 3s cadence). Report-by-exception: a slow heartbeat (`ENV_PERSIST_INTERVAL_MS`, 30s) PLUS an immediate store on a gas move past a deadband, any status transition, or a real temperature/humidity excursion. A stable room costs 1 point per 30s instead of 10; a smoke event is still captured on the 3s tick that sees it. Chosen over literal per-field intervals because gas-only points would leave most rows with a NULL temperature and `createEmpty:false` would gap the chart. Returns a `reason` naming the gate that fired, so a log line can say WHY a reading was kept. Tested in `tests/envPersistPolicy.test.js`
  linkAlertPolicy.js            ← PURE, import-free rule for WHEN a port with no carrier is a FAULT. An empty socket is down forever and is not news, so four gates must all pass: `monitored` (admin's per-port opt-out, `network_interfaces.monitor_link`) + `adminUp` (not `disabled=yes` in RouterOS / ifAdminStatus≠down — a port switched off on purpose used to be the LOUDEST alert) + `linkUp === false` (an unknown is never escalated into an outage) + `everUp` (`network_interfaces.ever_up`, set by the pollers the first time the port carries a link). Replaces an in-memory first-sighting baseline whose outcome depended on what the cables were doing at backend start — that is why one empty port alerted and three identical ones didn't. Tested in `tests/linkAlertPolicy.test.js`; `npm run link:check` prints the live verdict per port. Migration `2026-08-09_link_alert_gate.sql`
  backupService.js              ← on-site backup writer: mirrors EVERY ingested sample (env/server/router/MikroTik/UPS) to rotating NDJSON files on `BACKUP_DIR` (a micro SD / USB drive on the backend) — an independent copy that survives a DB wipe + a power outage. Buffered flush + synchronous flush on shutdown (UPS low-battery SIGTERM) + daily retention purge. `init()` once at startup. See `backup-storage.md`
  reportService.js              ← REAL reports (MySQL `reports` + on-disk CSV/PDF per report under backend/reports/). **Async**: create() records a `pending` row (route answers 202), build() gathers the data live from InfluxDB (sensor_environment / server_metrics / router_metrics + network_traffic / ups_metrics) + MySQL (alerts / aircon_logs), writes both files, flips status → generated|failed and pushes `reportUpdated` to `user:<id>` (`init(io)` once at startup). build() NEVER throws — it runs fire-and-forget after the response. Types: environment|server|network|ups|alerts|aircon. **Per-device scope** via `device_id` (migration `2026-08-02_report_device_scope.sql`), gated by `SCOPE_TYPES` which also drives GET /scope-options; environment is campus-wide and rejects a scope. Also list/fileFor(download name = title + period)/remove/email(PDF via emailService)/purgeOld(REPORT_RETENTION_DAYS, row + files). Backs `routes/reports.js`. **Since 2026-08-28 every report carries an IDENTITY BLOCK** (`report.meta`) — type, subject, monitoring period, date created, and **Responsible**, the user who generated it: `BASE_SELECT` had joined `users.name` all along for the Reports page and it was simply never carried into the document. **`buildServer` follows ICTU's own outline**: identity → Server Availability (uptime/downtime/%/incidents, from `availabilityMath`) → Resource Utilization (CPU/mem/disk **+ network**, whose `net_bytes_*` were collected from day one but never reported — ⚠️ they are CUMULATIVE counters, so they go through Flux `increase()`, never `mean()`, exactly as the SNMP byte counters do). Scoped to one server the identity is a header; unscoped it becomes a **Servers Monitored** table, since there is no one IP to put in a header. `claimReference` assigns the control number **during build and only on success** — a failed report must not consume one, because a gap in a filing sequence is a question somebody later has to answer — and the UNIQUE index, not the COUNT, is the arbiter when two builds race. Migration `2026-08-28_report_template.sql`. See `report-page.md`
  reportRenderer.js             ← turns a normalized report ({summary, table} or {summary, tables:[…]}) into CSV + PDF (pdfkit). Store-agnostic — layout only. ⚠️ **`csvCell` neutralises spreadsheet FORMULAS, not just RFC 4180 quoting.** A cell starting `= + - @` TAB or CR is executed by Excel/LibreOffice/Sheets on open, and that text is reachable: a report `title` comes from the request body, and device names come from `devices.device_name`, which `agentService.register` fills from the **agent-supplied hostname with no character validation** — so a host enrolling as `=cmd|'/c calc'!A1` plants a formula that fires later on a staffer's PC. Guarded with a leading apostrophe. ⚠️ Numbers are deliberately EXEMPT (`Number.isFinite`): `-12.5` starts with `-`, and prefixing it would make every negative measurement a text cell and silently break every SUM in the sheet. Tested in `tests/csvSafety.test.js`. See audits/file-handling-security-2026-08-25.md — FU-01. ⚠️ **Page size, timestamps and the letterhead are no longer constants.** `size` comes from `report.paperSize` (ICTU picks per report; **Folio/long bond is the default, not A4**), every timestamp renders in **Philippine time** via `reportTemplate.formatPH`, the two logos arrive as absolute paths on `report.branding` (resolved by reportBrandingService, so an admin's upload beats the bundled mark), and the identity block is `report.meta` — label/value rows the SERVICE builds, so adding a field never means touching the layout. **THREE signatories** now: Prepared by / Noted by / Approved by, all confirmed by ICTU on 2026-08-26
  reportTemplate.js             ← PURE, import-free rules for how a report LOOKS — all of it ICTU's answers on the 2026-08-26 questionnaire (`reports-client-questionnaire.md`). `PAPER_SIZES` (⚠️ **folio is 8.5x13in, long bond — NOT US Legal 8.5x14**; given in POINTS because pdfkit has no name for folio) + `normalizePaperSize` (folds junk back to folio so a hand-edited settings row cannot fail a build — the ROUTE validates strictly instead, so a human's typo is still a 400) + `formatPH`/`philippineYear` (⚠️ shifts the instant then reads it back with the **UTC** getters; the local getters would add the server's own offset on top and be right only on a machine already set to UTC — a bug that passes every test on a laptop in Manila) + `referenceNo`/`TYPE_CODE` (`ICTU-SRV-2026-001`, ICTU's own sample shape; codes are pinned so renaming a type cannot re-letter documents already filed) + `sniffImageType`/`logoFileName` (upload validation by **leading bytes**, never the declared Content-Type — SVG is refused outright because it is XML with script in it). Tested in `tests/reportTemplate.test.js`
  reportBrandingService.js      ← the I/O half of the template: MySQL `settings` (its FIRST rows — the table shipped in v13 and had never held one) plus the uploaded logo files. Resolution is uploaded → bundled → nothing, and the `existsSync` on the uploaded file is not paranoia: the settings row and the file are two pieces of state that drift the moment someone restores a DB dump without `backend/branding/`. Uploads land in `backend/branding/` (gitignored, RUNTIME data), never in `assets/branding/` (committed source — the fallback a fresh clone renders with). One fixed filename per slot, so an upload REPLACES rather than accumulating one file per upload in a directory nothing prunes
  availabilityMath.js           ← PURE, import-free uptime/downtime/percentage/incidents for the **Server Availability** section ICTU asked for. ⚠️ **Its source is the `alerts` table, NOT the agent's `uptime_seconds`** — that counter resets to zero on every reboot, so it answers "how long since this box last booted", while availability asks what share of THE PERIOD the server was reachable across however many reboots. Outages are clamped to the window (one that began last month is not a month of this month's downtime) and **MERGED** before summing: raw overlapping rows double-count, and enough of them push downtime past the period, which prints a NEGATIVE uptime. Incidents are counted off the MERGED set so the count and the duration describe the same object. Planned downtime never appears — `setMaintenance` stops the offline sweep, so no alert is raised — which makes this UNPLANNED availability. Tested in `tests/availabilityMath.test.js`
  handshakeLimiter.js           ← PURE, import-free Socket.IO handshake throttle + `clientIpFrom`. **The Express rate limiter cannot see /socket.io/** — Socket.IO installs its own `request` listener on the HTTP server and answers those itself, so the Express app (and `globalLimiter`) is never invoked. That left the one endpoint accepting `DEVICE_SECRET` with NO attempt limit while every HTTP credential path had one, and every handshake carrying a well-formed JWT costs a `fetchSessionRow` out of a MySQL pool of 10. Counts REJECTED handshakes only and a success CLEARS the key — a plain per-IP cap would be the self-inflicted DoS CLAUDE.md warns about elsewhere, since behind nginx every browser socket arrives from 127.0.0.1 and behind the campus NAT every agent shares one address. `clientIpFrom` reproduces Express's numeric `trust proxy` semantics exactly (`[peer, ...XFF reversed]`, index = hops, clamped) so the socket buckets by the same address `req.ip` yields. Tested in `tests/handshakeLimiter.test.js`
  socketSessions.js             ← live-socket session revocation. `io.use` authenticates ONCE at the handshake and Socket.IO never re-verifies, so a connection opened with a valid token outlived its session — disable an account and its HTTP calls fail instantly while the open socket kept streaming. `init(io)` starts a sweep (`SOCKET_REVOKE_SWEEP_MS`, 30s) that re-checks every connected BROWSER socket against `users` (missing / not active / `token_version` ≠ the socket's `tv` claim), emits `sessionRevoked` then `disconnect(true)`. ⚠️ Deliberately ignores the token's `exp`: HTTP sessions slide (auth.js re-issues past half-life), so kicking on exp would black out valid, actively-used dashboards every hour — idle expiry stays the client's job
  policyService.js              ← Privacy Notice & Terms acceptance (RA 10173 / Data Privacy Act of 2012). Owns `POLICY_VERSION` (the version IN FORCE — a constant, not a table row, so the gate can't be silenced by editing data) + `getAcceptance` + `accept` (writes `users.policy_version`/`policy_accepted_at` AND the `system_logs` evidence row in ONE transaction — unlike every other audit write in this codebase it is NOT best-effort, because the audit row *is* the evidence) + `resetAll`. The version recorded is always the server constant, never a client-supplied value. Bump `POLICY_VERSION` when the notice's SUBSTANCE changes and everyone re-accepts at their next sign-in. Backs `routes/policy.js`. Migration `2026-08-11_policy_acceptance.sql`
  auditService.js               ← audit(): append a user action to `system_logs` (module: auth|aircon|users|alerts|reports|devices|network) — the trail the **History** page reads. Best-effort BY DESIGN: an audit-write failure never breaks the action. Report generate/download/email/delete all log here
  serverMetricUtils.js          ← PURE helpers for the server-metric path (NUMERIC_FIELDS, validateSample, sanitizeVolumes, sanitizeInterval, formatUptime, offlineWindowSec, backfillTimestamp). **Deliberately import-free** so `backend/tests/` runs with no MySQL/InfluxDB/.env. Imported by serverMetricsHandler + agentService
  historyRange.js               ← PURE range resolver shared by the history endpoints: presets (`-1h/-6h/-24h/-7d/-30d`, each window sized to ~150-200 points) **plus a custom absolute window** (`?start=&stop=` ISO, `stop` defaults to now). Sizes a custom window's aggregate from its span so any range draws at the same density. Owns the Flux-injection guarantee — presets are whitelisted and custom bounds are re-serialised from `Date`, so no user text reaches the query; a malformed CUSTOM window is a 400 while an unknown PRESET still falls back to `-1h`. Also **import-free** (tested in `tests/historyRange.test.js`). Used by serverHistoryHandler; networkHistoryHandler + upsHistoryHandler have the identical shape and should adopt it
  analyticsMath.js              ← PURE predictive-analytics math — `linearRegression`/`score` (R²/MAE), `splitTrainTest`/`validate` (CHRONOLOGICAL 80/20 — never shuffle a time series), `percentile`, `ewma`, `holtLinear`, `forecastSeries` (project to a ceiling → disk ETA), `projectToBound` (down to a floor for UPS runtime, up to a ceiling for link util), `worstVolumeForecast`, plus the ETA gates (`MIN_ETA_R2` 0.4 / `MAX_ETA_DAYS` 365 / `MIN_POINTS` 6) and the advisory copy. **Import-free** like serverMetricUtils/historyRange, so `tests/analyticsMath.test.js` runs it with no MySQL/InfluxDB/.env. See `predictive-analytics.md` §15
  analyticsService.js           ← the I/O half of Predictive Analytics: InfluxDB reads + MySQL reads + result shaping (the math is in analyticsMath.js). `forecastDiskFull` regresses **every volume** (`server_volumes`, per `mount`) and headlines the fastest-filling one — matching agentService's worst-volume alerting; `forecastUpsBattery` (`ups_metrics.runtime_remaining_min` → replacement ETA), `forecastLinkSaturation` (`network_traffic.utilization_pct` per interface → saturation ETA), `forecastTrend` (**additive Holt-Winters**: the daily hour-of-day shape is subtracted, Holt fits the remaining drift, the shape is added back, and the whole projection is anchored to the last observation with a 3 h linear fade — plus threshold-crossing advice from `alert_rules`. EWMA is display-only and is deliberately NOT fed to the fit. ⚠️ It was plain Holt's LINEAR on the EWMA until 2026-08-15, which draws one straight line: asked at 11 PM for 12 h it extrapolated the evening's falling limb through dawn into midday, forecasting the day's coolest figure for the hour the room is hottest — ~8 °C out, in the wrong direction, and opening ~2 °C away from the reading shown beside it. Lookback floor is now 48 h and the default 168 h, because an hour-of-day profile needs several cycles to average over; below that it falls back to the straight line and reports `seasonal: false`), `detectAnomalies` (per-hour-of-day z-score + IQR), `recommendThresholds` (p95/p99 vs current global rules), `alertSummary` (MTTR etc. over MySQL `alerts`). **Device names resolve from MySQL** (`COALESCE(NULLIF(display_name,''), device_name)` + `device_type` + `network_interfaces.location_label`) — NOT the frozen InfluxDB `device_name` tag, so a renamed device reads the same here as everywhere else (`predictive-analytics.md` §14). Backs `routes/analytics.js`
backend/scripts/rekeySecrets.js  ← `npm run rekey`. THE ROTATION PATH that did not exist: four columns hold AES-256-GCM ciphertext and the documented answer to "how do I change the key?" was "you don't" — a key you cannot rotate is a key you must never lose, which is not a security property. Report / `--encrypt-plaintext` / `--from-key <old> [--apply]`. Rotation decrypts and re-encrypts EVERY row in memory before writing any of them: a half-finished rotation leaves rows split across two keys and then neither key opens the table. ⚠️ `mikrotik_devices.api_password` is pinned to MIKROTIK_ENC_KEY while the other three take SECRET_ENC_KEY (falling back to it), so `--suite` exists — and defaults to `both`, because doing one and forgetting the other is the failure mode
backend/tests/                  ← `npm test` (`node --test`, zero deps). `contract.test.js` PARSES `agent/internal/collector/metrics.go` and fails if its json tags drift from NUMERIC_FIELDS — the guard for the hand-duplicated Go↔Node metric contract. `analyticsMath.test.js` pins the regression/ETA behaviour, incl. the confidence gate (a noisy series must yield NO ETA)
backend/handlers/
  sensorHandler.js              ← validates, writes InfluxDB, broadcasts to browsers + raises per-metric room-level alerts (temperature/gas/humidity) on band escalation, evaluated against `alert_rules` (alertRulesService) — replaces the old firmware-status escalation. ⚠️ The InfluxDB write **and** the backup copy sit behind `envPersistPolicy.shouldPersist` (both inside the same gate — a backup that diverged from what was stored could not restore the database). Everything else runs on every 3s reading. The last-stored baseline is module-level, not per-socket: the ESP32 gets a new socket on each reconnect
  querySensorHistoryHandler.js  ← Flux queries, emits sensorHistory. ⚠️ **No `WINDOW_MAP` entry may be smaller than `ENV_PERSIST_INTERVAL_MS`** — a stable room yields one point per 30s, so a shorter window would mostly be empty and `createEmpty:false` drops empty windows, gapping the chart. `-30m`/`-1h` were 10s/20s when every 3s reading was stored and are now 30s/1m; raising the store interval means raising these with it. ⚠️ `sensor_environment` is written with three TAGS (smoke_status/temp_status/environment_status), so they sit in the Flux group key and split the result into **one table per status combination**. The numeric query therefore does `group(columns: ["_field"])` BEFORE `aggregateWindow` — without it (a) `sort()` only orders rows within each table while `queryRows` streams table by table, so a 30-day range came back Jul→Aug, Jul→Aug and the x-axis read "Jul, Aug, Jul, Aug"; and (b) `fn: mean` averaged each status subgroup separately, emitting several partial means at the same `_time` of which the dedupe map kept whichever streamed last. Short ranges hid both, because the statuses rarely change within an hour (one table). The result is also sorted by time in JS before emitting, since the array's order is really the map's insertion order
  offlineDataHandler.js         ← ESP32 micro-SD backfill: rows buffered while the socket was down, replayed on reconnect. Writes InfluxDB under the DEVICE's timestamp + mirrors to backupService (so the on-site backup has no hole across the outage), batched behind one debounced flush. **No broadcast and no alert evaluation** — it is history, and a smoke alert for air that cleared an hour ago is a false alarm with a real siren on it. Not re-gated by envPersistPolicy: the firmware applied the same deadbands before writing each row. See Environment.md §4.2
  serverMetricsHandler.js       ← agent metric POST → InfluxDB (`server_metrics` + per-volume `server_volumes`) + broadcast `serverMetrics`; also routes the agent's hourly optional `host` object to agentService.refreshHostInfo and skips threshold alerting while the server is in maintenance. Exports `serverMetricsBatchHandler` too (POST /metrics/batch) — **backfill of samples the agent buffered during an outage: InfluxDB + backup ONLY, no heartbeat/status/alerting/broadcast**
  serverHistoryHandler.js       ← Flux query on `server_metrics` for GET /api/servers/:id/history. Range presets + the **custom absolute window** (`?start=&stop=` ISO) come from `services/historyRange.js`
  networkMetricsHandler.js      ← router sample → InfluxDB (`router_metrics` + per-iface `network_traffic`) + broadcast `networkMetrics`
  upsMetricsHandler.js          ← UPS sample → InfluxDB (`ups_metrics`) + broadcast `upsMetrics`
  networkHistoryHandler.js      ← Flux on `network_traffic` (derived throughput) for GET /api/network/:id/history
  upsHistoryHandler.js          ← Flux on `ups_metrics` for GET /api/ups/:id/history
backend/sockets/connectionHandler.js  ← all socket events, device vs browser segregation
backend/middleware/
  auth.js                       ← authMiddleware, requireRole(...roles), JWT_SECRET export. **`requireRole` now LOGS its 403s** (`[AUTHZ]`) — it was the one authorization outcome in the codebase never written down, across 33 role-gated routes, while sign-ins, denied sign-ins, 429s, the policy gate and socket rejections were all logged. Operational log, not `system_logs`: it fires on every mis-click of a nav link a role cannot use. See audits/logging-monitoring-2026-08-25.md — LM-02
  agentAuth.js                  ← Bearer `AGT-…` token auth for agent metric POSTs
  securityHeaders.js            ← PURE, import-free response headers: nosniff, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, a `default-src 'none'` CSP, and HSTS **only over real TLS** (`req.secure`). `X-Powered-By` is disabled alongside it. Hand-written rather than `helmet` for one load-bearing reason: **Express here serves JSON and nothing else** — the dashboard's HTML/JS/CSS come from nginx (`deployment-guide.md` §5.3.1), so helmet's page-shaped CSP defaults would be applied to the wrong artifact, and the page CSP that actually matters has to live in the nginx config. Mounted BEFORE the routes and the limiter so a 429 and a 404 carry the headers too. Tested in `tests/securityHeaders.test.js`

frontend/src/
  index.css                     ← Grafana --gf-* design tokens + JetBrains Mono
  chart/ChartConfig.ts          ← one-time Chart.js registration, imported for side effects. **No zoom plugin**: `chartjs-plugin-zoom` + `hammerjs` backed the Environment page's scroll-to-zoom / drag-to-select and were removed with it (−38 kB from the bundle). The **RangePicker is the only way to change a chart's window.** ⚠️ Charts use a CATEGORY x-axis of preformatted label strings, so a tick callback's `index` argument is the position among the ticks Chart.js chose to DRAW (0…maxTicksLimit-1), NOT the data index — pass the callback's `value` (or `ticks[index].value`) to `getLabelForValue`. Using `index` labelled all seven ticks from the first seven samples, which is why a tick could read "Jun" while the tooltip on that same point read "Jul"
  App.tsx                       ← route tree + ProtectedRoute
  config.ts                     ← backend URL: auto-detects from page host:3000, VITE_API_URL override
  api/
    client.ts                   ← Axios instance, auto-attaches Bearer token (baseURL from config.ts)
    api.ts                      ← all API calls, all return ApiResult<T>
  components/dashboard/
    ServerFocus.tsx             ← the Dashboard's per-server trend: four live tiles (CPU/Mem/Disk/Network) + ONE chart carrying CPU, memory and disk on a **pinned 0-100% axis**. One axis because all three share a unit — three auto-scaled mini-charts make a 2% wobble and a 40% climb look identical; pinning it stops a flat-but-noisy metric being magnified into a dramatic climb. Throughput is bytes, so it is a tile, not a fourth line. Series hexes are ServerDetail's unchanged (CPU `#378ADD`, memory `#7F77DD`, disk `#EF9F27`) — a reader who learns "blue is CPU" on one page must not re-learn it on the other. Seeds from `GET /api/servers/:id/history` then tails `serverMetrics`; the TILES read the Dashboard's own live row, not the chart, so they stay current on a range whose last aggregated point is minutes old. Deliberately not a copy of ServerDetail — that page is the full read (four charts, per-volume, specs, logs); this is the glance
  components/layout/
    Sidebar.tsx                 ← Grafana-style nav, SVG icons, theme toggle
    Header.tsx                  ← 40px topbar, breadcrumb navigation
  context/
    AuthContext.tsx             ← login/logout, manages socket connect/disconnect
    ThemeContext.tsx            ← dark/light mode
  socket/socket.ts              ← shared Socket.IO client, autoConnect: false
  data/users.ts                 ← roleConfig: role → { label, color, allowed pages[] }
  utils/envThresholds.ts        ← PURE (import-free) **temperature + humidity + gas colour**, driven by the room-level `alert_rules` — `temperatureColor`/`gasColor`/`humidityColor` (+ `*Label`), `bandFor`/`tempBand`, `alertTint`, `withAlpha`, `ROOM_THRESHOLD_FALLBACK`, `TEMP_COLD_BELOW`. Green normal / orange warning / red critical, changing at exactly the point the system raises the alert; temperature adds a blue TOO COLD below `TEMP_COLD_BELOW` (22 °C), which mirrors the firmware's `TEMP_COLD` — the one threshold `envConfig` does NOT overwrite, so there is no rule to read it from (⚠️ change one, change the other). Replaces Dashboard's hardcoded `GAS_WARN = 150`/`GAS_CRIT = 300`, which sat under a comment asking whoever retuned the rules to retune the constants too. `bandFor` is always HIGHER-IS-WORSE (`>=`), matching every seeded env rule, the firmware (`t >= TEMP_WARNING`) and `alertRulesService.compare`. ⚠️ It must NOT infer the direction from the bounds: an earlier version read `crit < warn` as lower-is-worse and flipped both comparisons, which broke precisely when someone TESTED a rule — dropping the critical threshold below the live reading leaves it under the untouched warning threshold, and every band came out scrambled. A lower-is-worse env rule needs `alert_rules.comparison` plumbed through `getRoomThresholds()`, deliberately not done because that flat shape is also the `envConfig` payload the ESP32 parses. **`alertTint`** keeps a reading's identity hue while normal and switches to orange/red only on breach — it is what **humidity and both MQ-2 sensors** use, on tiles and lines alike. `humidityColor`/`gasColor` are the full-band variants (green when normal); only the Dashboard's aggregate Air Quality tile still uses one
  utils/tempZone.ts             ← PURE (import-free) auto-cooling ZONE resolution: `zoneOf`/`tempZone`/`tempColor`/`tempZoneLabel`/`zoneColor` + `ZONE_DEFAULTS`. Comparisons mirror the firmware's `getIRZone` exactly (`<` cold edge, `<=` the rest), so the page never names a zone the ESP32 is not in. ⚠️ **AirConditioner page ONLY** — that page is about the cooling zones, names the active one outright and lets an admin edit the boundaries, so colouring by zone is its subject matter. Dashboard + Environment colour temperature from the ALERT RULES instead (envThresholds.ts): cooling ramps before the alarm, so only the cooling PAGE paints with the cooling numbers
  hooks/useRoomThresholds.ts    ← the room-level alert thresholds, kept current: GET /api/environment/thresholds once, then follows the `envConfigUpdated` broadcast. Starts on `ROOM_THRESHOLD_FALLBACK` (the v13 seed) — starting empty would mean "no rule, no colour", painting a smoke reading green for as long as the request takes
  pages/                        ← one file per page

iot/esp32/env_monitor_v2/env_monitor_v2.ino    ← current firmware (active)
agent/                          ← standalone Go monitoring agent (enroll → approve → POST metrics); see server-metrics.md + agent/README.md
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
> ⚠️ **A stored session is never trusted without checking the token is still alive.** `sessionStorage` outlives what people assume: it survives a reload, and Chrome's **"Continue where you left off"** restores it *along with the tab* — so a laptop restart can hand the app a token that died two days ago. Restoring `cspc_user` on its own booted straight into the dashboard, fired every panel's request with the dead token, collected a screen of 403s and bounced to `/login` — which reads exactly like "signed out immediately after signing in", and only on machines that restore tabs. Three guards, each covering a moment the others never reach: **`AuthProvider` mount** (a tab that loads), the **axios request interceptor** (any request, in a tab already running — the only one that reaches a tab open for days), and the **`/login` mount wipe** (being on the sign-in page means the stored credentials are dead by definition). Expiry is measured by `msUntilTokenExpiry()` in `api/client.ts`, exported so both sides use one rule: it takes `exp - iat` (both server-clock, so skew-free) from `cspc_token_at` (our clock) — never `exp` against `Date.now()`, which mixes clocks and logs out anyone whose machine drifts. `middleware/auth.js` logs the real `jwt.verify` failure (`TokenExpiredError` vs `invalid signature` vs `jwt malformed`) plus `from=`/`ua=`; the client's `"Invalid or expired token."` hides all three, and the server listens on `0.0.0.0`, so a rejection can come from any device on the LAN.

- JWT signed with `JWT_SECRET`, expires 1 h, stored in `sessionStorage` as `cspc_token`. Carries a `tv` (token_version) claim; `authMiddleware` rejects the token when `users.token_version` / `status` no longer match (logout, disable, role change bump it — server-side session revocation)
  > **Bounded sliding session + issuer/audience (2026-08-25).** The token also carries **`ist`** (session start), stamped once at sign-in and preserved across every renewal, and `middleware/auth.js` stops renewing past `SESSION_MAX_HOURS` (blank = 12). Without it the sliding window had no ceiling: this dashboard polls constantly and can live on a wall display, so any token renewed itself forever and a stolen one could be kept alive indefinitely. It declines to renew rather than 401-ing, so the token dies at its own `exp` and the client's existing expiry path handles it. `iss`/`aud` are now enforced on every verify from ONE frozen definition (`JWT_VERIFY_OPTS`/`JWT_SIGN_OPTS` in middleware/auth.js), consumed by all five sign/verify sites — the middleware, the renewal, `issueSession`, the Socket.IO handshake and the rate limiter's user key. ⚠️ The renewal MUST strip `iss`/`aud` along with `iat`/`exp`/`nbf`: `jwt.sign` throws when an option duplicates a payload claim, so leaving them makes every renewal a 500 — and only for users past a token's half-life, which no quick manual test reaches. Pinned in `tests/jwtClaims.test.js`.
  > **Authorization reads the DB role, not the token's.** `authMiddleware` already fetches the row for the liveness check, so it overrides `req.user.role` from `users.role` at no extra cost. `updateUser` bumps `token_version` on a role change, but that is one code path remembering a counter — and a role edited directly in SQL (the documented way the first admin is made, `deployment-guide.md` §4.3) bumps nothing. Same reasoning `socketSessions` gives for being a sweep rather than a push. `permissions` in the payload is untouched: it drives nav links, never a server-side decision.
- Socket.IO: browsers send JWT in `socket.handshake.auth.token`; the ESP32 device key is read from `socket.handshake.auth.deviceKey` → `headers["x-device-key"]` → `.query.deviceKey`, in that order. The firmware sends the **header** (`setExtraHeaders`, since 2026-08-16) because EIO3 has no `auth` payload — that arrived in Socket.IO v3. The **query fallback is deprecated**: a query string is written verbatim into proxy/access logs, so the shared secret used to appear in every log line the handshake touched. Keep the fallback until every ESP32 in the field is reflashed, then delete it — removing it early silently strands an un-updated box
- Go agents authenticate metric POSTs with a Bearer `AGT-…` token (`middleware/agentAuth.js`); first-run enrollment uses an **`AIK-…` install key** from `agent_install_keys` (admin-minted, revocable, optional expiry — `services/installKeyService.js`), with the legacy `.env` `AGENT_INSTALL_KEY` as a deprecated fallback.
  > **NOTHING in `agent_tokens` is stored in readable form (both migrations, 2026-08-25 + …-25b).** The PENDING token (`pending_token_hash`) matters as much as the permanent one: `POST /api/agents/status` exchanges it for the live `AGT-` credential, and that exchange keeps working **after** approval, **repeatedly**, on a route with **no auth**. So a plaintext pending token was the permanent credential one unauthenticated HTTP call away — hashing `approved_token` alone did not close the dump path. Hashing it became possible by having `register()` mint a **FRESH** pending token every time instead of handing the stored one back; nothing depended on it being stable (the agent keeps it in memory only, never in `agent.conf`), and recovery is still gated by the `AIK-` install key that `/register` demands.
> **Neither credential is stored in readable form.** `agent_install_keys` keeps a SHA-256 hash + an AES-GCM copy for re-display; `agent_tokens` now does the same (`approved_token_hash` + `approved_token_cipher`). This matters because `ops/db-backup/dump-mysql.sh` dumps the whole database into `BACKUP_DIR` and `ops/offsite-backup/sync-offsite.sh` rclone-copies that folder **offsite** — so a plaintext credential column is a credential on cloud storage. The short **pending** enrollment token (`agent_tokens.token`) is still readable and is the one known gap; see audits/api-infra-security-2026-08-25.md §6.
  > **A key also OWNS what it enrolled.** `agent_tokens.install_key_id` records which key let each machine in, so revoking a key can *optionally* de-authorise those servers too — the branch model: one key per office, revoke it and that office's servers stop reporting. `POST /install-keys/:id/revoke` takes `{ revokeAgents }`; `GET /install-keys/:id/servers` lists the blast radius so the UI can name them first.
  > ⚠️ **Cutting agents off is opt-in, never an implicit side effect.** "Stop issuing this key" and "de-authorise its whole fleet" are both legitimate and differ by a fleet's worth of monitoring going dark. If it were automatic an admin could never tidy up a stale rollout key without taking servers down, so in practice they'd stop revoking keys at all. Set `revokeAgents:true` and the tokens go to `status='revoked'` → the agent's next POST 403s → it deletes its own `agent.conf` and exits (`agent/cmd/agent/main.go`). The **device row, its logs and its InfluxDB history are kept**, and `agentService.register` re-arms a `revoked` enrolment onto the *same* `device_id` — so re-installing with a live key brings the server back as itself rather than forking its time-series. Per-server revocation without touching a key is still `DELETE /api/servers/:id`.
- `socket.isDevice = true` for ESP32, `false` for browsers

| Role | DB value | Access |
|------|----------|--------|
| Admin | `admin` | all pages + user management (approves registrations) + alert rules (configurable thresholds) |
| IT Staff | `it_staff` | dashboard, server metrics, network, ups, environment, aircon, **alerts (acknowledge/resolve)**, history, reports |

> Login no longer uses passwords. `users.hash_password` is nullable and **all-NULL**; `users.status` gained `pending`/`rejected`; new columns `google_sub` + `auth_provider`.
> **The password code is GONE (2026-08-25), not vestigial.** `PATCH /users/me/password`, `POST /users`, `userService.createUser`, `userService.changeOwnPassword`, the `bcryptjs` dependency and the two dead `api.ts` functions were all removed. Nothing read `hash_password`, so no password set through them could ever authenticate anyone — and since every row is a Google account with a NULL hash, `bcrypt.compare(input, null)` **throws** (`Illegal arguments: string, object`), so the change-password endpoint answered **500** to every user who could reach it. A live auth endpoint nobody calls, tests or reads is where a real vulnerability survives. Accounts now arrive by exactly one route: Google self-registration → admin approval; the first admin is promoted by hand (`deployment-guide.md` §4.3). See audits/auth-flow-security-2026-08-25.md — AF-03.

> **Privacy Notice & Terms acceptance is a BLOCKING gate after sign-in, not a login checkbox.** Before the Google round-trip nobody has identified themselves, so a checkbox on the login page could not be attributed to a person — it would be a client-side flag, bypassable by clearing `sessionStorage`. Instead `AppShell` renders `components/legal/PolicyGate.tsx` **instead of** the dashboard (no sidebar, no routes, no socket pages) whenever `user.policy_version !== user.policy_current`, and `POST /api/policy/accept` writes the acceptance + an audit row naming the user, version, time and IP. The document lives in **one** component (`pages/legal/PolicyDocument.tsx`) rendered by both the gate and the **public** `/privacy` page — the text someone agrees to must be the text anyone can read without an account, and two copies would drift invisibly. `/privacy` is checked in `App.tsx` **before** the unauthenticated redirect for exactly that reason, and `GET /api/policy/version` is public so the page can stamp itself with the version in force. The gate fails **open** if `policy_current` is absent (an older cached session object) — locking every user out of the dashboard over a missing field is worse than one un-gated session. **⚠️ That client gate is now backed by a SERVER-SIDE one (2026-08-25).** `App.tsx` decides what React *renders*; it never decided what the TOKEN could do, so an `active` user who had never accepted held a completely ordinary session and could drive the whole API with curl — two of four live accounts were in exactly that state. `middleware/auth.js` now rejects **mutating** requests (POST/PUT/PATCH/DELETE) with **403 `policy_not_accepted`** when `users.policy_version` ≠ `POLICY_VERSION`, exempting `/api/policy/*` and `/api/auth/*` so the user can still read who they are, accept, and log out. It reuses the row already fetched for the liveness check, so it costs no extra query. 403 not 401 — `api/client.ts` logs out on 401 and deliberately not on 403, so a 401 here would loop the sign-in. Scoped to writes because every write lands an attributable `system_logs` row and consent should precede an attributable action; widen by deleting the `MUTATING.has(...)` term. See audits/business-logic-review-2026-08-25.md — BL-01. Contact/retention figures in the notice are real (`SYSTEM_LOG_RETENTION_DAYS` 365 / `NOTIFY_RETENTION_DAYS` 30 / `REPORT_RETENTION_DAYS` 90 / `BACKUP_RETENTION_DAYS` 30) — **change the code and you must change the notice.** ⚠️ The text is accurate but is a binding institutional commitment: it needs ICTU/DPO review before go-live. Full guide: `privacy-policy.md`.

> **Profile editing is username-only.** `name`, `email` and `profile_image` belong to Google — `googleAuthService` re-syncs them from the ID token on **every** sign-in (`userService.syncGoogleProfile`), so an edit would silently revert at the next login, and `email` is the identity key the login matches on. Both the **My Profile** modal (`components/layout/ProfileModal.tsx`) and the admin **Edit User** modal show them read-only; the avatar **upload** path is gone (`PATCH /users/me` no longer takes multipart, and `middleware/upload.js` has been deleted). `userService.updateOwnProfile` accepts `username` only, and `updateUser` accepts `username`/`role`/`status` only — the latter now uses `COALESCE` so an omitted field can never blank a column.

### Formerly-mock endpoints (all now real)
- `routes/environment.js` is **no longer mock.** GET `/history` + `/logs` (random data / five rows hardcoded to March 2025) are **removed**; `GET /daily` returns a real InfluxDB-backed per-day summary via `services/environmentService.js`, and live sensor history remains a Socket.IO concern (`changeRange` → `sensorHistory`). The file also serves `POST /calibrate-gas`, `GET /sensor-status` (see ESP32 Firmware Notes) and **`GET /thresholds`** — the room-level alert thresholds (`alertRulesService.getRoomThresholds()`, the `envConfig` shape) that the dashboards colour humidity and gas against, admin + it_staff. It lives here and **not** on `routes/alertRules.js` deliberately: that router is `requireRole("admin")` from its first line down, and a both-roles route slipped in above the gate is exactly what a security read of the file would miss. Rule **mutation** stays admin-only where it was.
- **`routes/reports.js` is now REAL** (the last mock, now gone): `services/reportService.js` persists to the `reports` table and writes a CSV **and** PDF per report under `backend/reports/` (git-ignored). `POST /api/reports` (admin + it_staff) builds the dataset **live** from the stores per `type` (environment → InfluxDB `sensor_environment`; server → InfluxDB `server_metrics`; **network → InfluxDB `router_metrics` + `network_traffic`, covering SNMP routers *and* the MikroTik**; **ups → InfluxDB `ups_metrics`**; alerts → MySQL `alerts`; aircon → MySQL `aircon_logs`) for the chosen `{periodStart, periodEnd}`, then `GET /api/reports/:id/download?format=csv|pdf` streams the saved file (download name = title + period) and `DELETE /api/reports/:id` (admin) removes the row + files. UI = **Reports** page (`pages/Reports.tsx`, Grafana-styled: a list of generated reports and nothing else). The **Generate modal is horizontal** (`max-w-5xl`, type cards beside scope/title/paper/period, footer pinned outside the scroll area — stacked, seven type cards pushed Generate below the fold) and carries a second **Report template** tab, admin-only, holding the paper-size default, the letterhead unit line and both logo uploads. That panel used to sit under the report list, which put configuration that changes a few times a year permanently below what people come to the page to read. Each row **expands on click** into a detail drawer (same pattern as ServerMetrics `ServerDrawerRow`) showing reference number, scope, paper size, full PHT period and who generated it — everything that decided what the PDF looks like, all of which was invisible once the report existed. ⚠️ Every action in the row calls `stopPropagation()`, or downloading would also toggle the drawer. Needs the `pdfkit` dep. **Four template routes** sit alongside (`GET /template` both roles — the Generate modal needs the size options; `PUT /template/paper-size`, `POST /template/logo/:slot`, `DELETE /template/logo/:slot`, all admin), declared BEFORE the `/:id` routes so a literal path can never be parsed as an id. ⚠️ The logo upload takes a **RAW body** via `express.raw({ type: ["image/png","image/jpeg"] })`, not multipart and not base64: `middleware/upload.js` was deleted with the avatar feature, base64-in-JSON would inflate the payload by a third and then fight the 100 kB `JSON_BODY_LIMIT` that protects every other route, and `express.raw` is already in Express and yields the Buffer both the content sniff and `writeFileSync` want. The declared Content-Type only decides whether the body is parsed — what the file IS gets decided by its leading bytes in `reportTemplate.sniffImageType`. Full guide: `report-page.md`. **Note:** the **notifications** feature (`routes/notifications.js` + `services/notificationService.js`) writes the **real** `alerts` + `alert_notifications` tables, and both the bell feed and the **Dashboard "Alerts" panel** render that real per-user feed (via `NotificationContext`). See `email-popup-notifications.md`.
> **Authorization is enumerated and audited (2026-08-25).** 99 routes: 75 JWT-gated (33 also role-gated), 2 agent-token, and **5 deliberately unauthenticated** — `POST /auth/google` (issues the session), `GET /policy/version` (public so `/privacy` can stamp itself without an account), `POST /agents/register` + `POST /agents/status` (install-key / pending-token auth). A 6th, `GET /aircon/channels`, was REMOVED: it was unauthenticated and called by **nothing** — the ESP32 gets the same payload as the `irConfig` socket event on a DEVICE_SECRET-authenticated connection, and the dashboard reads it from `GET /aircon/` behind a JWT. ⚠️ Four routers (`alertRules`, `alerts`, `analytics`, `history`) gate at `router.use(...)` rather than per route, so a new route added to those files inherits the guard — a per-route grep will wrongly report them as open. `requireRole` **fails closed** (401 when `req.user` is absent), so a middleware-ordering mistake denies rather than admits. Per-user data (`alert_notifications`, `widget_prefs`) always scopes on `req.user.id`; no route takes a subject id from the URL/body/query. See audits/authorization-review-2026-08-25.md

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
> Holt-Winters / EWMA / z-score / percentiles are **statistics**, not ML (say it that way in a
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
| `sensorData` | live reading every ~3s → broadcast + alert evaluation on EVERY one; the InfluxDB write and backup copy are gated by `envPersistPolicy` (~30s heartbeat + immediate on a gas/status/excursion change) |
| `offlineData` | micro-SD replay after an outage → InfluxDB write under the device's RTC time + backup mirror; no broadcast, no alerting |
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
| `networkMetrics` | on each router poll (~60s) → `{ device }` (interfaces, utilization, uptime, **latencyMs/packetLossPct**). ⚠️ `status` is DERIVED from `sample.reachable`, not hardcoded "Online" — the ICMP path broadcasts a sample for a DOWN device too |
| `upsMetrics` | on each UPS SNMP poll (~60s) → `{ ups }` (battery %, runtime, load, on-battery, **on-bypass + outputState**) |
| `networkStatus` / `upsStatus` | poller marks a router/UPS unreachable → `{ id, status: "Offline" }` |
| `agentApproved` / `agentPending` | agent approved / registered-or-rejected (admin pending list) |
| `userPending` / `userApproved` | user self-registered-or-rejected / approved (admin Pending registrations panel) |
| `deviceLog` | new `device_logs` entry (lifecycle + CPU/Mem/Disk threshold crossings) |
| `notification` | new alert raised → pushed to **one user's** room (`user:<id>`) → bell feed + badge + corner **toast** (`ToastHost`) + opt-in **OS popup** (Web Notifications API, tab-backgrounded only). Persisted (`alerts` + `alert_notifications`). See `email-popup-notifications.md` |
| `sessionRevoked` | the revocation sweep found this socket's account disabled/removed or its tokens revoked → `{ reason }`, then the server disconnects it. AuthContext clears the session and shows the sign-in notice, instead of the dashboard silently going stale. See services/socketSessions.js |
| `alertUpdated` | an alert's lifecycle changed (manual acknowledge/resolve, or auto-resolve on metric recovery) → Alerts page refreshes live |
| `reportCreated` / `reportUpdated` / `reportDeleted` | report lifecycle → **broadcast to every dashboard** (the reports list is shared — `GET /api/reports` returns everyone's). A row appears as `pending`, flips to `generated`/`failed` when the background build ends, and disappears on delete — no refresh, on any open page. `POST /api/reports` returns 202 immediately; this is how the result arrives. The toast is creator-only (page compares `generatedBy`). See `report-page.md` §11–12 |
| `reportTemplateUpdated` | an admin changed the report LETTERHEAD, default paper size or signature block → `{ paperSize, unitName, signatories, logos }` to **every** dashboard. Same reasoning as `envConfigUpdated`: the person who made the change is standing on the Report template tab and is the least likely to notice that everyone else’s Generate dialog still offers the old default — and a report built from a stale picker is printed on the wrong page size, which nobody discovers until it comes off a printer. The Generate tab’s picker follows the new default only while that operator has not chosen a size themselves |
| `airconStatus` | manual on/off toggle, or a **rename** (`{ aircon: { id, name }, entry }`) |
| `envConfigUpdated` | admin changed an **Alert Rule** → `{ thresholds }` (the same room-level `{tempWarn,tempCrit,gasWarn,gasCrit,humWarn,humCrit}` pushed to the ESP32 as `envConfig`). Broadcast to every dashboard because Dashboard/Environment colour **temperature, humidity and gas** against these (`utils/envThresholds.ts` via `hooks/useRoomThresholds.ts`) — and the admin who just retuned them is on the Alert Rules page, so is the least likely person to notice a stale Dashboard |
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

> **These boundaries colour the room temperature on the AirConditioner page — and ONLY
> there.** That page's Room Temp tile resolves its colour through
> `frontend/src/utils/tempZone.ts` and names the active zone beside the value
> ("ACCEPTABLE · LIVE"), which is the page's whole subject. **Dashboard and Environment
> colour temperature from the ALERT RULES instead** (`utils/envThresholds.ts` —
> `temperatureColor`): blue below 22 °C, green within the rules, orange at the `temperature`
> warning rule, red at the critical one, so the reading changes at the same instant the
> alert fires and agrees with the Environment page's **System Status** panel (firmware
> `temp_status`, computed from the very thresholds `envConfig` pushes it). Cooling ramps
> *before* the alarm, so the two sets of numbers still differ on purpose — what is scoped
> is which page paints with which.
>
> **Colour rules that apply to every environment reading.** Hexes come from the **Status
> Colors** table below, and CRITICAL is `#E02F44` — *not* `#F2495C`, which is DANGER.
> **Chart lines are coloured per SEGMENT**, each taking the band of the point it ends on,
> so history keeps its own colours instead of the whole line being repainted by the newest
> reading. The **tooltip swatch** is resolved the same way, via a `labelColor` callback on
> all three charts — Chart.js's default draws it from the dataset's static `borderColor`,
> which here is only the pre-first-reading fallback, so the hover box stayed amber no
> matter what the line under the cursor was doing.
>
> **Only temperature paints its NORMAL band.** Blue below 22 °C, green within the rules —
> both carry meaning, and it is one series per axis so nothing collides. **Humidity and the
> two MQ-2 sensors keep their identity hue while normal** — blue `#38BDF8`, violet
> `#A78BFA`, pink `#F472B6` — and turn orange/red only on breach (`alertTint`), on the
> tiles *and* the lines so a reading is the same colour in both places. That identity is
> what lets you watch the two MQ-2 sensors disagree, which is the point of having two;
> painting them both green when clean merged them into one indistinct band for the majority
> of the time the chart is on screen. ⚠️ Two known convergences, both left as-is: the TOO
> COLD blue `#5794F2` is a near neighbour of humidity's `#38BDF8`, and the two MQ-2 lines
> land on the same red if both go critical at once. Legend labels and values separate them
> in both cases; a `borderDash` on MQ2-2 is the fix if the latter ever needs reading at a
> glance. The Dashboard's **Air Quality** tile is the exception that stays green/orange/red
> — it aggregates both sensors ("higher of 2") and has no identity hue to return to.

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

- Active file: `iot/esp32/env_monitor_v2/env_monitor_v2.ino`
- **The micro-SD offline buffer is live again** (since 2026-08-21; SPI — SCK 18 / MISO 19 / MOSI 23 / CS 5). While the socket is down each reading is appended to `/log.csv`; on reconnect the file is replayed as `offlineData` events and deleted. It was removed in July 2026 on the reasoning that every monitored link is on a UPS — true of a *power* cut, but not of an AP reboot, a backend restart, a pulled cable, or WiFi failing to associate at boot, all of which leave the room unmonitored with no record that it was. `backupService` is still the primary on-site copy; the card covers the window where the backend cannot be reached at all. ⚠️ Rows are buffered **report-by-exception**, mirroring `envPersistPolicy` gate for gate (30 s heartbeat + gas/status/excursion deadbands) — change one side and change the other, or the outage replays ten times denser than the history around it. ⚠️ The replay is a **state machine** (`sdFlushStep`, 5 rows per loop tick), never a loop: the old implementation's `delay(30)` per row meant an hour of buffer blocked the sketch for 36 seconds — no sensor read, no buzzer, no IR — during a fire. ⚠️ The sketch was at ~94 % of program storage *before* this went back in; if it no longer fits use Tools ▸ Partition Scheme ▸ "Huge APP (3MB No OTA)", or `SD_ENABLED 0` to compile it out
- **⚠️ Backfill depends on the DS3231's coin cell, so fit one.** Live points are stamped by the backend (`new Date()`) and never cared about the device clock; a *replayed* point is stored under the **device's** timestamp, because only the ESP32 knows when it was taken. With no cell, `lostPower()` is true after any cut and the firmware sets `rtc.adjust(compile time)` — a well-formed date on readings never taken then, which is worse than losing them because it reads as history rather than as an error. Guarded on both sides: the firmware won't buffer a row it can't date (`sdClockIsReal`, catching the `UP HH:MM:SS` fallback) and the backend refuses one dated >90 d back or >5 min ahead (`services/backfillTime.js`, pure + tested — the only guard that catches the build-date case, since that string parses fine). ⚠️ The common ZS-042 DS3231 board trickle-charges its cell for a rechargeable **LIR2032**; a non-rechargeable **CR2032** needs the diode or the `201` resistor removed first
- `deviceSecret` must match `DEVICE_SECRET` in `backend/.env`
- IR fires only on temperature **zone change**, not every loop tick
- `enabledChannels[]` updated at runtime via `irConfig` socket event — no reflash needed to add/disable AC units
- **Alarm thresholds are runtime-configurable** (`WARNING_PPM`/`CRITICAL_PPM`/`TEMP_WARNING`/`TEMP_CRITICAL`/`HUM_WARNING`/`HUM_CRITICAL` are now mutable globals, not `#define`) — updated via the `envConfig` socket event from the dashboard's Alert Rules. One rule fills one global of the same name. The LED, buzzer and reported status all derive from these, so they track the dashboard's thresholds without reflashing. `TEMP_COLD` (LED "too cold") is intentionally **not** rule-driven. A metric with no rule keeps its compiled default on the device (dashboard goes silent, device retains its last threshold).
- **The three status tags speak `alert_rules`' vocabulary: NORMAL / WARNING / CRITICAL** (+ `TOO_COLD` on `temp_status`, an axis rather than a severity — it has no rule behind it). Until 2026-08-15 the firmware had a fourth, middle **DANGER** band: `smoke_status` topped out at DANGER, `environment_status` used DANGER for a critical gas/humidity reading but CRITICAL for a hot room — ranking a smoke event *below* a warm room — and `temp_status`' DANGER band was neutralised at runtime (`TEMP_DANGER = TEMP_CRITICAL`) rather than removed, so the device reported a band the dashboard had no severity for. ⚠️ These are InfluxDB **TAGS**, so every point written before that date keeps `DANGER` — history reads that way permanently, not for a migration window. `utils/envThresholds.normalizeStatus` folds it into CRITICAL at each ingest point (`Environment.tsx` live + history, `LiveSummaryContext`), so no comparison downstream sees two spellings. This matters because the colour helpers match exactly and **fall through to green**: an unmapped status paints a smoke event as clean air. `sensorHandler.js` also accepts both when picking the "Smoke detected" alert title, which is droppable once every ESP32 is reflashed.
- **IR/AC comfort-zone boundaries are runtime-configurable** (`IR_TEMP_COLD_BELOW`/`IR_TEMP_NORMAL_MAX`/`IR_TEMP_ACCEPT_MAX`/`IR_TEMP_NEARCRIT_MAX` are now mutable globals, not literals in `getIRZone`) — updated via the **`acConfig`** socket event from the dashboard's **Auto-Cooling Thresholds** card (separate from `envConfig`/Alert Rules — cooling ramps *before* the alarm). The per-zone target temps stay fixed (captured raw IR codes). No reflash needed to retune *when* IR fires.
- Timestamp priority: DS3231 RTC → NTP (UTC+8, `pool.ntp.org`) → uptime fallback (`UP HH:MM:SS`)
- Backend overrides ESP32 timestamp with `new Date()` for all InfluxDB writes and broadcasts
- Buzzer: 10-bit LEDC resolution; `ledcWrite(pin, 0)` to silence (not `ledcWriteTone(pin, 0)`)
