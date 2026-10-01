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

> **Deployment model (decided):** **on-premise at CSPC, delivered as Docker containers.**
> ICTU asked for the system as a container, and **ICTU publishes it themselves** — with
> **their own reverse proxy, their own hostname and their own TLS certificate** (expected:
> `datacenter.cspc.edu.ph`; confirm the exact name with ICTU). We hand over the repository
> with `docker-compose.yml`; ICTU runs it and points their proxy at it. See
> [§D](#d-docker-deployment--the-ictu-handover-production) and
> [§5](#5-publish-over-https--ictus-proxy-production).
>
> The backend *must* be on campus because it talks directly to the server-room hardware over
> the LAN, and polls routers / UPS / MikroTik on private addresses no cloud host could reach.
>
> **Cloudflare Tunnel (`monitoring.cspc-ictu.stream`) is for testing and the defense only.**
> The domain and the Cloudflare account are the developers', not the school's, so they are not
> the production front door. It is kept in [§5B](#5b-cloudflare-tunnel--testing-and-the-defense-only).
>
> **Two install paths, one system.** §D is the **production** path (Docker, what ICTU runs).
> §1–§4 are the **manual** install (Node, MySQL, InfluxDB directly on a host) — used on the
> development machine, and still the reference for what every setting means.

---

## 0. Architecture at a glance (what you actually deploy)

```
   Staff browsers (campus or home)      Go agents on servers OFF campus
                 │  https://datacenter.cspc.edu.ph  │  (HTTPS POST + Bearer AGT-…)
                 ▼                                  ▼
        ┌──────────────── ICTU's reverse proxy ────────────────┐
        │  ICTU's hostname + TLS certificate (ICTU manages it)  │
        │  /api/ + /socket.io/ ─▶ :3001   everything else ─▶ :8080
        └───────────────────────────┬───────────────────────────┘
   ┌──────────────── CAMPUS SERVER (on-prem, docker compose) ─────────────────┐
   │   dc-backend   :3001  Node + Express + Socket.IO + pollers              │
   │   dc-frontend  :8080  nginx serving the built dashboard                 │
   │   dc-db        MariaDB 10.11   (not published to the host)              │
   │   dc-influxdb  InfluxDB 2.7    (not published to the host)              │
   └──────────────────────────────────────────────────────────────────────────┘
        ▲ Socket.IO(deviceKey)        ▲ HTTP Bearer         ▲ SNMP / RouterOS API / ICMP
   ESP32 env node            Go agents ON campus        Routers/UPS/MikroTik
   (LAN → :3001 direct)      (LAN → :3001 direct)       (backend polls them)
                                                + Google OAuth (login) · SMTP (email, optional)
```

**Two kinds of collectors, two addresses.** The ESP32 and any Go agent **on the campus LAN**
send straight to `http://<server-LAN-IP>:3001` — no proxy, and they keep working when the
internet is down. A Go agent on a server **off campus** sends to the public
`https://datacenter.cspc.edu.ph` through ICTU's proxy, encrypted, like a browser does.

**Five deployable units:** (1) MariaDB, (2) InfluxDB, (3) backend, (4) frontend,
(5) the edge collectors (Go agents on each server + the ESP32 firmware) — units 1–4 are the
four containers in `docker-compose.yml`, on the one campus server.

**Container names.** Every container carries a `dc-` prefix (*datacenter*) so it is easy to
pick out in `docker ps` on a server that runs other things too:

| Service (in `docker compose …`) | Container (in plain `docker …`) | What it is |
|---|---|---|
| `db` | `dc-db` | MariaDB 10.11 |
| `influxdb` | `dc-influxdb` | InfluxDB 2.7 |
| `backend` | `dc-backend` | Node backend, `:3001` |
| `frontend` | `dc-frontend` | nginx + dashboard, `:8080` |

`docker compose` commands take the **service** name (`docker compose logs -f backend`);
plain `docker` commands take the **container** name (`docker logs -f dc-backend`). Both
reach the same container. This guide uses the `docker compose` form throughout.

---

### 0.1 Which address goes where (read this before you edit anything)

Three different addresses point at the **same backend process**, and each is correct for
exactly one audience. Putting the right one in the wrong file is the most common
deployment mistake, and it usually fails silently — a page that loads with no data, or a
sensor that never appears.

**You edit these. None of them is a source file.**

| # | File | What goes in | Which address |
|---|---|---|---|
| 1 | root `.env` (Docker) — or `frontend/.env` (manual install) | `VITE_API_URL=https://datacenter.cspc.edu.ph` | **hostname** |
| 2 | `backend/.env` | `WEB_ORIGIN=https://datacenter.cspc.edu.ph` | **hostname** |
| 3 | ICTU's proxy config (theirs, not ours) | `/api/` + `/socket.io/` → `<server>:3001`, the rest → `<server>:8080` | **server LAN IP / localhost** |
| 4 | the ESP32's **setup page** (hold its button 3 s — §8.2) | Backend IP `<server-LAN-IP>`, port `3001` | **LAN IP** |
| 5 | *(a command)* agent installer, **on-campus** server | `install.sh http://<server-LAN-IP>:3001 AIK-<key>` | **LAN IP** |
| 6 | *(a command)* agent installer, **off-campus** server | `install.sh https://datacenter.cspc.edu.ph AIK-<key>` | **hostname** |

#### Files you do NOT edit

These already read the values above. Changing them is how a deployment ends up with two
sources of truth that disagree:

| File | Why it needs no edit |
|---|---|
| `frontend/src/config.ts` | Reads `VITE_API_URL`, falling back to `<page-host>:3001` for LAN development. |
| `frontend/src/socket/socket.ts` | `io(API_URL)` — imports the same value. **The socket has no separate setting.** |
| `frontend/src/api/client.ts` | Axios `baseURL`, same value again. |

That is worth stating plainly because it is a natural thing to go looking for: the live
socket and the REST API are pinned by **one** variable, `VITE_API_URL`. ICTU's proxy routes
both `/api/` and `/socket.io/` to the backend on the same hostname, so the browser only ever
talks to one origin.

#### Why each one is what it is

**Hostname (1, 2, 6)** — the browser may be on campus wifi or at home, and an off-campus
server is by definition not on the LAN, so the public name is the only address they can reach.
`VITE_API_URL` tells the browser where to call; `WEB_ORIGIN` tells the backend which origin to
accept CORS from. **They must match exactly** — same scheme, same host, no trailing slash.

**Server address (3)** — ICTU's proxy forwards to the containers' published ports. If the
proxy runs on the same machine that is `localhost`; if it is a separate box it is the campus
server's LAN IP. Either way it is **plain HTTP inside the campus network** — the certificate
lives on the proxy. A browser asking for `localhost:3001` is asking its **own** laptop.

**LAN IP (4, 5)** — the ESP32 and on-campus agents talk to `:3001` directly, never through the
proxy. That keeps collection, buzzing and alerting alive when the internet is down — only the
dashboard and off-campus agents go dark — and it is why §9.1 firewalls `:3001` to the
collector subnets rather than closing it.

> ⚠️ **`VITE_API_URL` is compiled into the JavaScript at build time.** With Docker, set it in
> the root `.env` **before** `docker compose up -d --build` — changing it later means
> `docker compose up -d --build frontend`, not a restart. Manual install: edit
> `frontend/.env` **before** `npm run build` ([§4.1](#41-frontendenv) → [§4.2](#42-build)).
> This is the most common post-deploy failure: everyone except you sees
> "cannot connect to server", because your own localhost testing happens to guess the right
> address while the built bundle carries the wrong one.
> Building first and editing afterwards leaves the old address inside the bundle: the page
> loads, every API call and the socket fail, and the config file on disk looks correct —
> which is what makes it expensive to diagnose.

---

## D. Docker deployment — the ICTU handover (production)

What ICTU receives is **the repository**, not a pre-built image. The dashboard image has the
public hostname compiled into it (`VITE_API_URL`), so it has to be built **with ICTU's
hostname**, on or for their server — an image built for `monitoring.cspc-ictu.stream` would
keep calling the developers' Cloudflare address.

### D.1 Who does what

| We (developers) provide | ICTU provides |
|---|---|
| The repo: `docker-compose.yml`, both Dockerfiles, `v13_cspc-ictu-monitoring-system.sql`, `.env.docker.example` | A Linux server on the campus LAN with **Docker Engine + the compose plugin**, a static LAN IP |
| This guide + the values that are ours to give: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | **The public hostname** (e.g. `datacenter.cspc.edu.ph`) |
| | **The alert mailbox** (`ictusupport@cspc.edu.ph`) and its **App Password** — generated by whoever owns that mailbox, typed into `backend/.env` by ICTU (D.3). Never a developer's personal one |
| Registering ICTU's hostname in the Google OAuth client ([§5.4](#54-google-oauth)) | **The reverse proxy and the TLS certificate** ([§5](#5-publish-over-https--ictus-proxy-production)) |
| Flashing the ESP32 once with the production `DEVICE_SECRET` (§8.1) | Setting the ESP32's WiFi + backend IP from its setup page (§8.2) and firewall rules for port 3001 (§9.1) |

⚠️ **Hand secrets over separately from the code** — in person, on a USB stick, or through a
password manager. Never in the repo, an email body or a chat. The server generates its **own**
`JWT_SECRET`, `DEVICE_SECRET` and encryption keys (D.3) — those are never copied from a
development machine.

### D.2 Get the code onto the server

Any method from [§1.1.2](#112-get-the-code-onto-the-server) works (`git clone` with a deploy key
is recommended). Everything below runs from the repo root on the server.

```bash
docker --version && docker compose version     # both must answer
```

### D.3 The two configuration files

**1. Root `.env`** — only what the containers need to find each other and the two build-time
values. Copy the template and fill it in:

```bash
cp .env.docker.example .env
```

```dotenv
DB_ROOT_PASSWORD=<strong>          # set BEFORE the first `up`: written into the DB volume once
DB_NAME=cspc-ictu-monitoring-system
DB_USER=cspc
DB_PASSWORD=<strong>
FIRST_ADMIN_EMAIL=firstadmin@cspc.edu.ph         # created as an active admin on the first `up` (D.6)
INFLUX_PASSWORD=<8+ chars>
INFLUX_TOKEN=<openssl rand -hex 32>
VITE_API_URL=https://datacenter.cspc.edu.ph      # ICTU's hostname — no port, no /api
VITE_GOOGLE_CLIENT_ID=<same as GOOGLE_CLIENT_ID in backend/.env>
TZ=Asia/Manila
```

**2. `backend/.env`** — the application's own settings and secrets. Like the root `.env` it
is gitignored, so a fresh clone does not have one — copy its template:

```bash
cp backend/.env.example backend/.env
```

The full reference for every line is [§3.1](#31-backendenv). In Docker, **leave `DB_*` and `INFLUX_*` as they are** —
compose overrides them with the container addresses (`db`, `influxdb`), so the values in this
file are never used. The lines that are specific to this deployment:

```dotenv
WEB_ORIGIN=https://datacenter.cspc.edu.ph        # must match VITE_API_URL exactly
APP_PUBLIC_URL=https://datacenter.cspc.edu.ph    # the link put in account-approval emails
TRUST_PROXY=1                                    # proxy hops in front of the backend — see §5.3
```

**Alert email (optional — the system runs without it; bell and toasts still work).** The
system sends mail as a normal Google Workspace mailbox over SMTP, so it needs that mailbox's
**App Password**, not its real password. Whoever owns `ictusupport@cspc.edu.ph`:

1. signs in to it → **myaccount.google.com → Security** → turns on **2-Step Verification**
   (App Passwords do not exist without it);
2. opens **myaccount.google.com/apppasswords**, names it `Monitoring System`, **Create**;
3. copies the 16 characters — shown **once**.

```dotenv
SMTP_USER=ictusupport@cspc.edu.ph
SMTP_PASS=abcd efgh ijkl mnop                    # the App Password; spaces are fine
MAIL_FROM=CSPC ICTU Monitoring <ictusupport@cspc.edu.ph>
NOTIFY_EMAIL_TO=                                 # must be BLANK in production
```

Check it after D.4: `docker compose exec backend npm run mail:check -- you@cspc.edu.ph` → the
test mail should arrive. ⚠️ Changing the mailbox's main password **revokes** the App Password
and alert email stops with no other symptom — make a new one and update `SMTP_PASS`. Detail:
[`email-popup-notifications.md`](email-popup-notifications.md) §8–9.

Generate the secrets **on the server** (no Node needed — `openssl` ships with the OS):

```bash
echo "JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n=+/')"
echo "DEVICE_SECRET=$(openssl rand -hex 24)"
echo "MIKROTIK_ENC_KEY=$(openssl rand -hex 32)"
echo "SECRET_ENC_KEY=$(openssl rand -hex 32)"
```

The rules they must meet (length, and the two keys being different) are in
[§3.1 → Generating the secrets](#generating-the-secrets); the backend refuses to start on a
`JWT_SECRET` or `DEVICE_SECRET` that breaks them. Lock both files down:

```bash
chmod 600 .env backend/.env
```

### D.4 Build and start

```bash
docker compose up -d --build
docker compose ps                   # all four "healthy" after ~1-2 min on the first start
                                    #   (dc-db, dc-influxdb, dc-backend, dc-frontend)
docker compose logs -f backend      # expect "Server running on port 3001", no DB/Influx errors
```

On the **first** start MariaDB imports `v13_cspc-ictu-monitoring-system.sql` by itself (it is
mounted into `docker-entrypoint-initdb.d`) and InfluxDB creates its org, bucket and token from
the root `.env`. Neither happens again — an existing volume is never re-initialised.

### D.5 One port or two for ICTU's proxy

The containers publish **two** ports: `3001` (backend) and `8080` (dashboard). ICTU's proxy
can use them either way:

| Option | ICTU's proxy points at | Set `TRUST_PROXY` to |
|---|---|---|
| **A — two upstreams (default)** | `/api/` + `/socket.io/` → `:3001`, everything else → `:8080` | `1` |
| **B — one upstream** | everything → `:8080`; our nginx container splits `/api/` + `/socket.io/` to the backend itself | `2` |

For **B**, uncomment the two `location` blocks at the bottom of `frontend/nginx.conf`, then
`docker compose up -d --build frontend`. B is simpler for ICTU (one address to configure)
at the cost of one extra hop. Add 1 to `TRUST_PROXY` for every *further* proxy ICTU has in
front of their own (ask them — §5.3).

### D.6 First admin

**Set `FIRST_ADMIN_EMAIL` in the root `.env` before the first `docker compose up`** — the
CSPC Google account that will run the system. When the database is first built,
`ops/docker/first-admin.sh` creates it as an **active admin**, so its first sign-in goes
straight to the dashboard instead of landing *pending*. There is no password: sign in with
that Google account, and the name and photo fill in from Google. Everyone else then signs
in and is approved from **User Management → Pending registrations**. The seed is recorded
in **History** as `bootstrap_admin`.

Confirm it ran:

```bash
docker compose logs db | grep first-admin
```

It runs **once**, on an empty `db-data` volume — setting the value on a database that
already exists does nothing. In that case (or if it was left blank), sign in once with the
account so the row exists, then promote it inside the database container:

```bash
docker compose exec db mariadb -u cspc -p cspc-ictu-monitoring-system
```
```sql
UPDATE users SET status = 'active', role = 'admin' WHERE email = 'firstadmin@cspc.edu.ph';
```

Why this cannot be skipped: [§4.3](#43-bootstrap-the-first-admin-important--chicken-and-egg).

### D.7 Day to day

```bash
docker compose ps                      # what is running and healthy
docker compose logs -f backend         # the [AUTH] / [RATE] / poller lines live here
docker compose up -d backend           # after editing backend/.env — NOT `restart`
docker compose up -d --build frontend  # after changing VITE_* in the root .env
git pull && docker compose up -d --build   # update to a new version
docker compose down                    # stop everything, KEEP the data
```

The same with plain `docker`, by container name (see the table in [§0](#0-architecture-at-a-glance-what-you-actually-deploy) — `dc-` = datacenter):

```bash
docker ps --filter name=dc-            # just this system's containers
docker logs -f dc-backend              # = docker compose logs -f backend
docker exec -it dc-db mariadb -u cspc -p cspc-ictu-monitoring-system
docker stats dc-backend dc-db dc-influxdb dc-frontend   # CPU / memory per container
```

⚠️ **`restart` does not re-read `backend/.env`** — `env_file` is read when a container is
*created*, so `restart` keeps the old values and the edit appears to do nothing.
⚠️ **`docker compose down -v` deletes the volumes — i.e. the database, the time-series, the
backups and the reports.** Never run it on the production server.

Data lives in named volumes (`db-data`, `influx-data`, `backend-backups`, `backend-reports`,
`backend-branding`), so it survives `down`, rebuilds and upgrades.

**Backups:** set `BACKUP_HOST_DIR=/mnt/backup/backups` in the root `.env` so the on-site
backup lands on the USB/SD drive rather than in `backend-backups` on the main disk. That is
also what lets the nightly database dump and the Backblaze upload find it — both scripts
switch to their Docker mode when it is set. Full steps:
[`ops/backup-setup-linux.md`](ops/backup-setup-linux.md), section *"Running under Docker?"*.

---

## 1. Prerequisites

> **This section and §2–§4 are the MANUAL install** (everything directly on a host, no
> containers) — the development machine, or a server where Docker is not an option. For the
> ICTU production server use [§D](#d-docker-deployment--the-ictu-handover-production), which
> needs only Docker, plus the Go / Arduino / Google / HTTPS rows below.

| Component | Version | Notes |
|---|---|---|
| Node.js | **18+** (LTS 22 recommended) | backend + frontend build (manual install only) |
| npm | bundled with Node | |
| MySQL / MariaDB | **8.0+** / **10.4+** | relational store (the Docker stack uses MariaDB 10.11) |
| InfluxDB | **2.x** | time-series store (env, server, router/UPS metrics) |
| Docker Engine + compose plugin | recent | **production path** ([§D](#d-docker-deployment--the-ictu-handover-production)) |
| Go | **1.22+** | only to *build* the agents; target servers need nothing |
| Arduino IDE / arduino-cli | latest | only to flash the ESP32 |
| A Google Cloud OAuth **Web** client | — | login is Google-only (`google-oauth.md`) |
| An HTTPS hostname + certificate | — | **ICTU's** (e.g. `datacenter.cspc.edu.ph`), on **their** reverse proxy ([§5](#5-publish-over-https--ictus-proxy-production)). **Google rejects a bare LAN IP**, so this is required, not optional. For testing, the Cloudflare Tunnel ([§5B](#5b-cloudflare-tunnel--testing-and-the-defense-only)) |
| (optional) SMTP mailbox | — | alert + account emails over SMTP (`email-popup-notifications.md` §8); the system works without it |

Network: the backend listens on **0.0.0.0:3001** (all interfaces). On-campus collectors
(agents, ESP32) reach it directly at the server's LAN IP:3001; browsers and off-campus agents
reach it through ICTU's proxy. Give the campus server a **static LAN IP / internal hostname** —
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
| **Inbound firewall**: TCP **3001** open to the subnets holding the monitored servers and the ESP32 | Collectors reach the backend directly on `:3001`, never through the tunnel ([§9.1](#91-restrict-port-3001-to-the-agent-subnets--do-this-on-deploy-day)). **80/443 are no longer needed** | Agents enroll but never deliver metrics; the room shows no sensor data |
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
5.x  HTTPS through ICTU's proxy + Google OAuth origin   (5B for the test tunnel)
4.3  bootstrap the first admin      ← LAST: it needs Google sign-in working
```

⚠️ §4.3 is numbered before §5 but must be done **after** it: the first admin is created by
signing in with Google, and Google refuses a bare LAN IP (§5.4).

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
PORT=3001
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

# CORS — the dashboard's public origin (ICTU's hostname, §5). Comma-separated;
# or * for a roaming LAN. Include http://localhost:5173 too if you also use the dev server.
WEB_ORIGIN=https://datacenter.cspc.edu.ph
APP_PUBLIC_URL=https://datacenter.cspc.edu.ph   # link in account-approval emails; blank = first WEB_ORIGIN
TRUST_PROXY=1                            # proxy hops in front of the backend — §5.3. Security setting

# Alert + account email over SMTP (optional — blank SMTP_USER = email off; bell + toast still work)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=ictusupport@cspc.edu.ph        # full mailbox address
SMTP_PASS=<16-char Google App Password>  # NOT the account password
MAIL_FROM=CSPC ICTU Monitoring <ictusupport@cspc.edu.ph>
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
BACKUP_OFFSITE_CRITICAL_HOURS=72         # escalate to critical (= email) after this; 0 = never
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
node src/server.js     # entry point is backend/src/server.js  → "Server running on port 3001"
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
# Pin the backend to the PUBLIC origin (no :3001). ICTU's proxy (or the test tunnel, §5B)
# routes /api and /socket.io to the backend on the same hostname, so the browser talks to
# one origin. Must match the backend's WEB_ORIGIN exactly.
VITE_API_URL=https://datacenter.cspc.edu.ph
```

> Why set this here: by default the app auto-detects the backend at `<page-host>:3001`
> (`frontend/src/config.ts`). Behind a proxy, port 3001 isn't public — the API
> is reached at the page's own origin under `/api`. Pinning `VITE_API_URL` to the public
> URL makes both the Axios client and Socket.IO use it. (Docker: this value goes in the root
> `.env` instead — §D.3.)

`VITE_GOOGLE_CLIENT_ID` **must match** the backend's `GOOGLE_CLIENT_ID`. Vite inlines env
vars at build time → **rebuild after any change** (`npm run build`).

### 4.2 Build

```bash
npm run build          # → frontend/dist/  (static SPA)
```

`frontend/dist/` is served on port 8080 — by the nginx container in Docker (§D), or by
`npx serve -s dist -l 8080` on a manual install ([§5B.5](#5b5-serve-the-built-dashboard-on-8080)) — and
the proxy in front forwards to it.
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

> 🐳 **Under Docker this is automatic** — set `FIRST_ADMIN_EMAIL` in the root `.env` before
> the first `docker compose up` and that account is created as an active admin
> ([D.6](#d6-first-admin)). The steps below are for a non-Docker install, or a Docker
> database that was built without it.

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

## 5. Publish over HTTPS — ICTU's proxy (production)

ICTU owns the front door: **their hostname, their TLS certificate, their reverse proxy.** The
containers speak plain HTTP on the campus side; ICTU's proxy is where HTTPS starts and ends.
Nothing in the containers depends on which proxy product ICTU uses (nginx, Apache, HAProxy,
a FortiGate/Sophos publishing rule, or Cloudflare under **their** account) — only on the four
requirements below.

### 5.1 What ICTU's proxy must do

| # | Requirement | What breaks without it |
|---|---|---|
| 1 | **Route by path**: `/api/` and `/socket.io/` → `<server>:3001`; everything else → `<server>:8080`. (Or everything → `:8080` with option B, §D.5) | Login page loads, every panel is empty |
| 2 | **Pass WebSocket upgrades** on `/socket.io/` (`Upgrade` + `Connection: upgrade`, HTTP/1.1), with a long read timeout | Dashboard loads but no chart moves, no toast, no bell count — the easiest one to miss because everything *looks* fine |
| 3 | **Send `X-Forwarded-For` and `X-Forwarded-Proto`** | Every visitor logs as the proxy's IP (one shared rate-limit bucket for the whole campus); HSTS is never sent |
| 4 | **Allow request bodies of at least 2 MB** on `/api/` | Report logo uploads (up to 2 MB) and agent back-fill after an outage are refused with 413 |

**Off-campus servers** (Go agents outside the LAN) post to `/api/agents/*` and
`/api/servers/*` through this same proxy, so ICTU must **not** restrict those paths to the
campus network if any monitored server is off campus. If every server is on campus, restricting
them there is worthwhile hardening (§10).

### 5.2 Example — if ICTU's proxy is nginx

Give ICTU this as a starting point; `<server>` is the campus server's LAN IP (or `127.0.0.1`
if nginx runs on the same machine). Certificate lines are theirs.

```nginx
server {
    listen 443 ssl http2;
    server_name datacenter.cspc.edu.ph;
    # ssl_certificate / ssl_certificate_key — ICTU's certificate

    client_max_body_size 3m;               # report logos are up to 2 MB

    location /api/ {
        proxy_pass http://<server>:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /socket.io/ {
        proxy_pass http://<server>:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }

    location / {
        proxy_pass http://<server>:8080;
        proxy_set_header Host $host;
    }
}

server {                                   # plain HTTP → HTTPS
    listen 80;
    server_name datacenter.cspc.edu.ph;
    return 301 https://$host$request_uri;
}
```

### 5.3 `TRUST_PROXY` — ask ICTU how many hops

`TRUST_PROXY` in `backend/.env` is how many proxies in front of the backend may be believed
when they report the client's address. **It is a security setting, not a formality**: set it
too high and a client can forge its own IP (its own rate-limit bucket, and its own value in
`system_logs.ip_address` — the row that is the evidence for a Privacy Notice acceptance); too
low and everyone shares the proxy's IP.

| Path to the backend | `TRUST_PROXY` |
|---|---|
| ICTU proxy → backend `:3001` (option A) | `1` |
| ICTU proxy → our nginx container → backend (option B) | `2` |
| Each further proxy ICTU has in front (a load balancer, a firewall that adds `X-Forwarded-For`) | add `1` |

Verify after go-live: **History** → your own sign-in row must show your real public IP, not
ICTU's proxy address and not a `172.x` Docker address.

### 5.4 Google OAuth

Google Cloud Console → Credentials → the OAuth 2.0 **Web** client → **Authorized JavaScript
origins** → add:

```
https://datacenter.cspc.edu.ph
```

Leave redirect URIs empty (the app uses `redirect_uri: "postmessage"`). Allow a few minutes to
apply. ⚠️ Whoever owns that Google Cloud project controls sign-in for the whole system —
agree with ICTU whether it stays with the developers or is transferred to an ICTU account.

### 5.5 Settings that follow the hostname

All must name the **same** origin — same scheme, same host, no trailing slash:

| Where | Setting |
|---|---|
| root `.env` | `VITE_API_URL` → then `docker compose up -d --build frontend` |
| `backend/.env` | `WEB_ORIGIN`, `APP_PUBLIC_URL`, `TRUST_PROXY` → then `docker compose up -d backend` |
| Google Cloud Console | Authorized JavaScript origin (§5.4) |
| each **off-campus** agent | `API_URL=` in `agent.conf` (or re-run the installer), then restart the agent |

### 5.6 Verify

| # | Check | Expect |
|---|---|---|
| 1 | `https://datacenter.cspc.edu.ph/api/policy/version` | JSON |
| 2 | site root | login page, padlock |
| 3 | `/privacy` typed directly | loads, not 404 |
| 4 | sign in with a CSPC Google account | works |
| 5 | watch a chart one minute | numbers move (proves WebSocket forwarding) |
| 6 | History → your sign-in row | your real IP (proves `TRUST_PROXY`) |
| 7 | open it on mobile data, WiFi off | loads (proves it is public, not campus-only) |
| 8 | an off-campus agent | its server goes **Online** in Server Metrics |

---

## 5B. Cloudflare Tunnel — testing and the defense only

⚠️ **Not the production path.** The domain `cspc-ictu.stream` and the Cloudflare account belong
to the developers. Use this to demo and test before ICTU's hostname exists; production is §5.
If the tunnel is still running when ICTU's proxy goes live, both hostnames work — each needs
its own entry in `WEB_ORIGIN` and in Google's authorized origins, but `VITE_API_URL` can name
only one, so the dashboard build follows whichever is set there.

The system is published for testing at **`https://monitoring.cspc-ictu.stream`**.
Full operating manual: `cloudflare-tunnel-setup.md`.

### 5B.0 What the tunnel is, and is not

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

### 5B.1 One hostname, two local ports

The tunnel splits a single hostname by URL **path**:

```
                                    ┌─ /api/        ─┐
Browser ─https─▶ Cloudflare ─tunnel─┤ /socket.io/   ─┼─▶ localhost:3001   backend
                                    └─ everything else ─▶ localhost:8080  dashboard files

ESP32 + on-campus Go agents ── LAN, straight to <server-LAN-IP>:3001 ──▶
off-campus Go agents ── https://<the domain> ── through the tunnel like a browser
```

Two ports because the backend serves JSON only — the dashboard's HTML/JS/CSS are static
files and need something to hand them out. That used to be nginx; now it is `serve`.

### 5B.2 Install cloudflared on the server

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cf.deb
sudo dpkg -i cf.deb && rm cf.deb
cloudflared --version
```

### 5B.3 Move the tunnel credentials

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

### 5B.4 `~/.cloudflared/config.yml`

```yaml
tunnel: f8859a41-0eea-4c0c-a698-165335c802e7
credentials-file: /home/<service-user>/.cloudflared/f8859a41-0eea-4c0c-a698-165335c802e7.json

ingress:
  - hostname: monitoring.cspc-ictu.stream
    path: ^/api/
    service: http://localhost:3001

  - hostname: monitoring.cspc-ictu.stream
    path: ^/socket.io/
    service: http://localhost:3001

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
# must answer: service: http://localhost:3001
```

### 5B.5 Serve the built dashboard on :8080

```bash
cd /opt/cspc-monitoring/frontend
npm run build
npx serve -s dist -l 8080
```

⚠️ **`-s` is required.** Without it, a deep link or F5 on `/alerts` returns 404 instead of
falling back to `index.html`.

For production, run it under the same process manager as the backend (§3.2) rather than a
login shell — a terminal that closes takes the dashboard with it.

### 5B.6 Run the tunnel as a service

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
systemctl status cloudflared
```

It reconnects by itself after a network drop or a reboot. No cron, no watchdog.

### 5B.7 Four processes must be running

| Process | Port | Started by |
|---|---|---|
| backend | 3001 | pm2 / systemd (§3.2) |
| dashboard files | 8080 | pm2 / systemd |
| `cloudflared` | — | systemd (§5B.6) |
| MySQL + InfluxDB | 3306 / 8086 | systemd |

### 5B.8 App settings

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

### 5B.9 Google OAuth

Console → Credentials → OAuth 2.0 Client ID → **Authorized JavaScript origins** → add:

```
https://monitoring.cspc-ictu.stream
```

Leave redirect URIs empty (the app uses `redirect_uri: "postmessage"`). Keep
`http://localhost:5173` for development. Allow a few minutes to apply.

### 5B.10 Verify

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

### 5B.11 Troubleshooting

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

### 5B.12 Optional — restrict who can open it

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
then runs). **Which address to give it depends on where that server is:**

| The monitored server is… | `-ApiUrl` / `API_URL` | Why |
|---|---|---|
| **on the campus LAN** | `http://<backend-server-ip>:3001` | direct, no proxy — keeps reporting when the internet is down |
| **off campus** (another building's network, another site, a cloud VM) | `https://datacenter.cspc.edu.ph` | the only address it can reach; HTTPS encrypts the metrics and the `AGT-` token on the way |

**Get the install key from the dashboard first.** As admin: **Server Metrics → Agent
install keys → + New key**. Label it (e.g. "Main server room — Aug 2026"), optionally set
an expiry, and copy the ready-made command it prints — the key is shown **once**.

> **`<backend-server-ip>` is the LAN IP of the server running the containers**, e.g.
> `192.168.100.9` — **not** the address of the server being monitored.
> ⚠️ Never use plain `http://` over the internet: the agent's token travels in a header on
> every post, and anyone on the path could read it and report as that server.

```powershell
# Windows — elevated PowerShell, binary in same folder
.\install.ps1 -ApiUrl "http://<backend-server-ip>:3001" -InstallKey "AIK-<key>"   # on campus
.\install.ps1 -ApiUrl "https://datacenter.cspc.edu.ph" -InstallKey "AIK-<key>"    # off campus
```
```bash
# Linux — systemd
sudo bash install.sh http://<backend-server-ip>:3001 AIK-<key>                   # on campus
sudo bash install.sh https://datacenter.cspc.edu.ph AIK-<key>                    # off campus
```

The agent saves this address in `agent.conf` (`API_URL=`). To move an agent to a new address
later — e.g. from the test tunnel to ICTU's hostname — edit that line and restart the agent.

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

The ESP32 has **two kinds of settings**, set in two different places:

| Setting | Where it is set | Changed by |
|---|---|---|
| `DEVICE_SECRET` | `secrets.h`, **compiled in** | a developer — reflash |
| WiFi name + password, backend IP + port | the ESP32's own **setup page**, stored in its flash | ICTU staff, from a phone — **no reflash** |

#### 8.1 Flash once, with the production `DEVICE_SECRET`

Copy `iot/esp32/env_monitor_v2/secrets.h.example` to `secrets.h` (gitignored) and set
`DEVICE_SECRET` to **exactly** the backend's value — the production one generated in §D.3, not a
development value. A mismatch rejects every connection, and the symptom is a silently
unmonitored room rather than an error. Leave `WIFI_SSID` / `WIFI_PASSWORD` / `BACKEND_HOST`
**out**: they are only fallbacks, and a box without them opens its setup page on first boot,
which is what you want for the installed unit. Then flash via Arduino IDE / arduino-cli (ESP32
board package, correct COM port). `SD_ENABLED 0` only if the micro-SD offline buffer is not
wired.

#### 8.2 Set the WiFi and the backend address — the setup page

1. Power the box on. With nothing configured it starts in **setup mode** by itself.
   To re-enter setup mode later, **hold the setup push button (GPIO 13) for 3 seconds** — the
   RGB LED turns **magenta** while the hold is counted, then the ESP32 restarts into setup mode.
2. On a phone or laptop, join the WiFi network **`CSPC-ICTU-Sensor-XXXX`** (the last four
   characters come from the box's MAC address). The setup page opens by itself; if it does not,
   browse to `http://192.168.4.1`.
3. Choose the server room's WiFi and enter its password, the **backend IP** (the campus server's
   **LAN IP** — the ESP32 never uses the public hostname) and the port **`3001`**. Save.
4. The box joins the WiFi and **tests the backend address**. If nothing answers, the setup page
   reopens with the failure named, so a mistyped IP is caught on the spot.
5. On success it starts sending `sensorData` every ~3 s → the **Environment** page goes live.

Setup mode closes after **3 minutes** with no one using it, and the box carries on with its
previous settings — so a box powered up in an empty room does not sit as an open access point.

⚠️ **The setup access point is open (no password)** while setup mode lasts. Anyone within WiFi
range during those minutes could change where the box sends its data. Keep the window short,
or set `AP_PASSWORD` (8+ characters) in the firmware and print it on the enclosure.
The BOOT-button method (press BOOT within 4 s of power-up) still works as a fallback if the
setup button is not fitted.

Alarm thresholds and IR/auto-cooling boundaries are **runtime-configurable from the
dashboard** (Alert Rules + Auto-Cooling Thresholds) via the `envConfig` / `acConfig`
socket events — no reflash needed to retune. The IR codes are real captures from the Carrier
remote (see `CLAUDE.md` → Air Conditioner System).

⚠️ The ESP32 connects over **plain HTTP on the LAN**, so `DEVICE_SECRET` is readable to anything
on the same network segment. That is why §9.1 limits port 3001 to the ESP32 and agent subnets.

---

## 9. Ports & firewall

**Production (Docker + ICTU's proxy):**

| Port | Where | Service | Who may connect |
|---|---|---|---|
| **443** (+ 80 → redirect) | **ICTU's proxy** | HTTPS front door | the internet — ICTU manages it |
| 3001 | campus server | backend container (HTTP + WebSocket) | ICTU's proxy, on-campus Go agents, ESP32 |
| 8080 | campus server | dashboard container (nginx) | ICTU's proxy only |
| — | inside Docker | MariaDB, InfluxDB | the backend container only — **not published to the host at all** |

- **Only ICTU's proxy faces the internet.** 3001 and 8080 are campus-side, plain HTTP.
- **8080 should be reachable by ICTU's proxy only.** Opened to the whole LAN it serves the
  dashboard over plain HTTP, around the certificate.
- MariaDB and InfluxDB have no `ports:` in `docker-compose.yml`, so nothing outside the Docker
  network can reach them. Keep it that way.

**Testing with the Cloudflare Tunnel (§5B)** adds **outbound 7844** for `cloudflared` and
needs no inbound port at all.

### 9.1 Restrict port 3001 to the agent subnets — do this on deploy day

The backend listens on `0.0.0.0:3001` (`src/server.js`), and it **has to**: on-campus Go agents
and the ESP32 connect to it directly, not through the proxy. So port 3001 is reachable by anything
on the campus LAN, and *that is the bypass* — a client talking to `:3001` skips ICTU's proxy
entirely, which means it also writes its own `X-Forwarded-For`. The backend then believes it,
so such a client picks its own `req.ip`: its own bucket in every IP-keyed rate limiter
(sign-in, agent enrollment, metric ingest) and its own value in `system_logs.ip_address` — the
row that is the evidence for a Privacy Notice acceptance. It is also where the ESP32's
`DEVICE_SECRET` travels in plain text (§8).

No code can close this, because the port must stay open to the LAN. It is a firewall rule:
allow **ICTU's proxy, the on-campus agent subnet(s) and the ESP32**; drop everyone else. Ask
ICTU which VLAN the server room and the monitored servers are on — do not guess a /8. ICTU may
prefer to enforce this on their own switches/firewall instead; that works just as well.

⚠️ **With Docker, `ufw` does NOT protect published ports.** Docker writes its own iptables rules
for `ports:` and they are evaluated before `ufw`'s, so `ufw deny 3001` looks correct and blocks
nothing. The rules have to go in the `DOCKER-USER` chain, which Docker checks first and never
overwrites:

```bash
ip -br addr        # find the LAN interface name (e.g. eth0, ens18) → <LAN_IF>

# -I inserts at the TOP, so run these in this order: the DROP ends up LAST.
sudo iptables -I DOCKER-USER -i <LAN_IF> -p tcp --dport 3001 -j DROP
sudo iptables -I DOCKER-USER -i <LAN_IF> -p tcp --dport 3001 -s <ESP32_IP>      -j ACCEPT
sudo iptables -I DOCKER-USER -i <LAN_IF> -p tcp --dport 3001 -s <AGENT_SUBNET>  -j ACCEPT  # e.g. 10.10.20.0/24
sudo iptables -I DOCKER-USER -i <LAN_IF> -p tcp --dport 3001 -s <ICTU_PROXY_IP> -j ACCEPT
# dashboard: host 8080 → container 80, and DOCKER-USER sees the CONTAINER port
sudo iptables -I DOCKER-USER -i <LAN_IF> -p tcp --dport 80 -j DROP
sudo iptables -I DOCKER-USER -i <LAN_IF> -p tcp --dport 80 -s <ICTU_PROXY_IP> -j ACCEPT

sudo iptables -L DOCKER-USER -n -v --line-numbers   # check the order
sudo apt install iptables-persistent && sudo netfilter-persistent save   # survive a reboot
```

⚠️ **Keep `-i <LAN_IF>`.** Without it the DROP also matches traffic *between* containers, and
option B (our nginx container → backend, §D.5) stops working. If ICTU's proxy runs **on this
same machine**, it reaches the ports over loopback, which these rules do not touch — leave the
`<ICTU_PROXY_IP>` lines out.

On a manual install without Docker, plain `ufw allow from … to any port 3001` rules work.

**Browsers and off-campus agents are unaffected** — they arrive through ICTU's proxy, which is
on the allow list. Verify from a machine outside the allowed range:

```bash
curl -m 5 http://<backend-server-ip>:3001/api/policy/version      # expect: timeout / refused
curl -I  https://datacenter.cspc.edu.ph/api/policy/version        # expect: 200 (proxy fine)
```

Then re-check that an on-campus agent still reports in (Server Metrics → the host goes Online).
If it does not, its subnet is not in the allow list.

> ⚠️ If you are on SSH, make sure your own access is not caught by a new default-deny rule
> before you apply it — locking yourself out of the box is the usual way this goes wrong.

See `audits/api-infra-security-2026-08-25.md` — A-03.

---

## 10. Production hardening

- **HTTPS:** terminated at **ICTU's proxy** ([§5](#5-publish-over-https--ictus-proxy-production))
  with ICTU's certificate — no certificates to manage on the campus server. Certificate
  renewal is ICTU's; an expired one takes down the dashboard **and every off-campus agent**
  at once, so it is worth agreeing who watches it.

> ⚠️ **The dashboard is internet-facing.** ICTU publishes it publicly (§5), so the login page
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
> **Worth asking ICTU for — only if every monitored server is on campus:** restrict
> `/api/agents/` and `/api/servers/` to campus LAN sources at their proxy. On-campus agents and
> the ESP32 connect over the LAN (§7, §8), so then those paths never need to accept internet
> traffic. ⚠️ **Do not do this if any server is off campus** — its agent enrolls and reports
> through exactly those paths, and would go Offline. In that case the protections are the
> `AIK-` install key (revocable, optionally expiring), admin approval of every new agent, and
> keeping `AGENT_INSTALL_KEY` in `backend/.env` **blank**.
- **Secrets:** unique, long `JWT_SECRET` / `DEVICE_SECRET` / `AGENT_INSTALL_KEY`. Never
  commit `.env` or `agent.conf`. Rotate `AGENT_INSTALL_KEY` if it leaks (approved agents
  keep working — they use per-device tokens).
- **CORS:** set `WEB_ORIGIN` to the exact public dashboard origin (the ICTU hostname);
  avoid `*` outside a trusted LAN.
- **`TRUST_PROXY`** (backend/.env) is how many proxy hops may be believed when they claim a
  client's address — **`1`** for ICTU proxy → backend, **`2`** with our nginx container in
  between (option B), plus one per further proxy ICTU runs ([§5.3](#53-trust_proxy--ask-ictu-how-many-hops)).
  The blank default is 2. Set it to the REAL hop count: too low and every user shares one
  apparent IP (their proxy's); too high and the surplus entries are attacker-supplied (§9.1).
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
BACKUP_OFFSITE_CRITICAL_HOURS=72   # escalate to critical (= email) after this; 0 = never
```

If the sync stalls, the backend raises a `backup_offsite` **warning** (bell only) after 26 h,
escalates it to **critical** — which emails — after 72 h, and auto-resolves both once a
fresh sync lands. Leave `BACKUP_OFFSITE_ENABLED` unset
until the sync is actually running, so it never false-alerts.

> ⚠️ **Keep offline + safe** (they are **not** in any backup): the rclone **encryption
> passphrase**, `rclone.conf`, and `backend/.env`. Without the passphrase the cloud copy is
> unrecoverable — that's the point of client-side encryption. Store them with CSPC,
> separately from the server.

Full walkthrough — bucket, keys, rclone config, connection test, restore, and verification:
**`ops/backblaze-setup-guide.md`**.

---

## 12. Post-deploy verification checklist

- [ ] `docker compose ps` shows all four containers (`dc-db`, `dc-influxdb`, `dc-backend`, `dc-frontend`) **healthy**, and `docker compose logs backend`
      shows `Server running on port 3001` with no DB/Influx errors (manual install: `node src/server.js`).
- [ ] `https://datacenter.cspc.edu.ph/` loads the dashboard **from off the campus network** (test on phone mobile data, WiFi off).
- [ ] Live data updates on the public URL — confirms ICTU's proxy passes WebSocket upgrades.
- [ ] `system_logs` shows real client IPs, not ICTU's proxy address or a `172.x` Docker address (confirms `TRUST_PROXY` — [§5.3](#53-trust_proxy--ask-ictu-how-many-hops)).
- [ ] **Google sign-in** works from the public URL (origin added in Google Console — [§5.4](#54-google-oauth)).
- [ ] An **off-campus** agent (if any) reports through `https://datacenter.cspc.edu.ph` and shows Online.
- [ ] Port 3001 refuses a machine outside the allow list ([§9.1](#91-restrict-port-3001-to-the-agent-subnets--do-this-on-deploy-day)).
- [ ] First admin promoted ([§4.3](#43-bootstrap-the-first-admin-important--chicken-and-egg)); **Pending registrations** visible under User Management.
- [ ] **Alert Rules** page shows seeded rules (confirms the schema loaded WITH its data —
      an empty list means the export was structure-only and alerting will be silent).
- [ ] A Go agent enrolls → appears pending → approves → **Server Metrics** shows live gauges.
- [ ] ESP32 connected → **Environment** page shows live temp/humidity/gas.
- [ ] Trip a threshold (or lower a rule) → **bell + toast** fire; email arrives if SMTP is configured.
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
| Public URL loads the page but API/live data fails | `VITE_API_URL` not set to the public origin, **or set but not rebuilt** (`docker compose up -d --build frontend`) — it is compiled in at build time. Otherwise ICTU's proxy is not routing `/api/` + `/socket.io/` to `:3001` ([§5.1](#51-what-ictus-proxy-must-do)). |
| Page loads but live data never updates | ICTU's proxy is not passing **WebSocket upgrades** on `/socket.io/` — the most common failure with a proxy you don't control ([§5.1](#51-what-ictus-proxy-must-do)). |
| Every request logs the same IP | `TRUST_PROXY` lower than the real number of hops ([§5.3](#53-trust_proxy--ask-ictu-how-many-hops)). |
| Edited `backend/.env`, nothing changed | `docker compose restart` does not re-read it — use `docker compose up -d backend`. |
| Port 3001 still open to everyone despite `ufw` | Docker bypasses `ufw` — the rules belong in `DOCKER-USER` ([§9.1](#91-restrict-port-3001-to-the-agent-subnets--do-this-on-deploy-day)). |
| Uploading a report logo fails with 413 | ICTU's proxy body limit is below 2 MB ([§5.1](#51-what-ictus-proxy-must-do)). |
| API calls blocked (CORS error in console) | Public origin not in `WEB_ORIGIN`. Add the exact hostname; `docker compose up -d backend`. |
| Login fails from the public URL | Origin not in the Google OAuth **Authorized JavaScript origins** ([§5.4](#54-google-oauth)), or `GOOGLE_CLIENT_ID` ≠ `VITE_GOOGLE_CLIENT_ID`. |
| Login rejects a valid user | Email domain not in `GOOGLE_ALLOWED_DOMAINS`; only `@cspc.edu.ph`/`@my.cspc.edu.ph` are allowed. |
| First user can't do anything | Still `status='pending'`. Promote in MySQL ([§4.3](#43-bootstrap-the-first-admin-important--chicken-and-egg)). |
| No alerts ever fire | `alert_rules` is empty → alerting is rules-only → silent. The schema seeds it; if the table is empty the dump was loaded structure-only. |
| Agent stuck "pending" | Not approved yet (Server Metrics page), or `AGENT_INSTALL_KEY` mismatch. |
| Agent can't reach backend | On campus: use `http://<backend-server-ip>:3001` and check its subnet is in the §9.1 allow list. Off campus: use `https://datacenter.cspc.edu.ph`, and check ICTU's proxy is not limiting `/api/agents/` + `/api/servers/` to the LAN ([§7](#7-server-agents-go--one-per-monitored-server)). |
| Agent reports "certificate" / TLS errors | The proxy's certificate is not trusted by that server (self-signed or internal CA) — install the CA on the server, or have ICTU use a public certificate. |
| Agent 403s and removes itself | The server was **removed** in the dashboard (token revoked). Re-run `--register`. |
| ESP32 won't connect | `DEVICE_SECRET` in `secrets.h` ≠ the backend's (reflash), or a wrong backend IP/port — hold the setup button 3 s and fix it on the setup page (§8.2), or port 3001 blocks the ESP32's IP (§9.1). |
| Server IP or WiFi changed | Hold the ESP32's setup button 3 s and enter the new values (§8.2) — no reflash. |
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
   A router **without** SNMP can still be registered with a blank community — it is then
   monitored by ICMP only (up/down, latency, packet loss).
2. Confirm **UDP 161** is reachable from the campus server.
3. Probe it first — either the **Test connection** button on the Add router / Add UPS form,
   or from the server:
   ```bash
   docker compose exec backend npm run probe -- <device-ip> <community>   # Docker
   cd backend && npm run probe -- <device-ip> <community>                 # manual install
   ```
   It prints a verdict naming how to register the device (UPS / SNMP router / ping-only).
   A timeout = wrong IP, wrong community or a firewall — fix that first, or the dashboard
   will just show the device Offline.

**Hard limits to set expectations:**

- A **UPS needs a network / SNMP card.** A USB- or serial-only UPS cannot be monitored.
- A router **without SNMP** (e.g. ISP-owned equipment) gets reachability, latency and packet
  loss by ICMP, but no interfaces, traffic or CPU.
- **Router CPU / memory stay blank.** Those OIDs are vendor-specific, not in the standard
  MIBs, so the seeded `router_cpu` / `router_mem` rules never fire on SNMP routers. (They
  do work on MikroTik, which reports them over the RouterOS API.)
- A **3-phase UPS reports line 1 only**.

> This is exactly **why the backend must stay on-prem**: the pollers connect *into* the
> campus LAN (SNMP UDP 161 / RouterOS API) to private addresses a cloud host can't reach.

### Still roadmap

- **SNMP v3** — needs credential columns on `device_network` plus a v3 branch in
  `snmpClient`.

---

*See also: `CLAUDE.md` (architecture), `server-metrics.md` (agent ops),
`google-oauth.md` (login setup), `email-popup-notifications.md` (alerting/email),
`docker-compose.yml` + `.env.docker.example` (the stack ICTU runs),
`cloudflare-tunnel-setup.md` (the test tunnel).*
