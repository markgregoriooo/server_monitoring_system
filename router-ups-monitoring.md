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

> 🧭 **Status: IMPLEMENTED (poller + APIs + pages) — seeding pending.** The poller, handlers,
> read routes, and the two dashboard pages are built (`node --check` / `tsc` clean; see §8 /
> SESSION_NOTES SESSION 10). What's left is **registering the real devices** — the
> `migrations/2026-06-12_router_ups_devices.sql` template, blocked on the §10 device facts — and
> a live end-to-end test against a real SNMP target. MikroTik router monitoring (data source
> **B**) is explicitly **out of scope here** and handled separately.

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
| `backend/routes/network.js` | `GET /api/network`, `/:id/history`, `/:id/logs` | ✅ built |
| `backend/routes/ups.js` | `GET /api/ups`, `/:id/history`, `/:id/logs` | ✅ built |
| `frontend/src/pages/NetworkMonitoring.tsx` | router list + per-interface throughput/status (Grafana `--gf-*` tokens) | ✅ built |
| `frontend/src/pages/UpsMonitoring.tsx` | UPS battery %, runtime, load, on-battery banner | ✅ built |
| `migrations/2026-06-12_router_ups_devices.sql` | register `router`/`ups` devices + `device_network` / `ups_details` / `network_interfaces` | ⏳ template — needs §10 device facts |

---

## 9. Setup steps (per device, when we implement)

**Router (C):** in the router's admin UI, enable **SNMP** (v2c: set a read-only community
string; v3: create a read-only user). Note the **community string / credentials** and confirm
UDP **161** is reachable from the backend host. Add a `devices` + `device_network` row.

**UPS (D):** enable **SNMP** on the UPS's network management card, set a read-only community,
and confirm it answers the UPS-MIB (`snmpwalk -v2c -c <community> <ip> 1.3.6.1.2.1.33`). Add
`devices` + `device_network` + `ups_details(communication_type='snmp')`. *(A UPS with no
network/SNMP card can't be monitored — it needs an SNMP card added first.)*

> 🔎 **Quick probe before coding anything:** from the backend host run
> `snmpwalk -v2c -c <community> <device-ip>` (install net-snmp tools). If it returns a tree, SNMP
> works and we know the exact OIDs the device supports; if it times out, a router falls back to
> ping-only, and a UPS can't be monitored until it has an SNMP/network card.

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
4. **Alerting** — reuse the existing `device_logs` / `deviceLog` threshold path, or build proper
   `alert_rules` rows for "UPS on battery" / "interface down"?

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
- **Not started / blocked:** the **seed migration** (`migrations/2026-06-12_router_ups_devices.sql`
  is a fill-in template) — blocked on the §10 device facts (Q1 UPS SNMP cards, Q6 managed
  routers, Q9 firewall). Also: a **live end-to-end test** against a real SNMP target (needs MySQL
  + InfluxDB + seeded devices + a reachable router/UPS), and an **ICMP-ping fallback module** for
  unmanaged/no-community routers (currently skipped, returned `monitored:false`).
- See `CLAUDE.md` (architecture + data stores) and the architecture diagram (data sources C, D)
  for the broader context.
