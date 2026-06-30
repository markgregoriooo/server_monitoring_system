# dev-snmpsim — fake Router + UPS for local development

Develop and test the **Router & UPS (SNMP) monitoring** without real hardware.
`snmpsim` runs on this PC and *pretends to be* a router and a UPS — it answers the exact
same SNMP OIDs the poller (`backend/services/snmpPollerService.js`) reads, so the backend
can't tell it's fake. Live throughput graphs, battery %, on-battery alerts — all work.

> **DEV ONLY.** On campus you delete these fake devices and add the real ones
> (`migrations/2026-06-12_router_ups_devices.sql`). Nothing here ships to production.

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

**Windows / PowerShell** — note the **back**slash in the path:

```powershell
snmpsim-command-responder --data-dir="dev-snmpsim\data" --agent-udpv4-endpoint=127.0.0.1:1161 --log-level=error
```

> ⚠️ Use a back-slash (`dev-snmpsim\data`) on Windows. A forward slash makes snmpsim try to
> write its index cache into a non-existent folder and crash with a `dbm` flag error.

macOS / Linux:

```bash
snmpsim-command-responder \
  --data-dir="dev-snmpsim/data" \
  --agent-udpv4-endpoint=127.0.0.1:1161 \
  --log-level=error
```

It prints `Listening at UDP/IPv4 endpoint 127.0.0.1:1161` and stays running.
(The `redis`/`sql` "load FAILED" lines are harmless — those are optional modules we don't use.)
Port **1161** is used instead of 161 so it needs no admin rights.

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

### 4. (Optional) sanity-check the simulator directly

```bash
cd dev-snmpsim && npm install && node verify.cjs
```

Prints the router + UPS values and shows the traffic counter increasing.

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
2. Fill in and run `migrations/2026-06-12_router_ups_devices.sql` with the real
   IPs / community strings / ports (real devices use port **161**).
3. Everything else (poller, pages, alerts) is identical — only the device rows change.

---

## Stop the simulator

`Ctrl-C` in its terminal.
