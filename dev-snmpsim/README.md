# dev-snmpsim — fake Router + UPS for local development

Develop and test the **Router & UPS (SNMP) monitoring** without real hardware.
`snmpsim` runs on this PC and *pretends to be* a router and a UPS — it answers the exact
same SNMP OIDs the poller (`backend/services/snmpPollerService.js`) reads, so the backend
can't tell it's fake. Live throughput graphs, battery %, on-battery alerts — all work.

> **DEV ONLY.** On campus you delete these fake devices and add the real ones from the
> dashboard (**Add router** / **Add UPS**). Nothing here ships to production.

---

## What's in here

| File | What it is |
|------|------------|
| `data/dev-router.snmprec` | the fake **router**'s answers (IF-MIB: interfaces, traffic counters, link speed) |
| `data/dev-ups.snmprec`    | the fake **UPS**'s answers (UPS-MIB: battery %, runtime, load, output source) |
| `seed-dev-devices.sql`    | registers both fake devices in MySQL so the poller picks them up |
| `verify.cjs`              | quick standalone SNMP check that the simulator is answering |

The simulator serves a **different data file per community string**:
`dev-router` → `data/dev-router.snmprec`, `dev-ups` → `data/dev-ups.snmprec`.

---

## One-time setup (already done on this machine)

```bash
pip install snmpsim-lextudio            # the SNMP simulator
```

---

## How to use it (every dev session)

### 1. Start the simulator  (leave this terminal running)

**Use this — it works from any shell, on any machine, with nothing to fill in:**

```bash
cd dev-snmpsim
npm start
```

`npm` always runs a script with the cwd set to the folder holding `package.json`, so the
data directory resolves correctly every time. **Prefer this over typing the raw command** —
every path problem below stops existing.

<details>
<summary>Raw command (only if you can't use npm)</summary>

```powershell
snmpsim-command-responder --data-dir="<absolute path to>\dev-snmpsim\data" --agent-udpv4-endpoint=127.0.0.1:1161 --log-level=error
```

⚠️ **`<absolute path to>` is a placeholder — substitute your real path.** Pasting it
verbatim gives a directory that doesn't exist, and snmpsim will still print
`Listening at UDP/IPv4 endpoint…` and still bind the port. It just has no data, so every
request **times out** and the dashboard shows the devices Offline as if the simulator
were dead. See the troubleshooting note below.

</details>

It prints `Listening at UDP/IPv4 endpoint 127.0.0.1:1161` and stays running.
Port **1161** is used instead of 161 so it needs no admin rights.

#### ✅ These two lines are NOT errors — ignore them

```
ERROR Variation module "redis" … load FAILED: Redis connect parameters not specified
ERROR Variation module "sql"   … load FAILED: database type not specified
```

Optional snmpsim plugins we don't use, and it says `ERROR` for both on every single start.
The only line that matters is `Listening at UDP/IPv4 endpoint 127.0.0.1:1161`.
(You'll also see a `pysnmp-lextudio is deprecated` warning — likewise harmless.)

#### 🔍 Troubleshooting: it says "Listening" but the dashboard shows Offline

**A bound port is not proof it's answering.** `npm run verify` is the real test. snmpsim
prints `Listening…` and binds the port even when it has nothing to serve, so these two
failures look identical to a healthy start:

| Cause | How to confirm | Fix |
|---|---|---|
| **`--data-dir` doesn't resolve** (placeholder path left in, or a relative path run from the wrong folder) | the folder in the command doesn't exist | use `npm start` |
| **Two responders running** — the second can't bind and the first can wedge | `Get-CimInstance Win32_Process -Filter "Name like '%python%'"` → more than one `snmpsim` line | kill all, start one |

> On Windows check the port with `Get-NetUDPEndpoint -LocalPort 1161` — SNMP is **UDP**, so
> `Get-NetTCPConnection` will never show it no matter how healthy the simulator is.

If you do run the raw command with a relative path, use a **back**slash on Windows
(`dev-snmpsim\data`) — a forward slash makes snmpsim write its index cache into a
non-existent folder and crash with a `dbm` flag error.

### 2. (First time only) tell the backend about the fake devices

```bash
mysql -u <user> -p <db_name> < dev-snmpsim/seed-dev-devices.sql
```

### 3. Start the backend + frontend as usual

```bash
cd backend  && npm install && nodemon src/server.js   # npm install: net-snmp may be missing
cd frontend && npm run dev
```

Within ~60s the poller polls the simulator and the **Network** and **UPS** dashboard
pages light up with live data.

### 4. Sanity-check that it's actually answering

```bash
cd dev-snmpsim && npm run verify
```

Prints the router + UPS values and shows the traffic counter increasing. Worth running
whenever the dashboard looks wrong — it distinguishes "simulator is dead" from "backend
isn't polling" in one command. (First time only: `npm install` for the `net-snmp` dep.)

---

## Simulating failures (the fun part)

Edit the `.snmprec` files — **no restart needed**, the simulator re-reads per request.

| To test… | Edit | Change |
|----------|------|--------|
| **UPS on battery** (critical alert) | `data/dev-ups.snmprec` | `…33.1.4.1.0` from `3` → `5` (battery) |
| **UPS low battery** (warning alert) | `data/dev-ups.snmprec` | `…33.1.2.4.0` from `100` → `15` (under 20%) |
| **Interface down** | `data/dev-router.snmprec` | `…2.2.1.8.2` from `1` → `2` (down) |
| **Device unreachable / offline** | — | just **stop the simulator** (Ctrl-C); poller flips it Offline |
| **Higher traffic / utilization** | `data/dev-router.snmprec` | raise `rate=` on the `…1.1.6.x` / `…1.1.10.x` counter lines |

> The counter lines use snmpsim's `numeric` variation module (`70:numeric|initial=…,rate=…`)
> so the byte counters keep increasing over time → real throughput. `rate` is **bytes/sec**.

---

## Switching to real campus devices later

1. Stop using this — `DELETE FROM devices WHERE location = 'DEV - snmpsim';`
2. Register the real devices from the dashboard (**Add router** / **Add UPS**, admin) with
   their IPs / community strings / ports (real devices use port **161**).
3. Everything else (poller, pages, alerts) is identical — only the device rows change.

---

## Stop the simulator

`Ctrl-C` in its terminal.
