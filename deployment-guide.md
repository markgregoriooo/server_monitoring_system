# Deployment Guide — CSPC-ICTU Server Infrastructure Monitoring System

End-to-end runbook for standing up the system on a fresh host. Grounded in the real
entry point (`backend/src/server.js`), config (`backend/config/*`), schema
(`V10cspc-ictu-monitoring-system-schema.sql` + `migrations/`), Go agent, and ESP32
firmware. For *how each part works internally* see `CLAUDE.md`, `server-metrics.md`,
`google-oauth.md`, and `email-popup-notifications.md`.

> **Scope.** This covers everything currently on `main` / `predictive-analytics`:
> backend API, React dashboard, MySQL + InfluxDB, the Go server agents, and the ESP32
> environment node. The **router / UPS / MikroTik** monitoring lives on separate,
> unmerged branches and is **not deployable from here yet** — see [§14](#14-not-yet-deployable-roadmap-features).

> **Deployment model (decided):** **on-premise at CSPC** — the backend, databases, and
> dashboard all run on one **campus server**, and staff reach it from home through a
> **Cloudflare Tunnel** (public HTTPS, no port-forwarding). The backend *must* be on
> campus because it talks directly to the server-room hardware over the LAN (and, on the
> roadmap, polls routers/UPS/MikroTik on private addresses a cloud host can't reach).
> See [§5](#5-serve-everything-from-one-campus-server-nginx) and
> [§6](#6-remote-access--login-from-home-cloudflare-tunnel--domain).

---

## 0. Architecture at a glance (what you actually deploy)

```
   Staff at home ─https─▶ Cloudflare ─tunnel─┐  (outbound from campus; no inbound ports)
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
        ▲ Socket.IO(deviceKey)        ▲ HTTP Bearer        ▲ SNMP/RouterOS (future)
   ESP32 env node              Go agents (per server)   Routers/UPS/MikroTik
   (campus LAN)               (campus LAN)              (campus LAN)
                                                + Google OAuth (login) · Resend (email, optional)
```

**On-campus collectors point at the server's LAN address; only humans (browsers) use the
public tunnel URL.** See [§6](#6-remote-access--login-from-home-cloudflare-tunnel--domain).

**Five deployable units:** (1) MySQL, (2) InfluxDB, (3) backend, (4) frontend,
(5) the edge collectors (Go agents on each server + the ESP32 firmware) — units 1–4 all
live on the one campus server.

---

## 1. Prerequisites

| Component | Version | Notes |
|---|---|---|
| Node.js | **18+** (LTS 20 recommended) | backend + frontend build |
| npm | bundled with Node | |
| MySQL | **8.0+** | relational store |
| InfluxDB | **2.x** | time-series store (env + server metrics) |
| nginx | latest | serves the dashboard + reverse-proxies the API ([§5](#5-serve-everything-from-one-campus-server-nginx)) |
| cloudflared | latest | Cloudflare Tunnel for remote access ([§6](#6-remote-access--login-from-home-cloudflare-tunnel--domain)) |
| Go | **1.22+** | only to *build* the agents; target servers need nothing |
| Arduino IDE / arduino-cli | latest | only to flash the ESP32 |
| A Google Cloud OAuth **Web** client | — | login is Google-only (`google-oauth.md`) |
| A domain / subdomain | — | for the public URL — ideally a free `…cspc.edu.ph` subdomain ([§6.1](#61-get-a-domain)) |
| (optional) Resend account | — | alert emails; system works without it |

Network: the backend listens on **0.0.0.0:3000** (all interfaces). On-campus collectors
(agents, ESP32) reach it directly at the server's LAN IP:3000; browsers reach it through
nginx (+ the tunnel). Give the campus server a **static LAN IP / internal hostname** —
agents and firmware cache the address.

---

## 2. Databases

### 2.1 MySQL

The schema file creates the database **`server_monitoring_system`** (this is your
`DB_NAME`).

```bash
# 1) Create + load the base schema (V10)
mysql -u root -p < V10cspc-ictu-monitoring-system-schema.sql

# 2) Apply migrations in chronological order. The base schema is dated 2026-06-09,
#    so 2026-06-09_google_auth.sql may already be folded in — if a column already
#    exists, that one statement errors harmlessly; the later ones are the important set.
mysql -u root -p server_monitoring_system < migrations/2026-06-13_alerts_nullable_device.sql
mysql -u root -p server_monitoring_system < migrations/2026-06-13_notifications.sql
mysql -u root -p server_monitoring_system < migrations/2026-06-14_alert_rules.sql
mysql -u root -p server_monitoring_system < migrations/2026-06-14_alert_rules_updated_by.sql
mysql -u root -p server_monitoring_system < migrations/2026-06-14_alerts_resolved_by.sql
mysql -u root -p server_monitoring_system < migrations/2026-06-14_alerts_rule_fk_setnull.sql
mysql -u root -p server_monitoring_system < migrations/2026-06-15_aircon_ir_config.sql
```

> ⚠️ **`2026-06-14_alert_rules.sql` is mandatory.** Alerting is *rules-only* — with no
> rows in `alert_rules`, **no threshold alert ever fires** (CPU/mem/disk and
> temperature/gas/humidity all go silent). This migration seeds the default rules.

Create a dedicated app user (don't run the app as root):

```sql
CREATE USER 'cspc_app'@'%' IDENTIFIED BY 'a-strong-password';
GRANT SELECT, INSERT, UPDATE, DELETE ON server_monitoring_system.* TO 'cspc_app'@'%';
FLUSH PRIVILEGES;
```

### 2.2 InfluxDB 2.x

Install InfluxDB 2.x, then via the UI (`http://<host>:8086`) or `influx setup`:

1. Create an **org** (e.g. `cspc-ictu`) and a **bucket** (e.g. `monitoring`).
2. Create an **API token** with read+write on that bucket.
3. Note the **URL** (`http://localhost:8086`), org, bucket, token → these become the
   `INFLUX_*` env vars below.

The backend writes two measurements automatically (no manual schema): `sensor_environment`
(ESP32) and `server_metrics` (Go agents), both at millisecond precision. Set a sensible
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

# MySQL
DB_HOST=127.0.0.1
DB_USER=cspc_app
DB_PASSWORD=a-strong-password
DB_NAME=server_monitoring_system
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

# CORS — the dashboard's public origin (the tunnel hostname from §6). Comma-separated;
# or * for a roaming LAN. Include http://localhost:5173 too if you also use the dev server.
WEB_ORIGIN=https://monitoring.cspc.edu.ph

# Alert email (optional — blank RESEND_API_KEY = email off; bell + toast still work)
RESEND_API_KEY=
RESEND_FROM=CSPC ICTU Monitoring <alerts@your-verified-domain>
NOTIFY_EMAIL_MIN_SEVERITY=critical       # info|warning|critical
NOTIFY_EMAIL_TO=                         # force ALL mail to one address (testing only)
NOTIFY_COOLDOWN_MIN=30                   # de-dup window (restart-proof)
NOTIFY_RETENTION_DAYS=30                 # purge alerts older than this, daily
```

Generate strong secrets, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
`DEVICE_SECRET` must equal the firmware constant; `AGENT_INSTALL_KEY` is what every agent
presents at enrollment.

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

```ini
# Option B — systemd  (/etc/systemd/system/cspc-backend.service)
[Unit]
Description=CSPC-ICTU Monitoring Backend
After=network.target mysql.service influxdb.service

[Service]
WorkingDirectory=/opt/cspc/backend
ExecStart=/usr/bin/node src/server.js
EnvironmentFile=/opt/cspc/backend/.env
Restart=on-failure
User=cspc

[Install]
WantedBy=multi-user.target
```

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
# For the campus + tunnel topology (§5/§6): pin the backend to the PUBLIC origin (no :3000).
# nginx reverse-proxies /api and /socket.io to the backend on the same hostname, so the
# browser talks to one origin. Must match the tunnel hostname and the backend's WEB_ORIGIN.
VITE_API_URL=https://monitoring.cspc.edu.ph
```

> Why set this here: by default the app auto-detects the backend at `<page-host>:3000`
> (`frontend/src/config.ts`). Behind nginx + the tunnel, port 3000 isn't public — the API
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
admin must be activated by hand:

1. Have that person sign in once with their CSPC Google account (creates the pending row).
2. Promote them directly in MySQL:

```sql
UPDATE users SET status = 'active', role = 'admin'
WHERE email = 'firstadmin@cspc.edu.ph';
```

They can now log in and approve everyone else from **User Management → Pending registrations**.

---

## 5. Serve everything from one campus server (nginx)

Put the built dashboard **and** the backend behind a single nginx on the campus server, so
the browser sees one origin (no cross-origin/mixed-content issues) and one hostname is
exposed by the tunnel.

`/etc/nginx/sites-available/cspc-monitoring` (symlink it into `sites-enabled/`):

```nginx
server {
    listen 80;
    server_name monitoring.cspc.edu.ph;     # your tunnel hostname (§6); or _ to match any

    root /opt/cspc/frontend/dist;            # the `npm run build` output
    index index.html;

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

    # Uploaded avatars (backend serves /uploads as static)
    location /uploads/ { proxy_pass http://127.0.0.1:3000; }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/cspc-monitoring /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

- **TLS:** with the Cloudflare Tunnel ([§6](#6-remote-access--login-from-home-cloudflare-tunnel--domain))
  HTTPS is terminated **at Cloudflare's edge** — nginx can stay on plain port 80 locally
  and you don't manage certificates on the box. (If you ever expose nginx directly to the
  internet instead of via the tunnel, add a real cert with `certbot --nginx` and listen on
  443.)
- After this, the backend and dashboard share the hostname `monitoring.cspc.edu.ph`, so
  set `VITE_API_URL` ([§4.1](#41-frontendenv)) and `WEB_ORIGIN` ([§3.1](#31-backendenv))
  to exactly that.

---

## 6. Remote access — login from home (Cloudflare Tunnel + domain)

"Accessible from home" is a *networking* switch, not a hosting choice: the server stays on
campus, and a tunnel publishes it to the internet. **Cloudflare Tunnel** makes an
**outbound** connection from the campus server to Cloudflare, so you need **no static
public IP and no firewall ports opened** — ideal behind a campus network.

```
  https://monitoring.cspc.edu.ph
        │
   Cloudflare edge (free TLS)
        │  ← cloudflared holds an outbound connection
   Campus server → nginx :80 → backend :3000
```

### 6.1 Get a domain

| Option | Cost | Notes |
|---|---|---|
| **`…cspc.edu.ph` subdomain from ICTU** (recommended) | **free** | CSPC already owns the domain. Ask the network admins for e.g. `monitoring.cspc.edu.ph`. Official + professional for the panel. |
| **Buy a cheap domain** (Cloudflare Registrar / Namecheap) | ~$1–12/yr | e.g. `cspc-monitoring.online`; add it to a free Cloudflare account. Fully under your control. |
| **Temporary demo URL** | free | `cloudflared tunnel --url http://localhost:80` prints a random `https://<words>.trycloudflare.com` — instant proof it works from home. Not stable (URL changes each run, and Google login needs a fixed origin), so use it only to demo reachability. |

To use a named tunnel, the domain must be on a **free Cloudflare account** (add the
domain, switch its nameservers to Cloudflare).

### 6.2 Create the tunnel (on the campus server)

```bash
# 1) Install cloudflared (Debian/Ubuntu example)
curl -fsSL https://pkg.cloudflare.com/cloudflared/gpg.key | sudo gpg --dearmor -o /usr/share/keyrings/cloudflare.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install cloudflared

# 2) Authenticate (opens a browser; pick your Cloudflare domain)
cloudflared tunnel login

# 3) Create the tunnel (writes a credentials .json under ~/.cloudflared/)
cloudflared tunnel create cspc-monitoring

# 4) Point the public hostname at the tunnel (creates the DNS record for you)
cloudflared tunnel route dns cspc-monitoring monitoring.cspc.edu.ph
```

Config — `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL-ID>                                   # printed by `tunnel create`
credentials-file: /home/cspc/.cloudflared/<TUNNEL-ID>.json

ingress:
  - hostname: monitoring.cspc.edu.ph
    service: http://localhost:80                      # nginx from §5
  - service: http_status:404
```

Run it, then install as a boot service:

```bash
cloudflared tunnel run cspc-monitoring     # test in the foreground
sudo cloudflared service install           # then run on boot (systemd)
```

`https://monitoring.cspc.edu.ph` is now reachable from anywhere, with HTTPS, no ports
opened.

### 6.3 Two addresses, two audiences (important)

| Who | Uses which address |
|---|---|
| **Browsers / staff (incl. from home)** | the **public tunnel URL** `https://monitoring.cspc.edu.ph` |
| **Go agents + ESP32 (on campus)** | the **server's LAN address** `http://<campus-server-ip>:3000` |

Keep the on-campus collectors pointing at the **internal LAN IP** — it's faster and doesn't
depend on internet/Cloudflare being up. The tunnel is only for human dashboard access.

### 6.4 Update Google OAuth authorized origins

Login runs in the browser from the public origin, so in **Google Cloud Console → your
OAuth Web client**, add `https://monitoring.cspc.edu.ph` to **Authorized JavaScript
origins** (and the temporary `trycloudflare.com` URL too, if you demo with it). Miss this
and sign-in fails from the public URL. See `google-oauth.md`.

---

## 7. Server agents (Go) — one per monitored server

Build once on a machine with Go; run the binary anywhere (no Go/runtime on targets).
Full runbook: `server-metrics.md`; internals: `go-agent/README.md`.

```bash
cd go-agent
go mod tidy
make all        # → dist/go-agent-windows-amd64.exe, dist/go-agent-linux-amd64, dist/go-agent-linux-arm64
```

Install on a target server as a background service (enrolls, waits for your approval,
then runs). Point `-api-url` at the campus server's **LAN address** (not the tunnel URL):

```powershell
# Windows — elevated PowerShell, binary in same folder
.\install.ps1 -ApiUrl "http://<campus-server-ip>:3000" -InstallKey "<AGENT_INSTALL_KEY>"
```
```bash
# Linux — systemd
sudo bash install.sh http://<campus-server-ip>:3000 <AGENT_INSTALL_KEY>
```

Then in the dashboard (as admin): **Server Metrics → approve** the pending agent. It
streams CPU/mem/disk/net every ~10 s thereafter. (`AGENT_INSTALL_KEY` here must equal the
backend `.env` value.)

---

## 8. ESP32 environment node

Edit `iot/esp32/env_monitor_v2.ino` before flashing — three constants are **hardcoded in
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
| 80 (local) | nginx → dashboard + API proxy | the Cloudflare tunnel (localhost); LAN browsers |
| 3000 | Backend (HTTP + WebSocket) | nginx, Go agents, ESP32 (LAN) |
| 5173 | Vite dev server | browsers (dev only — not in prod) |
| 3306 | MySQL | backend only — **do not expose** |
| 8086 | InfluxDB | backend only — **do not expose** |

- **No inbound public ports needed.** The Cloudflare Tunnel dials *out* from the campus
  server, so you don't open or forward anything at the campus firewall.
- On the LAN, allow the agent/ESP32 subnets to reach the server on **3000**.
- Keep MySQL (3306) and InfluxDB (8086) bound to localhost / the backend host only.

---

## 10. Production hardening

- **HTTPS / reverse proxy:** handled by nginx ([§5](#5-serve-everything-from-one-campus-server-nginx))
  + the Cloudflare Tunnel ([§6](#6-remote-access--login-from-home-cloudflare-tunnel--domain)),
  which terminates TLS at the edge — no certs to manage on the box, no inbound ports.
- **Secrets:** unique, long `JWT_SECRET` / `DEVICE_SECRET` / `AGENT_INSTALL_KEY`. Never
  commit `.env` or `agent.conf`. Rotate `AGENT_INSTALL_KEY` if it leaks (approved agents
  keep working — they use per-device tokens).
- **CORS:** set `WEB_ORIGIN` to the exact public dashboard origin (the tunnel hostname);
  avoid `*` outside a trusted LAN.
- **`trust proxy`** is already enabled (`app.set("trust proxy", 1)`) so rate limiting
  sees the real client IP behind one proxy hop (nginx).
- **DB user:** least-privilege app user ([§2.1](#21-mysql)), not root.
- **Backups:** a full on-site + offsite (cloud) backup runbook is in
  [§11](#11-backups--on-site--offsite-cloud) — an NDJSON stream mirror, a nightly
  `mysqldump`, and an encrypted **Backblaze B2** offsite copy (3-2-1).
- **OS-popup notifications** require a secure context — they work once the dashboard is
  served over the HTTPS tunnel URL (not over plain-HTTP LAN IP).

---

## 11. Backups — on-site + offsite (cloud)

> **Branch scope.** The automated backup subsystem (the NDJSON stream mirror written by
> `backupService`, plus `ops/db-backup/` and `ops/offsite-backup/`) ships with the backup
> work on the **`mikrotik-monitoring`** branch, not this one — deploy it once that branch
> is merged (or if you deploy from it). The **full step-by-step for the cloud copy** is in
> **`ops/backblaze-guide.md`**; this section is the deploy-time summary.

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
**`ops/backblaze-guide.md`**.

---

## 12. Post-deploy verification checklist

- [ ] `node src/server.js` logs `Server running on port 3000` with no DB/Influx errors.
- [ ] `https://<tunnel-host>/` loads the dashboard from **off the campus network** (test on phone data).
- [ ] **Google sign-in** works from the public URL (origin added in Google Console — [§6.4](#64-update-google-oauth-authorized-origins)).
- [ ] First admin promoted ([§4.3](#43-bootstrap-the-first-admin-important--chicken-and-egg)); **Pending registrations** visible under User Management.
- [ ] **Alert Rules** page shows seeded rules (confirms the `alert_rules` migration ran).
- [ ] A Go agent enrolls → appears pending → approves → **Server Metrics** shows live gauges.
- [ ] ESP32 connected → **Environment** page shows live temp/humidity/gas.
- [ ] Trip a threshold (or lower a rule) → **bell + toast** fire; email arrives if Resend configured.
- [ ] Stop an agent → within ~15 s the server flips **Offline** and an alert is raised.
- [ ] **Analytics** page renders (disk-full ETA / alert summary) — matures as history accrues.

---

## 13. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Tunnel URL loads the page but API/live data fails | `VITE_API_URL` not set to the public origin (rebuild after setting), or nginx not proxying `/api` + `/socket.io` ([§5](#5-serve-everything-from-one-campus-server-nginx)). |
| API calls blocked (CORS error in console) | Public origin not in `WEB_ORIGIN`. Add the exact tunnel hostname; restart backend. |
| Login fails from the public URL | Tunnel origin not in the Google OAuth **Authorized JavaScript origins** ([§6.4](#64-update-google-oauth-authorized-origins)), or `GOOGLE_CLIENT_ID` mismatch between front/back. |
| Login rejects a valid user | Email domain not in `GOOGLE_ALLOWED_DOMAINS`; only `@cspc.edu.ph`/`@my.cspc.edu.ph` are allowed. |
| First user can't do anything | Still `status='pending'`. Promote in MySQL ([§4.3](#43-bootstrap-the-first-admin-important--chicken-and-egg)). |
| No alerts ever fire | `2026-06-14_alert_rules.sql` not applied → no rules → silent. Apply it. |
| Agent stuck "pending" | Not approved yet (Server Metrics page), or `AGENT_INSTALL_KEY` mismatch. |
| Agent can't reach backend | Pointed at the tunnel URL instead of the **LAN IP**, or LAN firewall blocks :3000. Agents use `http://<campus-server-ip>:3000` ([§6.3](#63-two-addresses-two-audiences-important)). |
| Agent 403s and removes itself | The server was **removed** in the dashboard (token revoked). Re-run `--register`. |
| ESP32 won't connect | `deviceSecret` ≠ backend `DEVICE_SECRET`, or wrong `host`/`port` (use the LAN IP). |
| Analytics shows "need more data" | Expected early — forecasts need ~1–2 weeks of `server_metrics`; alert analytics works day one. |

---

## 14. Not-yet-deployable (roadmap features)

These are **not on this branch** and cannot be deployed yet:

- **Router / UPS (SNMP)** and **MikroTik (RouterOS)** monitoring — live on the
  `router-ups-monitoring` and `mikrotik-monitoring` branches. They add new pollers, env
  vars (`SNMP_POLL_INTERVAL_MS`, `MIKROTIK_ENC_KEY`, `MIKROTIK_POLL_INTERVAL_MS`),
  migrations, and InfluxDB measurements (`router_metrics`, `network_traffic`,
  `ups_metrics`). They still need real device seeding + live-hardware testing before
  merge. See `router-ups-monitoring.md` / `mikrotik-monitoring.md`.
- **Analytics on router/UPS/network** — added after those branches merge to `main` and
  this branch is rebased (`predictive-analytics.md` §8, row "2b/3b").

> These features are exactly **why the backend must stay on-prem**: the pollers connect
> *into* the campus LAN (SNMP UDP 161 / RouterOS API) to private device addresses a cloud
> host can't reach. When they land, fold their migrations + env vars into §2–§3 above.

---

*See also: `CLAUDE.md` (architecture), `server-metrics.md` (agent ops),
`google-oauth.md` (login setup), `email-popup-notifications.md` (alerting/email).*
