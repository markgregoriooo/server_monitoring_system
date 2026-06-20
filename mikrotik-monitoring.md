# MikroTik Network Monitoring — CSPC-ICTU Monitoring

> Status: **PLAN** (branch `mikrotik-monitoring`). Nothing implemented yet — this is the
> design of record. Update §11 as phases land.

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
      │                                 │   (one row per interface = per building)
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
| **Connected clients per building** | ✅ DHCP leases (per interface/subnet) | ⚠️ hard / not portable |
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
| Interface up/down | `/interface print` `running` / `disabled` | per port = per building |
| Interface errors/drops | `/interface print stats` `rx-error` / `tx-error` | cumulative |
| Link speed (for util %) | `/interface/ethernet print` `rate` | optional |
| **Connected clients (per building)** | `/ip/dhcp-server/lease print` grouped by `server`/interface | ⚠️ only breaks down per building if each building is its own subnet / DHCP server / VLAN — see §10 Q3 |

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

- `network_traffic` — **per interface (= per building), per poll**: `rx_bytes`/`tx_bytes`
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

- [ ] **Phase 0 — Decisions.** Branch base ✅ **decided: B** (stack on `router-ups-monitoring`;
      re-point the branch at the start of Phase 1). Still to resolve from the questionnaire:
      RouterOS version, per-building subnets, API access, port→building map. Confirm
      `devices.device_type` is `VARCHAR`. Pick `node-routeros` vs REST.
- [ ] **Phase 1 — Schema + crypto.** ✅ migration written: `migrations/2026-06-20_mikrotik_device.sql`
      (ENUM `+'mikrotik'` + `use_tls`; `mikrotik_devices` + `network_interfaces` already exist in
      V10) — run it + fill the seed template. Then `mikrotikCrypto.js` (AES-256-GCM) +
      `MIKROTIK_ENC_KEY`. Acceptance: the device + encrypted creds round-trip; ports map to buildings.
- [ ] **Phase 2 — Collector.** `mikrotikClient.js` + `mikrotikPollerService.collectMikrotik()`
      returning the shared sample shape (per port) → `writeNetworkSample()` → `networkMetrics`
      broadcast, on `MIKROTIK_POLL_INTERVAL_MS`. Acceptance: the **dev MikroTik** streams live,
      values match Winbox; offline flip works.
- [ ] **Phase 3 — Page.** The MikroTik on the Network page with per-building (per-port) rows +
      admin connection form ("Test connection") + editable port→building labels + nav badge.
- [ ] **Phase 4 — Detail.** Per-port rx/tx charts + link state + clients + device CPU/mem/uptime
      + recent events (mirror `ServerDetail`).
- [ ] **Phase 5 — Alerting.** Port-down / offline-online / link-util / CPU-mem via `alert_rules`
      + `device_logs`, through the existing notification + Alerts lifecycle.
- [ ] **Phase 6 — Polish + docs.** PiP `network.summary` tile, MikroTik questionnaire, live test
      on the dev MikroTik then the campus MikroTik, update `CLAUDE.md` + `SESSION_NOTES.md`.

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
| `network_interfaces` table | port → building mapping — **REUSED** (from router-ups) |
| `backend/services/snmpPollerService.js` | the structure this poller mirrors — **reference** |
| `frontend/src/pages/NetworkMonitoring.tsx` | the page to extend (per-building rows) — **REUSED/extend** |
| `frontend/src/api/api.ts` | MikroTik connection/history calls — **edit** |
| `frontend/src/components/layout/Sidebar.tsx` | nav item + offline badge — **edit** |
| `router-ups-monitoring.md` | sibling feature (sources C+D); shared data model — **reference** |
