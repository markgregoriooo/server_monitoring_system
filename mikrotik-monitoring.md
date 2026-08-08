# MikroTik Network Monitoring — CSPC-ICTU Monitoring

> Status: **IMPLEMENTED + LIVE-TESTED** (branch `mikrotik-monitoring`, stacked on
> `router-ups-monitoring`). Backend poller + RouterOS client + crypto + REST routes, and the
> dashboard list → detail pages with admin **Add / Configure / Test / Remove** and a port
> **label editor**. **Mock removed — live RouterOS only.** Real alerts (bell / email / Alerts
> page) via configurable `alert_rules` (`services/deviceAlerts.js`, shared by the MikroTik +
> SNMP pollers), including interface **error-rate** alerting.
> **→ §13 is the study guide for how it actually works (read that with the code open).**
>
> ⚠️ **Terminology.** This document was written around "each building is a port". The
> implementation and UI now speak in **ports**, with an optional free-text label per port
> (`network_interfaces.location_label`) — which may be a building, a rack, an uplink, or
> anything else. Read "building" below as "labelled port".
>
> **Live test (2026-07-31, RB951G-2HnD / RouterOS 6.43.4)** found two real issues, both fixed:
> `/interface/print` with `=stats=` is rejected on that build (now falls back to a plain print),
> and `/interface/print` returns every logical interface — `bridge`, `wlan1`, VLANs — so a
> 5-port router reported 7 "ports" until `physicalOnly()` was added.

Monitor the **campus network through a single MikroTik router**. The campus has **one large
MikroTik** that all buildings' networks pass through; it has ~**4–5 ports**, and **each
building is a port/interface** on that router. (Development uses a **small MikroTik** as a
stand-in for the large one — same code, only the connection details differ.) The backend
connects out to the **one** MikroTik, **pulls** live metrics (per-interface = per-building
throughput, interface up/down, connected clients, router CPU/memory/uptime), writes them to
InfluxDB, and streams them to the dashboard in real time — exactly the **experience** of the
server-metrics page, but for the network.

> **The key reframe:** "per-building" = **per-interface**. We monitor **one device** and label
> its ports with building names. We are *not* registering 5 routers.

---

## 0. ⚠️ Read this first — relationship to `router-ups-monitoring`

This is **not** greenfield. The architecture diagram already splits the network data sources:

| Source | What | Branch / status |
|--------|------|-----------------|
| **B** | **MikroTik router (RouterOS)** | **THIS branch** (`mikrotik-monitoring`) — was left "handled separately" |
| C | Other / non-MikroTik routers & switches | `router-ups-monitoring` — built (SNMP poller), seeding pending |
| D | UPS units | `router-ups-monitoring` — built (SNMP/UPS-MIB), seeding pending |

The `router-ups-monitoring` branch **explicitly excludes MikroTik** and says it is *"handled
separately."* Crucially, it already **designed for us**: its InfluxDB measurements
`network_traffic` and `router_metrics` are documented as **shared by both collectors — the
SNMP poller (non-MikroTik) *and* the RouterOS API path (MikroTik) write the same shapes.**
It also already ships `frontend/src/pages/NetworkMonitoring.tsx`, `routes/network.js`, the
`networkMetrics` / `networkStatus` socket events, the `devices` + `device_network` model, **and
the `network_interfaces` table that maps a port to a `location_label`** — which is exactly the
"port → building" mapping we need.

**Implication:** the right move is to **reuse that foundation**, not build a parallel network
stack. We add **one new collector** (a RouterOS poller for the one MikroTik) that emits the same
sample shape, and the router lights up the existing Network page for free. See §1 and the
**branch-base decision in §10** — that's the main thing for you to choose.

> RouterOS API vs SNMP: the one MikroTik *could* be polled by the existing SNMP poller (register
> it as a `router` device and label its ports). We choose the **RouterOS API** because it gives
> MikroTik-native data SNMP can't easily provide — CPU/memory (the SNMP poller leaves these
> `null`) and **per-building connected-client counts** from DHCP leases. If you decide the SNMP
> route is "good enough," this whole feature collapses into a few `network_interfaces` rows on
> the other branch — noted as the fallback in §9.

---

## 1. The one decision that drives everything: **pull, not push** + RouterOS API

Server monitoring uses a **Go agent installed on each server** that **pushes** metrics. You
**cannot** install our agent on a MikroTik (RouterOS is a closed appliance). So MikroTik
monitoring is the mirror image: a **poller on our backend pulls** metrics from the MikroTik on
a timer — identical to how `snmpPollerService` already polls routers/UPS, just speaking the
**RouterOS API** instead of SNMP, and against **one** device.

```
Server metrics (existing)         MikroTik metrics (this feature)
  Go agent on host                  backend poller (no agent on the device)
      │ PUSH every 10s                  │ PULL every ~30s, ONE MikroTik
      ▼                                 ▼
  POST /api/servers/metrics         RouterOS API connect → read all ports → close
      │                                 │
      ▼                                 ▼
  InfluxDB server_metrics           InfluxDB network_traffic + router_metrics  (SHARED w/ SNMP)
      │                                 │   (one row per physical port)
      ▼                                 ▼
  socket "serverMetrics"            socket "networkMetrics" / "networkStatus"  (SHARED w/ SNMP)
      │                                 │
      ▼                                 ▼
  ServerMetrics page                NetworkMonitoring page (one router, ports labeled by building)
```

**Why RouterOS API over SNMP for MikroTik (recommended):**

| | RouterOS API | SNMP (existing poller) |
|---|---|---|
| Per-interface rx/tx, up/down | ✅ `/interface print` (+ `/interface/monitor-traffic`) | ✅ IF-MIB |
| **Router CPU / memory** | ✅ `/system/resource` | ❌ vendor MIB — left `null` today |
| **DHCP leases, per port** | ✅ leases grouped by DHCP server → interface | ⚠️ hard / not portable |
| RouterOS version, board, uptime | ✅ `/system/resource` | partial (`sysDescr`) |
| Credential sensitivity | router **login** (encrypt at rest, read-only user) | community string (read-only) |
| Library | `node-routeros` (v6 + v7) **or** REST `/rest` (v7 only, no dep) | `net-snmp` (already added) |

---

## 2. What we read from the one MikroTik (RouterOS API)

| Metric | RouterOS source | Notes |
|--------|-----------------|-------|
| CPU load % | `/system/resource` `cpu-load` | device-level gauge |
| Memory used % | `/system/resource` `free-memory` / `total-memory` | derive % |
| Uptime, version, board | `/system/resource` `uptime`, `version`, `board-name` | identity |
| Per-interface rx/tx **bytes** | `/interface print stats` `rx-byte` / `tx-byte` | **cumulative counters** → derive bps at query time |
| Interface up/down | `/interface print` `running` / `disabled` | one row per physical port |
| Interface errors/drops | `/interface print stats` `rx-error` / `tx-error` | cumulative |
| Link speed (for util %) | `/interface/ethernet print` `rate` | optional |
| **Connected clients (total)** | `/ip/dhcp-server/lease print ?status=bound` | device-level count |
| **Connected clients (per port)** | leases grouped by `server`, mapped to an interface via `/ip/dhcp-server print` | ✅ implemented. Resolves to `null` per port when every lease sits on one bridge — see §10 Q3 |

This maps **1:1 onto the shape `collectRouter()` already returns** in `snmpPollerService`
(`{ reachable, sysName, uptimeSeconds, cpuPercent, memPercent, connectedClients, interfaces:[{ name, rxBytes, txBytes, rxErrors, txErrors, linkUp, utilizationPct }] }`),
so we **reuse `writeNetworkSample()` and the `networkMetrics` broadcast unchanged** — we just
fill `cpuPercent` / `memPercent` / `connectedClients` that the SNMP path leaves `null`.

---

## 3. Data model — **one** MikroTik device; buildings = labeled ports

Just **one** row in the existing `devices` table for the MikroTik:

- `device_type = 'mikrotik'` — ⚠️ **correction:** `devices.device_type` is an **ENUM**
  (`'aircon','server','ups','router','esp32'`) that does **not** include `'mikrotik'` yet, so the
  migration must **ALTER** the ENUM to add the value (done in
  `migrations/2026-06-20_mikrotik_device.sql`). *(Alternative: reuse `'router'` and tell MikroTik
  apart by "has a `mikrotik_devices` row" — but adding the ENUM value is cleaner and matches the
  dedicated table that already exists.)*
- `location` = e.g. "CSPC-ICTU Server Room" (where the router physically is). The **buildings**
  are not here — they're per **interface** (below).
- `status` = `online` / `offline`, flipped by the poller itself (polling **is** the heartbeat —
  no separate offline sweep).

**Buildings = interface labels (reuse `network_interfaces`, already built on the other branch):**

```sql
-- network_interfaces already exists: one row per port, mapping the RouterOS interface
-- name to a human label. For us, location_label = the building that port serves.
INSERT INTO `network_interfaces` (device_id, interface_name, location_label, is_active) VALUES
  (@mikrotik_id, 'ether1', 'Uplink to ISP',        1),
  (@mikrotik_id, 'ether2', 'Engineering Building',  1),
  (@mikrotik_id, 'ether3', 'Admin Building',        1),
  (@mikrotik_id, 'ether4', 'Library',               1),
  (@mikrotik_id, 'ether5', 'Student Center',        1);
```

The poller tags each per-interface InfluxDB point with `location_label`, so the page shows one
device with **4–5 building-labeled rows** — that *is* the per-building view.

**RouterOS connection details — `mikrotik_devices` (already exists in the V10 schema).** This
**1:1 detail table** off `devices` is the right home — same pattern as `server_specs` /
`ups_details` / `aircon_state` — so we **keep it** and do **not** fold it into the shared
`device_network` (that would add RouterOS-only columns that are NULL for every server / router /
UPS / ESP32 row — the sparse-column anti-pattern). The V10 columns already cover us:

```sql
-- ALREADY EXISTS (V10): mikrotik_devices — 1:1 with devices (UNIQUE device_id, FK CASCADE)
--   mikrotik_id, device_id, routeros_version, board_model, api_port DEFAULT 8728,
--   api_username, api_password VARCHAR(255), api_enabled DEFAULT 1, last_seen, created_at, updated_at
-- The migration ADDS use_tls, and DROPS firmware_version (unused; overlaps routeros_version):
ALTER TABLE `mikrotik_devices` ADD COLUMN `use_tls` TINYINT NOT NULL DEFAULT 0 AFTER `api_port`;
ALTER TABLE `mikrotik_devices` DROP COLUMN `firmware_version`;
```

> **Dev vs production = the same one row, pointed at a different IP/credentials** (small dev
> MikroTik ↔ large campus MikroTik) — no code change, like swapping the backend address.

**Credential security (this is login material):**
- Store `api_password` (the existing `VARCHAR(255)`) **encrypted** with **AES-256-GCM**
  (ciphertext base64-encoded — fits in 255, no column change), key from `.env` `MIKROTIK_ENC_KEY`
  (32-byte hex). Decrypt only in the poller, in memory. **Never** send the password to the UI.
- On the MikroTik, create a **dedicated read-only user** (group with `read` + `api`, no
  `write`/`policy`); never use `admin`.
- Prefer **API-SSL (8729)**; plain 8728 is acceptable on a trusted management LAN.
- Managing the MikroTik connection is **admin-only**.

---

## 4. InfluxDB — reuse the shared measurements (no new schema)

Write the **same** measurements the `router-ups-monitoring` design defined, tagged by the
stable `device_id` **and `interface_name` / `location_label`**:

- `network_traffic` — **per interface (= per physical port), per poll**: `rx_bytes`/`tx_bytes`
  (**uinteger**, cumulative Counter64 — use `point.uintField`, not float),
  `rx_errors`/`tx_errors`, `link_up` (boolean), `utilization_pct` (float). Throughput is derived
  at query time (`derivative(nonNegative:true)`), so a counter wrap / reboot doesn't spike.
- `router_metrics` — **per device (the one MikroTik), per poll**: `cpu_percent`, `mem_percent`,
  `uptime_seconds`, `reachable` (boolean), `connected_clients` (integer, where derivable).

Because the shapes match, the **existing Network page renders this with no new query code**, and
history/Flux is identical. (InfluxDB pins a field's type on first write — keep the byte counters
`uinteger` and status fields `boolean`, exactly as the SNMP path does.)

---

## 5. Proposed pieces (new), mirroring the SNMP poller

### Backend
```
backend/services/mikrotikClient.js        ← thin node-routeros wrapper: connect (TLS optional),
                                            timeout, run a command, close. + REST fallback option.
backend/services/mikrotikCrypto.js        ← AES-256-GCM encrypt/decrypt for api_password (MIKROTIK_ENC_KEY)
backend/services/mikrotikPollerService.js ← the mirror of snmpPollerService, for ONE device:
                                            loadDevice() (the single device_type='mikrotik' row)
                                            → collectMikrotik(conn) → SAME sample shape (per port)
                                            → writeNetworkSample() (REUSED) → broadcast networkMetrics
                                            → offline/online flip → networkStatus
backend/routes/mikrotik.js                ← GET /api/mikrotik (the device + its ports),
                                            PUT /api/mikrotik (set/update connection, admin),
                                            POST /api/mikrotik/test (probe creds), ports CRUD,
                                            /history, /logs   (reuses networkHistoryHandler)
migrations/2026-06-20_mikrotik_device.sql
```
Wire-up in `src/server.js`: mount `/api/mikrotik`, and drive `mikrotikPollerService.poll()` on a
`setInterval` (like the SNMP poller / offline sweep), guarded by `MIKROTIK_POLL_INTERVAL_MS`.

### Frontend
```
frontend/src/pages/NetworkMonitoring.tsx   ← extend the existing page: the MikroTik shows as one
                                             device whose interface rows are labeled by BUILDING
                                             (per-building throughput, up/down, clients). Grafana --gf-*.
frontend/src/pages/MikrotikDetail.tsx       ← per-port detail: rx/tx charts, link state, clients,
                                             + device CPU/mem/uptime gauges, recent events
                                             (mirror ServerDetail) — OR fold into NetworkDetail.
admin connection form                       ← host, port, TLS, read-only user/pass, "Test"; + edit
                                             the port→building labels (network_interfaces)
frontend/src/api/api.ts                     ← getMikrotik / saveMikrotik / testMikrotik / ports / history
Sidebar nav "Network"                       ← offline badge when the MikroTik is unreachable
```

### Env (`backend/.env`)
```
MIKROTIK_POLL_INTERVAL_MS=30000   # poll cadence (RouterOS API is lighter than SNMP walks)
MIKROTIK_API_TIMEOUT_MS=5000      # connect/read timeout
MIKROTIK_ENC_KEY=                 # 32-byte hex key for AES-256-GCM credential encryption (REQUIRED)
MIKROTIK_TLS_VERIFY=              # true = verify the router's cert when use_tls is on. Blank/false
                                  #   = encrypted but unverified. RouterOS ships a SELF-SIGNED cert,
                                  #   so strict verification fails against a stock router.
MIKROTIK_TLS_CA=                  # optional CA file path, used only when MIKROTIK_TLS_VERIFY=true
```

> Dependency: `node-routeros` (RouterOS API client, v6 + v7). If the router is RouterOS **v7**,
> the built-in **REST API** (`https://<router>/rest`, basic auth) needs **no** dependency —
> decide in Phase 0.

---

## 6. Resilience (mirror the SNMP poller's rules)

- **One device, but still time-boxed.** Wrap the poll in `MIKROTIK_API_TIMEOUT_MS` so a hung
  router never stalls the loop.
- **Polling is the heartbeat.** The router answers → `online`; a connect/timeout failure →
  `offline` (emit `networkStatus`, zero its live values). No separate offline sweep.
- **Counters wrap / reboot** → discard a negative byte delta rather than graph a spike (the SNMP
  poller already does this; reuse the logic).
- **Log once on transition**, not every cycle: a building **port down**, router offline/online —
  reuse the `device_logs` + `deviceLog` pattern.
- Connect → read all ports → close each cycle (simplest); switch to a pooled persistent
  connection only if the per-poll connect cost matters.

---

## 7. Alerting — reuse the existing stack

Network alerts flow through the **same** `notificationService.raiseAlert` → `alertsService`
lifecycle → bell/toast/email + Alerts page that servers use (the MikroTik is a `devices` row, so
`alerts.device_id` / `device_logs.device_id` FKs just work):

- **Building port down** (an interface drops) → warning/critical, named by its building label,
  log on the down transition, auto-resolve when it recovers.
- **Router offline / online** → reuse the **exact pattern built in SESSION 14** for servers
  (offline = open warning; online = info event that auto-resolves the offline incident).
- **High link utilization** / **router CPU / memory high** → make these **`alert_rules`**
  metrics (e.g. `link_util`, plus `cpu`/`mem` on the MikroTik) so thresholds are
  admin-configurable, consistent with the server + environment rules.

> This also answers `router-ups-monitoring §10 Q4` — recommend **`alert_rules`** for thresholds,
> `device_logs` for lifecycle/up-down events.

---

## 8. PiP widget tile (optional, post-1.0)

Add a `network.summary` tile to the PiP catalog (`frontend/src/pip/tiles/catalog.tsx`) — buildings
up/down + total uplink throughput — feeding off the `networkMetrics` stream via
`LiveSummaryContext`, mirroring the `servers.list` tile from SESSION 14. No backend work.

---

## 9. Decisions (recommended defaults)

| # | Decision | Recommendation |
|---|----------|----------------|
| 1 | Pull vs push | **Pull** (backend polls) — can't install an agent on RouterOS |
| 2 | RouterOS API vs SNMP | **RouterOS API** — gives CPU/mem + client counts SNMP can't |
| 3 | Scope | **One** MikroTik device; **buildings = its ports** (labeled interfaces) |
| 4 | Building mapping | reuse **`network_interfaces`** (`interface_name` → `location_label` = building) |
| 5 | Reuse vs new data model | **Reuse** `devices` + shared `network_traffic`/`router_metrics` |
| 6 | Credential storage | one-row `mikrotik_devices` (or +cols on `device_network`); **password AES-256-GCM** |
| 7 | RouterOS account | dedicated **read-only** user; never `admin` |
| 8 | Dev vs prod | same one row, different IP/credentials (small dev ↔ large campus MikroTik) |
| 9 | Page | **extend** the existing `NetworkMonitoring.tsx` (shared collector) |
| 10 | Fallback | if RouterOS API is overkill, register the MikroTik as an SNMP `router` on the other branch |

---

## 10. Open questions / decisions needed from you

1. **Branch base — ✅ DECIDED: Option B.** This feature wants the network foundation on
   `router-ups-monitoring` (shared measurements, `NetworkMonitoring.tsx`, `networkMetrics`
   events, `network_interfaces`, the `devices`/`device_network` model). The options were:
   - **(A)** Merge `router-ups-monitoring` → `main` first, then rebase this branch on `main` and
     add only the RouterOS collector. *(Cleanest **once that branch is done** — but it isn't yet,
     and merging incomplete/un-live-tested work into `main` is poor practice. Rejected for now.)*
   - **(B) ✅ CHOSEN.** Branch `mikrotik-monitoring` **off `router-ups-monitoring`** so it reuses
     those files directly while that branch finishes. Standard **stacked-branch** pattern: this
     branch sits on top of `router-ups-monitoring`; as that branch lands new commits I merge them
     up; eventually `router-ups-monitoring` → `main`, then `mikrotik-monitoring` → `main`.
   - **(C)** Build standalone off `main`, re-implementing a minimal network model, reconcile later.
     *(Most isolated, most duplication — rejected.)*
   > **Rationale:** `router-ups-monitoring` is not yet complete, so A is premature. The code we
   > reuse (the shared measurements, `network_interfaces`, `NetworkMonitoring.tsx`, handlers) is
   > already built on that branch, so B reuses it with zero duplication.
   > **Action when building starts (Phase 1):** re-point this branch onto `router-ups-monitoring`
   > (`git branch -f mikrotik-monitoring router-ups-monitoring`). It's currently still off `main`,
   > carrying only the planning docs (untracked), so the move is clean. **Not done yet** — we're
   > blocked on the questionnaire answers, so there's no need to transform the working tree now.
2. **RouterOS version** on the MikroTik (v6 vs v7) → decides `node-routeros` vs the
   dependency-free REST API. Also: dev MikroTik model + production (large) MikroTik model.
3. **Per-building client counts.** Is each building on its **own subnet / DHCP server / VLAN** on
   the MikroTik? If yes, we can break "connected clients" down per building; if it's one flat
   network, we can only show **total clients + per-port traffic** (traffic/up-down are always
   per building since they're per physical port).
4. **API access:** can we enable the API service and create a **read-only** API user? Over **TLS
   (8729)** or plain (8728)? Is the API port reachable from the backend host?
5. **Port → building map:** which `etherN` port serves which building (and which is the ISP
   uplink). A short MikroTik questionnaire (like `router-ups-client-questionnaire.md`) captures
   this in Phase 0.

---

## 11. Status & next steps (phased)

- [x] **Phase 0 — Decisions.** Branch base **B** (stacked on `router-ups-monitoring`). RouterOS API
      via `node-routeros` (works v6 + v7). `devices.device_type` is an **ENUM** → migration adds
      `'mikrotik'`. `mikrotik_devices` + `network_interfaces` already exist in V10.
- [x] **Phase 1 — Schema + crypto.** `migrations/2026-06-20_mikrotik_device.sql` (ENUM `+'mikrotik'`,
      `use_tls`, drops `firmware_version`, seed template) + `mikrotikCrypto.js` (AES-256-GCM) +
      `MIKROTIK_ENC_KEY`. ⚠️ **Run the migration before adding a router.**
- [x] **Phase 2 — Collector.** `mikrotikClient.js` (RouterOS API, lazy-loads `node-routeros`) +
      `mikrotikPollerService` → shared `writeNetworkSample()` → `networkMetrics`/`networkStatus`,
      on a 30s `setInterval`. ⏳ live test against the dev MikroTik not yet run.
- [x] **Phase 3 — Page + admin.** `MikrotikMonitoring.tsx` (per-port = per-building rows,
      CPU/mem/clients, throughput history) + **Add MikroTik** (`POST /api/mikrotik`) + **Configure**
      + **Test connection** (admin). Route / sidebar / role wired.
- [x] **Phase 4 — Detail.** Split into a fleet **list** (`MikrotikMonitoring.tsx`) and a per-router
      **detail** page (`MikrotikDetail.tsx`), reached via **View** — an in-page swap mirroring
      ServerMetrics ↔ ServerDetail and NetworkMonitoring ↔ NetworkDetail. Detail carries stat tiles,
      a Chart.js throughput chart with a **per-port selector**, a WinBox-style port table
      (flags / Tx / Rx / errors / leases / utilization), the **port label editor**, connection info
      and the event log. Live throughout — history re-fetches each poll and `deviceLog` streams in.
- [x] **Phase 5 — Alerting.** **Real alerts wired** via `services/deviceAlerts.js` (shared by the
      MikroTik + SNMP pollers): router CPU/mem/clients, per-interface link utilization, and UPS
      charge/runtime/load are evaluated against the configurable `alert_rules` (band + hysteresis via
      `alertRulesService.nextBand`) and raise real alerts through `notificationService.raiseAlert`
      (bell + toast + email + the Alerts page), auto-resolving on recovery (`alertsService`). Boolean
      events (interface down, UPS on-battery, and device offline/unreachable via checkReachability) raise directly, like server 'offline'. Global default
      thresholds are seeded by `migrations/2026-06-30_router_ups_alert_rules.sql` (⚠️ run it, or
      rules-only means silent), and the **Alert Rules** admin page now lists these metrics.
      Per-device overrides are now selectable: the Alert Rules scope dropdown lists servers, routers /
      MikroTik and UPS in grouped sections, and the metric list narrows to that device class.
      Interface **error rate** (`link_errors`) was added on 2026-07-31 — seeded by
      `migrations/2026-07-31_link_errors_alert_rule.sql`, measured as the per-poll DELTA so a
      long-running router isn't permanently in alarm over old errors.
- [ ] **Phase 6 — Polish.** ~~PiP `network.summary` tile~~ ✅ (see §13.6); live test on the dev
      MikroTik then campus still outstanding.

> **Removed:** the `MIKROTIK_MOCK` synthetic-data mode (built during scaffolding, dropped at request
> — live RouterOS only). `node-routeros` is now a required backend dependency.

---

## 12. Key files (when building)

| File | Role |
|------|------|
| `backend/services/mikrotikPollerService.js` | poll loop for the one device (mirror of `snmpPollerService.js`) — **new** |
| `backend/services/mikrotikClient.js` | RouterOS API/REST wrapper — **new** |
| `backend/services/mikrotikCrypto.js` | AES-256-GCM for `api_password` — **new** |
| `backend/routes/mikrotik.js` | `/api/mikrotik` connection + ports + history/logs (admin gates) — **new** |
| `migrations/2026-06-20_mikrotik_device.sql` | ENUM `+'mikrotik'` + `use_tls` + seed template (`mikrotik_devices` / `network_interfaces` already in V10) — **new** |
| `backend/handlers/networkMetricsHandler.js` | `writeNetworkSample()` — **REUSED** (from router-ups) |
| `backend/handlers/networkHistoryHandler.js` | Flux history — **REUSED** (from router-ups) |
| `network_interfaces` table | port → label mapping (edited from the Ports panel) — **REUSED** (from router-ups) |
| `backend/services/snmpPollerService.js` | the structure this poller mirrors — **reference** |
| `frontend/src/pages/MikrotikMonitoring.tsx` | fleet **list** page (View / Configure / Remove per row) — **new** |
| `frontend/src/pages/MikrotikDetail.tsx` | per-router **detail** page (in-page swap, mirrors ServerMetrics ↔ ServerDetail) — **new** |
| `migrations/2026-07-31_link_errors_alert_rule.sql` | seeds the `link_errors` thresholds — **new** (⚠️ run it, or error alerting is silent) |
| `frontend/src/pages/NetworkMonitoring.tsx` | the SNMP router page; shares the collector + events — **reference** |
| `frontend/src/api/api.ts` | MikroTik connection/history calls — **edit** |
| `frontend/src/components/layout/Sidebar.tsx` | nav item + offline badge — **edit** |
| `router-ups-monitoring.md` | sibling feature (sources C+D); shared data model — **reference** |

---

## 13. How it works — study guide (the real implementation)

> Read this with the code open. The feature is the **pull mirror** of the Go-agent server pipeline:
> instead of an agent pushing, our backend connects out to the MikroTik and pulls.

### 13.1 Runtime data flow (one poll cycle, every ~30s)

```
server.js  setInterval(MIKROTIK_POLL_INTERVAL_MS)
   │
   ▼
mikrotikPollerService.pollAll(io)
   │  loadDevices() ── SELECT devices(type='mikrotik') JOIN mikrotik_devices
   │                   (api_enabled=1, has ip + username)
   │
   ├─ for the device:
   │    connFor(d)        decrypt api_password (mikrotikCrypto.decrypt) → {host,port,tls,user,password}
   │    collect(d,labels) ── mikrotikClient.collect(conn) over the RouterOS API:
   │                          /system/resource          → cpu, mem, uptime, version, board
   │                          /interface print stats     → per-port rx/tx bytes, errors, running
   │                          /interface/ethernet        → link speed (for utilization)
   │                          /ip/dhcp-server/lease      → bound-lease count = connected clients
   │                        withUtilization() → (byte delta vs last cycle ÷ link speed) → utilization_pct
   │                        attach locationLabel from network_interfaces (port → label)
   │    setReachable(io,d,true)       flip devices.status; log device_logs on transition; emit networkStatus
   │    writeNetworkSample(io,d,sample)   ← SHARED with the SNMP poller:
   │         InfluxDB  router_metrics (cpu/mem/uptime/clients) + network_traffic (per port, cumulative)
   │         emit "networkMetrics" { device:{ …, type:"mikrotik", interfaces:[…] } }
   │    checkThresholds()             log a port-down transition → device_logs + deviceLog
   │    cache in `latest` (so GET /api/mikrotik renders instantly) + UPDATE mikrotik_devices.last_seen
   │
   └─ on throw (unreachable) → setReachable(io,d,false) → status Offline + networkStatus
```

Browser: `MikrotikMonitoring.tsx` fetches `GET /api/mikrotik` once, then live-updates from the
`networkMetrics` / `networkStatus` socket events (filtered to `type==="mikrotik"` — the events are
**shared** with the SNMP Network page, which ignores `mikrotik`).

### 13.2 The files (read in this order)

| # | File | Role |
|---|------|------|
| 1 | `backend/services/mikrotikCrypto.js` | AES-256-GCM encrypt/decrypt of the API password (`MIKROTIK_ENC_KEY`) |
| 2 | `backend/services/mikrotikClient.js` | RouterOS API reads → the shared sample shape; lazy-loads `node-routeros` |
| 3 | `backend/services/mikrotikPollerService.js` | the core — loadDevices, collect, utilization, setReachable, pollAll, getMikrotikDevices, createDevice, saveConnection, testConnection |
| 4 | `backend/handlers/networkMetricsHandler.js` | `writeNetworkSample()` — InfluxDB write + `networkMetrics` (SHARED, from router-ups) |
| 5 | `backend/routes/mikrotik.js` | REST: list / create / connection / test / history / logs |
| 6 | `backend/src/server.js` | mounts `/api/mikrotik` + the poll `setInterval` |
| 7 | `frontend/src/pages/MikrotikMonitoring.tsx` | the **list** page + `AddModal` + `ConnectionModal` + `PasswordField` + remove-confirm |
| 8 | `frontend/src/pages/MikrotikDetail.tsx` | the **detail** page (in-page swap via "View"): stat tiles, throughput chart with a per-port selector, the WinBox-style port table, the label editor, event log. Owns the shared `MkDevice` / `MkIface` types |
| 9 | `frontend/src/api/api.ts` | `getMikrotikDevices` / `addMikrotik` / `deleteMikrotik` / `saveMikrotikConnection` / `testMikrotik` / `get|saveMikrotikInterfaces` / history / logs |
| — | `backend/services/snmpPollerService.js` | the sibling this mirrors — read side-by-side |

### 13.3 REST surface (`/api/mikrotik`, all behind JWT `authMiddleware`)

| Method / Path | Role | Purpose |
|---|---|---|
| `GET /` | any | list MikroTik(s) + latest live values (password is **never** returned) |
| `POST /` | admin | register a router (creates `devices` + `mikrotik_devices` rows; encrypts password). `409` if the name is taken |
| `DELETE /:id` | admin | decommission — cascades to `mikrotik_devices` / `network_interfaces` / `device_logs` / `alerts`; emits `networkRemoved` |
| `PUT /:id/connection` | admin | update port / TLS / username / password |
| `POST /test` | admin | probe credentials **before** the device exists (Add form) — nothing persisted |
| `POST /:id/test` | admin | probe the API; body may carry credentials to test instead of the stored ones (blank password = use stored) |
| `GET /:id/interfaces` | any | port → label map (`network_interfaces`) |
| `PUT /:id/interfaces` | admin | set port labels; a blank label deletes that port's row |
| `GET /:id/history?range=-1h\|-6h\|-24h\|-7d\|-30d[&interface=ether3]` | any | throughput from InfluxDB (shared handler). Without `interface` = device totals; with it = that single port |
| `GET /:id/history?start=<ISO>&stop=<ISO>[&interface=ether3]` | any | the same, over a **custom absolute window**. Presets and custom bounds are resolved by `services/historyRange.js`, which also owns the Flux-injection guarantee; a malformed custom window is a 400 |
| `GET /:id/logs` | any | device event log (`device_logs`) |

### 13.4 Operational flow (how an admin uses it)

1. **Once:** run `migrations/2026-06-20_mikrotik_device.sql`, set `MIKROTIK_ENC_KEY` in `backend/.env`, restart the backend.
2. **Router:** enable the API + create a read-only user (`mikrotik-dev-setup.md`).
3. Dashboard → **MikroTik** → **+ Add MikroTik** → name / IP / port / username / password → **Add**.
4. **Configure** edits creds later; **Test connection** verifies. The poller then streams every ~30s.
5. **Port labels:** open a router → **View** → Ports panel → **Edit labels** (admin). Name each port
   by what it connects to; blank clears it and the raw RouterOS name shows instead. Saved to
   `network_interfaces` and pushed live, no poll wait.

### 13.5 What changed from the original plan (§1–§12)

- **`mikrotik_devices` already existed** in the V10 schema (1:1 detail table, like `server_specs` /
  `ups_details`) — kept it; the migration only adds `use_tls` + drops the unused `firmware_version`.
- **`device_type` is an ENUM** (not free-form) — the migration appends `'mikrotik'`.
- **Add-from-UI** (`POST /api/mikrotik` + `AddModal`) was added so registering a router needs no SQL.
- **Mock mode removed** — `MIKROTIK_MOCK` was built during scaffolding, then dropped; live only.
- **`api_password`** stays `VARCHAR(255)`, holding AES-GCM ciphertext (base64) — no column change.

### 13.6 Known gaps / next

Closed on 2026-07-31:

- ~~Live test against the dev MikroTik~~ — done on an RB951G-2HnD / RouterOS 6.43.4; found and
  fixed the `=stats=` rejection and the virtual-interface leak (see the status note at the top).
- ~~Port labeling UI~~ — `GET/PUT /api/mikrotik/:id/interfaces` + an **Edit labels** editor in the
  Ports panel (admin). Blank label deletes the row; changes are pushed live, no poll wait.
- ~~Per-device alert-rule overrides~~ — the Alert Rules scope dropdown now lists servers, routers /
  MikroTik and UPS in grouped sections, and the metric list narrows to whatever that device class
  supports.
- ~~Per-port client counts~~ — leases grouped by DHCP server → interface, with a total-only fallback.
- ~~Interface error alerting~~ — new `link_errors` metric on the per-poll error DELTA (not the
  lifetime counter), seeded by `migrations/2026-07-31_link_errors_alert_rule.sql`.
- ~~Test connection required saving first~~ — `POST /api/mikrotik/test` (no id) plus body
  credentials on `/:id/test`, so a login is verified before anything is persisted.
- ~~API-SSL unusable~~ — TLS options now tolerate RouterOS's self-signed certificate by default;
  set `MIKROTIK_TLS_VERIFY=true` (+ optional `MIKROTIK_TLS_CA`) once a CA-signed cert is installed.

Still open:

- **Per-port history is device-wide by default.** `GET /:id/history?interface=ether3` charts one
  port, but the *alert* rules for `link_util` / `link_errors` are still per-DEVICE — one threshold
  covers every port on that router. Per-interface rules would need a different rule model.
- ~~PiP `network.summary` tile~~ — shipped. Counts **ports** up/total across SNMP routers *and*
  MikroTiks (they share the `networkMetrics` stream) plus peak link utilization. Opt-in from
  Settings → Customize Widget. See `pip-widget.md` §3.1.
- **Production hardening:** API-SSL with a real certificate, and the API firewalled to the backend
  host only. See §3 and `mikrotik-dev-setup.md`.
