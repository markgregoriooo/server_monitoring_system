# Router & UPS Monitoring — CSPC-ICTU Monitoring

Monitoring for the two remaining server-room data sources in the architecture diagram:
**(C) other routers** (the non-MikroTik network gear) and **(D) UPS units**. Both are read
**over the LAN via SNMP** — nothing is installed *on* the device.
Branch: `router-ups-monitoring`.

> ⚠️ **SNMP-only (no NUT).** A UPS must have a **network / SNMP card** to be monitored — a
> USB-/serial-only UPS is **out of scope** (it would need an SNMP card added first). Routers
> still use **ICMP ping** as a complement for reachability / latency / packet-loss — that's not
> a separate stack, just a ping.

> ✅ **Scope (confirmed with client):** UPS monitoring is **monitor-and-alert only** — the
> system never takes automated action on a power event (no automatic server shutdown). It
> observes, records to InfluxDB, and raises alerts; humans decide what to do.

> 🧭 **Status: IMPLEMENTED (poller + APIs + pages + add/remove UI).** The poller, handlers,
> read routes, and the two dashboard pages are built (`node --check` / `tsc` clean; see §8 /
> SESSION_NOTES SESSION 10). **Devices can now be registered from the dashboard** — the Network
> and UPS pages have an admin-only **"Add router" / "Add UPS"** button (`POST /api/network`,
> `POST /api/ups`) plus a per-device **Remove** (`DELETE`), so hand-writing the
> `migrations/2026-06-12_router_ups_devices.sql` seed is no longer required (the SQL template
> stays as an alternative / for bulk seeding). The poller picks up a newly added device on its
> next cycle (≤ `SNMP_POLL_INTERVAL_MS`, ~60s) with **no restart**. What's left is a live
> end-to-end test against a real SNMP target. MikroTik router monitoring (data source **B**) is
> explicitly **out of scope here** and handled separately.

> 📖 **New to this?** Read §1–§3 for the concept and the one decision that drives everything,
> then §4 (what we read) and §5 (how it fits the current system).

---

## 1. What it is (in one paragraph)

Network gear and UPS units almost universally speak **SNMP** (Simple Network Management
Protocol) — a standard, vendor-neutral way to *read* health data off a device by polling it
over the network at its IP. You don't install an agent on the device; a **poller** on our
backend asks for specific **OIDs** (numeric addresses like "interface in-octets" or "battery
charge %") on an interval and the device answers. One background poller service therefore
covers **both** routers and UPS — only the **OID set** differs (IF-MIB for routers, UPS-MIB
for UPS). The poller writes the readings to **InfluxDB** (time-series) and broadcasts the
latest values over **Socket.IO**, exactly mirroring how the Go-agent `server_metrics` pipeline
already works — except this is a **pull** (we poll) rather than a **push** (the agent POSTs).

> The architecture diagram already names this service **"SNMP Poller (Routers & UPS)"** under
> Background Services, and the DB already has the tables for it (`device_network`,
> `ups_details`, `network_interfaces`). This feature fills in that box.

---

## 2. The two device classes

| | C — Other routers | D — UPS |
|---|---|---|
| **What** | non-MikroTik managed routers/switches in the room | UPS units protecting the racks |
| **Method** | **SNMP** (IF-MIB / MIB-II — standardized across vendors) | **SNMP** via the UPS-MIB (RFC 1628) — **requires a network / SNMP card** |
| **If no SNMP** | **ICMP ping** (reachability + latency + packet loss) | **not supported** — a USB-only UPS needs an SNMP card added first |
| **Poll interval** | ~60 s | ~60 s |

---

## 3. The one decision that drives everything: **how does the device connect?**

Before writing any code, look at the actual hardware. This single question decides the path.
(`ups_details.communication_type` records it; under SNMP-only we use `'snmp'` / `'network'`.)

```
Router (C)                              UPS (D)
  │                                       │
  ├─ has SNMP? (managed gear usually      ├─ has an Ethernet port / SNMP card?
  │  does — check its web UI →            │   │
  │  "SNMP" settings page)                │   ├─ YES → SNMP, UPS-MIB (RFC 1628) ── same poller as C
  │   │                                   │   │
  │   ├─ YES → SNMP poller (IF-MIB)       │   └─ NO (USB/serial only) → NOT SUPPORTED
  │   │                                   │         (add an SNMP/network card to monitor it)
  │   └─ NO  → ICMP ping only             │
  │           (up/down + loss)            │
```

**Recommendation:** one **SNMP poller** is the whole feature — it covers every router (with
ICMP ping filling in for unmanaged ones) and every UPS that has a network card. Confirm each
UPS has an SNMP card during requirements; a USB-only unit can't be monitored without one.

---

## 4. What we read (and from where)

### Plain-English primer: MIB, OID, IF-MIB, UPS-MIB

The jargon below is simpler than it looks. The whole idea: **you talk to a router/UPS by asking
it questions *by number*.** It can't chat — you send a number, it sends back a value.

- **OID = a question number.** Like a fixed extension that always reaches the same answer.
  `1.3.6.1.2.1.1.3.0` always means *"how long have you been running?"* — ask it, get the uptime.
  The same number means the same thing on every device.
- **MIB = the dictionary that says what each number means.** On its own an OID is gibberish; the
  MIB is the published list — *"this number = uptime, that one = battery %, this one = port speed."*
- **SNMP = the act of dialing those numbers and reading the answers** — what our poller does every ~60s.

**IF-MIB** and **UPS-MIB** are just two *chapters* of that dictionary, one per topic:

- **IF-MIB** = the chapter about **network ports** — *"is this port up? how many bytes went through
  it? how fast is the link?"* → used for **routers/switches**.
- **UPS-MIB** = the chapter about **batteries/power** — *"battery %? minutes of runtime left? on
  battery right now?"* → used for **UPS units**.

A tiny example of the whole exchange:

```
Poller:  "Give me 1.3.6.1.2.1.33.1.2.4.0"   ← an OID (a question number)
UPS:     "80"                                ← the answer
```
The UPS-MIB dictionary says that number = "battery %", so we read it as **battery at 80%.**

Because these dictionaries are **standard**, the same numbers work on any brand (a Cisco and a
TP-Link router both answer the IF-MIB numbers; an APC and an Eaton UPS both answer the UPS-MIB
numbers) — which is why the poller needs no brand-specific code. *(MIB-II is the shared base both
device types also implement — it's where the universal name/uptime numbers live.)* The exact OIDs
we use are in the tables below.

### C — Routers, via **IF-MIB / MIB-II** (standardized; works across Cisco/HP/Aruba/TP-Link/…)

| Metric | OID | Notes |
|---|---|---|
| Uptime | `sysUpTime` `1.3.6.1.2.1.1.3.0` | universal |
| Name / model | `sysDescr` `1.3.6.1.2.1.1.1.0` | universal |
| Per-interface in/out bytes | `ifHCInOctets` / `ifHCOutOctets` (IF-MIB, 64-bit) | **counters** — poll twice, Δbytes ÷ Δt = throughput |
| Interface up/down | `ifOperStatus` | per interface |
| Link speed | `ifHighSpeed` | for % utilization |
| Interface name | `ifName` / `ifDescr` | label the interfaces |
| Reachability / packet loss | **ICMP ping** (not SNMP) | universal fallback |

> ⚠️ **CPU and memory are NOT standardized** — each vendor has its own MIB (Cisco
> `CISCO-PROCESS-MIB`, etc.). So traffic / uptime / interface-status / packet-loss are universal,
> but CPU/mem only where we look up that specific vendor's OIDs. Unmanaged gear → ping only.

> 🔁 **Counters wrap.** `ifHC*Octets` are monotonically increasing 64-bit counters; compute the
> delta against the previous poll and discard a negative delta (a wrap or device reboot) rather
> than graphing a spike.

### D — UPS, via **UPS-MIB (RFC 1628)**, OID base `1.3.6.1.2.1.33`

| Metric | Object |
|---|---|
| Battery charge % | `upsEstimatedChargeRemaining` |
| Runtime remaining (min) | `upsEstimatedMinutesRemaining` |
| On-battery vs on-mains | `upsOutputSource` |
| Input / output voltage | `upsInputVoltage` / `upsOutputVoltage` |
| Output load % | `upsOutputPercentLoad` |
| Battery status | `upsBatteryStatus` |

Vendor MIBs (e.g. APC `PowerNet-MIB`) expose more detail; RFC 1628 is the portable baseline.

---

## 5. How it fits the current system

The data model is **already there** — this feature mostly fills in services + a page:

| Existing table | Use |
|---|---|
| `devices` (`device_type` includes `router`, `ups`) | one row per monitored device |
| `device_network` (`snmp_port`, `snmp_community`, gateway, dns, …) | SNMP connection details |
| `ups_details` (`communication_type`, brand, model, …) | UPS-specific facts + which path it uses |
| `network_interfaces` | per-interface labels for routers |

New pieces:

- **Socket.IO:** `networkMetrics` / `upsMetrics` broadcasts on each poll (like `serverMetrics`);
  `deviceLog` reused for threshold crossings (e.g. UPS on battery, interface down).
- **Pull, not push:** unlike the Go agent (push), the poller *initiates* every read on a timer.

### InfluxDB measurements

Three measurements, tagged by the **stable** `device_id` (the permanent join key — a rename
starts a new series, so don't rename; resolve display names from MySQL). `network_traffic` and
`router_metrics` are shared by **both** collectors — the SNMP poller (non-MikroTik) *and* the
RouterOS API path (MikroTik) write the same shapes.

```
network_traffic   ── per-interface, 60s ─────────────────────────────────────────
  Tags:   device_id, device_name, interface_name, location_label
  Fields: rx_bytes(uinteger)      CUMULATIVE Counter64 (ifHCInOctets) — rate at query time
          tx_bytes(uinteger)      CUMULATIVE Counter64 (ifHCOutOctets)
          rx_errors(uinteger)     CUMULATIVE counter
          tx_errors(uinteger)     CUMULATIVE counter
          link_up(boolean)
          utilization_pct(float)  precomputed gauge (rate ÷ link speed)

router_metrics    ── per-device, 60s (also covers ping-only / unmanaged routers) ─
  Tags:   device_id, device_name, device_type
  Fields: cpu_percent(float)         vendor MIB — only where the device exposes it
          mem_percent(float)         vendor MIB
          uptime_seconds(float)
          latency_ms(float)          device-level ICMP
          packet_loss_pct(float)     device-level ICMP
          reachable(boolean)         ICMP up/down — the one metric a no-SNMP router still gives
          connected_clients(integer) device-level; optional

ups_metrics       ── per-device, 60s ────────────────────────────────────────────
  Tags:   device_id, device_name, location, communication_type
  Fields: battery_charge_pct(float)   runtime_remaining_min(float)   load_pct(float)
          input_voltage(float)        output_voltage(float)          battery_voltage(float)
          on_battery(boolean)         temperature(float — only if the UPS reports it)
```

**Why cumulative byte/error counters, not pre-computed rates?** It's the Telegraf/LibreNMS/
Prometheus convention and matches the existing `server_metrics.net_bytes_*`. Cumulative is
**lossless** (re-window any rate later) and **survives missed polls** (the derivative uses real
elapsed time). Two rules: use the **64-bit** counters (`ifHCInOctets`, not Counter32 — it wraps
in seconds on a gigabit link), and type them **uinteger**, *not float* (a 64-bit octet counter
exceeds float64's ~4.5×10¹⁵ safe-integer range and would lose precision). InfluxDB pins a
field's type on first write, so lock these in up front (this is also why `link_up` is `boolean`,
consistent with `on_battery`).

Derive throughput from the counters at query time:

```flux
from(bucket: "monitoring")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "network_traffic" and r._field == "rx_bytes")
  |> filter(fn: (r) => r.device_id == "12")
  |> derivative(unit: 1s, nonNegative: true)   // → bytes/sec; nonNegative resets the spike on reboot/wrap
```

(`×8` for bits/sec.) When writing from `@influxdata/influxdb-client`, the `uinteger`/`integer`
fields must use `point.uintField(...)` / `point.intField(...)` — `floatField` would store the
wrong type and break the pinned schema.

---

## 6. Architecture — the SNMP poller service

```
backend startup
   │  load monitored devices (type router|ups + their device_network row)
   ▼
snmpPollerService  ── every ~60s, for each device ───────────────────────────────
   │  1. SNMP GET/walk the device's OID set (net-snmp)
   │       routers → IF-MIB        UPS → UPS-MIB (RFC 1628)
   │  2. counters (rx/tx bytes, errors) are written cumulative; utilization_pct is
   │       computed from the delta vs the previous sample (see §5)
   │  3. write point → InfluxDB (network_traffic / router_metrics | ups_metrics), tag device_id
   │  4. broadcast latest → Socket.IO (networkMetrics | upsMetrics)
   │  5. evaluate thresholds → device_logs + deviceLog event
   ▼
(unreachable device → mark offline, emit serverStatus-style event, skip stale values)
```

**UPS path:** the same `snmpPollerService` polls each UPS over SNMP using the UPS-MIB
(RFC 1628) — no separate ingest path. A UPS without a network/SNMP card can't be monitored
(SNMP-only); flag those during requirements so an SNMP card can be added.

---

## 7. Library & config (planned)

- **Backend dependency:** [`net-snmp`](https://www.npmjs.com/package/net-snmp) — pure-JS SNMP
  client; supports v2c and v3, GET / GETNEXT / walk. (No other dependency — SNMP-only.)
- **SNMP version:** **v2c** is simplest (a shared *community string*, but sent in cleartext —
  acceptable on a trusted management LAN). **v3** adds per-user auth + encryption; prefer it if
  the gear supports it and the LAN isn't fully trusted.
- **Credentials live in `device_network`** (`snmp_community`, `snmp_port` default 161), not in
  `.env`, since they're per-device. A future env knob:

```
SNMP_POLL_INTERVAL_MS=60000   # default poll cadence for the router/UPS poller
```

---

## 8. Planned files

| File | Role | Status |
|---|---|---|
| `backend/services/snmpClient.js` | thin `net-snmp` wrapper (GET/walkColumn, v2c, timeouts, OID maps for IF-MIB + UPS-MIB) | ✅ built (loopback-verified) |
| `backend/services/snmpPollerService.js` | poll loop: load devices, SNMP GET/walk, diff counters, write InfluxDB, broadcast, thresholds; + list reads | ✅ built |
| `backend/handlers/networkMetricsHandler.js` | router sample → InfluxDB `network_traffic` (per-interface) + `router_metrics` + `networkMetrics` broadcast | ✅ built |
| `backend/handlers/upsMetricsHandler.js` | UPS sample → InfluxDB `ups_metrics` + `upsMetrics` broadcast | ✅ built |
| `backend/handlers/networkHistoryHandler.js` / `upsHistoryHandler.js` | Flux history (throughput / battery+load) | ✅ built |
| `backend/routes/network.js` | `GET /api/network`, `/:id/history`, `/:id/logs`; **`POST /api/network` + `DELETE /:id` (admin — add/remove a router from the dashboard)** | ✅ built |
| `backend/routes/ups.js` | `GET /api/ups`, `/:id/history`, `/:id/logs`; **`POST /api/ups` + `DELETE /:id` (admin — add/remove a UPS from the dashboard)** | ✅ built |
| `frontend/src/pages/NetworkMonitoring.tsx` | router list + per-interface throughput/status (Grafana `--gf-*` tokens) | ✅ built |
| `frontend/src/pages/UpsMonitoring.tsx` | UPS battery %, runtime, load, on-battery banner | ✅ built |
| `migrations/2026-06-12_router_ups_devices.sql` | register `router`/`ups` devices + `device_network` / `ups_details` / `network_interfaces` | ⏳ template — needs §10 device facts |

---

## 9. Setup steps — adding a new device to monitor

Registration is now a **dashboard action** (admin-only): the Network and UPS pages each have an
**"Add router" / "Add UPS"** button that writes the same `devices` / `device_network` /
`ups_details` rows the old SQL migration did. No backend restart is needed — the poller loads
its device list every cycle and starts polling a new device on the **next tick**
(≤ `SNMP_POLL_INTERVAL_MS`, ~60s). The `migrations/2026-06-12_router_ups_devices.sql` template
remains only as a **bulk-seed alternative**.

### Step 0 — prepare the device (both classes, do this first)

1. **Enable SNMP on the device** (its admin/web UI → SNMP settings). Use **v2c** (this system is
   v2c-only — see §7 / §10 Q3) and set a **read-only community string**. Prefer a non-default
   value over `public` (see the security note below).
   - *UPS:* SNMP lives on the UPS's **network / SNMP management card**. A **USB-/serial-only UPS
     cannot be monitored** — it needs an SNMP card added first (§2/§3).
   - *Router/switch:* only **managed** gear speaks SNMP. Unmanaged gear can't be added yet (the
     ICMP-ping fallback module isn't built — §11).
2. **Confirm UDP 161 is reachable** from the backend host (firewall / ACL). §10 Q9.
3. **(Recommended) Probe it before registering** — from the backend host, with net-snmp tools:
   ```bash
   snmpwalk -v2c -c <community> <device-ip>              # any device: returns a tree if SNMP works
   snmpwalk -v2c -c <community> <ups-ip> 1.3.6.1.2.1.33   # UPS: should return the UPS-MIB subtree
   ```
   A tree back = you have the right IP + community and UDP 161 is open. A timeout = fix that
   first (wrong community, SNMP not enabled, or firewall) — the dashboard will just show the
   device **Offline** otherwise.

### Step 1 — register it from the dashboard (admin)

**Router / switch** → **Network Monitoring** page → **"Add router"**:

| Field | Notes |
|---|---|
| **Name** | display name, e.g. `Core switch` |
| **IP address** | the device's management IPv4 (validated) |
| **SNMP port** | default **161** |
| **SNMP community** | the **read-only** v2c community you set in Step 0 (**required**) |
| **Location** | default `CSPC-ICTU Server Room` |

**UPS** → **UPS Monitoring** page → **"Add UPS"** — same fields, plus:

| Field | Notes |
|---|---|
| **Comm. type** | `snmp` or `network` (equivalent — both mean "pollable over SNMP"; default `snmp`) |
| **Brand / Model / Battery capacity / Serial no.** | optional descriptive metadata (`APC`, `Smart-UPS 1500`, `1500 VA`, …) |

> A **community string is required** for both forms: under the SNMP-only scope a device without
> one is invisible to the poller, so the form won't create a dead row.

### Step 2 — verify

The device appears in the list immediately as **Offline**. Within one poll cycle (~60s) it should
flip to **Online** and start showing live data (interface throughput for routers; battery %,
runtime, load for UPS). If it stays Offline, re-run the Step-0 `snmpwalk` probe — the community,
IP, or firewall is the usual culprit. Per-device events land in **View → logs** (`device_logs`).

### Removing a device

Each row/card has an admin-only **Remove** (inline confirm). It deletes the `devices` row;
`device_network` / `ups_details` / `network_interfaces` cascade away. **InfluxDB history is left
intact** (it's tagged by the stable `device_id`; see §5).

> 🔒 **Security note:** v2c sends the community **in cleartext**. That's acceptable on a trusted
> management LAN (this deployment) but is the reason to (a) use a **read-only** community and
> (b) prefer a **non-`public`** value. v3 (per-user auth + encryption) would need the follow-up
> migration described in §10 Q3.

---

## 10. Open questions / decisions needed

1. **Actual device models?** The router make/model decides SNMP-vs-ping and which vendor MIB
   (if any) exposes CPU/mem.
2. **Does each UPS have a network / SNMP card?** *(Required — a USB-/serial-only UPS can't be
   monitored under SNMP-only; it needs an SNMP card added first.)*
3. **SNMP v2c or v3?** — *settled by the schema:* `device_network` only stores a community
   string + port (no v3 auth/priv columns), so the implementation is **v2c**. v3 would need a
   follow-up migration to add credential columns + the `snmpClient` v3 branch. (Use a read-only
   community on a trusted management LAN.)
4. **Alerting — ✅ DECIDED & IMPLEMENTED: configurable `alert_rules`.** Router/UPS threshold
   alerting now runs through `services/deviceAlerts.js` (shared with the MikroTik poller):
   numeric metrics (`router_cpu`/`router_mem`/`router_clients`/`link_util`/`ups_charge`/
   `ups_runtime`/`ups_load`) are evaluated against the configurable `alert_rules`
   (alertRulesService, hysteresis-aware) and raise REAL alerts via `notificationService.raiseAlert`
   (bell/email/Alerts page), auto-resolving on recovery; boolean events (interface down, UPS
   on-battery, device offline) raise directly like server 'offline'. Global defaults are seeded by
   `migrations/2026-06-30_router_ups_alert_rules.sql`, tunable from the **Alert Rules** admin page.
   This replaced the earlier hardcoded per-condition checks in `snmpPollerService`.

> 📋 **Collecting these from the client:** Q1/Q2 (UPS SNMP cards), Q6-equivalent (managed routers),
> Q9 (firewall/UDP 161), plus per-device IP/model/community, are gathered via
> **`router-ups-client-questionnaire.md`** (and a Word `.docx` version) — a plain-language form for
> the CSPC-ICTU team. Their answers fill in `migrations/2026-06-12_router_ups_devices.sql`.

---

## 11. Status & next steps

- **Done:** the whole pipeline — `snmpClient` + `snmpPollerService` + the metric/history
  handlers + `/api/network` & `/api/ups` routes + the two Grafana dashboard pages. Verified
  `node --check` / `tsc` clean. `network_traffic` / `router_metrics` / `ups_metrics` written as
  designed (§5). New socket events `networkMetrics` / `upsMetrics` / `networkStatus` /
  `upsStatus`; env `SNMP_POLL_INTERVAL_MS` (default 60s). **v2c** (per §10 Q3).
- **Scope confirmed (client):** UPS = **monitor-and-alert only**, no automated server shutdown.
- **Device registration:** now done from the **dashboard** — admin-only **"Add router" / "Add UPS"**
  on the Network/UPS pages (name, IP, SNMP port, read-only community; UPS also brand/model/capacity/
  serial/comm-type), plus per-device **Remove**. The poller loads devices every cycle, so an added
  device starts polling within ~60s with no restart. The `migrations/2026-06-12_router_ups_devices.sql`
  template remains as an alternative (e.g. bulk seeding), still gated on the §10 device facts (Q1 UPS
  SNMP cards, Q6 managed routers, Q9 firewall).
- **Not started / blocked:** a **live end-to-end test** against a real SNMP target (needs MySQL
  + InfluxDB + registered devices + a reachable router/UPS), and an **ICMP-ping fallback module** for
  unmanaged/no-community routers (currently skipped, returned `monitored:false`; note the add form
  **requires** a community string, so it won't register a ping-only router until that module exists).
- See `CLAUDE.md` (architecture + data stores) and the architecture diagram (data sources C, D)
  for the broader context.
