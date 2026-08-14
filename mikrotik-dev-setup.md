# Dev MikroTik Setup — for building Network Monitoring

> Goal: get the **small dev MikroTik** ready so the backend can connect to it over the
> **RouterOS API (read-only)** and we can build + live-test the feature end to end. See
> `mikrotik-monitoring.md` for the design, and **`deploy-mikrotik-setup.md`** for the real
> campus router.

**Everything on the router is done by clicking in WinBox.** No terminal, no commands. The only
things you type are on your own PC (a PowerShell check in Step 7) — those aren't router config.

What the monitoring backend needs, and which step provides it:

| The app needs | Provided by |
|---|---|
| All LAN ports on one network (**only** after a no-defaults reset) | Step 1b |
| A reachable IP for the router | Steps 1–2 |
| RouterOS version (v6 / v7) | Step 2 |
| The **API service** enabled (port 8728) | Step 3 |
| A **read-only** login | Step 4 |
| The port reachable from the backend PC | Steps 5, 7 |
| The port names (your test "buildings") | Step 6 |
| Values for the dashboard + `.env` | Step 8 |

> ⚠️ This is a **dev** box on a trusted LAN, so we keep it simple: plain API on 8728, no TLS.
> Encryption, certificates and firewalling are **campus** work — see `deploy-mikrotik-setup.md`.

---

## What you need

- The dev MikroTik, its power adapter, and an Ethernet cable.
- A PC on the same network as the router (this also runs the backend).
- **WinBox** — download from <https://mikrotik.com/download>.
  *WebFig* (just browse to the router's IP) has the identical menu tree, so every click path
  below works there too.

---

## Step 1 — Power on and connect

1. Plug the router in. Connect an Ethernet cable from your **PC** to one of the router's **LAN
   ports** — usually **not** `ether1`, which is normally the WAN/uplink.
2. A factory-default MikroTik hands out DHCP on `192.168.88.0/24` and answers at
   **`192.168.88.1`**. Your PC should get a `192.168.88.x` address automatically.
3. Open **WinBox** → **Neighbors** tab → the router appears in the list.
4. Click its **MAC address** (this works even when you don't know the IP).
5. **Login:** `admin`, password blank → **Connect**.

Newer units may make you set an admin password on first login, and may show a *"RouterOS Default
Configuration"* notice — click **OK** to keep it.

> That admin password is **not** the monitoring account. We create a separate read-only user in
> Step 4.

**Can't find it?** Use **Neighbors** and connect by MAC. If it's not factory-default and you don't
know the login, hold the **RES** button while powering on until the LED flashes to reset — only do
this on a throwaway dev box.

> **PC got `169.254.x.x` and the router has no IP?** It was reset with **No Default Configuration** —
> there's no bridge. Do **Step 1b** first; everything after it assumes the router answers at an IP.

---

## Step 1b — Only if you reset *without* default configuration

Skip on a factory-default router. A **No Default Configuration** reset leaves no bridge, no IP, no
DHCP — so yes, **you build the bridge yourself.** Connect by MAC (**Neighbors** → click the MAC →
`admin`, blank password), then:

1. **Bridge → Bridge** tab → **+** → **Name:** `bridge1` → **OK**
2. **Bridge → Ports** tab → **+** → **Interface:** `ether2`, **Bridge:** `bridge1` → **OK**.
   Repeat for `ether3`, `ether4`, … — **leave `ether1` out** (that's the uplink).
3. **IP → Addresses → +** → **Address:** `192.168.88.1/24`, **Interface:** `bridge1` → **OK**
4. **IP → DHCP Server → DHCP Setup** → **Interface:** `bridge1` → **Next** through every screen →
   **Setup**. Replug your PC's cable to get a lease.
5. **System → Users → Users** → double-click `admin` → **Password** → set one → **OK**
6. *Optional, for internet:* **IP → DHCP Client → +** → **Interface:** `ether1` → **OK**, then
   **IP → Firewall → NAT → +** → **Chain** `srcnat`, **Out. Interface** `ether1`, *Action* tab →
   `masquerade` → **OK**

✅ Router answers at `192.168.88.1` — the factory address, so the rest of this guide reads the same.

> WinBox may drop when your port joins the bridge — reconnect by MAC.
> No-defaults also means **no firewall**, which is why step 5 isn't optional.

---

## Step 2 — Check the version and name it

**System → Resources**

Read and write down:

| Field | Why it matters |
|---|---|
| **Version** | `6.x` or `7.x` — v7 also offers a REST API; either works |
| **Board Name** | e.g. `RB951G-2HnD` |
| **Uptime / CPU / Memory** | these are what the dashboard tiles will show |

**System → Identity**

Set **Name** to `dev-mikrotik` → **OK**. Makes it obvious which router you're on.

**IP → Addresses**

Note the address, e.g. `192.168.88.1`. A router has **one address per network it touches**, so you
may see two — the LAN one (`192.168.88.1`) and, if `ether1` is plugged into another network, a
second one from that network's DHCP.

> Use whichever address your **backend PC** can reach.

---

## Step 3 — Enable the API

**IP → Services**

1. Find the **`api`** row (disabled by default — it shows an `X`).
2. Click it once to select.
3. Click the **✓ (Enable)** button in the toolbar.
4. Double-click the row and confirm **Port = 8728** → **OK**.

✅ The `X` should be gone.

> `api-ssl` (8729) is the encrypted version. It needs a certificate — skip it on the bench.

---

## Step 4 — Create a read-only monitoring user

Never let monitoring log in as `admin`. A leaked read-only password can only *look* at things.

### 4a · The group

**System → Users → Groups** tab → **+**

- **Name:** `monitoring`
- **Policies:** tick **read**, **api**, **rest-api**, **test**, **winbox**
- Leave **write**, **policy** and everything else **unticked**
- **OK**

### 4b · The user

**System → Users → Users** tab → **+**

- **Name:** `monitor-ro`
- **Group:** `monitoring`
- **Password:** a strong one — you'll type it into the dashboard once
- **OK**

✅ The Users list shows `monitor-ro` with group `monitoring`.

> **read** + **api** is the minimum the poller needs. `test` is for a future ping/latency feature;
> `rest-api` lets you try the v7 REST path.

---

## Step 5 — Restrict the API to your backend PC

**IP → Services** → double-click **`api`**

In **Available From**, click **+** and add your backend PC's address:

- A single machine: `192.168.88.50/32`
- Or the whole dev subnet: `192.168.88.0/24`

**OK**.

> ⚠️ If your PC can reach the router from **two** networks (e.g. cable on one, WiFi on another),
> add **both**, or polling breaks the moment you switch. Leaving this empty allows everything.

---

## Step 6 — List the ports

**Interfaces**

The `ether1 … etherN` names are your test "buildings". Write them down — they go into the port
label editor later.

Double-click any port → **Status** tab shows the link **Rate** and whether it's up.

**Bridge → Ports** tab shows which ports sit in the bridge — the factory one, or the one you built
in Step 1b. That's fine for basic monitoring; it only matters for per-port client counts (see
*Optional* below).

**IP → DHCP Server → Leases** tab — bound leases are the "DHCP leases" figure the dashboard shows.

> Ports with nothing plugged in show **link down** and zero traffic. That's correct, not a fault.
> Plug a laptop into one to see real numbers.

---

## Step 7 — Check the backend PC can reach it

This one is **not** in WinBox — run it on the **backend PC** in PowerShell:

```powershell
Test-NetConnection 192.168.88.1 -Port 8728
```

`TcpTestSucceeded : True` = good.

**If it fails:** re-check Step 3 (is `api` enabled?), Step 5 (does Available From include this PC?),
and any firewall on the PC itself.

---

## Step 8 — Add it to the dashboard

You don't need SQL. In the dashboard, go to **MikroTik → + Add MikroTik**:

| Field | Dev value |
|---|---|
| Name | `dev-mikrotik` |
| IP address | the router IP from Step 2 |
| Location | `Dev Bench` |
| API Port | `8728` |
| Use TLS | **unticked** |
| Username | `monitor-ro` |
| Password | the one from Step 4b |

Click **Test connection** first — it verifies the login **without saving anything**. A green
`OK — RouterOS …` means everything above is right. Then **Add MikroTik**.

**`backend/.env`** needs one key so the password can be stored encrypted:

```
MIKROTIK_ENC_KEY=<64 hex characters>
MIKROTIK_POLL_INTERVAL_MS=30000
```

Generate the key on the backend PC:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> ⚠️ **Keep this key.** The API password is encrypted with it. Change the key and the stored
> password silently becomes unreadable — the poller then logs in with a blank password and you get
> "Username or password is invalid" while the RouterOS account is perfectly fine.

### Label the ports

Open the router → **View** → **Ports** panel → **Edit labels** (admin only). Name each port by what
it connects to. Blank leaves the raw RouterOS name.

---

## Optional — simulate multiple buildings

Only needed if you want to test **per-port DHCP lease counts**. Give two ports their own subnet and
DHCP server so leases can be attributed per port. All in WinBox:

> First, **take those ports out of the bridge** — **Bridge → Ports** → select the `ether2` /
> `ether3` rows → **−**. A port in a bridge has no address of its own; the bridge owns the network,
> which is exactly why lease counts can't be attributed per port on a flat bridge.

**For `ether2`:**

1. **IP → Addresses → +** — Address `10.10.2.1/24`, Interface `ether2` → **OK**
2. **IP → Pool → +** — Name `bldgA`, Addresses `10.10.2.10-10.10.2.100` → **OK**
3. **IP → DHCP Server → DHCP** tab → **+** — Name `dhcpA`, Interface `ether2`,
   Address Pool `bldgA` → **OK**
4. **IP → DHCP Server → Networks** tab → **+** — Address `10.10.2.0/24`,
   Gateway `10.10.2.1` → **OK**

Repeat for `ether3` with `10.10.3.0/24`. Plug a laptop or phone into each, and the dashboard's
per-port **Leases** column fills in.

> On a single flat bridge every lease belongs to the bridge, so the per-port column shows `—`.
> That's correct — it means "can't be attributed", not "nothing connected".

---

## Security note

This is a **dev** setup: plain API on 8728, address-restricted, read-only user. Fine on a bench
where you're the only one who could listen.

**Do not deploy this way.** On campus the password would cross a network shared with thousands of
devices. See **`deploy-mikrotik-setup.md`** for the hardened setup.

---

## Quick troubleshooting

| Symptom | Check |
|---|---|
| Can't find the router | WinBox **Neighbors** (connect by MAC); is the cable in a LAN port, not `ether1`? |
| PC gets `169.254.x.x`, router has no IP, **IP → Addresses** empty | The router was reset with **No Default Configuration** — there's no bridge and no DHCP server. Do **Step 1b** |
| Two laptops on two ports can't see each other | Same cause — the ports aren't bridged. **Bridge → Ports** should list them (Step 1b-2) |
| `Test-NetConnection … 8728` fails | **IP → Services**: `api` enabled? **Available From** includes this PC? PC firewall? |
| Test connection says invalid password | **System → Users**: is `monitor-ro` in group `monitoring`, and does that group have the **api** policy? Also check `MIKROTIK_ENC_KEY` hasn't changed |
| Router shows Offline, backend logs a reason | The reason is printed — `[MIKROTIK_POLLER] poll failed for …`. Read it before changing anything |
| More ports listed than the router has | Fixed — the poller filters to physical ethernet only, so `bridge` / `wlan1` no longer appear |
| Ports show `—` for Leases | Expected on one flat bridge. See *Optional* above |
