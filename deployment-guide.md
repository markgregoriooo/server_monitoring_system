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

> **Deployment model (decided):** **on-premise at CSPC** — the backend, databases and
> dashboard all run on one **campus server**, published over HTTPS at
> **`monitoring.cspc-ictu.stream`** through a **Cloudflare Tunnel**. The backend *must* be on
> campus because it talks directly to the server-room hardware over the LAN, and polls
> routers / UPS / MikroTik on private addresses no cloud host could reach.
>
> ⚠️ **The tunnel is a pipe, not a host.** It removes nginx, port-forwarding, TLS certificates
> and the wait for ICTU to publish a hostname — it does not remove the server. See
> [§5](#5-publish-the-dashboard-cloudflare-tunnel).

---

## 0. Architecture at a glance (what you actually deploy)

```
   Staff (campus or home) ─https─▶ Cloudflare ─┐  (their DNS + TLS cert)
                                               │  outbound tunnel, no open ports
   ┌─────────────────────── CAMPUS SERVER (on-prem) ───────────────────────┐
   │                                          ▼                             │
   │   cloudflared  ─┬─ /api/ + /socket.io/ ─▶ backend      :3000           │
   │                 └─ everything else ─────▶ serve -s dist :8080          │
   │                                          │                             │
   │   Backend: Node + Express + Socket.IO (:3000)  ──▶ MySQL 8 (:3306)     │
   │   backend/src/server.js                        └─▶ InfluxDB 2 (:8086)  │
   └───────────────────────────────────────────────────────────────────────┘
        ▲ Socket.IO(deviceKey)        ▲ HTTP Bearer        ▲ SNMP / RouterOS API
   ESP32 env node              Go agents (per server)   Routers/UPS/MikroTik
   (campus LAN)               (campus LAN)              (campus LAN)
                                                + Google OAuth (login) · SMTP (email, optional)
```

**On-campus collectors point at the server's LAN address; only humans (browsers) use the
public hostname.** See [§5](#5-publish-the-dashboard-cloudflare-tunnel).

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
| 1 | `frontend/.env` | `VITE_API_URL=https://monitoring.cspc-ictu.stream` | **hostname** |
| 2 | `backend/.env` | `WEB_ORIGIN=https://monitoring.cspc-ictu.stream` | **hostname** |
| 3 | `~/.cloudflared/config.yml` | `service: http://localhost:3000` / `:8080` | **localhost** |
| 4 | `iot/esp32/env_monitor_v2/secrets.h` | `#define BACKEND_HOST "192.168.100.39"` | **LAN IP** |
| 5 | *(a command, not a file)* the agent installer | `install.sh http://192.168.100.39:3000 AIK-<key>` | **LAN IP** |

#### Files you do NOT edit

These already read the values above. Changing them is how a deployment ends up with two
sources of truth that disagree:

| File | Why it needs no edit |
|---|---|
| `frontend/src/config.ts` | Reads `VITE_API_URL`, falling back to `<page-host>:3000` for LAN development. |
| `frontend/src/socket/socket.ts` | `io(API_URL)` — imports the same value. **The socket has no separate setting.** |
| `frontend/src/api/client.ts` | Axios `baseURL`, same value again. |

That is worth stating plainly because it is a natural thing to go looking for: the live
socket and the REST API are pinned by **one** variable, `VITE_API_URL`. The tunnel routes both
`/api/` and `/socket.io/` to the backend on the same hostname, so the browser only ever talks
to one origin.

#### Why each one is what it is

**Hostname (1, 2)** — the browser may be on campus wifi or at home, so the public name is
the only address it can reach. `VITE_API_URL` tells the browser where to call;
`WEB_ORIGIN` tells the backend which origin to accept CORS from. **They must match exactly**
— same scheme, same host, no trailing slash.

**localhost (3)** — `cloudflared` runs on the *same machine* as the backend, so it reaches it
over loopback. This address is meaningful only inside that box. A browser asking for
`localhost:3000` is asking its **own** laptop, where nothing is listening.

**LAN IP (4, 5)** — the ESP32 and the Go agents are on campus and talk to `:3000` directly,
never through the tunnel. That keeps collection, buzzing and alerting alive when the internet
is down — only the dashboard goes dark — and it is why §9.1 firewalls `:3000` to the collector
subnets rather than closing it.

> ⚠️ **`VITE_API_URL` is compiled into the JavaScript at build time.** Edit
> `frontend/.env` **before** `npm run build` ([§4.1](#41-frontendenv) → [§4.2](#42-build)).
> This is the most common post-deploy failure: everyone except you sees
> "cannot connect to server", because your own localhost testing happens to guess the right
> address while the built bundle carries the wrong one.
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
| `cloudflared` | latest | publishes the dashboard over HTTPS ([§5](#5-publish-the-dashboard-cloudflare-tunnel)) — replaces nginx |
| Go | **1.22+** | only to *build* the agents; target servers need nothing |
| Arduino IDE / arduino-cli | latest | only to flash the ESP32 |
| A Google Cloud OAuth **Web** client | — | login is Google-only (`google-oauth.md`) |
| An HTTPS hostname | — | `monitoring.cspc-ictu.stream`, already registered and routed ([§5](#5-publish-the-dashboard-cloudflare-tunnel)). **Google rejects a bare LAN IP**, so this is required, not optional |
| (optional) Resend account | — | alert emails; system works without it |

Network: the backend listens on **0.0.0.0:3000** (all interfaces). On-campus collectors
(agents, ESP32) reach it directly at the server's LAN IP:3000; browsers reach it through
the Cloudflare Tunnel. Give the campus server a **static LAN IP / internal hostname** —
agents and firmware cache the address, and ICTU's proxy needs a fixed target.

---

### 1.1 Put the code on the server

Everything below assumes the project is already at **`/opt/cspc`** on the Linux box. This
section is how it gets there. Do it first — §2 onward all run from inside it.

**Why `/opt/cspc` specifically.** It is not a preference: `ops/systemd/cspc-monitoring.service`
declares `WorkingDirectory=/opt/cspc/backend`, and §5.2 serves the dashboard from
`/opt/cspc/frontend-dist`. Putting the project anywhere else means editing the unit file.

> ⚠️ **Do not put it under `/home/<you>/`.** The service account usually cannot
> traverse a home directory, which produces a 403 that reads like a config error (§5.6).

#### 1.1.1 Create the service account and the directory

The backend runs as a dedicated **system user with no shell** — it holds `JWT_SECRET`,
the database password and the encryption keys, so it should not be a login account and
should not be `root`.

```bash
sudo useradd --system --home /opt/cspc --shell /usr/sbin/nologin cspc
sudo mkdir -p /opt/cspc
```

#### 1.1.2 Get the code onto the server

Three ways in. The choice is **not** a preference — it is decided by what ICTU's network
allows and by how many times you expect to update the code after go-live.

| | Method | When it's right |
|---|---|---|
| **1** | **`git clone` + deploy key** | You will update the code more than once. **For this project, this is the answer** — see below. |
| **2** | `rsync` over SSH | You can reach the server over the network, but git on the server is not permitted |
| **3** | USB drive / `scp` a tarball | The server has no network path from your laptop (air-gapped) |

##### The one question that decides it

From your own laptop:

```bash
ssh <your-account>@<backend-server-ip>
```

**If that connects, you never need a USB drive.** Method 1 or 2 will both work, and both
are repeatable — which matters, because you will not transfer this project only once.

If it refuses, the reason decides the rest: no account yet (ask ICTU — below), or no
network route at all (Method 3).

> ⚠️ **Why Method 1 is worth the extra ten minutes of setup.** This is a capstone: the
> code will change after panel feedback, after the ICTU review, and every time a bug turns
> up in testing. With git, an update is four commands and about twenty seconds
> ([below](#updating-the-code-later)). With a USB drive it is a re-archive, a walk across
> campus, and a manual extract — every single time, with no record of what changed. The
> first deployment costs the same either way. The fifth does not.

##### What to ask ICTU's system administrator

You are deploying onto **someone else's infrastructure**, so several things are not yours
to configure. Ask for all of these **before** deployment day — the outbound-access answer
in particular decides whether Method 1 is even possible, and it is the one most likely to
be "no" on an institutional server.

| Ask for | Why you need it | If you don't get it |
|---|---|---|
| **An SSH account** on the campus server, plus its **IP/hostname and SSH port** | Every method except USB starts here | You are on Method 3, physically at the machine |
| **`sudo` rights** for that account | Installing Node/MySQL/InfluxDB/cloudflared, creating the `cspc` service user, writing to `/opt`, `systemctl`, firewall rules — §1 through §5 all need root | Nothing in this guide can be completed; ICTU must run it with you |
| **A static LAN IP** (or a reserved DHCP lease) for the server | Agents and the ESP32 firmware **cache the address**. If it moves, every collector goes silent at once and nothing points at DHCP as the cause | Re-flash the ESP32 and re-enroll every agent whenever the lease changes |
| **Outbound internet from the server** to `github.com` (**port 22** for SSH clones, or 443 for HTTPS) and `registry.npmjs.org` (443) | `git clone` **and** `npm ci` both need it. `npm ci` is required by §1.1.4 regardless of how the code arrives | Method 1 is impossible, and §1.1.4 needs an offline `node_modules` workaround — tell ICTU early, this is the expensive one |
| **Whether the server sits behind an HTTP proxy**, and its address | `git` and `npm` both need explicit proxy configuration; without it they hang and then time out with no useful error | Installs fail in a way that looks like a broken network |
| **Inbound firewall**: TCP **3000** open to the subnets holding the monitored servers and the ESP32 | Collectors reach the backend directly on `:3000`, never through the tunnel ([§9.1](#91-restrict-port-3000-to-the-agent-subnets--do-this-on-deploy-day)). **80/443 are no longer needed** | Agents enroll but never deliver metrics; the room shows no sensor data |
| **Outbound TCP 7844** allowed from the server | `cloudflared` dials Cloudflare on it. Nothing INBOUND needs opening — that is the point of a tunnel | The tunnel never connects: `failed to connect to the edge` |
| **A maintenance window** for restarts | The backend restarts on every deploy and config change | Coordinate each restart ad hoc |

> ⚠️ **Ask about outbound access first and explicitly.** "Can this server reach github.com
> and registry.npmjs.org?" is a five-second question with a fifteen-minute consequence if
> the answer is no and you find out on deployment day. A server that is firewalled inbound
> is normal and expected; one that is firewalled *outbound* is also common on institutional
> networks, and it invalidates Method 1 along with `npm ci`.

##### Method 1 — `git clone` with a deploy key (recommended)

The repository is **private**, so the server needs its own read access. Do not use your
personal GitHub password or a personal access token: a **deploy key** is scoped to this one
repository, is read-only, and can be revoked without touching your account.

**Step 1 — generate a key ON THE SERVER** (never copy your laptop's key across):

```bash
ssh-keygen -t ed25519 -C "cspc-campus-server-deploy" -f ~/.ssh/deploy_key -N ""
cat ~/.ssh/deploy_key.pub
```

**Step 2 — register it on GitHub.** Copy the whole `ssh-ed25519 …` line printed above, then
in a browser go to:

> your repository → **Settings** → **Deploy keys** → **Add deploy key**
> Title: `cspc-campus-server` · Key: *paste* · **Leave “Allow write access” UNCHECKED**

Read-only is deliberate: the server never pushes, so write access buys nothing and means a
compromised server could rewrite your capstone's history.

**Step 3 — tell SSH to use that key for GitHub:**

```bash
cat >> ~/.ssh/config <<'EOF'

Host github-cspc
  HostName github.com
  User git
  IdentityFile ~/.ssh/deploy_key
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
```

`IdentitiesOnly yes` matters: without it SSH offers every key it can find and GitHub
rejects the connection after too many attempts, which reads as "permission denied" rather
than "wrong key".

**Step 4 — verify the key works before relying on it:**

```bash
ssh -T git@github-cspc
# Expect: "Hi markgregoriooo/server_monitoring_system! You've successfully authenticated,
#          but GitHub does not provide shell access."
# That message IS success — the shell-access line is normal for a deploy key.
```

**Step 5 — clone into place:**

```bash
sudo mkdir -p /opt/cspc
sudo chown $USER /opt/cspc                     # temporary — §1.1.5 hands it to `cspc`
git clone git@github-cspc:markgregoriooo/server_monitoring_system.git /opt/cspc
cd /opt/cspc
```

> ⚠️ **If your SSH port to GitHub is blocked** (some campus firewalls block outbound 22),
> use GitHub's SSH-over-HTTPS endpoint instead — same key, port 443. Add `Port 443` and
> `HostName ssh.github.com` to the `Host github-cspc` block above.

Then skip to [§1.1.3](#113-two-things-windowslinux-breaks). **A clone needs no cleanup** —
`node_modules`, `.env`, `backups/`, `reports/`, `branding/` and `dist/` are all gitignored,
so the exclusion list below simply does not apply to you. That is the second reason this
method is the least error-prone: there is no list to remember.

<a id="updating-the-code-later"></a>
###### Updating the code later

This is the payoff. After pushing changes from your laptop:

```bash
cd /opt/cspc
sudo -u cspc git pull                          # or: git pull, then re-run §1.1.5

cd backend  && npm ci --omit=dev               # only if package.json changed
cd ../frontend && npm ci && npm run build      # only if the dashboard changed
sudo cp -r dist/. /opt/cspc/frontend-dist/     # see §5.2

sudo systemctl restart cspc-monitoring
sudo systemctl status cspc-monitoring --no-pager
```

⚠️ **Re-run [§1.1.5](#115-ownership-and-permissions) after any pull that adds files** —
new files are owned by whoever ran `git pull`, and the backend runs as `cspc`.

⚠️ **A pull that includes a new file under `migrations/` needs that migration applied**
([§2.1](#21-mysql)). The backend does not run migrations on start, so the symptom is
a route failing on an unknown column rather than anything announcing itself at boot.

##### Method 2 — `rsync` over SSH

For when the server is reachable but git on it is not permitted. One command from your
laptop, inside the project folder:

```bash
rsync -avz --delete \
  --exclude node_modules --exclude .env --exclude '.env.*' \
  --exclude backups --exclude reports --exclude branding \
  --exclude dist --exclude .git --exclude secrets.h \
  ./ <your-account>@<backend-server-ip>:/opt/cspc/
```

Re-run it for every update; it transfers only what changed, so later syncs take seconds.
`--delete` removes files on the server that you have since deleted locally — without it the
server slowly accumulates dead files that no longer exist in your project.

In **WinSCP**, the same exclusions go in *Transfer settings → File mask → Exclude*:

```
node_modules/; .env; .env.*; backups/; reports/; branding/; dist/; .git/; secrets.h
```

##### Method 3 — USB drive or `scp` (no network path)

Only when the server genuinely cannot be reached. Build one archive on Windows (Git Bash),
which is faster and safer than copying thousands of loose files onto a FAT32 drive — flash
filesystems do not preserve Linux permissions or the execute bit, and a `.tar.gz` carries
both through intact:

```bash
cd /c/Users/<you>/Documents/server-infrastructure-monitoring-system-webSystem
tar -czf /d/cspc-deploy.tar.gz \
  --exclude='./backend/node_modules'   --exclude='./frontend/node_modules' \
  --exclude='./backend/.env'           --exclude='./backend/.env.*' \
  --exclude='./frontend/.env'          --exclude='./iot/esp32/env_monitor_v2/secrets.h' \
  --exclude='./backend/backups'        --exclude='./backend/reports' \
  --exclude='./backend/branding'       --exclude='./frontend/dist' \
  --exclude='./.git' \
  .
```

That lands at roughly **17 MB** — well under FAT32's 4 GB limit, so the drive needs no
reformatting. On the server:

```bash
sudo mkdir -p /mnt/usb /opt/cspc
sudo mount /dev/sdb1 /mnt/usb                  # confirm the device with: lsblk
sudo tar -xzf /mnt/usb/cspc-deploy.tar.gz -C /opt/cspc
sudo umount /mnt/usb
```

> ⚠️ **Check the archive before you carry it.** `tar -tzf cspc-deploy.tar.gz | grep -E '\.env|secrets\.h'`
> must print nothing. An `.env` backup left in the project folder (`.env.bak-…`) is matched
> by the `--exclude='./backend/.env.*'` line above, but only if it lives where that pattern
> looks — and a stray copy of `secrets.h` carries a real WiFi password and `DEVICE_SECRET`.

##### What must not be copied

**Applies to Methods 2 and 3 only** — a git clone gets this right automatically, because
every item below is gitignored.

| Do not copy | What happens if you do |
|---|---|
| `backend/node_modules/`<br>`frontend/node_modules/` | ~190 MB, and the native modules are compiled **for Windows**. On Linux they crash or misbehave. They are reinstalled in §1.1.4. |
| `backend/.env`<br>(and any `.env.bak-*`) | Carries the dev database name and the dev secrets. Production writes its own in §3.1. Copying it is also how a compromised key spreads. |
| `iot/esp32/…/secrets.h` | Real WiFi password + `DEVICE_SECRET`. The server never needs it — the ESP32 is flashed from your laptop (§8). |
| `backend/backups/` | Tens of MB of the *development* room's NDJSON history. |
| `backend/reports/` | Generated CSV/PDFs for reports that will not exist in the new database. |
| `backend/branding/` | Logos uploaded on the dev box. Production uses the committed marks until ICTU re-uploads. |
| `frontend/dist/` | Built with the **dev** `VITE_API_URL` compiled in. Rebuilt on the server in §4.2. |

##### Verify before moving on

Whichever method you used:

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
5.x  Cloudflare Tunnel
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
WEB_ORIGIN=https://monitoring.cspc-ictu.stream

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
# The Cloudflare Tunnel routes /api and /socket.io to the backend on the same hostname, so
# the browser talks to one origin. Must match the backend's WEB_ORIGIN exactly.
VITE_API_URL=https://monitoring.cspc-ictu.stream
```

> Why set this here: by default the app auto-detects the backend at `<page-host>:3000`
> (`frontend/src/config.ts`). Behind the tunnel, port 3000 isn't public — the API
> is reached at the page's own origin under `/api`. Pinning `VITE_API_URL` to the public
> URL makes both the Axios client and Socket.IO use it.

`VITE_GOOGLE_CLIENT_ID` **must match** the backend's `GOOGLE_CLIENT_ID`. Vite inlines env
vars at build time → **rebuild after any change** (`npm run build`).

### 4.2 Build

```bash
npm run build          # → frontend/dist/  (static SPA)
```

`frontend/dist/` is served by `npx serve -s dist -l 8080` on the campus server, which the
tunnel forwards to — see [§5](#5-publish-the-dashboard-cloudflare-tunnel).
(For local development instead:
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

## 5. Publish the dashboard (Cloudflare Tunnel)

Replaces nginx, port-forwarding, TLS certificates and waiting on ICTU for a hostname. The
system is published at **`https://monitoring.cspc-ictu.stream`**.

Full operating manual: `cloudflare-tunnel-setup.md`. This section is the deploy-day version.

### 5.0 What the tunnel is, and is not

`cloudflared` makes an **outbound** connection from the campus server to Cloudflare.
Cloudflare then forwards public traffic back down it.

⚠️ **It does not host anything.** The backend, MySQL, InfluxDB and the dashboard files all
still run on the campus server. Cloudflare is a pipe, not a host.

⚠️ **The server must still be on the campus LAN.** The ESP32 opens a socket to it, the Go
agents POST to it, and the SNMP and MikroTik pollers reach out to `192.168.100.x`. None of
that can travel through Cloudflare — those are private addresses. This is why the deployment
target is an on-prem machine and not a cloud VM.

| Removed by the tunnel | Still required |
|---|---|
| nginx reverse proxy | the campus server itself |
| public IP / port-forwarding | it being on the monitored LAN |
| TLS certificate + renewal | it staying powered on |
| ICTU publishing a hostname | |

### 5.1 One hostname, two local ports

The tunnel splits a single hostname by URL **path**:

```
                                    ┌─ /api/        ─┐
Browser ─https─▶ Cloudflare ─tunnel─┤ /socket.io/   ─┼─▶ localhost:3000   backend
                                    └─ everything else ─▶ localhost:8080  dashboard files

ESP32 + Go agents ──── LAN, straight to 192.168.100.39:3000 ────▶   (never the domain)
```

Two ports because the backend serves JSON only — the dashboard's HTML/JS/CSS are static
files and need something to hand them out. That used to be nginx; now it is `serve`.

### 5.2 Install cloudflared on the server

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cf.deb
sudo dpkg -i cf.deb && rm cf.deb
cloudflared --version
```

### 5.3 Move the tunnel credentials

The tunnel and its DNS record **already exist** — they were created once and belong to the
Cloudflare account, not to a machine. Do not create a second one.

Copy two files from the machine that created it to the server's service account:

```bash
# on the server, as the service user
mkdir -p ~/.cloudflared
# then copy in (scp / USB):
#   cert.pem
#   f8859a41-0eea-4c0c-a698-165335c802e7.json
chmod 600 ~/.cloudflared/*
```

⚠️ Both are credentials. `cert.pem` can create tunnels and edit DNS on the whole domain.
Never commit either; never put them on a shared drive.

### 5.4 `~/.cloudflared/config.yml`

```yaml
tunnel: f8859a41-0eea-4c0c-a698-165335c802e7
credentials-file: /home/<service-user>/.cloudflared/f8859a41-0eea-4c0c-a698-165335c802e7.json

ingress:
  - hostname: monitoring.cspc-ictu.stream
    path: ^/api/
    service: http://localhost:3000

  - hostname: monitoring.cspc-ictu.stream
    path: ^/socket.io/
    service: http://localhost:3000

  - hostname: monitoring.cspc-ictu.stream
    service: http://localhost:8080

  - service: http_status:404
```

⚠️ **Order matters** — first match wins, catch-all last.
⚠️ **Miss the `/socket.io/` rule** and the dashboard loads but no chart ever updates, no
alert toast fires and the bell never counts. It is the single easiest thing to get wrong,
because everything *looks* fine.

Validate:
```bash
cloudflared tunnel ingress validate
cloudflared tunnel ingress rule https://monitoring.cspc-ictu.stream/api/servers
# must answer: service: http://localhost:3000
```

### 5.5 Serve the built dashboard on :8080

```bash
cd /opt/cspc-monitoring/frontend
npm run build
npx serve -s dist -l 8080
```

⚠️ **`-s` is required.** Without it, a deep link or F5 on `/alerts` returns 404 instead of
falling back to `index.html`.

For production, run it under the same process manager as the backend (§3.2) rather than a
login shell — a terminal that closes takes the dashboard with it.

### 5.6 Run the tunnel as a service

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
systemctl status cloudflared
```

It reconnects by itself after a network drop or a reboot. No cron, no watchdog.

### 5.7 Four processes must be running

| Process | Port | Started by |
|---|---|---|
| backend | 3000 | pm2 / systemd (§3.2) |
| dashboard files | 8080 | pm2 / systemd |
| `cloudflared` | — | systemd (§5.6) |
| MySQL + InfluxDB | 3306 / 8086 | systemd |

### 5.8 App settings

**`backend/.env`**
```ini
WEB_ORIGIN=https://monitoring.cspc-ictu.stream
TRUST_PROXY=1
```

⚠️ **`TRUST_PROXY=1`, not the default 2.** A tunnel is exactly one hop. At 2 every visitor
arrives as `127.0.0.1` and the spare slot is filled by a header **they** control — so a
visitor picks their own rate-limit bucket and their own value in `system_logs.ip_address`,
the row that *is* the evidence for a Privacy Notice acceptance.

**`frontend/.env`**
```ini
VITE_API_URL=https://monitoring.cspc-ictu.stream
```

⚠️ No port, no `/api` suffix — the tunnel splits by path, not by port.
⚠️ Compiled in at **build time**. Edit this *before* `npm run build`, or the old address
stays inside the bundle and every request fails while the file on disk looks correct.

### 5.9 Google OAuth

Console → Credentials → OAuth 2.0 Client ID → **Authorized JavaScript origins** → add:

```
https://monitoring.cspc-ictu.stream
```

Leave redirect URIs empty (the app uses `redirect_uri: "postmessage"`). Keep
`http://localhost:5173` for development. Allow a few minutes to apply.

### 5.10 Verify

| # | Check | Expect |
|---|---|---|
| 1 | `https://monitoring.cspc-ictu.stream/api/policy/version` | JSON |
| 2 | site root | login page, padlock |
| 3 | `/privacy` typed directly | loads, not 404 |
| 4 | sign in with a CSPC Google account | works |
| 5 | watch a chart one minute | numbers move (proves `/socket.io/`) |
| 6 | History → your sign-in row | your real public IP, not `127.0.0.1` |
| 7 | Server Metrics + Environment | agents Online, sensor live |
| 8 | open it on campus WiFi | loads |

⚠️ **Row 8 is not a formality.** `.stream` is a low-reputation TLD and some institutional
DNS filters block whole TLDs. If it loads on mobile data but not on campus WiFi, that is
filtering rather than a fault, and the only fix is a different domain. Test it early.

### 5.11 Troubleshooting

| Symptom | Cause |
|---|---|
| `502 Bad Gateway` | backend or `serve` not running |
| Site unreachable entirely | `cloudflared` not running |
| Dashboard loads, panels empty | `VITE_API_URL` unset, or set but not rebuilt |
| `blocked by CORS policy` | `WEB_ORIGIN` — restart the backend after editing |
| Login popup opens then closes | domain missing from Google's authorized origins |
| Charts never move | `/socket.io/` rule missing or below the catch-all |
| F5 gives 404 | missing `-s` on `serve` |
| Everything `127.0.0.1` in History | `TRUST_PROXY` must be `1` |
| `failed to connect to the edge` | campus firewall blocking outbound TCP **7844** |
| Site dies after ~14 days | ICANN registrant email never verified |

Logs: `sudo journalctl -u cloudflared -f`

### 5.12 Optional — restrict who can open it

Cloudflare dashboard → **Zero Trust** → **Access** → **Applications** → **Add an
application** → **Self-hosted** → domain `monitoring.cspc-ictu.stream` → policy: Allow /
Include / **Emails ending in** `@cspc.edu.ph`. Free up to 50 users.

⚠️ Do **not** apply Access to `/api/` — it would block the Go agents if they ever move off
the LAN.

---

## 6. Bootstrap the first admin

The schema seeds **no** admin, so the first Google sign-in lands as `pending` with nobody
able to approve it. Promote that row by hand, once:

```sql
UPDATE users SET role = 'admin', status = 'active'
 WHERE email = 'your.name@cspc.edu.ph';
```

Everyone after that is approved from **User Management → Pending registrations**.

⚠️ Before a demo, have every panel member sign in once, then approve them all. A first-time
visitor cannot see anything until an admin acts.

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

| Port | Direction | Service | Who connects |
|---|---|---|---|
| **7844** | **outbound** | `cloudflared` → Cloudflare | the tunnel itself |
| 8080 | localhost | dashboard files (`serve`) | `cloudflared` only |
| 3000 | LAN | Backend (HTTP + WebSocket) | `cloudflared`, Go agents, ESP32 |
| 5173 | localhost | Vite dev server | dev only — not in prod |
| 3306 | localhost | MySQL | backend only — **do not expose** |
| 8086 | localhost | InfluxDB | backend only — **do not expose** |

- **No inbound port is open to the internet.** That is the point of a tunnel: `cloudflared`
  dials *out* on 7844 and traffic returns down that connection. Ports 80 and 443 are no longer
  needed anywhere.
- **8080 stays on localhost.** Only `cloudflared` reads it; exposing it would publish the
  dashboard over plain HTTP, bypassing Cloudflare entirely.
- Keep MySQL (3306) and InfluxDB (8086) bound to localhost / the backend host only.

### 9.1 Restrict port 3000 to the agent subnets — do this on deploy day

The backend listens on `0.0.0.0:3000` (`src/server.js`), and it **has to**: the Go agents and
the ESP32 connect to it directly, not through the tunnel. So port 3000 is reachable by anything
on the campus LAN, and *that is the bypass* — a client talking to `:3000` skips `cloudflared`
entirely, which means it also writes its own `X-Forwarded-For`. The backend then believes it,
so such a client picks its own `req.ip`: its own bucket in every IP-keyed rate limiter
(sign-in, agent enrollment, metric ingest) and its own value in `system_logs.ip_address` — the
row that is the evidence for a Privacy Notice acceptance.

⚠️ With the tunnel, `TRUST_PROXY` is **1**, not 2 — one hop, not two. See §5.8.

No code can close this, because the port must stay open to the LAN. It is a firewall rule:

```bash
# No rule for 80/443: the tunnel needs no inbound port at all.
sudo ufw allow from <AGENT_SUBNET> to any port 3000 proto tcp # e.g. 10.10.20.0/24
sudo ufw allow from <ESP32_SUBNET> to any port 3000 proto tcp # if it differs
sudo ufw deny 3000                                            # everyone else
sudo ufw enable && sudo ufw status numbered
```

Replace `<AGENT_SUBNET>` / `<ESP32_SUBNET>` with the ranges those devices actually sit on — ask
ICTU which VLAN the server room and the monitored servers are on; do not guess a /8.

**Browsers are unaffected** — they reach the API through the tunnel and never touch 3000.
Verify from a machine outside the allowed range:

```bash
curl -m 5 http://<backend-server-ip>:3000/api/policy/version      # expect: timeout / refused
curl -I  https://monitoring.cspc-ictu.stream/api/policy/version   # expect: 200 (tunnel fine)
```

Then re-check that an agent still reports in (Server Metrics → the host goes Online). If it
does not, its subnet is not in the allow list.

> ⚠️ Run `ufw allow 22/tcp` (or your SSH port) **before** `ufw enable` if you are on SSH —
> enabling a default-deny firewall over SSH without it locks you out of the box.

See `audits/api-infra-security-2026-08-25.md` — A-03.

---

## 10. Production hardening

- **HTTPS:** Cloudflare Tunnel ([§5](#5-publish-the-dashboard-cloudflare-tunnel)) — certificate issued and renewed by Cloudflare, nothing to manage on the server
  behind **ICTU's edge** ([§6](#6-publish-the-dashboard-over-https-ictu-endpoint)), which
  terminates TLS — no certificates to manage on this box.

> ⚠️ **The dashboard is internet-facing.** ICTU publishes it publicly (§6.1), so the login page
> is reachable by anyone, including bots and scanners. Three layers already stand in the way,
> and it's worth knowing they're what makes public exposure acceptable:
>
> 1. **Google OAuth + the server-side domain allow-list** — there is no password to guess and
>    no local account to brute-force. ⚠️ The app is **External** (Internal is unavailable —
>    `google-oauth.md` §10), so Google itself does *not* restrict who reaches the consent
>    screen. `GOOGLE_ALLOWED_DOMAINS` (`services/googleDomain.js`) is what refuses a session to
>    anything outside the CSPC domains, and `recordSignInDenied` audits the attempt.
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
  client's address. **With the Cloudflare Tunnel set it to `1`** — cloudflared → backend is one
  hop. The default **2** described ICTU's edge → campus nginx → backend, which is this
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
- [ ] `https://monitoring.cspc-ictu.stream/` loads the dashboard **from off the campus network** (test on phone mobile data, WiFi off).
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
| Public URL loads the page but API/live data fails | `VITE_API_URL` not set to the public origin, **or set but not rebuilt** — it is compiled in at build time. Otherwise the `/api/` or `/socket.io/` ingress rule is missing from `config.yml` ([§5](#5-publish-the-dashboard-cloudflare-tunnel)). |
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
