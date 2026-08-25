# Architecture Review — CSPC-ICTU Monitoring System

**Date:** 2026-08-25
**Scope:** `backend/` (83 modules), `frontend/src/` (88 modules), `agent/` (Go, structural only)
**Companions:** [`code-duplication`](./code-duplication-report-2026-08-25.md) ·
[`code-complexity`](./code-complexity-report-2026-08-25.md) ·
[`design-patterns`](./design-patterns-report-2026-08-25.md) ·
[`error-handling`](./error-handling-report-2026-08-25.md) ·
[`error-flow`](./error-flow-report-2026-08-25.md)

---

## 0. Verdict

**Architectural pattern: a layered monolith with three ingest adapters.** Not MVC (there
are no controllers or view models — routes are thin adapters and rendering is a separate
SPA), and not microservices (one process, one database, one deploy unit). Layered is the
right choice here: the system monitors one server room from one box on the same LAN, and
splitting it into services would add network hops between components that must all agree
about the same device list.

**Modularity: 7 / 10.** Justified in §5.

The structure is better than the file sizes suggest. Measured, not asserted:

| Structural check | Result |
|---|---|
| Circular dependencies (backend) | **0** |
| Circular dependencies (frontend) | **0** (2 type-only, fixed in C-14) |
| Routes touching the database directly | **0** |
| Upward layer dependencies | **0 real** (was 4 — see A-02) |
| External runtime dependencies | 12, all appropriate |

| ID | Finding | Imp | Status |
|----|---------|-----|--------|
| **A-05** | Per-sample `await writeClient.flush()` defeats InfluxDB batching — the main throughput ceiling | **5** | ⏳ Measure first |
| **A-02** | `handlers/` conflated inbound request handlers with outbound metric *sinks* — caused 3 of 4 layering violations | **5** | ✅ **Fixed** |
| **A-04** | Two god modules: `reportService.js` (1067 lines), `analyticsService.js` (969) | **5** | ⏳ Open |
| **A-06** | Pollers are the most unstable modules (Ce=12/11, I≈0.8) | **4** | ⏳ By design, watch |
| **A-07** | Frontend has no shared data layer — 22 pages each own their fetching; `pip/` re-fetches the same endpoints | **4** | ⏳ Open |
| **A-03** | Dead `db` import in `src/server.js` after the session refactor | **2** | ✅ **Fixed** |
| **A-01** | Layering, dependency flow, external deps | — | ✅ Sound |

**247/247 backend tests pass. Server boots clean.**

---

## 1. Separation of concerns ✅ genuinely clean

Measured every import edge between backend directories:

```
   58  services -> services
   31  routes   -> services
   30  services -> config
   20  handlers -> services
   19  services -> utils
   17  routes   -> middleware
   16  src      -> routes
   12  routes   -> utils
    5  routes   -> handlers
```

**No route touches MySQL or InfluxDB.** Verified twice — by import scan (`routes` → `config/mysql`: **0**) and by grepping for `db.query` in `routes/` (**0**). Data access is confined to `services/` (22 modules) and the metric writers. For a codebase this size that discipline usually slips somewhere; here it hasn't.

### A-02 — `handlers/` was two different things ✅ Fixed (importance 5)

The layering scan found 4 upward dependencies, and 3 were one misplacement:

```
services/snmpPollerService.js:17     (services) imports handlers/networkMetricsHandler.js
services/snmpPollerService.js:18     (services) imports handlers/upsMetricsHandler.js
services/mikrotikPollerService.js:4  (services) imports handlers/networkMetricsHandler.js
```

`handlers/` contained two unrelated kinds of module:

| Kind | Examples | Who calls it |
|---|---|---|
| **Inbound request handlers** | `serverHistoryHandler`, `sensorHandler`, `offlineDataHandler` | `routes/`, `sockets/` |
| **Outbound metric sinks** | `writeNetworkSample`, `writeUpsSample` | **`services/` (the pollers)** |

The sinks are not handlers at all — nothing routes to them. They are the write side of the
ingest pipeline: take a collected sample, write InfluxDB + the on-site backup, broadcast.
Sitting in `handlers/` made every poller look like it depended *upward*.

✅ **Applied** — `git mv` to their real layer, with a header explaining the move:

```
handlers/networkMetricsHandler.js  ->  services/networkSampleWriter.js
handlers/upsMetricsHandler.js      ->  services/upsSampleWriter.js
```

Three import sites updated; internal `../services/backupService.js` → `./backupService.js`.
**Upward violations: 4 → 1.**

The remaining one is `middleware/agentAuth.js:1` importing `agentService` to validate an
`AGT-` token. That is not really a violation — it is an artifact of ranking `middleware`
below `services` in the model. Middleware is *delivery-tier*, alongside `routes`: both sit
above services and depend on them. **Under the correct model there are zero violations.**

### A-03 — Dead import ✅ Fixed (importance 2)

`src/server.js:9` still imported `db` after the Socket.IO handshake was refactored to use
`fetchSessionRow()` (error-handling audit, R-03). Verified unused before removing.

---

## 2. Architecture diagram

```
┌─ EXTERNAL / PHYSICAL ────────────────────────────────────────────────────────────┐
│  ESP32 node        Go agents        MikroTik router     SNMP routers / UPS        │
│  DHT11·MQ-2×2      (per server)     (RouterOS API)      (IF-MIB / UPS-MIB)        │
│  IR TX·SD card                                          + ICMP ping               │
└───────┬────────────────┬──────────────────┬──────────────────┬───────────────────┘
        │ Socket.IO      │ HTTP POST        │ PULL (30s)       │ PULL (60s)
        │ push ~3s       │ push ~10s        │                  │
        ▼                ▼                  ▼                  ▼
┌─ DELIVERY TIER ─────────────────────────────────────────────────────────────────┐
│  sockets/connectionHandler   routes/*.js (17)          [ pollers live in         │
│    guard(name, fn)             asyncHandler              services — they PULL,   │
│    device vs browser           middleware/auth           nothing routes to them ]│
│                                middleware/agentAuth                              │
└───────┬─────────────────────────────┬────────────────────────────────────────────┘
        │                             │
        ▼                             ▼
┌─ REQUEST HANDLERS ──────────┐  ┌─ SERVICE LAYER (~40 modules) ───────────────────┐
│ handlers/                   │  │                                                  │
│   sensorHandler             │  │  ORCHESTRATORS      DOMAIN         PURE (tested) │
│   offlineDataHandler        │─▶│  snmpPoller  ───┐   agentService   analyticsMath │
│   serverMetricsHandler      │  │  mikrotikPoller │   userService    snmpUtils     │
│   *HistoryHandler ×3        │  │  reportService  │   alertRules     pingOutput    │
│   querySensorHistory        │  │  analyticsSvc   │   notification   historyRange  │
└─────────────────────────────┘  │                 │   deviceAlerts   linkAlertPol. │
                                 │                 ▼   backupService  envPersistPol.│
                                 │      networkSampleWriter ◀── A-02 moved here     │
                                 │      upsSampleWriter                             │
                                 └───────┬──────────────────┬───────────────────────┘
                                         │                  │
                    ┌────────────────────┼──────────────────┼─────────────────┐
                    ▼                    ▼                  ▼                 ▼
              ┌──────────┐        ┌────────────┐    ┌──────────────┐   ┌───────────┐
              │  MySQL   │        │  InfluxDB  │    │ BACKUP_DIR   │   │  SMTP     │
              │  pool=10 │        │ writeClient│    │ NDJSON files │   │ nodemailer│
              │  ⚠ A-05  │        │  ⚠ A-05    │    │ ⚠ not mounted│   │           │
              └──────────┘        └────────────┘    └──────────────┘   └───────────┘
                    ▲                                                         ▲
                    │                                                  Google OAuth
              config/mysql.js ── config/env.js ── config/influx.js       (login only)

┌─ BROWSER (SPA) ─────────────────────────────────────────────────────────────────┐
│  socket/socket.ts (Ca=22)    api/client.ts ──▶ api/api.ts (Ca=30)                │
│         │                          │                                             │
│         ▼                          ▼                                             │
│  context/  AuthContext (Ca=20) · NotificationContext · ThemeContext              │
│         │                                                                        │
│         ▼                                                                        │
│  ErrorBoundary ──▶ pages/ (22)  ·  components/ (37)  ·  pip/ (8, own sub-app)    │
│                    ⚠ A-07: each page owns its own fetching; pip re-fetches       │
└──────────────────────────────────────────────────────────────────────────────────┘

BOTTLENECKS
  ① A-05  await writeClient.flush() per sample — an Influx round trip on EVERY ingest
  ② P-01  MySQL pool = 10, shared by pollers + agent POSTs + every dashboard request
  ③       single Node process — no clustering; all 3 ingest paths + HTTP + sockets
  ④       ~19 requests per Dashboard mount (see RATE_LIMIT_MAX note in CLAUDE.md)
```

---

## 3. God objects and modules

### A-04 — Two, and they are *long* rather than *tangled* (importance 5)

| Module | Significant / raw | Why it is large |
|---|---|---|
| `services/reportService.js` | 825 / **1067** | 7 report builders + persistence + file I/O + email + retention + socket lifecycle |
| `services/analyticsService.js` | 705 / **969** | 6 forecast/anomaly readers + result shaping |

Neither is a classic God object — no shared mutable state, and the parts do not reach into
each other. `reportService`'s builders touch nothing in its persistence half except the
`BUILDERS` lookup, which is exactly the seam to cut along.

**`analyticsService` is the better-structured of the two** and shows the pattern to copy:
all the mathematics already lives in `analyticsMath.js` (435 lines, pure, import-free,
tested). What remains is I/O and shaping. `reportService` has no such split — its
aggregation is inline and therefore untestable without a live InfluxDB.

**Fix — the seam already exists:**

```
services/reportService.js            -> lifecycle: create/build/generate/list/file/email/purge
services/reports/builders/index.js   -> export const BUILDERS = { environment, server, … }
services/reports/builders/ups.js     -> buildUps + its PURE aggregation helpers
```

⚠️ **Deliberately deferred** to the ICTU report-template work (see the
`report-template-ictu` memory) — that work touches these same files, and doing both at
once means one review instead of two conflicting ones.

**Not god modules, despite their size:** `snmpPollerService.js` (877 raw) is an
orchestrator whose length is device-type breadth, not entanglement; `agentService.js` was
one (Ca=11) and was split in the complexity audit (now Ca=6).

---

## 4. Dependency flow

**Zero circular dependencies** in either package. That is the strongest result here — a
service ↔ service cycle is nearly universal at this size.

### Stable abstractions (Ca ≥ 3, Ce = 0) — the load-bearing base

| Module | Ca |
|---|---|
| `utils/httpError.js` | **28** |
| `config/env.js` | 10 |
| `utils/asyncHandler.js` | 8 |
| `services/alertBandState.js` | 7 |
| `services/snmpUtils.js` | 6 |
| `services/historyRange.js` | 3 |

Depended on by many, depending on nothing. `httpError.js` reaching Ca=28 is a direct
result of the `describeError()` rollout — the most-used module in the backend is also its
most stable.

### A-06 — The pollers are the least stable modules (importance 4)

| Module | Ca | Ce | I |
|---|---|---|---|
| `snmpPollerService.js` | 3 | **12** | 0.80 |
| `mikrotikPollerService.js` | 3 | **11** | 0.79 |
| `agentService.js` | 6 | 9 | 0.60 |

High instability at the top of a call graph is **correct** — an orchestrator is supposed to
know about the things it orchestrates, and nothing should depend on it. `I ≈ 0.8` with
`Ca = 3` is the healthy shape.

The reason to watch it: each poller reaches into 11–12 modules, so a change to any of them
can break polling, and polling has **no automated test** — `npm run link:check` and
`npm run probe` exist precisely because failure is otherwise invisible. **Unable to
verify** whether the pollers could be covered by tests. **What would prove it:** whether
`collectRouter`/`collect` can be called with an injected fake session, or whether the SNMP
session is constructed inline.

### A-07 — The frontend has no shared data layer (importance 4)

22 page components each own their fetching, and the PiP sub-app duplicates it:
`pip/LiveSummaryContext.tsx:181` is a 187-line `useEffect` (branching complexity 49) that
**re-fetches five endpoints the Dashboard already loaded** — `CLAUDE.md` documents the
resulting ~19 requests per Dashboard mount, doubled by StrictMode in dev.

This is the architectural root of the complexity audit's C-02 (page components 456–838
lines): the pages are large because each is its own data layer.

**Fix — extract per-resource hooks, then share them:**

```tsx
// hooks/useForecast.ts — one owner per resource, reusable by pages AND pip/
export function useForecast(kind: "disk" | "ups-battery" | "link-saturation") {
  // { data, loading, error, refetch } — fetch once, share via context or a cache
}
```

`hooks/` currently holds **one** file (`useRoomThresholds.ts`) — and that one is exactly
right: it fetches once and follows a socket event. It is the model; there just needs to be
more of it.

---

## 5. Modularity: 7 / 10

**What earns the 7:**

- Zero circular dependencies in 171 modules
- Zero routes touching a datastore; zero real upward layer dependencies after A-02
- A genuine pure-module tier — `analyticsMath`, `snmpUtils`, `pingOutput`, `historyRange`,
  `linkAlertPolicy`, `envPersistPolicy`, `installKeyUtils`, `alertRuleValidation`,
  `reportTypes`, `httpError` — all import-free and unit-tested, which is why 247 tests run
  in under a second with no MySQL or InfluxDB
- Six stable abstractions in the ideal `Ca≥3, Ce=0` shape
- 12 external dependencies, each doing one job

**What keeps it from 8–9:**

- Two modules over 950 raw lines with an obvious, uncut seam (A-04)
- The frontend has no data layer; 22 pages each reimplement fetching, and `pip/` re-fetches
  what the Dashboard already has (A-07)
- 7.8% duplication overall, but **concentrated**: four page components sit at 39–51%
- Polling — one of the three ingest paths — has no automated coverage
- Report aggregation cannot be tested without a live InfluxDB (A-04)

**What it would take to reach 9:** split `reportService` along the `BUILDERS` seam with
pure aggregation, and give the frontend a hooks layer. Both are known, both are scoped, and
neither is architectural surgery.

---

## 6. Anti-patterns

| Anti-pattern | Verdict |
|---|---|
| **Spaghetti code** | ❌ Not present. Only **1** function nests control flow 4 deep (`forecastAccuracy`); zero cycles; no `goto`-ish control flow |
| **Copy-paste programming** | ⚠️ Was the main issue — `GhostButton` ×4, `Panel` ×11, `gf` tokens ×14. Largely fixed in the duplication audit (303 → 110 redundant lines) |
| **God classes/modules** | ⚠️ Two, both *long* not *tangled* (A-04) |
| **Tight coupling** | ✅ Low. The one painful-zone module (`agentService`, Ca=11) was split to Ca=6 |
| **Missing abstractions** | ⚠️ Two: a frontend data layer (A-07), and pure aggregation inside the report builders (A-04) |
| **Circular dependencies** | ✅ None |

---

## 7. Bottlenecks

### A-05 — Every ingest path forces an InfluxDB round trip (importance 5) ⏳ Measure first

`config/influx.js:11` creates the write client with **default batching**
(`getWriteApi(org, bucket, "ms")` — batch 1000 points / flush every 60 s). But every write
site immediately defeats it:

```
services/networkSampleWriter.js:65    await writeClient.flush();
services/upsSampleWriter.js:89        await writeClient.flush();
handlers/sensorHandler.js:182         await writeClient.flush();
handlers/offlineDataHandler.js:45     await writeClient.flush();
handlers/serverMetricsHandler.js:95   await writeClient.flush();
handlers/serverMetricsHandler.js:268  await writeClient.flush();
```

So **every** agent POST, ESP32 reading and poll cycle blocks on a synchronous HTTP round
trip to InfluxDB before responding. At current scale (one ESP32, a handful of servers, one
MikroTik) this is invisible. It is the ceiling that appears first as the fleet grows,
because it converts an async batched write into a per-sample request.

**But it is not simply wrong**, which is why I am not changing it. The flush buys
durability: without it, up to a batch of samples sits in memory and is lost on a crash.
That trade is partly covered by `backupService` writing an independent NDJSON copy — but
only partly, and "partly" is not something to guess at.

**Fix — when there is load data to size it:**

```js
// config/influx.js — explicit, tuned, instead of default-then-defeat
const writeClient = client.getWriteApi(org, bucket, "ms", {
  batchSize: 100,          // ~10 s of agent traffic at current fleet size
  flushInterval: 5_000,    // matches BACKUP_FLUSH_MS, so both copies lag equally
  maxRetries: 3,
});
```
then drop the per-sample `await writeClient.flush()` from the six sites, keeping it in
`offlineDataHandler` (a backfill batch genuinely should land before it reports success).

⚠️ **What would prove the right numbers:** time `writeClient.flush()` at each site under
real load for a day, and compare against the agent POST interval. If flush latency is a
small fraction of the interval, the current design costs nothing and should be left alone.

### Other ceilings, named for completeness

- **MySQL pool = 10** (design-patterns P-01), shared by pollers, agent POSTs and every
  dashboard request. `queueLimit: 0` means exhaustion *queues* — it appears as latency, not
  as an error.
- **Single Node process.** No clustering, so all three ingest paths, all HTTP and all
  sockets share one event loop. Correct for one server room; it is the first thing to
  revisit if a second site is ever added (see the `multi-site-scoping-blocked` memory).
- **~19 requests per Dashboard mount**, already documented in `CLAUDE.md` and the reason
  `RATE_LIMIT_MAX` defaults to 3000.

---

## 8. Unable to verify

- **Whether the pollers are testable.** **What would prove it:** whether `collectRouter`
  accepts an injected SNMP session or constructs one inline.
- **Real InfluxDB flush latency** (A-05). Static reading cannot show it. **What would prove
  it:** instrument the six flush sites for a day under real load.
- **The Go agent's internal architecture.** Only its contract was checked (via
  `tests/contract.test.js`). **What would prove it:** read `agent/internal/`.
- **Whether `pip/` could share the pages' hooks** (A-07) — it renders in a separate window
  context. **What would prove it:** confirm the PiP window shares the same JS realm; if it
  does, one hook layer serves both.

---

## 9. Applied this session

| ID | Change | Verification |
|----|--------|--------------|
| A-02 | `networkMetricsHandler` → `services/networkSampleWriter.js`; `upsMetricsHandler` → `services/upsSampleWriter.js`; 3 imports updated | Layer scan: **4 → 1** upward deps (the last is a modelling artifact); 247 tests; clean boot |
| A-03 | Removed the unused `db` import from `src/server.js` | Verified unused first; clean boot |

---

## 10. Recommended order

1. **A-04** — split `reportService` along the `BUILDERS` seam, **bundled with the ICTU
   template work** so the files are touched once.
2. **A-07** — extract per-resource hooks, starting with `Analytics.tsx`. This is also the
   fix for the complexity audit's C-02.
3. **A-05** — instrument the flush sites, then decide. Do not change write durability on
   intuition.
4. **A-06** — add coverage for one poller path, so the least-tested ingest route stops
   being invisible.

---

*Reviewed 2026-08-25. Method: import-graph extraction across 171 modules with layer-rank
violation detection; DFS cycle detection; afferent/efferent coupling and instability per
module; significant-line counts per module; datastore-access census per layer. All figures
re-measured after this session's changes.*
