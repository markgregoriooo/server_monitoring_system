# Router & UPS Monitoring — CSPC-ICTU Monitoring

Monitoring for the two remaining server-room data sources in the architecture diagram:
**(C) other routers** (the non-MikroTik network gear) and **(D) UPS units**. Both are read
**over the LAN** — nothing is installed *on* the device — using **SNMP** as the primary
technique, with **NUT** as the fallback for UPS units that only expose USB/serial.
Branch: `router-ups-monitoring`.

> 🧭 **Status: DESIGN / PLAN — not yet implemented.** This file is the blueprint we build
> against. MikroTik router monitoring (data source **B**) is explicitly **out of scope here**
> and handled separately. Code sections below describe the *intended* files; they don't exist yet.

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
| **Primary method** | **SNMP** (IF-MIB / MIB-II — standardized across vendors) | **SNMP** via the UPS-MIB (RFC 1628) — *if* it has a network card |
| **Fallback** | **ICMP ping** (reachability + latency + packet loss) when SNMP is absent | **NUT** (Network UPS Tools) over USB/serial when there's no network card |
| **Poll interval** | ~60 s | ~60 s |

---

## 3. The one decision that drives everything: **how does the device connect?**

Before writing any code, look at the actual hardware. This single question decides the path,
and it's already modeled in `ups_details.communication_type ENUM('usb','snmp','serial','network')`.

```
Router (C)                              UPS (D)
  │                                       │
  ├─ has SNMP? (managed gear usually      ├─ has an Ethernet port / network card?
  │  does — check its web UI →            │   │
  │  "SNMP" settings page)                │   ├─ YES → SNMP, UPS-MIB (RFC 1628)  ── same poller as C
  │   │                                   │   │
  │   ├─ YES → SNMP poller (IF-MIB)       │   └─ NO (USB/serial only) → NUT on a
  │   │                                   │         nearby host (Pi or the server),
  │   └─ NO  → ICMP ping only             │         queried over TCP 3493 — or the
  │           (up/down + loss)            │         existing Go agent runs `upsc` and
  │                                       │         POSTs it like server metrics
```

**Recommendation:** make the **SNMP poller the one primary path** (covers all of C, plus any
UPS with a network card), and treat **NUT** purely as the UPS fallback for USB-only units.

---

## 4. What we read (and from where)

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

- **InfluxDB measurements:** `network_metrics` (per-interface throughput, status) and
  `ups_metrics` (battery %, runtime, load, voltages, on-battery) — tagged by `device_id`,
  matching the `server_metrics` convention so history queries reuse the same Flux shape.
- **Socket.IO:** `networkMetrics` / `upsMetrics` broadcasts on each poll (like `serverMetrics`);
  `deviceLog` reused for threshold crossings (e.g. UPS on battery, interface down).
- **Pull, not push:** unlike the Go agent (push), the poller *initiates* every read on a timer.

---

## 6. Architecture — the SNMP poller service

```
backend startup
   │  load monitored devices (type router|ups + their device_network row)
   ▼
snmpPollerService  ── every ~60s, for each device ───────────────────────────────
   │  1. SNMP GET/walk the device's OID set (net-snmp)
   │       routers → IF-MIB        UPS → UPS-MIB (RFC 1628)
   │  2. for counters, diff against the previous sample → rates (B/s, % util)
   │  3. write point → InfluxDB (network_metrics | ups_metrics), tag device_id
   │  4. broadcast latest → Socket.IO (networkMetrics | upsMetrics)
   │  5. evaluate thresholds → device_logs + deviceLog event
   ▼
(unreachable device → mark offline, emit serverStatus-style event, skip stale values)
```

**NUT fallback (USB-only UPS):** run NUT on a host physically next to the UPS (a Raspberry Pi
or the same server the Go agent runs on); the UPS connects by USB and NUT exposes it on TCP
**3493**. Either the poller queries NUT over 3493, or — simpler — the **existing Go agent runs
`upsc <ups>` and POSTs the values** through the metric pipeline it already has, so no new
ingest path is needed.

---

## 7. Library & config (planned)

- **Backend dependency:** [`net-snmp`](https://www.npmjs.com/package/net-snmp) — pure-JS SNMP
  client; supports v2c and v3, GET / GETNEXT / walk. (NUT path adds nothing to `package.json` —
  it shells out to `upsc` or speaks the NUT TCP protocol.)
- **SNMP version:** **v2c** is simplest (a shared *community string*, but sent in cleartext —
  acceptable on a trusted management LAN). **v3** adds per-user auth + encryption; prefer it if
  the gear supports it and the LAN isn't fully trusted.
- **Credentials live in `device_network`** (`snmp_community`, `snmp_port` default 161), not in
  `.env`, since they're per-device. A future env knob:

```
SNMP_POLL_INTERVAL_MS=60000   # default poll cadence for the router/UPS poller
NUT_HOST=                     # host:port running upsd (blank = NUT path disabled)
```

---

## 8. Planned files

| File | Role |
|---|---|
| `backend/services/snmpPollerService.js` | the poll loop: load devices, SNMP GET/walk, diff counters, write InfluxDB, broadcast, thresholds |
| `backend/services/snmpClient.js` | thin `net-snmp` wrapper (GET/walk, v2c/v3, timeouts, OID maps for IF-MIB + UPS-MIB) |
| `backend/handlers/networkMetricsHandler.js` | shape a router sample → InfluxDB `network_metrics` + `networkMetrics` broadcast |
| `backend/handlers/upsMetricsHandler.js` | shape a UPS sample → InfluxDB `ups_metrics` + `upsMetrics` broadcast |
| `backend/routes/network.js` | `GET /api/network`, `GET /api/network/:id/history` (Flux on `network_metrics`) |
| `backend/routes/ups.js` | `GET /api/ups`, `GET /api/ups/:id/history` |
| `frontend/src/pages/NetworkMonitoring.tsx` | router list + per-interface throughput/status (Grafana `--gf-*` tokens) |
| `frontend/src/pages/UpsMonitoring.tsx` | UPS battery %, runtime, load, on-battery banner |
| migration | register `router`/`ups` devices + their `device_network` / `ups_details` rows; add `network_interfaces` seed |

---

## 9. Setup steps (per device, when we implement)

**Router (C):** in the router's admin UI, enable **SNMP** (v2c: set a read-only community
string; v3: create a read-only user). Note the **community string / credentials** and confirm
UDP **161** is reachable from the backend host. Add a `devices` + `device_network` row.

**UPS (D) with a network card:** enable **SNMP** on the UPS's network management card, set a
read-only community, and confirm it answers the UPS-MIB (`snmpwalk -v2c -c <community> <ip>
1.3.6.1.2.1.33`). Add `devices` + `device_network` + `ups_details(communication_type='snmp')`.

**UPS (D) USB-only:** install **NUT** on the nearby host, configure the driver for the model
(`usbhid-ups` covers most), verify with `upsc <ups>@localhost`, then either point the poller at
`NUT_HOST` or have the Go agent POST `upsc` output. Set `communication_type='usb'`.

> 🔎 **Quick probe before coding anything:** from the backend host run
> `snmpwalk -v2c -c <community> <device-ip>` (install net-snmp tools). If it returns a tree, SNMP
> works and we know the exact OIDs the device supports; if it times out, that device needs the
> ping-only (router) or NUT (UPS) fallback.

---

## 10. Open questions / decisions needed

1. **Actual device models?** The router and UPS make/model decide SNMP-vs-ping (router) and
   SNMP-vs-NUT (UPS), and which vendor MIB (if any) gives CPU/mem.
2. **Does the UPS have an Ethernet port / network management card,** or only USB/serial?
3. **SNMP v2c or v3?** (Is the management LAN trusted enough for a cleartext community string?)
4. **Where does NUT run** if needed — a dedicated Raspberry Pi, or co-located with the Go agent?
5. **Alerting** — reuse the existing `device_logs` / `deviceLog` threshold path, or build proper
   `alert_rules` rows for "UPS on battery" / "interface down"?

---

## 11. Status & next steps

- **Done:** design captured here; data model already supports it; SNMP poller box exists in the
  architecture diagram.
- **Not started:** `net-snmp` poller service, InfluxDB measurements, routes, frontend pages, NUT
  fallback, migration to register the devices.
- **Blocked on:** the device facts in §10 (models + connectivity) — answer those and the first
  build target is `snmpPollerService.js` + `snmpClient.js` against one real router via `snmpwalk`.
- See `CLAUDE.md` (architecture + data stores) and the architecture diagram (data sources C, D)
  for the broader context.
