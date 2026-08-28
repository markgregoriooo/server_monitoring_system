# Deployment Guide — CSPC-ICTU Server Infrastructure Monitoring System

End-to-end runbook for standing up the system on a fresh host. Grounded in the real
entry point (`backend/src/server.js`), config (`backend/config/*`), schema
(`v13_cspc-ictu-monitoring-system.sql`), Go agent, and ESP32 firmware. For *how each
part works internally* see `CLAUDE.md`, `server-metrics.md`, `google-oauth.md`, and
`email-popup-notifications.md`.

> **Scope.** Everything on `main`: backend API, React dashboard, MySQL + InfluxDB, the
> Go server agents, the ESP32 environment node, and — since the `router-ups-monitoring`
> merge — **router / UPS (SNMP)** and **MikroTik (RouterOS)** monitoring. All of it
> deploys from this one branch.

> **Schema:** there is no longer a migration chain. `v13_cspc-ictu-monitoring-system.sql`
> is a single full export that already contains every change the old `migrations/` folder
> applied, plus the seed rows the app needs to function. See [§2.1](#21-mysql).

> **Deployment model (decided):** **on-premise at CSPC** — the backend, databases, and
> dashboard all run on one **campus server**, published over HTTPS at
> `monitoring.cspc.edu.ph` by **ICTU's own edge** (their DNS, their certificate, reverse-proxied
> to this server). The backend *must* be on campus because it talks directly to the
> server-room hardware over the LAN — and polls routers / UPS / MikroTik on private addresses
> a cloud host could never reach.
> See [§5](#5-serve-everything-from-one-campus-server-nginx) and
> [§6](#6-publish-the-dashboard-over-https-ictu-endpoint).

---

## 0. Architecture at a glance (what you actually deploy)

```
   Staff (campus or home) ─https─▶ ICTU edge ─┐  (their DNS + TLS cert, reverse proxy)
                                             │
   ┌─────────────────────── CAMPUS SERVER (on-prem) ───────────────────────┐
   │                                         ▼                              │
   │   nginx (:80/:443)                                                     │
   │     ├─ serves frontend/dist  (React SPA, static files)                 │
   │     └─ reverse-proxies /api + /socket.io → backend :3000               │
   │                                         │                              │
   │   Backend: Node + Express + Socket.IO (:3000)  ──▶ MySQL 8 (:3306)     │
   │   backend/src/server.js                        └─▶ InfluxDB 2 (:8086)  │
   └───────────────────────────────────────────────────────────────────────┘
        ▲ Socket.IO(deviceKey)        ▲ HTTP Bearer        ▲ SNMP / RouterOS API
   ESP32 env node              Go agents (per server)   Routers/UPS/MikroTik
   (campus LAN)               (campus LAN)              (campus LAN)
                                                + Google OAuth (login) · Resend (email, optional)
```

**On-campus collectors point at the server's LAN address; only humans (browsers) use the
public HTTPS hostname.** See [§6](#6-publish-the-dashboard-over-https-ictu-endpoint).

**Five deployable units:** (1) MySQL, (2) InfluxDB, (3) backend, (4) frontend,
(5) the edge collectors (Go agents on each server + the ESP32 firmware) — units 1–4 all
live on the one campus server.

---

### 0.1 Which address goes where (read this before you edit anything)

Three different addresses point at the **same backend process**, and each is correct for
exactly one audience. Putting the right one in the wrong file is the most common
deployment mistake, and it usually fails silently — a page that loads with no data, or a
sensor that never appears.

**You edit five things. None of them is a source file.**

| # | File | What goes in | Which address |
|---|---|---|---|
| 1 | `frontend/.env` | `VITE_API_URL=https://monitoring.cspc.edu.ph` | **hostname** |
| 2 | `backend/.env` | `WEB_ORIGIN=https://monitoring.cspc.edu.ph` | **hostname** |
| 3 | nginx site config<br>`/etc/nginx/sites-available/cspc` | `proxy_pass http://127.0.0.1:3000;` | **127.0.0.1** |
| 4 | `iot/esp32/env_monitor_v2/secrets.h` | `#define BACKEND_HOST "192.168.100.9"` | **LAN IP** |
| 5 | *(a command, not a file)* the agent installer | `install.sh http://192.168.100.9:3000 AIK-<key>` | **LAN IP** |

#### Files you do NOT edit

These already read the values above. Changing them is how a deployment ends up with two
sources of truth that disagree:

| File | Why it needs no edit |
|---|---|
| `frontend/src/config.ts` | Reads `VITE_API_URL`, falling back to `<page-host>:3000` for LAN development. |
| `frontend/src/socket/socket.ts` | `io(API_URL)` — imports the same value. **The socket has no separate setting.** |
| `frontend/src/api/client.ts` | Axios `baseURL`, same value again. |

That is worth stating plainly because it is a natural thing to go looking for: the live
socket and the REST API are pinned by **one** variable, `VITE_API_URL`. nginx proxies both
`/api/` and `/socket.io/` to the backend on the same hostname, so the browser only ever
talks to one origin.

#### Why each one is what it is

**Hostname (1, 2)** — the browser may be on campus wifi or at home, so the public name is
the only address it can reach. `VITE_API_URL` tells the browser where to call;
`WEB_ORIGIN` tells the backend which origin to accept CORS from. **They must match exactly**
— same scheme, same host, no trailing slash.

**127.0.0.1 (3)** — nginx runs on the *same machine* as the backend, so it reaches it over
loopback. This address is meaningful only inside that box. A browser asking for
`127.0.0.1:3000` is asking its **own** laptop, where nothing is listening.

**LAN IP (4, 5)** — the ESP32 and the Go agents are on campus and talk to `:3000`
directly, never through nginx. That keeps ingest alive when the internet or ICTU's edge is
down, and it is why §9.1 firewalls `:3000` to the collector subnets rather than closing it.

> ⚠️ **`VITE_API_URL` is compiled into the JavaScript at build time.** Edit
> `frontend/.env` **before** `npm run build` ([§4.1](#41-frontendenv) → [§4.2](#42-build)).
> Building first and editing afterwards leaves the old address inside the bundle: the page
> loads, every API call and the socket fail, and the config file on disk looks correct —
> which is what makes it expensive to diagnose.

---

## 1. Prerequisites

| Component | Version | Notes |
|---|---|---|
| Node.js | **18+** (LTS 20 recommended) | backend + frontend build |
| npm | bundled with Node | |
| MySQL | **8.0+** | relational store |
| InfluxDB | **2.x** | time-series store (env, server, router/UPS metrics) |
| nginx | latest | serves the dashboard + reverse-proxies the API ([§5](#5-serve-everything-from-one-campus-server-nginx)) |
| Go | **1.22+** | only to *build* the agents; target servers need nothing |
| Arduino IDE / arduino-cli | latest | only to flash the ESP32 |
| A Google Cloud OAuth **Web** client | — | login is Google-only (`google-oauth.md`) |
| An HTTPS hostname from ICTU | — | `monitoring.cspc.edu.ph`, published by ICTU ([§6.1](#61-request-the-https-endpoint-from-ictu)). **Google rejects a bare LAN IP**, so this is required, not optional |
| (optional) Resend account | — | alert emails; system works without it |

Network: the backend listens on **0.0.0.0:3000** (all interfaces). On-campus collectors
(agents, ESP32) reach it directly at the server's LAN IP:3000; browsers reach it through
nginx (+ ICTU's edge). Give the campus server a **static LAN IP / internal hostname** —
agents and firmware cache the address, and ICTU's proxy needs a fixed target.

---

### 1.1 Put the code on the server

Everything below assumes the project is already at **`/opt/cspc`** on the Linux box. This
section is how it gets there. Do it first — §2 onward all run from inside it.

**Why `/opt/cspc` specifically.** It is not a preference: `ops/systemd/cspc-monitoring.service`
declares `WorkingDirectory=/opt/cspc/backend`, and §5.2 serves the dashboard from
`/opt/cspc/frontend-dist`. Putting the project anywhere else means editing the unit file.

> ⚠️ **Do not put it under `/home/<you>/`.** nginx runs as `www-data` and usually cannot
> traverse a home directory, which produces a 403 that reads like a config error (§5.6).

#### 1.1.1 Create the service account and the directory

The backend runs as a dedicated **system user with no shell** — it holds `JWT_SECRET`,
the database password and the encryption keys, so it should not be a login account and
should not be `root`.

```bash
sudo useradd --system --home /opt/cspc --shell /usr/sbin/nologin cspc
sudo mkdir -p /opt/cspc
```

#### 1.1.2 Transfer the project folder

The whole project folder is copied across — by WinSCP, `scp`, `rsync`, or a USB drive.
Any of them is fine. What matters is that **six things do not make the trip**, because
each one is either wrong on Linux or belongs to the development machine.

##### What must not be copied

| Do not copy | What happens if you do |
|---|---|
| `backend/node_modules/`<br>`frontend/node_modules/` | ~52 MB in the backend alone, and the native modules are compiled **for Windows**. On Linux they crash or misbehave. They are reinstalled in §1.1.4. |
| `backend/.env` | Carries the dev database name and the dev secrets. Production writes its own in §3.1. Copying it is also how a compromised key spreads. |
| `backend/backups/` | Tens of MB of the *development* room's NDJSON history. |
| `backend/reports/` | Generated CSV/PDFs for reports that will not exist in the new database. |
| `backend/branding/` | Logos uploaded on the dev box. Production uses the committed marks until ICTU re-uploads. |
| `frontend/dist/` | Built with the **dev** `VITE_API_URL` compiled in. Rebuilt on the server in §4.2. |

`.git/` is optional — harmless to copy, and useless without a remote.

##### Option A — exclude during the transfer (fastest)

`rsync` over SSH, run from the project folder on your workstation:

```bash
rsync -av \
  --exclude node_modules \
  --exclude .env \
  --exclude backups \
  --exclude reports \
  --exclude branding \
  --exclude dist \
  --exclude .git \
  ./ user@campus-server:/opt/cspc/
```

In **WinSCP**, the same list goes in *Transfer settings → File mask → Exclude*:

```
node_modules/; .env; backups/; reports/; branding/; dist/; .git/
```

##### Option B — copy everything, then clean on the server

Simpler to get right if the transfer tool has no exclude support (a plain drag-and-drop,
or a USB drive). Copy the folder to `/opt/cspc`, then, **before** installing anything:

```bash
cd /opt/cspc
sudo rm -rf backend/node_modules frontend/node_modules
sudo rm -rf backend/backups backend/reports backend/branding
sudo rm -rf frontend/dist
sudo rm -f  backend/.env
```

The transfer is slower — you move the 52 MB of `node_modules` only to delete it — but
nothing depends on remembering an exclude list in a dialog box.

##### Verify before moving on

```bash
cd /opt/cspc
ls backend/src/server.js frontend/package.json v13_cspc-ictu-monitoring-system.sql
# All three must exist — they are the backend entry point, the frontend manifest
# and the schema you import in §2.1.

[ -d backend/node_modules ] && echo "STOP: node_modules came across — delete it"
[ -f backend/.env ]         && echo "STOP: dev .env came across — delete it"
```

⚠️ **`backend/assets/` must be present**, and is easy to lose to an over-eager exclude
mask. It holds the report letterhead marks (`assets/branding/`) and the embedded PDF font
(`assets/fonts/`). Without the fonts, reports still generate but fall back to Helvetica
instead of the Arial-compatible face ICTU asked for:

```bash
ls backend/assets/fonts/Arimo-Regular.ttf backend/assets/branding/cspc-logo.png
```

#### 1.1.3 Two things Windows→Linux breaks

Both are silent on Windows and only appear on the server.

**Line endings.** A shell script committed with CRLF fails as
`bad interpreter: /bin/bash^M` — which reads as a missing file, not a line-ending problem.
`.gitattributes` now pins `*.sh text eol=lf`, so a fresh clone is correct. Verify anyway,
since the two backup scripts run nightly and their failure is invisible:

```bash
file ops/db-backup/dump-mysql.sh ops/offsite-backup/sync-offsite.sh
# want: "ASCII text" — NOT "with CRLF line terminators"

# If any say CRLF:
sed -i 's/\r$//' ops/db-backup/*.sh ops/offsite-backup/*.sh
```

**Filename case.** Linux filesystems are case-sensitive; Windows is not. An import written
`../Services/foo.js` for a file named `services/foo.js` works on the dev machine and fails
here. The first `npm run build` on the server is the real test — a build that passed on
Windows proves nothing about this.

#### 1.1.4 Install dependencies (on the server)

```bash
cd /opt/cspc/backend  && npm ci --omit=dev
cd /opt/cspc/frontend && npm ci
```

`npm ci` installs exactly the lockfile, which is what you want on a server; `npm install`
may resolve different versions. The frontend keeps its dev dependencies because Vite needs
them to build.

> ⚠️ **Do not build the frontend yet.** `VITE_API_URL` is baked in at build time, so the
> build has to come *after* §4.1. Building now silently ships the wrong backend URL, and
> the only symptom is API calls going nowhere.

#### 1.1.5 Ownership and permissions

```bash
sudo chown -R cspc:cspc /opt/cspc/backend

# The backend writes reports and on-site backups itself — create them owned by it,
# or the first write fails at runtime rather than at deploy time.
sudo mkdir -p /opt/cspc/backend/reports /opt/cspc/backend/backups /opt/cspc/backend/branding
sudo chown cspc:cspc /opt/cspc/backend/reports /opt/cspc/backend/backups /opt/cspc/backend/branding
```

`.env` gets its own tighter mode once it exists (§3.1):

```bash
sudo chown cspc:cspc /opt/cspc/backend/.env
sudo chmod 600 /opt/cspc/backend/.env     # secrets — owner-read only
```

#### 1.1.6 What the server will NOT have, and that is correct

A clean deployment starts empty. None of these is a fault to fix:

| Absent | Why, and what to do |
|---|---|
| **`backend/.env`** | Gitignored. Write it on the server (§3.1) with **freshly generated** secrets — never copy the dev values. |
| **Uploaded logos** (`backend/branding/`) | Gitignored runtime data. Reports use the committed marks in `backend/assets/branding/` until an admin re-uploads on the Reports page. |
| **All users** | The first Google sign-in lands `pending` with nobody able to approve it — see **§4.3**. |
| **All devices** | Every server, router, UPS and aircon is registered again. Agents re-enrol; MikroTik credentials and aircon IR channels are re-entered. |
| **All history** | No alerts, reports or audit trail. InfluxDB starts empty too (§2.2). |

#### 1.1.7 Where to go next

```
1.1  code at /opt/cspc            ← you are here
2.1  create the MySQL database, import v13_cspc-ictu-monitoring-system.sql
2.2  InfluxDB bucket + token
3.1  backend/.env   (fresh secrets)
3.2  run the backend / install the systemd unit  → ops/systemd/README.md
4.1  frontend/.env  (VITE_API_URL)  →  4.2 build
5.x  nginx
6.x  HTTPS hostname + Google OAuth origins
4.3  bootstrap the first admin      ← LAST: it needs Google sign-in working
```

⚠️ §4.3 is numbered before §5 and §6 but must be done **after** them: the first admin is
created by signing in with Google, and Google refuses a bare LAN IP (§6.3).

---

## 2. Databases

### 2.1 MySQL

**One file, no migrations.** `v13_cspc-ictu-monitoring-system.sql` is a phpMyAdmin export
of the full schema (**25 tables**) and already includes everything the `migrations/`
folder used to apply.

> **Upgrading a database loaded before 2026-08-09?** One statement is needed (already
> applied on the development database): the **Capacity Forecast** report type is a new value in
> the `reports.type` ENUM, and MySQL rejects a value outside the list. A fresh load of
> the schema above already has it.
>
> ```bash
> mysql -u root -p <your-db> < migrations/2026-08-09_report_forecast_type.sql
> ```
>
> Skipping it fails only at the moment someone generates a forecast report; everything
> else keeps working.

> ⚠️ **It does NOT create the database.** A phpMyAdmin export contains tables only — no
> `CREATE DATABASE`, no `USE`. Create the database yourself first and load into it. The
> name is yours to choose; whatever you pick becomes `DB_NAME` in `backend/.env`.

```bash
# 1) Create the database (name it whatever you'll put in DB_NAME)
mysql -u root -p -e "CREATE DATABASE cspc_ictu_monitoring CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;"

# 2) Load the schema INTO it
mysql -u root -p cspc_ictu_monitoring < v13_cspc-ictu-monitoring-system.sql
```

The export ships **three tables pre-populated**, and all three matter:

| Seeded table | Why it's not optional |
|---|---|
| `alert_rules` | Alerting is **rules-only** — an empty table means **no threshold alert ever fires**: CPU/mem/disk, temperature/gas/humidity, router CPU/mem, link utilisation/errors, UPS charge/runtime all go silent. |
| `aircon_ir_config` | The auto-cooling IR zone boundaries. Without them the ESP32 keeps its compiled-in defaults and the dashboard can't retune when IR fires. |
| `settings` | Report template defaults — page size (Folio), the letterhead unit line, the signature block and both logo slots. Empty means every generated PDF falls back to code defaults and the admin panel has nothing to show. |

Everything else ships **empty**, which is what a fresh install wants: no users (the first
Google sign-in creates a `pending` account for an admin to approve — [§4.3](#43-bootstrap-the-first-admin-important--chicken-and-egg)),
no devices, no history.

Create a dedicated app user (don't run the app as root):

```sql
-- 'localhost', NOT '%'. The backend runs on this same machine, so the account never
-- needs to accept a connection from anywhere else — and '%' would let it be used from
-- any host that can reach port 3306.
CREATE USER 'cspc_app'@'localhost' IDENTIFIED BY 'a-strong-password';

-- SELECT/INSERT/UPDATE/DELETE only. Deliberately NO: DROP, ALTER, CREATE, GRANT,
-- FILE or SUPER. The app never changes its own schema — migrations are run by hand
-- (§2.1, migrations/) — so giving it DDL rights only widens what a bug or an
-- injection could reach.
GRANT SELECT, INSERT, UPDATE, DELETE ON cspc_ictu_monitoring.* TO 'cspc_app'@'localhost';
FLUSH PRIVILEGES;
```

Then point `backend/.env` at it — `DB_USER=cspc_app`, `DB_PASSWORD=…`.

> ⚠️ **Check what you are actually connecting as before go-live.** During development it is
> easy to leave `DB_USER=root`, and a `.env` gets copied to the server along with everything
> else. Verify on the deployed box:
>
> ```sql
> SELECT CURRENT_USER();   -- expect cspc_app@localhost, NOT root@localhost
> SHOW GRANTS;             -- expect only SELECT, INSERT, UPDATE, DELETE on this one schema
> ```
>
> On the machine this guide was audited against, that returned
> `GRANT ALL PRIVILEGES ON *.* TO root@localhost WITH GRANT OPTION` — every right MariaDB
> has, on every database. See `audits/database-security-2026-08-25.md` — DB-01.

> **Re-exporting later:** export from **phpMyAdmin**, not by forward-engineering the
> MySQL Workbench `.mwb` model. The model is a design artifact and drifts — the previous
> V10 came from it and was missing eight migrations' worth of schema, because migrations
> were applied to the database and never back to the model. When you do re-export, select
> **structure for all tables** but **data for `alert_rules` + `aircon_ir_config` only** —
> a full data export would carry agent bearer tokens, SNMP community strings, the
> encrypted MikroTik password and real user accounts into the repo.
>
> **Then sanitize the exported file — never the live database.** The seeded rows carry
> foreign keys into tables that ship empty, so a straight export does not import into a
> fresh database. Fix these in the `.sql` file only (the live values are real audit data
> and must stay):
>
> - every non-NULL `updated_by` → `NULL`. It points at `users.user_id`, and `users` ships
>   empty, so `ADD CONSTRAINT` fails with errno 1452 when it validates the seeded rows.
> - every `alert_rules` row with a non-NULL `device_id` → **delete the row**. It is a
>   per-device override for a device that will not exist, and nulling it instead would
>   turn it into a second global rule competing with the existing one for that metric.
>
> Verify by importing into a throwaway database before committing — `CREATE DATABASE
> zz_test`, load, confirm 25 tables and 31 foreign keys, `DROP DATABASE zz_test`. Static
> inspection missed this twice; the import is the only real proof.

### 2.2 InfluxDB 2.x

Install InfluxDB 2.x, then via the UI (`http://<host>:8086`) or `influx setup`:

1. Create an **org** (e.g. `cspc-ictu`) and a **bucket** (e.g. `monitoring`).
2. Create an **API token** with read+write on that bucket.
3. Note the **URL** (`http://localhost:8086`), org, bucket, token → these become the
   `INFLUX_*` env vars below.

The backend creates its measurements automatically (no manual schema): `sensor_environment`
(ESP32), `server_metrics` + `server_volumes` (Go agents), and `router_metrics` /
`network_traffic` / `ups_metrics` (SNMP + MikroTik pollers) — all at millisecond precision. Set a sensible
**retention** on the bucket — long analytics lookbacks need the points to still exist.

---

## 3. Backend

```bash
cd backend
npm install
```

### 3.1 `backend/.env`

Create `backend/.env`. Full reference (also in `CLAUDE.md`):

```dotenv
PORT=3000
JWT_SECRET=<long-random-string>          # signs app JWTs (1h expiry)
DEVICE_SECRET=<shared-secret>            # ESP32 socket auth — MUST match firmware deviceSecret
AGENT_INSTALL_KEY=<shared-secret>        # Go agents present this at enrollment

# MySQL — DB_NAME must match the database you created in §2.1
DB_HOST=127.0.0.1
DB_USER=cspc_app
DB_PASSWORD=a-strong-password
DB_NAME=cspc_ictu_monitoring
DB_PORT=3306

# InfluxDB
INFLUX_URL=http://127.0.0.1:8086
INFLUX_TOKEN=<influx-api-token>
INFLUX_ORG=cspc-ictu
INFLUX_BUCKET=monitoring

# Google OAuth (login) — see google-oauth.md
GOOGLE_CLIENT_ID=<web-client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<web-client-secret>
GOOGLE_ALLOWED_DOMAINS=cspc.edu.ph,my.cspc.edu.ph   # blank = these defaults

# CORS — the dashboard's public origin (the ICTU hostname from §6). Comma-separated;
# or * for a roaming LAN. Include http://localhost:5173 too if you also use the dev server.
WEB_ORIGIN=https://monitoring.cspc.edu.ph

# Alert email (optional — blank RESEND_API_KEY = email off; bell + toast still work)
RESEND_API_KEY=
RESEND_FROM=CSPC ICTU Monitoring <alerts@your-verified-domain>
NOTIFY_EMAIL_MIN_SEVERITY=critical       # info|warning|critical
NOTIFY_EMAIL_TO=                         # force ALL mail to one address (testing only)
NOTIFY_COOLDOWN_MIN=30                   # de-dup window (restart-proof)
NOTIFY_RETENTION_DAYS=30                 # purge alerts older than this, daily
REPORT_RETENTION_DAYS=90                 # purge generated reports (row + CSV/PDF), daily

# Server agents
SERVER_OFFLINE_AFTER_SEC=                # FLOOR for the per-agent offline window; blank = 30.
                                         # Real window = max(this, agent interval x 3), capped 1h.

# Router / UPS over SNMP (see router-ups-monitoring.md)
SNMP_POLL_INTERVAL_MS=60000              # blank = 60000. Per-device community/port live in
                                         # device_network, NOT here.

# MikroTik over the RouterOS API (see mikrotik-monitoring.md)
MIKROTIK_ENC_KEY=<64-hex-chars>          # ⚠️ REQUIRED for MikroTik — 32 bytes for AES-256-GCM of
                                         # the stored API password. Saving credentials THROWS
                                         # without it. Generate:
                                         #   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
MIKROTIK_POLL_INTERVAL_MS=30000          # blank = 30000; lighter than SNMP, 10-15s is fine
MIKROTIK_API_TIMEOUT_MS=5000             # per-call connect/read timeout
MIKROTIK_TLS_VERIFY=false                # RouterOS ships a SELF-SIGNED cert, so strict verify
                                         # fails on a stock router. Blank/false = encrypted but
                                         # unverified.
MIKROTIK_TLS_CA=                         # optional CA path, only used when TLS_VERIFY=true

# On-site backup writer (see backup-storage.md) — mirrors every ingested sample to NDJSON
BACKUP_ENABLED=                          # false disables; blank = enabled
BACKUP_DIR=                              # micro SD / USB drive path; blank = backend/backups
BACKUP_FLUSH_MS=5000                     # larger = kinder to flash, larger worst-case loss
BACKUP_RETENTION_DAYS=30                 # purge dated backup files older than this
BACKUP_OFFSITE_ENABLED=                  # true turns on the offsite-staleness check (§11.2)
BACKUP_OFFSITE_MARKER=                   # path the rclone job stamps on each success
BACKUP_OFFSITE_MAX_AGE_HOURS=26          # warn if no successful offsite sync within this
```

#### Generating the secrets

⚠️ **Generate these ON THE SERVER, and never reuse the development values.** Copying
`backend/.env` across carries the dev database name, the dev Influx token and — worse —
any key that has ever been pasted into a chat, a ticket or a screenshot. New machine, new
keys.

All four are **validated, not merely documented** — the code refuses rather than warns, so
a bad value surfaces on deploy day instead of at the moment it matters. The first two are
checked at **boot** (the backend will not start); the encryption keys are checked the
first time a credential is **saved**:

| Variable | Requirement | Enforced by |
|---|---|---|
| `JWT_SECRET` | at least **32 characters** | `config/env.js` — throws at import |
| `DEVICE_SECRET` | at least **24 characters**, and not a value published in this repo's history (checked by SHA-256) | `config/env.js` — throws at import |
| `MIKROTIK_ENC_KEY` | exactly **64 hex characters** (32 bytes) | `services/secretCrypto.js` — throws when a credential is saved |
| `SECRET_ENC_KEY` | exactly **64 hex characters**, and **different from** `MIKROTIK_ENC_KEY` | as above |

Run this once on the server and paste the four lines into `backend/.env`:

```bash
node -e "
const c = require('crypto');
console.log('JWT_SECRET='        + c.randomBytes(48).toString('base64url'));
console.log('DEVICE_SECRET='     + c.randomBytes(24).toString('hex'));
console.log('MIKROTIK_ENC_KEY='  + c.randomBytes(32).toString('hex'));
console.log('SECRET_ENC_KEY='    + c.randomBytes(32).toString('hex'));
"
```

Then lock the file down — it now holds every credential the system has:

```bash
sudo chown cspc:cspc /opt/cspc/backend/.env
sudo chmod 600 /opt/cspc/backend/.env      # owner read/write only
```

##### Two that need more than pasting

> ⚠️ **`DEVICE_SECRET` is TWO-SIDED.** The same value must also go into
> `iot/esp32/env_monitor_v2/secrets.h`, and the ESP32 must be **reflashed** (§8). The
> handshake compares them with `timingSafeEqual`, so a mismatch rejects every device
> connection — and the symptom is a room that is silently unmonitored, not an error
> anyone is looking at. Setting it on the backend alone is half the job.

> ⚠️ **`MIKROTIK_ENC_KEY` should be set once and left alone.** Every RouterOS password is
> encrypted under it, so changing it later makes them all undecryptable — the poller then
> fails to log in with no obvious cause. `npm run rekey -- --from-key <old> --apply`
> recovers from that, but it is a stop-the-backend procedure. Set this **before**
> registering the MikroTik (§7), not after.

##### The rest

`AGENT_INSTALL_KEY` is the deprecated bootstrap fallback and should be **left blank** on a
new install: enrollment keys are minted in the UI (Server Metrics → Agent install keys)
once you have an admin. It exists only because a fresh database has no keys *and* no admin
to mint one — if you use it to bootstrap the first agent, blank it and restart afterwards.

`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `SMTP_*` are copied from their own consoles,
not generated here — see `google-oauth.md` and `email-popup-notifications.md` §8.


### 3.2 Run

```bash
# Dev (watch mode)
npm run dev            # nodemon src/server.js

# Production (foreground)
node src/server.js     # entry point is backend/src/server.js  → "Server running on port 3000"
```

> Note: `package.json`'s `start` script points at the old `server.js`; the real entry is
> **`src/server.js`**. Run `node src/server.js` (or `npm run dev`) — don't rely on `npm start`.

**Keep it running** with a process manager:

```bash
# Option A — pm2
npm i -g pm2
pm2 start src/server.js --name cspc-backend --cwd "$(pwd)"
pm2 save && pm2 startup        # restart on boot
```

**Option B — systemd (recommended).** A complete, commented unit ships in the repo:

```bash
sudo cp ops/systemd/cspc-monitoring.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cspc-monitoring
journalctl -u cspc-monitoring -f
```

Full install, verification and troubleshooting: **`ops/systemd/README.md`**.

> ⚠️ **An earlier sketch in this guide had two defects — don't copy it from an old revision.**
>
> 1. **`EnvironmentFile=/opt/cspc/backend/.env`** — the app already loads that file itself
>    (`config/env.js` → `dotenv.config()`). Pointing systemd at it too parses it twice with two
>    different parsers, and systemd's is stricter: it does not strip inline `#` comments and
>    quotes differently, so a value dotenv reads correctly can reach the process mangled. One
>    loader, one set of rules — the shipped unit sets only `NODE_ENV`.
> 2. **`Restart=on-failure`** — `src/server.js` exits on an uncaught exception *by design*
>    ("Restart is left to the process supervisor, which is the right owner"). `Restart=always`
>    with a start-limit is what makes that decision safe.
>
> Two traps the unit used to carry warnings about have since been **fixed in the
> application**, so the unit is safer than the warnings implied:
>
> - **`.env` no longer depends on the working directory.** `config/env.js` exports
>   `BACKEND_ROOT`, resolved from the module's own path, and `.env`, `REPORTS_DIR` and the
>   default `BACKUP_DIR` all anchor to it. Starting the backend from any directory works.
>   Set `WorkingDirectory` anyway — it is still good hygiene — but a wrong value is no
>   longer the silent misconfiguration it was.
> - **`NoNewPrivileges=true` no longer invents an outage.** It still blocks the
>   setuid/`cap_net_raw` that `ping` needs, but `icmpPing` now separates "could not run the
>   probe" from "no reply": packet loss is reported as **null** instead of 100, `[ICMP]` is
>   logged once, and the poller skips the sample rather than marking every router Offline.
>   Enabling it still *disables* latency/loss monitoring — check the journal for `[ICMP]`.

**Why a supervisor at all, beyond restarts:** it decides where `console.*` output goes. Under
`npm run dev` that is a terminal which eventually closes. Under systemd it is **journald** —
captured, rotated, and kept across restarts — which is what makes the `[AUTH]`, `[AUTHZ]`,
`[RATE]` and `[POLICY]` lines usable during an incident. See
`audits/logging-monitoring-2026-08-25.md` §8. Bound the journal's size with
`ops/systemd/README.md` §4.

On boot the backend also starts two background jobs (no setup needed): a **15 s offline
sweep** (flips silent servers to Offline + raises an alert) and a **daily retention purge**.

---

## 4. Frontend (dashboard)

```bash
cd frontend
npm install
```

### 4.1 `frontend/.env`

```dotenv
VITE_GOOGLE_CLIENT_ID=<same-web-client-id>.apps.googleusercontent.com
# For the campus + ICTU-edge topology (§5/§6): pin the backend to the PUBLIC origin (no :3000).
# nginx reverse-proxies /api and /socket.io to the backend on the same hostname, so the
# browser talks to one origin. Must match the ICTU hostname and the backend's WEB_ORIGIN.
VITE_API_URL=https://monitoring.cspc.edu.ph
```

> Why set this here: by default the app auto-detects the backend at `<page-host>:3000`
> (`frontend/src/config.ts`). Behind nginx + ICTU's edge, port 3000 isn't public — the API
> is reached at the page's own origin under `/api`. Pinning `VITE_API_URL` to the public
> URL makes both the Axios client and Socket.IO use it.

`VITE_GOOGLE_CLIENT_ID` **must match** the backend's `GOOGLE_CLIENT_ID`. Vite inlines env
vars at build time → **rebuild after any change** (`npm run build`).

### 4.2 Build

```bash
npm run build          # → frontend/dist/  (static SPA)
```

`frontend/dist/` is served by nginx on the campus server — see
[§5](#5-serve-everything-from-one-campus-server-nginx). (For local development instead:
`npm run dev` → `http://localhost:5173`.)

### 4.3 Bootstrap the first admin (important — chicken-and-egg)

Login is Google-only and **self-register → admin-approve**: a first sign-in creates a
`users` row with `status='pending'`, and only an **admin** can approve it. So the *first*
admin must be activated by hand.

> ⚠️ **This is a DEPLOYMENT-DAY step, not a one-time setup step.** Production gets a **fresh
> MySQL database** — your development database's approved admin does **not** come with it.
> On the new server the very first Google sign-in lands `pending` with **nobody in existence
> who can approve it**, and you are locked out of your own system. Nothing in the UI can fix
> this; it needs a direct SQL statement.
>
> Do it immediately after loading the schema, while you still have a terminal open. It is the
> single most common way a working deployment appears broken on day one.

**Order matters — sign in first, then promote:**

1. Open the dashboard and **sign in once** with the CSPC Google account that will be the first
   admin. It will say *"Registration submitted…"* — that's correct. The sign-in is what
   **creates the row**; there is nothing to promote before it.
2. Promote that row in MySQL:

```sql
UPDATE users SET status = 'active', role = 'admin'
WHERE email = 'firstadmin@cspc.edu.ph';     -- exact, lowercase, as Google reports it
```

3. Sign in again — you're now admin.
4. Have the ICTU staff sign in, then approve each of them from **User Management → Pending
   registrations** (assigning `admin` or `it_staff`). From here on the UI handles everything.

```sql
-- Verify it worked before moving on:
SELECT user_id, email, role, status FROM users;
```

> **If step 2 matches 0 rows**, the email doesn't match what Google reported — check for a
> different domain (`@cspc.edu.ph` vs `@my.cspc.edu.ph`) or capitalisation. `SELECT email FROM
> users;` shows exactly what was stored.

---

## 5. Serve everything from one campus server (nginx)

Put the built dashboard **and** the backend behind a single nginx on the campus server, so
the browser sees one origin (no cross-origin/mixed-content issues) and ICTU's edge has a
single target to forward to.

### 5.0 Who sets up what

There are **two** reverse proxies in this deployment, on two different machines, configured by
two different people. Confusing them is the most common source of "wait, is that mine?":

```
  Staff at home / on campus
      │  https://monitoring.cspc.edu.ph
      ▼
  ICTU edge proxy               ←── THEY configure this. You never touch it.
      │                              · their DNS record
      │                              · their TLS certificate (HTTPS ends here)
      │                              · their firewall (inbound 443)
      │  plain http, over the campus LAN
      ▼
  YOUR campus server — nginx :80  ←── YOU configure this (§5)
      ├─ /              → frontend/dist   (static React files)
      ├─ /api/*         → 127.0.0.1:3000
      └─ /socket.io/*   → 127.0.0.1:3000  (WebSocket)
      │
      ▼
  Node backend :3000  →  MySQL · InfluxDB   ←── YOU (§2, §3)
```

**Why both?** ICTU's proxy makes the app *public and encrypted* — the part you can't do
yourself. Your nginx does two things theirs can't:

1. **Serves the React app.** `npm run build` produces static files; the Node backend only
   answers `/api` and `/socket.io` and will never serve HTML/JS/CSS. Something has to.
2. **Presents one simple target.** ICTU forwards everything to `<LAN-IP>:80` and never needs
   to know your internal layout. Without nginx they'd have to route three path prefixes to
   different places — configuration in *their* system that you'd have to file a ticket to
   change every time something moved.

Everything below is **your** work, on **your** server, and none of it needs ICTU. Do it now,
test it over the LAN, and have it working before they connect anything.

### 5.1 Install nginx

```bash
sudo apt update && sudo apt install nginx
sudo systemctl enable --now nginx
curl -I http://localhost          # expect: HTTP/1.1 200 OK (the nginx welcome page)
```

### 5.2 Build the dashboard and put it where nginx can read it

```bash
cd frontend
npm ci                            # or npm install
npm run build                     # → frontend/dist

sudo mkdir -p /opt/cspc
sudo cp -r dist /opt/cspc/frontend-dist
sudo chown -R www-data:www-data /opt/cspc/frontend-dist
sudo chmod -R a+rX /opt/cspc/frontend-dist
```

> ⚠️ **Set `VITE_API_URL` before building** ([§4.1](#41-frontendenv)) — Vite bakes it into the
> bundle at build time. Building first and editing `.env` afterwards silently ships the wrong
> backend URL, and the only symptom is API calls going to the wrong host.

> ⚠️ **Don't serve the build from your home directory.** nginx runs as `www-data` and usually
> can't traverse `/home/<you>/`, producing a 403 that looks like a config error. `/opt/cspc/`
> or `/var/www/` avoids it.

### 5.3 The config

`/etc/nginx/sites-available/cspc-monitoring` (symlink it into `sites-enabled/`):

```nginx
server {
    listen 80;
    server_name _;                           # match ANY Host — safest behind ICTU's proxy,
                                             # which may forward with Host: <LAN-IP>

    root /opt/cspc/frontend-dist;            # the `npm run build` output from §5.2
    index index.html;

    # Headroom only. The avatar-upload path (and middleware/upload.js) is gone —
    # profile photos now come from Google — so nothing the app accepts is anywhere
    # near this: agent metric batches are deliberately kept under the backend's
    # explicit `express.json({ limit: '100kb' })`. Safe to drop to nginx's 1m default;
    # kept as slack.
    client_max_body_size 4m;

    # React SPA — serve the file if it exists, else fall back to index.html
    location / {
        try_files $uri /index.html;
    }

    # REST API → backend
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Socket.IO — needs the WebSocket upgrade headers
    location /socket.io/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;
        proxy_set_header X-Real-IP  $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

}
```

> ⚠️ **The `/uploads/` location is gone on purpose.** It used to proxy to the backend's
> `express.static("uploads")`, which served real staff profile photos to anyone who asked,
> with no token and no role check. The avatar-upload feature was deleted when login went
> Google-only, and that reader has now been removed from the backend too
> (`audits/api-infra-security-2026-08-25.md` — A-02). Avatars are absolute Google URLs.
> If you copied this config from an earlier revision, delete that line.

### 5.3.1 Security headers for the dashboard PAGE

The backend sets its own headers on every API response (`middleware/securityHeaders.js`),
but **it never serves the HTML** — nginx does, from `frontend-dist`. So the Content-Security
Policy that governs the dashboard has to live here; a CSP set by the API applies only to
API responses.

Add this inside the `server { }` block, above the `location` blocks:

```nginx
    # Applies to everything nginx serves from this vhost, including the SPA shell.
    add_header X-Content-Type-Options  "nosniff"            always;
    add_header X-Frame-Options         "DENY"               always;
    add_header Referrer-Policy         "no-referrer"        always;
    add_header Permissions-Policy      "camera=(), microphone=(), geolocation=()" always;

    # Enable ONLY once §6's certificate is in place. Over plain HTTP this pins the
    # hostname to HTTPS in every staff browser — on a host with no certificate that is
    # a self-inflicted outage, and it is not quickly undoable.
    # add_header Strict-Transport-Security "max-age=15552000" always;

    # Built up with `set` rather than written as one 400-character line. nginx has no
    # line-continuation inside a quoted string — a quoted value split across lines keeps
    # the newlines, and a header value containing a newline is not a valid header.
    set $csp "default-src 'self'";
    set $csp "${csp}; script-src 'self' https://accounts.google.com";
    set $csp "${csp}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com";
    set $csp "${csp}; font-src 'self' https://fonts.gstatic.com";
    set $csp "${csp}; img-src 'self' data: blob: https://*.googleusercontent.com";
    set $csp "${csp}; connect-src 'self' https://accounts.google.com";
    set $csp "${csp}; frame-src https://accounts.google.com";
    set $csp "${csp}; frame-ancestors 'none'; base-uri 'self'";
    set $csp "${csp}; form-action 'self'; object-src 'none'";
    add_header Content-Security-Policy $csp always;
```

Where each allowance comes from — **do not trim these without checking**:

| Directive | Why it is there |
|-----------|-----------------|
| `script-src … accounts.google.com` | `@react-oauth/google` injects `https://accounts.google.com/gsi/client`. Without it the **sign-in button never loads** and nobody can log in |
| `style-src 'unsafe-inline'` | The pages use React `style={{…}}` attributes throughout. A CSP-safe alternative is a per-response nonce, which Vite's static build cannot provide |
| `style-src`/`font-src … fonts.g*` | JetBrains Mono (`src/index.css` `@import`) and Share Tech Mono (`index.html`) are loaded from Google Fonts |
| `img-src … *.googleusercontent.com` | Profile photos come from the Google ID token (`lh3.googleusercontent.com`, but the host varies) |
| `connect-src 'self'` | **Only correct when `VITE_API_URL` points at this same origin.** Left to auto-detect, `config.ts` builds `http://<host>:3000` — a *different* origin — and every API call and the socket are blocked. [§4.1](#41-frontendenv) already tells you to pin it to the public hostname (`https://monitoring.cspc.edu.ph`, no `:3000`); this is the second reason it matters |

> ⚠️ **Verify before go-live, don't assume.** Load the dashboard, open DevTools ▸ Console
> and look for `Refused to load …` / `Refused to connect …`. Then sign out and sign in
> again — the Google button is the piece most likely to be blocked, and it is the piece
> that locks everyone out. `add_header` in nginx is **replaced, not merged**, by any
> `add_header` in a nested `location`, so if you add one later you must repeat these.

### 5.4 Enable it

```bash
sudo ln -s /etc/nginx/sites-available/cspc-monitoring /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default    # the welcome page would otherwise win
sudo nginx -t && sudo systemctl reload nginx
```

`nginx -t` validates the config before you reload — if it reports an error, nginx keeps
running the old config, so a typo can't take the site down.

### 5.5 Test over the LAN — before ICTU connects anything

Do this from **another machine on the campus network**, using the server's LAN IP. Get all
four green before handing the IP to ICTU; if something breaks after they wire it up, you'll
know the problem is on their side.

```bash
# 1. Dashboard HTML is served
curl -I http://<LAN-IP>/                     # → 200, Content-Type: text/html

# 2. SPA routing works (deep links must fall back to index.html, not 404)
curl -I http://<LAN-IP>/dashboard            # → 200

# 3. API reaches the backend (401 is CORRECT — the route exists and demands auth)
curl -i http://<LAN-IP>/api/auth/me          # → 401 {"error":"Access denied..."}

# 4. WebSocket upgrade is accepted
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
     "http://<LAN-IP>/socket.io/?EIO=4&transport=websocket"   # → 101 Switching Protocols
```

Then open `http://<LAN-IP>/` in a browser. The dashboard should load. **Login will fail at
this stage — that's expected**, because Google rejects a bare LAN IP as an OAuth origin
(§6.3). You're only proving nginx serves and routes correctly.

### 5.6 If something's wrong

| Symptom | Cause |
|---|---|
| **403 Forbidden** | nginx (`www-data`) can't read the build directory — check §5.2 permissions, and that it isn't under `/home/` |
| **404 on every deep link** (`/dashboard`) | `try_files $uri /index.html;` missing — the SPA fallback |
| **502 Bad Gateway** on `/api/` | backend isn't running, or not on `:3000`. Check `curl http://127.0.0.1:3000/api/auth/me` on the server itself |
| **Page loads, live data never arrives** | `/socket.io/` block missing the `Upgrade`/`Connection` headers or `proxy_http_version 1.1` |
| **413 on an agent metric batch** | `client_max_body_size` too low, or a proxy in front capping below 100 KB |
| **Sign-in button never appears** | the CSP is blocking `https://accounts.google.com/gsi/client` — check DevTools ▸ Console (§5.3.1) |
| **Page loads, every API call fails** | `connect-src 'self'` with `VITE_API_URL` left to auto-detect → the app calls `:3000`, a different origin (§5.3.1) |
| **nginx welcome page instead of the dashboard** | the `default` site is still enabled — remove the symlink (§5.4) |

### 5.7 Notes

- **TLS:** HTTPS is terminated at **ICTU's edge**
  ([§6](#6-publish-the-dashboard-over-https-ictu-endpoint)) — nginx stays on plain port 80
  locally and you never manage a certificate on this box. Certificates and renewals are
  ICTU's responsibility.
- **HTTPS is not optional.** Google refuses `http://<LAN-IP>` as an OAuth origin, so nginx
  on port 80 with nothing in front of it means **nobody can log in**. §6 has to be in place
  before the system is usable by anyone, on campus or off.
- After this, the backend and dashboard share the hostname `monitoring.cspc.edu.ph`, so
  set `VITE_API_URL` ([§4.1](#41-frontendenv)) and `WEB_ORIGIN` ([§3.1](#31-backendenv))
  to exactly that.

---

## 6. Publish the dashboard over HTTPS (ICTU endpoint)

> 🛠️ **Developing right now? Skip this whole section.** You do **not** need HTTPS or a
> hostname to work on the system. `npm run dev` serves the dashboard at
> `http://localhost:5173`, and **`localhost` is the one non-HTTPS origin Google accepts** —
> so Google sign-in works on your machine with no §6 setup at all.
>
> The only Google Console step development needs is having `http://localhost:5173` listed
> under **Authorized JavaScript origins** (§6.3) on whatever OAuth client your `.env`
> already points at.
>
> Come back to §6 when the dashboard has to be opened from **another machine** — a campus
> PC, a phone, or someone's house. That's the point at which the LAN IP stops working
> (Google rejects `http://192.168.x.x`) and you need the real hostname.

The dashboard needs a real HTTPS hostname before anyone other than you can log in — Google
will not accept a bare LAN IP as an OAuth origin. **ICTU publishes that endpoint**: they own
the DNS record and the certificate, and reverse-proxy to this server on the campus LAN.

```
  https://monitoring.cspc.edu.ph
        │
   ICTU edge  (their DNS record + TLS certificate)
        │  ← reverse-proxy over the campus LAN
   Campus server → nginx :80 → backend :3000
```

**Why this route:** it's free, the hostname is official, ICTU handles certificate renewals,
no third party sits in the traffic path, and nothing extra runs on your server. It also
survives handover cleanly — there's no personal domain or account for anyone to inherit.

### 6.1 Request the HTTPS endpoint from ICTU

Everything else in §6 waits on this, and it's the item with the longest lead time — send the
request as early as you can, even while still developing.

**What you're asking for.** ICTU creates `monitoring.cspc.edu.ph`, terminates TLS with CSPC's
certificate, and reverse-proxies to this server on the campus LAN. You provide the server's
**static LAN IP and port 80** (nginx, §5); they provide everything public-facing.

> ✅ **Off-campus access: agreed with ICTU (2026-08-05).** They want the dashboard reachable
> from outside the campus network, so their edge publishes it: the name resolves in **public**
> DNS, points to a **publicly routable** IP, and inbound 443 is permitted at their firewall.
> Staff can check server status from home. See the hardening note in
> [§10](#10-production-hardening) — the dashboard is now internet-facing, which changes what
> needs protecting.

**Two proxy requirements to state upfront.** These are what usually break with a proxy you
don't control, and both are far cheaper to raise now than to debug later:

| Requirement | Why |
|---|---|
| Pass **WebSocket upgrades** on `/socket.io/` | the dashboard's live data is Socket.IO; without it the page loads but never updates — which looks like a bug in your system |
| Preserve **`X-Forwarded-For`** | the backend uses `req.ip` for the sign-in rate limiter and the `system_logs` audit trail; without it every request appears to come from their proxy |

**The handover spec.** This is everything ICTU needs — how they implement it (nginx, Apache,
HAProxy, an appliance) is their business:

```
Public hostname:  monitoring.cspc.edu.ph
Forward to:       http://<CAMPUS-SERVER-LAN-IP>:80     (plain HTTP over the LAN)
Forward:          ALL paths, unchanged (no prefix stripping / rewriting)

Required headers:
  Host                 monitoring.cspc.edu.ph    ← preserve; don't rewrite to the IP
  X-Forwarded-For      client IP (append)
  X-Forwarded-Proto    https

WebSocket:        allow HTTP/1.1 Upgrade on /socket.io/ (long-lived connections;
                  read timeout well above the ~25 s Socket.IO ping interval)
Max body size:    at least 1 MB (report downloads stream out; the largest
                  request IN is an agent metric batch, capped at 100 KB)

Requested:        restrict /api/agents/ and /api/servers/metrics to campus LAN sources
```

> ⚠️ **Lead with the WebSocket requirement.** If their proxy silently drops upgrade requests,
> the dashboard loads perfectly and simply **never updates** — no error, no console warning,
> nothing visibly broken. It reads as a bug in your application, and you can lose a day
> looking in the wrong place. One sentence upfront prevents it.

Two others bite quietly if missed. **Path rewriting** — if their proxy strips a prefix, every
`/api/...` call 404s. **Body size** — nothing this
system accepts is large (the biggest request in is a 100 KB agent metric batch), but a proxy
capped below that turns an agent's post-outage backfill into a silent 413.

**Draft message** — a complete, ready-to-send version, including the seven questions to ask
them, is in **`https_hostname&reverse_proxy_req_letter.md`** (and as a Word document,
`…_letter.docx`, for sending or printing):

> "We need the ICTU server-monitoring dashboard reachable over HTTPS at
> `monitoring.cspc.edu.ph`. Can you host that endpoint — DNS record plus TLS, reverse-proxied
> to our campus server at `<LAN-IP>:80`?
>
> Two requirements on the proxy: it needs to pass **WebSocket upgrades** on `/socket.io/`
> (the dashboard's live data depends on it) and preserve **`X-Forwarded-For`** so we log real
> client IPs.
>
> Also, could you restrict `/api/agents/` and `/api/servers/metrics` to campus LAN sources at
> the proxy? Those endpoints are only ever called by monitoring agents inside the network —
> never from the internet."

> **`trust proxy` is set to `2`** in `backend/src/server.js` for this topology (ICTU's edge →
> nginx → backend = two hops). With `1` the client IP would resolve to their proxy and every
> user would share one apparent IP, quietly degrading the sign-in rate limiter and the audit
> log. If the topology ever changes, this value has to change with it.

### 6.2 Two addresses, two audiences (important)

| Who | Uses which address |
|---|---|
| **Browsers / staff (incl. from home)** | the **public hostname** `https://monitoring.cspc.edu.ph` |
| **Go agents + ESP32 (on campus)** | the **server's LAN address** `http://<backend-server-ip>:3000` |

Keep the on-campus collectors pointing at the **internal LAN IP** — it's faster and doesn't
depend on ICTU's edge or the internet being up. The public hostname is for human dashboard
access only.

> There is a **third** address, and it is the one people put in the wrong file: nginx
> reaches the backend over `http://127.0.0.1:3000`, which is meaningful only on the campus
> server itself. [§0.1](#01-which-address-goes-where-read-this-before-you-edit-anything)
> is the one-page map of all three — which file each belongs in, and which files need no
> edit at all.

> ⚠️ **Login needs the internet, even on campus.** Ingest survives an ISP outage (the row
> above keeps ESP32 + agents on the LAN), but *signing in* does not: the browser must reach
> `accounts.google.com` and the backend must reach `oauth2.googleapis.com`. If the campus
> link drops, nobody can obtain a new session, and since the JWT expires after 1 h everyone
> already signed in is logged out within the hour. Data keeps being collected and nothing is
> lost — only the dashboard UI becomes unreachable until the link returns.

### 6.3 Update Google OAuth authorized origins

Login runs in the browser from the public origin, so in **Google Cloud Console → your
OAuth Web client**, add `https://monitoring.cspc.edu.ph` to **Authorized JavaScript
origins**. Keep `http://localhost:5173` in the list as well so local development keeps
working. Miss this and sign-in fails from the public URL. See `google-oauth.md`.

Format is strict — `https://monitoring.cspc.edu.ph` exactly: scheme required, **no trailing
slash**, no path, no `:443`, and the host must match character for character. Getting any of
these wrong produces `Error 400: origin_mismatch` when the popup opens.

> ⚠️ **This is why §6 is mandatory, not optional polish.** Google accepts only
> `http://localhost` or an **HTTPS** origin here. A raw `http://192.168.x.x:5173` or
> `http://<backend-server-ip>` is **rejected outright** — you cannot "just add the LAN
> address". Without the ICTU hostname there is **no way for anyone to log in at all**,
> on campus or at home. Treat §6.1 as a prerequisite of the whole deployment, not a
> remote-access convenience.

**Authorized redirect URIs stays empty.** The popup authorization-code flow uses the magic
`postmessage` redirect URI, set in code (`services/googleAuthService.js`) — nothing goes in
that box.

### 6.4 Open the app to all CSPC accounts (Internal audience)

Adding the origin is not enough. A fresh OAuth app sits in **External / Testing**, where
**only Google accounts listed under Test users can sign in**, capped at 100 — fine for
development, unworkable for a campus rollout. Fix this before go-live.

> **"Publishing" is not a step here.** Two settings get conflated: **User type** (Internal ·
> External) and **Publishing status** (Testing · In production). Publishing exists only to
> lift an *External* app out of its 100-test-user sandbox — it does **not** apply to Internal.
> An Internal app is live for the whole organization the moment you set it, with no button to
> press and the Test users list ignored. **Do not "publish"**: that means switching to
> External, which discards the org restriction, the removed user cap, and the absence of an
> "unverified app" warning.

The project lives under the **CSPC Google Workspace**, which unlocks the best option —
**Internal**:

| | External / Testing | External / Published | **Internal** |
|---|---|---|---|
| Who can sign in | only listed test users | any Google account on earth | **only CSPC Workspace accounts** |
| User cap | 100 | none | none |
| Google verification review | n/a | not needed for our scopes | **not needed** |
| "Unverified app" warning | yes | possible | **no** |
| Ongoing admin work | add every user by hand | none | none |

> **Internal is only offered to projects owned by a Workspace organization.** A project
> created with a personal Gmail account can never be switched to Internal, whatever else you
> configure — so create it with a CSPC Workspace account from the start.

> ✅ **Both CSPC domains are confirmed to be one Workspace** (verified 2026-08-05). Employees
> sign in as `@cspc.edu.ph`, students as `@my.cspc.edu.ph`, and a `@my.cspc.edu.ph` account
> was able to log in with Audience already set to **Internal** — which only admits members of
> the owning Workspace, so the two domains are the same tenant.
>
> This was the one thing that could have broken the plan: had they been separate tenants,
> Internal would have refused every student account and you'd have needed External + Published.
> It isn't, so **keep both domains in `GOOGLE_ALLOWED_DOMAINS`** and use Internal.

> **Already done?** Check **IAM & Admin → Settings** — if it shows the `cspc.edu.ph`
> organization, and **Google Auth Platform → Audience** reads *Internal*, steps 1–4 below are
> complete. Only step 5 (adding the production origin to the Web client, §6.3) is left, and
> that has to wait until the hostname exists.

**Steps** (console.cloud.google.com, signed in **with the CSPC Workspace account** — check
the avatar, this is the step people get wrong):

1. **New Project** → name it e.g. `cspc-ictu-monitoring`. The **Organization** field must
   show the CSPC org, not *No organization*. If it says *No organization*, you're on the
   wrong account or lack org rights — stop and resolve that first.
2. **Google Auth Platform → Branding** — app name, support email, optional CSPC logo (under
   Internal the logo shows with no verification review).
3. **Audience → user type = Internal.** If it's greyed out, go back to step 1. There is no
   "Publish" button for Internal — it's live for the whole org as soon as it's configured,
   and the Test users list becomes irrelevant.
4. **Data access / Scopes** — keep **only** `openid`, `email`, `profile`. That's all the app
   reads; anything sensitive or restricted drags you into a verification review for nothing.
5. **Clients → Create client → Web application** — add the origins from §6.3, leave redirect
   URIs empty, then copy **both** the **Client ID** and the **Client secret**.

> ⚠️ **The client secret is shown once.** Google will never display it again — only the last
> 4 characters. If it's lost, use **Add secret** to mint a new one. A client can hold several
> secrets, so the safe rotation is: add new → update `.env` → verify a login → delete old.

**Then update the config** — four values, two files. The client **ID must be identical in
both**, since the backend verifies the ID token's *audience* against it:

```bash
# backend/.env
GOOGLE_CLIENT_ID=<new>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<new secret>
GOOGLE_ALLOWED_DOMAINS=cspc.edu.ph,my.cspc.edu.ph
WEB_ORIGIN=https://monitoring.cspc.edu.ph

# frontend/.env
VITE_GOOGLE_CLIENT_ID=<new>.apps.googleusercontent.com   # SAME id as above
VITE_API_URL=https://monitoring.cspc.edu.ph              # see §4.1 — no :3000 behind nginx
```

Restart the backend and **rebuild** the frontend — neither picks these up live (nodemon does
not reload `.env`; Vite inlines `VITE_*` at build time).

**Keep `GOOGLE_ALLOWED_DOMAINS` set even under Internal.** Google restricts sign-in to the
org; the allow-list independently restricts it to these two domains. Defence in depth, and
it lets you narrow access further without touching Google.

**Verify:**

| Test | Expected |
|---|---|
| Approved CSPC account | reaches the dashboard |
| New CSPC account | "Registration submitted…" → shows in **User Management → Pending registrations** |
| Personal `@gmail.com` | blocked by Google (Internal); our domain gate refuses it too |
| `@my.cspc.edu.ph` student account | works (confirmed under Internal, 2026-08-05) — re-test after any Audience change |
| Open the public HTTPS URL | popup opens, no `origin_mismatch` |

**What does *not* change:** no application code changes — this is Google Cloud config plus
`.env`. Existing accounts keep working, because Google's `sub` identifies the Google
*account*, not the OAuth client, so stored `users.google_sub` values stay valid across a
project switch. And **Internal does not mean "everyone at CSPC gets in"** — it controls who
may *knock*; a first-time sign-in still lands `status='pending'` until an admin approves it
(§4.3).

**Cut over safely:** keep the old project/client alive for a few days after the swap.
Reverting is just pasting the old two values back into `.env` and restarting. Delete the old
project only once the new one is proven.

---

## 7. Server agents (Go) — one per monitored server

Build once on a machine with Go; run the binary anywhere (no Go/runtime on targets).
Full runbook: `server-metrics.md`; internals: `agent/README.md`.

```bash
cd cspc-agent
go mod tidy
make all        # → dist/cspc-agent-windows-amd64.exe, dist/cspc-agent-linux-amd64, dist/cspc-agent-linux-arm64
```

Install on a target server as a background service (enrolls, waits for your approval,
then runs). Point `-api-url` at the **backend server's LAN address** (not the public hostname):

**Get the install key from the dashboard first.** As admin: **Server Metrics → Agent
install keys → + New key**. Label it (e.g. "Main server room — Aug 2026"), optionally set
an expiry, and copy the ready-made command it prints — the key is shown **once**.

> **`<backend-server-ip>` is the LAN IP of the Linux box running the backend** — the same
> machine that holds `/opt/cspc`, e.g. `192.168.100.9`. It is **not** the public hostname,
> and **not** the address of the server being monitored. Every agent on every host points
> at this one address. See §6.2 for why on-campus collectors stay on the LAN even after
> HTTPS is published.

```powershell
# Windows — elevated PowerShell, binary in same folder
.\install.ps1 -ApiUrl "http://<backend-server-ip>:3000" -InstallKey "AIK-<key>"
```
```bash
# Linux — systemd
sudo bash install.sh http://<backend-server-ip>:3000 AIK-<key>
```

Then in the dashboard (as admin): **Server Metrics → approve** the pending agent. It
streams CPU/mem/disk/net every ~10 s thereafter.

> Revoke the key from the same panel once the rollout is done. The dialog lists the
> servers that key enrolled and offers two outcomes: **revoke key only** (blocks new
> installs, running servers untouched) or **revoke key and stop its servers** (those
> agents get a 403 on their next post and shut themselves down). The second is reversible
> — history is kept, and re-installing with a live key brings the machine back as the same
> server, pending approval.

---

## 8. ESP32 environment node

Edit `iot/esp32/env_monitor_v2/env_monitor_v2.ino` before flashing — three constants are **hardcoded in
firmware** (not driven by `.env`):

| Constant | Set to |
|---|---|
| `host` | campus server's **LAN IP/hostname** |
| `port` | `3000` |
| `deviceSecret` | **exactly** the backend's `DEVICE_SECRET` |

Then:

1. `#define SD_ENABLED false` unless the SD module is physically wired.
2. Flash via Arduino IDE / arduino-cli (ESP32 board package, correct COM port).
3. On boot it connects over Socket.IO (device key auth) and starts sending `sensorData`
   every ~3 s → the **Environment** page goes live.

Alarm thresholds and IR/auto-cooling boundaries are **runtime-configurable from the
dashboard** (Alert Rules + Auto-Cooling Thresholds) via the `envConfig` / `acConfig`
socket events — no reflash needed to retune. IR raw codes are still mock NEC until
captured from the real remote (see `CLAUDE.md` → Air Conditioner System).

---

## 9. Ports & firewall

| Port | Service | Who connects |
|---|---|---|
| 80 (LAN) | nginx → dashboard + API proxy | ICTU's reverse proxy; LAN browsers |
| 3000 | Backend (HTTP + WebSocket) | nginx, Go agents, ESP32 (LAN) |
| 5173 | Vite dev server | browsers (dev only — not in prod) |
| 3306 | MySQL | backend only — **do not expose** |
| 8086 | InfluxDB | backend only — **do not expose** |

- **Nothing is exposed to the internet from this server.** ICTU's edge is the only
  public-facing component; it reaches nginx over the campus LAN on port 80. Any inbound 443
  rule lives at their edge, not here.
- Keep MySQL (3306) and InfluxDB (8086) bound to localhost / the backend host only.

### 9.1 Restrict port 3000 to the agent subnets — do this on deploy day

The backend listens on `0.0.0.0:3000` (`src/server.js`), and it **has to**: the Go agents and
the ESP32 connect to it directly, not through nginx. So port 3000 is reachable by anything on
the campus LAN, and *that is the bypass* — a client talking to `:3000` skips nginx entirely,
which means it also writes its own `X-Forwarded-For`. With `TRUST_PROXY=2` the backend believes
two of those entries, so such a client picks its own `req.ip`: its own bucket in every IP-keyed
rate limiter (sign-in, agent enrollment, metric ingest) and its own value in
`system_logs.ip_address` — the row that is the evidence for a Privacy Notice acceptance.

No code can close this, because the port must stay open to the LAN. It is a firewall rule:

```bash
sudo ufw allow 80/tcp                                        # nginx — browsers
sudo ufw allow from <AGENT_SUBNET> to any port 3000 proto tcp # e.g. 10.10.20.0/24
sudo ufw allow from <ESP32_SUBNET> to any port 3000 proto tcp # if it differs
sudo ufw deny 3000                                            # everyone else
sudo ufw enable && sudo ufw status numbered
```

Replace `<AGENT_SUBNET>` / `<ESP32_SUBNET>` with the ranges those devices actually sit on — ask
ICTU which VLAN the server room and the monitored servers are on; do not guess a /8.

**Browsers are unaffected** — they reach the API through nginx on 80/443 and never touch 3000.
Verify from a machine outside the allowed range:

```bash
curl -m 5 http://<backend-server-ip>:3000/api/policy/version   # expect: timeout / refused
curl -I  http://<backend-server-ip>/                            # expect: 200 (nginx still fine)
```

Then re-check that an agent still reports in (Server Metrics → the host goes Online). If it
does not, its subnet is not in the allow list.

> ⚠️ Run `ufw allow 22/tcp` (or your SSH port) **before** `ufw enable` if you are on SSH —
> enabling a default-deny firewall over SSH without it locks you out of the box.

See `audits/api-infra-security-2026-08-25.md` — A-03.

---

## 10. Production hardening

- **HTTPS / reverse proxy:** nginx ([§5](#5-serve-everything-from-one-campus-server-nginx))
  behind **ICTU's edge** ([§6](#6-publish-the-dashboard-over-https-ictu-endpoint)), which
  terminates TLS — no certificates to manage on this box.

> ⚠️ **The dashboard is internet-facing.** ICTU publishes it publicly (§6.1), so the login page
> is reachable by anyone, including bots and scanners. Three layers already stand in the way,
> and it's worth knowing they're what makes public exposure acceptable:
>
> 1. **Google OAuth with Internal audience** — only accounts in the CSPC Workspace can even
>    authenticate. There's no password to guess and no local account to brute-force.
> 2. **Admin approval** — a valid CSPC account still lands `status='pending'` and cannot hold a
>    session until an admin approves it ([§4.3](#43-bootstrap-the-first-admin-important--chicken-and-egg)).
> 3. **Rate limiting** — 30 sign-in attempts / 15 min per IP (failures only), 3000 requests /
>    15 min keyed **per user** where the request carries a verified JWT and per IP otherwise,
>    plus 50 failed Socket.IO handshakes / 15 min per IP. These depend on `TRUST_PROXY` being
>    correct AND on §9.1's firewall rule, or a client can choose its own bucket.
>
> **Worth asking ICTU for:** restrict `/api/agents/` and `/api/servers/metrics` to campus LAN
> sources at their proxy. Go agents and the ESP32 always connect over the LAN
> ([§6.2](#62-two-addresses-two-audiences-important)), so those paths never need to accept
> internet traffic — and `/api/agents/register` accepts the shared `AGENT_INSTALL_KEY`, which is
> the one credential worth keeping off a public endpoint.
- **Secrets:** unique, long `JWT_SECRET` / `DEVICE_SECRET` / `AGENT_INSTALL_KEY`. Never
  commit `.env` or `agent.conf`. Rotate `AGENT_INSTALL_KEY` if it leaks (approved agents
  keep working — they use per-device tokens).
- **CORS:** set `WEB_ORIGIN` to the exact public dashboard origin (the ICTU hostname);
  avoid `*` outside a trusted LAN.
- **`TRUST_PROXY`** (backend/.env) is how many proxy hops may be believed when they claim a
  client's address. Default **2** = ICTU's edge → campus nginx → backend, which is this
  deployment. Set it to the REAL hop count: too low and every user shares one apparent IP
  (their proxy's); too high and the surplus entries are attacker-supplied (§9.1).
- **DB user:** least-privilege app user ([§2.1](#21-mysql)), not root.
- **Backups:** a full on-site + offsite (cloud) backup runbook is in
  [§11](#11-backups--on-site--offsite-cloud) — an NDJSON stream mirror, a nightly
  `mysqldump`, and an encrypted **Backblaze B2** offsite copy (3-2-1).
- **OS-popup notifications** require a secure context — they work once the dashboard is
  served over the HTTPS hostname (not over a plain-HTTP LAN IP).

---

## 11. Backups — on-site + offsite (cloud)

> **Step-by-step walkthroughs** (this section is the reference; those are the runbooks):
> **Linux → [`ops/backup-setup-linux.md`](ops/backup-setup-linux.md)** ·
> Windows → [`ops/backblaze-setup-guide.md`](ops/backblaze-setup-guide.md)

> **Branch scope.** The automated backup subsystem (the NDJSON stream mirror written by
> `backupService`, plus `ops/db-backup/` and `ops/offsite-backup/`) ships with the backup
> work on the **`mikrotik-monitoring`** branch, not this one — deploy it once that branch
> is merged (or if you deploy from it). The **full step-by-step for the cloud copy** is in
> **`ops/backblaze-setup-guide.md`**; this section is the deploy-time summary.

Three copies, **3-2-1** style — so the data survives a DB wipe, a dead disk, *and* a lost
building:

| # | Copy | Where | Set up in |
|---|---|---|---|
| 1 | Live databases | MySQL + InfluxDB on the campus server | [§2](#2-databases) |
| 2 | On-site backup | NDJSON stream mirror + nightly `mysqldump`, on a **USB / micro-SD** (`BACKUP_DIR`) | 11.1 |
| 3 | **Offsite (cloud)** | **Backblaze B2**, client-side **encrypted** | 11.2 |

### 11.1 On-site copy (local drive)

The backend automatically mirrors **every ingested sample** (env / server / router / UPS)
to rotating NDJSON files under `BACKUP_DIR` — an independent copy that survives a DB wipe.
Add the relational half with the nightly MySQL dump. Env vars in `backend/.env`:

```dotenv
BACKUP_DIR=/mnt/backup/backups     # a mounted USB stick / micro-SD — NOT the same disk as the DB
BACKUP_RETENTION_DAYS=30           # local files older than this are purged daily
```

Schedule the DB dump a few minutes **before** the offsite sync (Linux cron shown; Windows
Task Scheduler in `ops/db-backup/README.md`):

```cron
15 2 * * *  BACKUP_DIR=/mnt/backup/backups /opt/cspc/ops/db-backup/dump-mysql.sh
```

The dump lands in `BACKUP_DIR` as `mysql-YYYY-MM-DD.sql.gz`, so the offsite job **and** the
retention + SHA-256 integrity manifest cover it automatically — no extra plumbing.

### 11.2 Offsite copy (Backblaze B2, encrypted)

A scheduled `rclone` job copies `BACKUP_DIR` to a Backblaze B2 bucket, **encrypted
client-side** (data *and* filenames) before it leaves campus. It uses `rclone copy` (never
`sync`) so the cloud keeps full history even after local retention purges.

1. **Account:** sign up at backblaze.com with a **CSPC institution email** (ideally a shared
   ICTU mailbox), choose **Application storage (B2 Cloud Storage)**, create a **Private**
   bucket + an application key scoped to it. The sign-up email owns the backups + billing
   forever — keep it CSPC's, not personal. Cost is a few cents/month (telemetry is tiny).
2. **Install `rclone`** on the campus server and configure two remotes — a raw `b2` and a
   `crypt` layer on top (template: `ops/offsite-backup/rclone.conf.example`).
3. **Schedule** the sync just after the dump:

```cron
30 2 * * *  BACKUP_DIR=/mnt/backup/backups /opt/cspc/ops/offsite-backup/sync-offsite.sh
```

4. **Backend offsite-health alert** — each successful sync stamps
   `BACKUP_DIR/.last_offsite_sync`; point the backend at it:

```dotenv
BACKUP_OFFSITE_ENABLED=true
BACKUP_OFFSITE_MAX_AGE_HOURS=26    # warn if no successful sync within this window
```

If the sync stalls, the backend raises a `backup_offsite` warning on the normal bell/email
pipeline and auto-resolves it once a fresh sync lands. Leave `BACKUP_OFFSITE_ENABLED` unset
until the sync is actually running, so it never false-alerts.

> ⚠️ **Keep offline + safe** (they are **not** in any backup): the rclone **encryption
> passphrase**, `rclone.conf`, and `backend/.env`. Without the passphrase the cloud copy is
> unrecoverable — that's the point of client-side encryption. Store them with CSPC,
> separately from the server.

Full walkthrough — bucket, keys, rclone config, connection test, restore, and verification:
**`ops/backblaze-setup-guide.md`**.

---

## 12. Post-deploy verification checklist

- [ ] `node src/server.js` logs `Server running on port 3000` with no DB/Influx errors.
- [ ] `https://monitoring.cspc.edu.ph/` loads the dashboard **from off the campus network** (test on phone mobile data, WiFi off).
- [ ] Live data updates on the public URL — confirms ICTU's proxy passes WebSocket upgrades.
- [ ] `system_logs` shows real client IPs, not ICTU's proxy address (confirms `trust proxy = 2`).
- [ ] **Google sign-in** works from the public URL (origin added in Google Console — [§6.3](#63-update-google-oauth-authorized-origins)).
- [ ] First admin promoted ([§4.3](#43-bootstrap-the-first-admin-important--chicken-and-egg)); **Pending registrations** visible under User Management.
- [ ] **Alert Rules** page shows seeded rules (confirms the schema loaded WITH its data —
      an empty list means the export was structure-only and alerting will be silent).
- [ ] A Go agent enrolls → appears pending → approves → **Server Metrics** shows live gauges.
- [ ] ESP32 connected → **Environment** page shows live temp/humidity/gas.
- [ ] Trip a threshold (or lower a rule) → **bell + toast** fire; email arrives if Resend configured.
- [ ] Stop an agent → the server flips **Offline** and an alert is raised (within
      `max(SERVER_OFFLINE_AFTER_SEC, agent interval × 3)`, so ~30 s at default settings).
- [ ] **Network**: add a router ([§14](#14-router--ups--mikrotik--now-deployable-with-caveats)) → within one poll cycle (~60 s) it flips
      **Online** and its ports appear. Expect CPU/Mem to stay blank on SNMP routers.
- [ ] **UPS**: add a UPS → battery %, runtime and load populate within ~60 s.
- [ ] Per-device **View → Event Log** shows the "reachable" entry for each new device.
- [ ] **Analytics** page renders (disk-full ETA / alert summary). Forecasts read
      "need more data" until ~1–2 weeks of history accrues — expected, not a fault
      ([§13](#13-troubleshooting)); the alert-analytics half is useful on day one.
- [ ] If a device stays Offline: check the backend console — the poller logs *why* the
      poll failed (timeout vs wrong community vs unreachable).

---

## 13. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Public URL loads the page but API/live data fails | `VITE_API_URL` not set to the public origin (rebuild after setting), or nginx not proxying `/api` + `/socket.io` ([§5](#5-serve-everything-from-one-campus-server-nginx)). |
| Page loads but live data never updates | ICTU's proxy is not passing **WebSocket upgrades** on `/socket.io/` — the most common failure with a proxy you don't control ([§6.1](#61-request-the-https-endpoint-from-ictu)). |
| Every request logs the same IP | ICTU's edge adds a second proxy hop — set `trust proxy` to `2` in `backend/src/server.js` ([§6.1](#61-request-the-https-endpoint-from-ictu)). |
| API calls blocked (CORS error in console) | Public origin not in `WEB_ORIGIN`. Add the exact hostname; restart backend. |
| Login fails from the public URL | Origin not in the Google OAuth **Authorized JavaScript origins** ([§6.3](#63-update-google-oauth-authorized-origins)), or `GOOGLE_CLIENT_ID` mismatch between front/back. |
| Login rejects a valid user | Email domain not in `GOOGLE_ALLOWED_DOMAINS`; only `@cspc.edu.ph`/`@my.cspc.edu.ph` are allowed. |
| First user can't do anything | Still `status='pending'`. Promote in MySQL ([§4.3](#43-bootstrap-the-first-admin-important--chicken-and-egg)). |
| No alerts ever fire | `alert_rules` is empty → alerting is rules-only → silent. The schema seeds it; if the table is empty the dump was loaded structure-only. |
| Agent stuck "pending" | Not approved yet (Server Metrics page), or `AGENT_INSTALL_KEY` mismatch. |
| Agent can't reach backend | Pointed at the public hostname instead of the **LAN IP**, or LAN firewall blocks :3000. Agents use `http://<backend-server-ip>:3000` ([§6.2](#62-two-addresses-two-audiences-important)). |
| Agent 403s and removes itself | The server was **removed** in the dashboard (token revoked). Re-run `--register`. |
| ESP32 won't connect | `deviceSecret` ≠ backend `DEVICE_SECRET`, or wrong `host`/`port` (use the LAN IP). |
| Analytics shows "need more data" | Expected early — forecasts need ~1–2 weeks of `server_metrics`; alert analytics works day one. |

---

## 14. Router / UPS / MikroTik — now deployable, with caveats

`router-ups-monitoring` is **merged into `main`**, so SNMP router/UPS monitoring and the
MikroTik RouterOS poller deploy from this branch. Env vars are in
[§3.1](#31-backendenv); the InfluxDB measurements (`router_metrics`, `network_traffic`,
`ups_metrics`) are created automatically on first write.

Devices are registered **from the dashboard** (admin-only **Add router** / **Add UPS** on
the Network and UPS pages) — no seed SQL. The poller reloads its device list every cycle,
so a new device starts being polled within ~60s with no restart.

**Before adding a device, on the device itself:**

1. Enable **SNMP v2c** and set a **read-only** community (prefer something other than
   `public`). v3 is *not supported* — `device_network` has no v3 credential columns.
2. Confirm **UDP 161** is reachable from the campus server.
3. Probe it first, from the backend host:
   ```bash
   snmpwalk -v2c -c <community> <device-ip>                 # any device
   snmpwalk -v2c -c <community> <ups-ip> 1.3.6.1.2.1.33     # UPS-MIB subtree
   ```
   A tree back = right IP + community + open firewall. A timeout = fix that first, or the
   dashboard will just show the device Offline.

**Hard limits to set expectations:**

- A **UPS needs a network / SNMP card.** A USB- or serial-only UPS cannot be monitored.
- A router must be **managed**. Unmanaged gear cannot be registered at all — the Add form
  requires a community string and the ICMP-ping fallback is not built.
- **Router CPU / memory stay blank.** Those OIDs are vendor-specific, not in the standard
  MIBs, so the seeded `router_cpu` / `router_mem` rules never fire on SNMP routers. (They
  do work on MikroTik, which reports them over the RouterOS API.)
- A **3-phase UPS reports line 1 only**.

> This is exactly **why the backend must stay on-prem**: the pollers connect *into* the
> campus LAN (SNMP UDP 161 / RouterOS API) to private addresses a cloud host can't reach.

### Still roadmap

- **ICMP-ping fallback** for unmanaged / no-community routers — not built.
- **SNMP v3** — needs credential columns on `device_network` plus a v3 branch in
  `snmpClient`.

---

*See also: `CLAUDE.md` (architecture), `server-metrics.md` (agent ops),
`google-oauth.md` (login setup), `email-popup-notifications.md` (alerting/email),
`https_hostname&reverse_proxy_req_letter.md` / `.docx` (the request to send ICTU).*
