# Dev MikroTik Setup — for building Network Monitoring

> Goal: get the **small dev MikroTik** ready so the backend can connect to it over the
> **RouterOS API (read-only)** and we can build + live-test the feature end to end — without
> waiting on the campus questionnaire. See `mikrotik-monitoring.md` for the design.

What the monitoring backend needs from the router, and what each step here provides:

| The app needs | Provided by |
|---|---|
| A reachable IP for the router | Steps 1–2 |
| RouterOS version (v6/v7) | Step 2 |
| The **API service** enabled (port 8728) | Step 3 |
| A **read-only** login (username + password) | Step 4 |
| The port reachable from the backend host | Steps 5, 7 |
| The interface names (your test "buildings") | Step 6 |
| Values for the DB seed + `.env` | Step 8 |

> ⚠️ This is a **dev** box on a trusted LAN, so we keep it simple (plain API on 8728, no TLS).
> Production hardening (API-SSL/8729, firewalled to the backend only) is a go-live step, not this.

---

## What you need
- The dev MikroTik + its power adapter, and an Ethernet cable.
- A PC on the same network as the router (this will also run the backend).
- **WinBox** (easiest) — download from <https://mikrotik.com/download> (Windows). You can also use
  **WebFig** (browser) or **SSH** / the terminal — every step below shows the **CLI command**, which
  works the same in WinBox's *New Terminal*, WebFig's *Terminal*, or SSH.
  > **Prefer clicking to typing?** The next section is the **GUI equivalent** of every step — do
  > **either** the click‑path **or** the CLI, not both.

---

## WinBox / WebFig walkthrough (the GUI / click path)

> **WinBox** (desktop app) and **WebFig** (just browse to the router's IP, e.g.
> `http://192.168.88.1`) share the **same left‑hand menu tree**, so every click path here works in
> both. WebFig also has a **Terminal** link if you'd rather paste the CLI from the steps below.
> This mirrors **Steps 1–8** — pick one path.

**Connect — WinBox:** open WinBox → **Neighbors** tab → it lists the router → click its **MAC
address** (works even when the IP is unknown) → user `admin`, password blank → **Connect**. Newer
units may force you to set an admin password on first login, and may pop a *"RouterOS Default
Configuration"* notice (click **OK** to keep it). That admin password is **not** the monitoring
account — we make a separate read‑only user in Step 4.

**Connect — WebFig:** browse to **`http://192.168.88.1`** → log in as `admin`. You land on WebFig
with the same menus as below. (If asked to upgrade RouterOS, **skip** it for a dev box.)

| Step | Goal | Click path (WinBox / WebFig) | What to do |
|---|---|---|---|
| 2 | Version & identity | **System → Resources** | Read **Version** (v6/v7), **Board Name**, CPU, Memory, Uptime |
| 2 | Name the router | **System → Identity** | Set **Name** = `dev-mikrotik` → **OK/Apply** |
| 2 | See its IP | **IP → Addresses** | Note the address (e.g. `192.168.88.1`) |
| 3 | Enable the API | **IP → Services** | Select the **`api`** row → click the **✓ (Enable)** toolbar button. Double‑click `api` to confirm **Port = 8728** |
| 4 | Read‑only group | **System → Users → Groups** tab → **+** | Name `monitoring`; tick policies **read, api, rest-api, test, winbox** → **OK** |
| 4 | Read‑only user | **System → Users → Users** tab → **+** | Name `monitor-ro`; **Group** = `monitoring`; set a strong **Password** → **OK** |
| 5 | Lock API to backend | **IP → Services** → double‑click **`api`** | **Available From** → add `192.168.88.0/24` (or your backend host as `/32`) → **OK** |
| 6 | List interfaces | **Interfaces** | The `ether1…etherN` names = your test "buildings". Double‑click one → **Status** tab shows link **Rate** & state |
| 6 | Bridge check *(see prior note)* | **Bridge → Ports** tab | See which `etherN` sit in the factory **bridge**. Fine to leave for basic monitoring; **per‑building client counts** need separate subnets/DHCP (see *Optional* below) |
| — | DHCP leases (clients) | **IP → DHCP Server → Leases** tab | Bound leases = the "connected clients" the poller counts |

> **Step 7 (reachability)** is **not** done in WinBox — run it from the **backend PC**
> (`Test-NetConnection … 8728`, Step 7 below). **Step 8** is just writing down the values you read
> above for the DB seed + `.env`.

✅ **Sanity check after Steps 3 & 5:** in **IP → Services**, the `api` row shows **no `X`
(disabled) flag**, **Port 8728**, and your **Available From** address.

---

## Step 1 — Power on and connect
1. Plug the router in. Connect an Ethernet cable from your **PC** to one of the router's **LAN
   ports** (usually **not** `ether1` — that's typically the WAN/uplink port).
2. A factory-default MikroTik hands out DHCP on **`192.168.88.0/24`** and is reachable at
   **`192.168.88.1`**. Your PC should get a `192.168.88.x` address automatically.
3. Open **WinBox** → the **Neighbors** tab → it discovers the router (you can connect by **MAC**
   even if the IP is unknown). Default login is user **`admin`** with **no password** (newer units
   may have a password on a sticker / ask you to set one on first login).

> If it's not factory default and you don't know the IP: WinBox Neighbors (connect by MAC), or
> reset to defaults (hold the **RES** button while powering on until the LED flashes) — only if
> it's a throwaway dev box.

---

## Step 2 — Check the RouterOS version + identity
```rsc
/system resource print      ; shows version (v6 vs v7), board-name, cpu, memory, uptime
/system identity print      ; the router's name
/ip address print           ; its IP address(es)
```
- **Note the `version`** — `7.x` means we can also use the dependency-free REST API; `node-routeros`
  works for both, so either way you're fine.
- Give it a fixed identity so it's easy to spot: `/system identity set name=dev-mikrotik`.

---

## Step 3 — Enable the RouterOS API
The classic API listens on **TCP 8728** (8729 = API-SSL, needs a certificate — skip for dev).

**CLI:**
```rsc
/ip service print                 ; see which services are enabled
/ip service enable api            ; turn on the API on 8728
/ip service print                 ; confirm 'api' is no longer disabled (X)
```

**WinBox/WebFig:** **IP → Services** → select **`api`** → click **Enable** (the ✓). Leave port 8728.

---

## Step 4 — Create a read-only monitoring user
Never let monitoring use `admin`. Make a dedicated group with **read + api** only (no write), then a
user in it. `test` is for the ping tool (latency add-on later); `rest-api` lets you try the REST path.

```rsc
/user group add name=monitoring policy=read,api,rest-api,test,winbox \
  comment="read-only for CSPC monitoring"

/user add name=monitor-ro group=monitoring password="ChooseAStrongPasswordHere" \
  comment="CSPC monitoring (read-only)"
```
Verify it can read but not change:
```rsc
/user print                        ; monitor-ro should be in group 'monitoring'
```
> Why these policies: `read` + `api` is the minimum the poller needs. `!write`/`!policy` are
> implied (not granted). With this account a leaked password can only **read** status.

---

## Step 5 — (Recommended) restrict the API to the backend host
Lock the API so only your backend PC can talk to it:
```rsc
/ip service set api address=192.168.88.0/24      ; or a single host, e.g. 192.168.88.50/32
```
Replace with your backend host's IP/subnet. (You can widen this later; on a dev LAN the subnet is fine.)

---

## Step 6 — List the interfaces (your test "buildings")
Each building = one port. For dev, the physical ports stand in for buildings.
```rsc
/interface print                   ; the names: ether1, ether2, sfp1, ...
/interface ethernet print          ; link speed / state per port
```
Write down the names — these go in `network_interfaces` as `interface_name`, each labeled with a
fake building (e.g. `ether2` → "Test Building A"). Ports with nothing plugged in just show **link
down / zero traffic**, which is fine for development; plug a device into one to see real throughput.

---

## Step 7 — Verify the backend host can reach the API
From the **backend PC** (PowerShell):
```powershell
Test-NetConnection 192.168.88.1 -Port 8728      ; TcpTestSucceeded : True  = good
```
(Use the router's real IP.) If it fails: check Step 3 (api enabled), Step 5 (address restriction),
and any firewall on the router (`/ip firewall filter print`) or the PC.

> A full RouterOS-login test happens once the collector exists (Phase 2). This just confirms the
> port is open.

---

## Step 8 — Record the values for the app
Plug these into the **dev seed** in `migrations/2026-06-20_mikrotik_device.sql` (uncomment the
template) and into `backend/.env`:

**DB seed (dev):**
| Field | Dev value |
|---|---|
| `devices.ip_address` | the router IP (e.g. `192.168.88.1`) |
| `devices.device_name` | `dev-mikrotik` |
| `devices.device_type` | `mikrotik` |
| `devices.location` | `Dev Bench` |
| `mikrotik_devices.api_port` | `8728` |
| `mikrotik_devices.use_tls` | `0` |
| `mikrotik_devices.api_username` | `monitor-ro` |
| `network_interfaces` rows | `ether2`→"Test Building A", `ether3`→"Test Building B", … |

**`.env`:** add the encryption key the app uses to store the API password (32-byte hex):
```
MIKROTIK_ENC_KEY=<run: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
MIKROTIK_POLL_INTERVAL_MS=30000
```
> The **password** isn't seeded as plaintext — you'll enter it once via the dashboard admin form
> (Phase 3), which encrypts it with `MIKROTIK_ENC_KEY` before storing in `api_password`. For an
> early Phase-2 bring-up before that form exists, we'll add a tiny one-off encrypt helper.

---

## Optional — simulate multiple buildings on one router
For dev you usually don't need this (physical ports = buildings is enough). If you want to test
**per-building client counts**, give two ports their own subnet + DHCP server so leases group per
"building":
```rsc
/ip address add address=10.10.2.1/24 interface=ether2
/ip pool add name=bldgA ranges=10.10.2.10-10.10.2.100
/ip dhcp-server add name=dhcpA interface=ether2 address-pool=bldgA disabled=no
/ip dhcp-server network add address=10.10.2.0/24 gateway=10.10.2.1
```
Repeat on `ether3` with `10.10.3.0/24` for a second building. Plug a laptop/phone into each to get
DHCP leases the poller can count per building.

---

## Security notes (dev vs production)
- **Dev:** plain API (8728) on a trusted LAN, address-restricted to the backend, read-only user. Fine.
- **Production (campus MikroTik, later):** prefer **API-SSL (8729)** with a certificate, firewall
  the API to the backend host only, and again a **read-only** user. Captured in the questionnaire.

---

## Quick troubleshooting
| Symptom | Check |
|---|---|
| Can't find the router | WinBox **Neighbors** (connect by MAC); confirm cable in a LAN port |
| `Test-NetConnection … 8728` fails | `/ip service print` (api enabled?), `/ip service` address restriction (Step 5), router/PC firewall |
| Login refused for `monitor-ro` | `/user print` (right group?), retype password; group has `api` policy |
| Want the REST API instead (v7) | enable `www-ssl` + use `https://<ip>/rest`; `rest-api` policy already granted in Step 4 |
