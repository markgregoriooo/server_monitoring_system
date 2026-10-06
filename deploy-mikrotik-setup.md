# Campus MikroTik Deployment — go-live setup

> The hardened setup for the **real campus router**. `mikrotik-dev-setup.md` is the bench version;
> this replaces its shortcuts with encryption, a certificate, and a locked-down API.

**Everything on the router is done by clicking in WinBox.** No terminal, no commands. The only
things you type are on the backend PC (PowerShell checks and `.env`) — those aren't router config.

> ⚠️ This router carries **all building traffic**. A wrong firewall rule can cut the campus off, or
> lock you out of the router itself. Read §0 before touching anything.

> **The campus router is already configured and running** — bridges, addressing, DHCP and firewall
> are ICTU's, already in place. **Never reset it**, and don't touch its L2/L3 config. Everything
> below is *additive*: one read-only user, one certificate, one service, two firewall rules. That's
> why there's no bridge step here — that's `mikrotik-dev-setup.md` Step 1b, for a wiped bench box.

---

## 0 · Before you start

### 0.1 What's different from the bench

| | Dev bench | Campus |
|---|---|---|
| API port | 8728, plain | **8729, encrypted (API-SSL)** |
| Certificate | none | **required** |
| Who may connect | a whole subnet | **the backend's single IP** |
| Traffic | idle, 0% | real — utilization and error alerts actually fire |
| Mistakes | unplug and retry | can disrupt the campus |

### 0.2 The trap that will cost you an afternoon

The API password is encrypted with **`MIKROTIK_ENC_KEY`** from `backend/.env`. If the production
backend has a **different key** than the one used when the password was saved, decryption fails
**silently** — the poller logs in with an empty password and reports:

```
poll failed for Campus MikroTik: Username or password is invalid
```

You will blame the RouterOS account. The account will be fine.

**Pick one:**

- **Carry the same `MIKROTIK_ENC_KEY`** across to the production `.env`, or
- Use a **fresh key** and **re-enter the password** in the dashboard's Configure modal so it gets
  re-encrypted with the new one.

Never move the database to a new host with a new key and expect stored passwords to work.

### 0.3 Have a way back in

Before changing services or firewall rules:

- Keep a **WinBox session already connected** — if you lock yourself out, that session usually keeps
  working, and you can undo.
- Know the **MAC-address connect** path (WinBox → **Neighbors** → click the MAC). It works even when
  IP access is broken.
- Do this in a **maintenance window**.

---

## 1 · Connect and check the version

**System → Resources**

| Field | Note it down |
|---|---|
| **Version** | v6 or v7 — see below |
| **Board Name** | the model |

**Why the version matters:** on **RouterOS 6.43.x**, `/interface/print` rejects the `stats`
attribute, and the poller falls back to a plain print (already handled in code). On **v7** the
primary path works, and the dependency-free REST API becomes an option.

**System → Identity** — set **Name** to something unambiguous, e.g. `cspc-core-mikrotik`.

**IP → Addresses** — note which address the **backend host** can reach. A core router has several.

---

## 2 · Create the read-only monitoring user

Same as the bench, and just as important here.

**System → Users → Groups** tab → **+**

- **Name:** `monitoring`
- **Policies:** tick **read**, **api**, **rest-api**, **test**, **winbox** — nothing else
- **OK**

**System → Users → Users** tab → **+**

- **Name:** `monitor-ro`
- **Group:** `monitoring`
- **Password:** strong, and different from the bench password
- **OK**

> Never point monitoring at `admin`. With **read** only, a leaked password can look but not touch.

---

## 3 · Create the certificate

API-SSL will not start without one. This is where people get stuck, so follow the order exactly.

The certificate is **self-signed**. That encrypts the connection but doesn't prove the router's
identity — and proving identity would only matter against something impersonating the router on the
wire between it and the backend, a path §4's `/32` *Available From* and §5's single-source firewall
rule already narrow to one host on the management segment. A private CA buys that last increment for
a two-stage chain, an exported `.crt` to keep in sync on the backend host, and a second certificate
to keep alive. Not worth it here. If the backend and router ever end up on opposite sides of a
building link, a shared VLAN or a WAN hop, revisit that.

**System → Certificates**

If a half-made `api-cert` is left over from an earlier attempt, select it and click **–** (Remove)
first. A duplicate name is one of the ways this step fails.

**Click + (Add New)** and fill in the **General** tab:

| Field | Value |
|---|---|
| **Name** | `api-cert` |
| **Common Name** | the router's IP or DNS name — **must match what the backend connects to** |
| **Key Size** | `2048` |
| **Days Valid** | `3650` |

**Key Usage** tab — untick everything, then tick exactly these four:

- **digital signature**
- **key encipherment**
- **tls server**
- **key cert. sign** ← the one everybody misses

Click **OK**.

> ⚠️ **`key cert. sign` is not optional here.** A self-signed certificate signs *itself*, so it has
> to be a certificate authority. Leave that box unticked and RouterOS has no signing capability to
> apply, so **Sign** fails with **`Starting error: CA not found`** — a misleading message for a
> missing *capability*, not a missing certificate. An empty CA field is correct and is never the
> cause.
>
> **tls client** is harmless if you tick it too, but unnecessary — for API-SSL the router is the
> TLS *server*.

**Now sign it.** Select the `api-cert` row → click **Sign** in the toolbar:

- **CA:** leave **empty** — that means "sign it with itself"
- **Start**

Wait for it to finish — a minute or two on a small board is normal.

✅ The row now shows flags **`KAT`**:

| Flag | Meaning |
|---|---|
| **K** | has a private key — API-SSL is useless without one |
| **A** | it's a certificate authority — expected, it signed itself |
| **T** | trusted |

---

## 4 · Turn on API-SSL

**IP → Services** → double-click **`api-ssl`**

- **Port:** `8729`
- **Certificate:** `api-cert`
- **Available From:** **+** → the backend's address as a **`/32`**, e.g. `10.20.30.40/32`
- **OK**, then click **✓ (Enable)**

Then **disable the plain API**: select the **`api`** row → click **✗ (Disable)**.

✅ `api-ssl` shows no `X` and has a certificate. `api` shows an `X`.

> ⚠️ A blank **Certificate** field is a silent killer — the service looks enabled and refuses every
> connection.

---

## 5 · Firewall the API

Two independent layers. §4's *Available From* is the first; this is the second, so the port is
*unreachable* rather than merely refused.

**IP → Firewall → Filter Rules** tab

### 5.1 Allow the backend

**+** (Add New)

- **General** tab — **Chain:** `input`, **Protocol:** `tcp`, **Dst. Port:** `8729`
- **General** tab — **Src. Address:** the backend IP, e.g. `10.20.30.40`
- **Action** tab — **Action:** `accept`
- **Comment:** `monitoring API-SSL`
- **OK**

### 5.2 Block everyone else

**+** again

- **General** tab — **Chain:** `input`, **Protocol:** `tcp`, **Dst. Port:** `8728,8729`
- **Action** tab — **Action:** `drop`
- **Comment:** `block API from everywhere else`
- **OK**

### 5.3 Order matters — drag them

Firewall rules run **top to bottom**, and the first match wins. If the drop sits above the accept,
your backend is blocked too.

In the Filter Rules list, **drag the `accept` rule above the `drop` rule**. Confirm by eye: accept
first, drop second.

> This drag-and-drop replaces the `place-before` you'd use in a terminal.

⚠️ **Check the rules that were already there, not just your two.** A campus router has an existing
input chain, and RouterOS's own default config ends it with a **drop** that catches anything not
explicitly allowed. If that drop sits **above** your accept, your accept never runs and the poller
is blocked — with both of your new rules in the correct order relative to each other.

Read the whole `input` chain top to bottom and make sure **`monitoring API-SSL` is above every
`drop` in it**, not merely above the one you just added. Drag it up until it is.

> A rule that never runs shows **0 B / 0 packets** in the **Bytes** and **Packets** columns. After
> the poller has been running a minute, your accept rule must show a non-zero count. Zero means
> something above it is matching first — that column is the fastest way to prove the ordering is
> right, and it's how you tell "firewall is blocking me" apart from "the API is misconfigured".

---

## 6 · Configure the backend

`backend/.env`:

```
MIKROTIK_ENC_KEY=<same key as before, or re-enter the password after changing it>
MIKROTIK_POLL_INTERVAL_MS=30000
MIKROTIK_API_TIMEOUT_MS=5000
```

That's all three. **Leave `MIKROTIK_TLS_VERIFY` unset** — it defaults to off, which is what a
self-signed certificate needs. Setting it to `true` makes the backend demand a chain the router
can't present, and every poll fails on a certificate error.

**Restart the backend** after editing `.env`.

---

## 7 · Register it in the dashboard

**MikroTik → + Add MikroTik**

| Field | Value |
|---|---|
| Name | `CSPC Campus MikroTik` |
| IP address | the address from §1 |
| Location | where it physically is |
| **Use TLS** | **ticked** — the API Port switches to **8729** automatically |
| Username | `monitor-ro` |
| Password | from §2 |

**Check the API Port really says 8729 before saving.** Ticking the box moves it, but confirm — TLS
sent to port 8728 just hangs until it times out.

Click **Test connection** first. Nothing is saved by that button, so a wrong password costs you
nothing. Green `OK — RouterOS …` means everything above is right.

### Label the ports

Open the router → **View** → **Ports** panel → **Edit labels**. Name each port by the building or
link it serves. These labels show throughout the dashboard and in alert messages, so
"Interface Engineering Building is down" reads better than "Interface ether4 is down".

---

## 8 · Verify

From the **backend host**:

```powershell
Test-NetConnection <router-ip> -Port 8729   # TcpTestSucceeded : True
Test-NetConnection <router-ip> -Port 8728   # should FAIL — plain API is off
```

From **any other machine**, both should fail. If 8729 answers from elsewhere, your accept rule is
below the drop rule — go back to §5.3.

Then watch the dashboard for one poll cycle (~30s). The router should go **Online** and ports
should populate.

If it doesn't, **read the backend console** — the reason is printed:

```
[MIKROTIK_POLLER] poll failed for CSPC Campus MikroTik (<ip>): <reason>
```

| Reason | Meaning |
|---|---|
| `Timed out after 5 seconds` | Speaking TLS to a non-TLS port — check the port is 8729 |
| `Username or password is invalid` | Wrong credentials **or** a changed `MIKROTIK_ENC_KEY` (§0.2) |
| certificate error | `MIKROTIK_TLS_VERIFY=true` is set somewhere — it must be unset for a self-signed certificate (§6) |

---

## 9 · Tune the alert thresholds

Bench values were guesses against an idle network. Now they matter.

**Alert Rules** page (admin). Scope the campus router and set per-port thresholds where the ports
differ — an ISP uplink that normally runs at 70% and an access port that should never exceed 5%
can't share one number:

| Scope | Metric | Suggested |
|---|---|---|
| Router · *All ports* | Link utilization | `>= 80` warning |
| Router · uplink port | Link utilization | `>= 90` warning, `>= 97` critical |
| Router · access ports | Link utilization | `>= 40` warning |
| Router · *All ports* | Link errors | `>= 10` warning, `>= 100` critical |
| Router | Router CPU / memory | `>= 85` warning, `>= 95` critical |

These rules ship pre-seeded in `v13_cspc-ictu-monitoring-system.sql`. Alerting is rules-only, so
if one has been deleted on the Alert Rules page, that metric stays silent.

---

## 10 · Go-live checklist

**Router**
- [ ] Dedicated `monitor-ro` user in a **read + api** group — no write, no policy
- [ ] `admin` not used by monitoring
- [ ] Certificate signed, showing the `K` flag, attached to `api-ssl`
- [ ] `api-ssl` enabled on 8729
- [ ] Plain `api` (8728) **disabled**
- [ ] `Available From` on `api-ssl` = backend `/32`
- [ ] Firewall accept rule **above** the drop rule
- [ ] A working way back in (WinBox session / MAC connect) confirmed

**Backend**
- [ ] `MIKROTIK_ENC_KEY` matches the one the password was saved with, **or** password re-entered
- [ ] `MIKROTIK_TLS_VERIFY` **not set** — a self-signed certificate can't satisfy it (§6)
- [ ] Both alert-rule migrations applied
- [ ] Backend restarted after the `.env` change
- [ ] Router shows **Online** and ports populate
- [ ] Ports labelled
- [ ] Thresholds tuned for real traffic

**Verified**
- [ ] 8729 reachable **only** from the backend
- [ ] 8728 unreachable from everywhere
- [ ] **Test connection** passes

---

## Rollback

If monitoring breaks the router or you run out of window:

1. **IP → Services** — enable **`api`**, disable **`api-ssl`**
2. Dashboard → **Configure** → untick **Use TLS**, confirm the port drops back to **8728** → Save
3. **IP → Firewall → Filter Rules** — disable your two new rules (select → **✗**) rather than
   deleting them, so you can re-enable next window

Monitoring resumes unencrypted. Not ideal, but working — and nothing about the campus network
itself is affected either way.
