# Running the system at `https://monitoring.cspc-ictu.stream`

Cloudflare Tunnel publishes the LAN system on a public HTTPS hostname. No nginx, no port
forwarding, no router changes.

```
Browser ──https──▶ Cloudflare ──tunnel──▶ this PC ┬─ :3000 backend   (/api, /socket.io)
                                                  └─ :8080 dashboard (everything else)

Agents + ESP32 ──── LAN, straight to 192.168.100.39:3000 ────▶   (never use the domain)
```

Setup is **already done**. Day-to-day you only need Part 1.

---

# PART 1 — Start the system

Three windows. All three must stay open.

**Open PowerShell three times:** Windows key → type `powershell` → Enter. (Or Windows Terminal,
then Ctrl+Shift+T twice.)

### Window 1 — backend
```powershell
cd "C:\Users\Mark Angelo\Documents\server-infrastructure-monitoring-system-webSystem\backend"
npm run dev
```
Wait for the startup lines to stop.

### Window 2 — dashboard
```powershell
cd "C:\Users\Mark Angelo\Documents\server-infrastructure-monitoring-system-webSystem\frontend"
npx serve -s dist -l 8080
```
Wait for `Accepting connections at http://localhost:8080`.

⚠️ **`npx serve`, never `npm run dev`.** `npm run dev` starts Vite on port **5173**; the tunnel
points at **8080**, so you would get `502 Bad Gateway`. It must also be the **built** `dist` —
that is the only copy with the tunnel URL compiled into it.

⚠️ **`-s` is required.** Without it, pressing F5 on any page gives a 404.

### Window 3 — tunnel
```powershell
cloudflared tunnel run cspc-monitoring
```
Wait for `Registered tunnel connection`.

### Check it
Open <https://monitoring.cspc-ictu.stream/api/policy/version> → returns JSON.

**Stop everything:** Ctrl+C in each window.

---

# PART 2 — After changing frontend code

Vite compiles `VITE_*` values **into the bundle**. Editing `.env` or any `frontend/src` file
does nothing on the live site until you rebuild.

```powershell
cd "C:\Users\Mark Angelo\Documents\server-infrastructure-monitoring-system-webSystem\frontend"
npm run build
```

Then **Ctrl+C in window 2 and start it again**, and tell anyone already on the site to press
**Ctrl+Shift+R** (a normal refresh keeps the cached old bundle).

Confirm the build took:
```powershell
Select-String -Path dist\assets\*.js -Pattern "monitoring.cspc-ictu.stream" | Select-Object -First 1
```
A match = good. Nothing = `.env` was not picked up.

> This is the single most common failure. A stale `dist` gives **"cannot connect to server"**
> for everyone except you — your `localhost` testing happens to guess the right address, so it
> looks fine from here.

**Backend code changes** need no rebuild — `npm run dev` restarts itself.

---

# PART 3 — Verify (after setup changes, or before a demo)

| # | Check | Expect |
|---|---|---|
| 1 | `/api/policy/version` | JSON |
| 2 | site root | login page, padlock |
| 3 | `/privacy` typed directly | loads, not 404 |
| 4 | sign in with CSPC Google | works |
| 5 | watch a chart 1 min | numbers move (proves `/socket.io/`) |
| 6 | History → your sign-in row | your real public IP, not `127.0.0.1` |
| 7 | Server Metrics + Environment | agents Online, sensor live |
| 8 | **open on campus WiFi** | loads — see below |

### ⚠️ Test `.stream` on campus WiFi before the defense
`.stream` is a low-reputation TLD and some institutional DNS filters block whole TLDs like it.
Loads on mobile data but not on CSPC WiFi = filtering, not your setup — and the fix is a
different domain. Find out early.

### ⚠️ New people cannot sign in until you approve them
A first Google sign-in creates a **pending** account. Approve it in **User Management →
Pending registrations**. Before a demo, have every panel member sign in once, then approve them
all.

---

# Troubleshooting

| Symptom | Cause |
|---|---|
| **"cannot connect to server"** for others | stale `dist` — Part 2 |
| `502 Bad Gateway` | window 1 or 2 not running |
| Site completely unreachable | window 3 not running |
| Dashboard loads, panels empty | same as row 1 |
| `blocked by CORS policy` | `WEB_ORIGIN` in `backend/.env`, restart backend |
| Login popup opens then closes | domain missing from Google Authorized JavaScript origins |
| Charts never move | `/socket.io/` rule missing in `config.yml` |
| F5 gives 404 | missing `-s` on `npx serve` |
| Everything `127.0.0.1` in History | `TRUST_PROXY` must be `1` |
| `failed to connect to the edge` | firewall blocking outbound TCP **7844** |
| Site dies after ~14 days | registrant email never verified — ICANN suspension |

Debug: `cloudflared tunnel run --loglevel debug cspc-monitoring`

---

# Which address goes where

| File | Setting | Value |
|---|---|---|
| `frontend/.env` | `VITE_API_URL` | `https://monitoring.cspc-ictu.stream` |
| `backend/.env` | `WEB_ORIGIN` | `https://monitoring.cspc-ictu.stream,…` |
| `backend/.env` | `TRUST_PROXY` | `1` |
| `~/.cloudflared/config.yml` | `service:` | `http://localhost:3000` / `:8080` |
| `agent.conf` (each server) | `API_URL` | `http://192.168.100.39:3000` |
| `secrets.h` (ESP32) | `BACKEND_HOST` | `192.168.100.39` |

**Browser → hostname. cloudflared → localhost. Hardware → LAN IP.**

Agents and the ESP32 stay on the LAN deliberately: collection, buzzing and alerting keep
working through an internet outage — only the dashboard goes dark.

⚠️ `TRUST_PROXY=1`, not the default 2. A tunnel is one hop. At 2 every visitor arrives as
`127.0.0.1` and the spare slot is filled by a header **they** control — so a visitor picks their
own rate-limit bucket and their own `system_logs.ip_address`, the row that *is* the evidence for
a Privacy Notice acceptance.

---

# Reference — the one-time setup (already done)

Kept for rebuilding on another machine.

| | |
|---|---|
| Domain | `cspc-ictu.stream`, Cloudflare Registrar |
| Tunnel | `cspc-monitoring` · ID `f8859a41-0eea-4c0c-a698-165335c802e7` |
| Credentials | `C:\Users\Mark Angelo\.cloudflared\` — `cert.pem`, `<ID>.json` (never commit) |

```powershell
cloudflared tunnel login                 # browser → pick cspc-ictu.stream → Authorize
cloudflared tunnel create cspc-monitoring
# write config.yml (below)
cloudflared tunnel route dns cspc-monitoring monitoring.cspc-ictu.stream
```

`C:\Users\Mark Angelo\.cloudflared\config.yml`:
```yaml
tunnel: f8859a41-0eea-4c0c-a698-165335c802e7
credentials-file: C:\Users\Mark Angelo\.cloudflared\f8859a41-0eea-4c0c-a698-165335c802e7.json

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
⚠️ Order matters — first match wins, catch-all last. Miss `/socket.io/` and the dashboard loads
but no chart ever updates.

Check: `cloudflared tunnel ingress validate`

**Google OAuth:** Console → Credentials → OAuth 2.0 Client ID → Authorized JavaScript origins →
add `https://monitoring.cspc-ictu.stream`. Keep `http://localhost:5173`. Redirect URIs stay
empty (the app uses `redirect_uri: "postmessage"`).

---

# Optional

**Start the tunnel on boot** — removes window 3:
```powershell
cloudflared service install
```

**Restrict who can open it:** Zero Trust → Access → Applications → Add → Self-hosted → domain
`monitoring.cspc-ictu.stream` → Allow / Include / Emails ending in `@cspc.edu.ph`. Free to 50
users. Add your panel's emails **before** the defense. Do not apply Access to `/api/` — it would
block the agents if they ever move off-LAN.

**Moving to the Linux server:** same steps; install via `.deb`, paths become `~/.cloudflared/`,
autostart is `sudo cloudflared service install && sudo systemctl enable --now cloudflared`. The
tunnel and DNS record already exist — only `config.yml` and the credentials file move.
