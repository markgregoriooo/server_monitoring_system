# Design Pattern Review — CSPC-ICTU Monitoring System

**Date:** 2026-08-25
**Scope:** `backend/`, `frontend/src/` — tests, `node_modules/`, `dist/` excluded
**Companions:** [`code-duplication-report-2026-08-25.md`](./code-duplication-report-2026-08-25.md) ·
[`code-complexity-report-2026-08-25.md`](./code-complexity-report-2026-08-25.md)

---

## 0. Summary

**This codebase does not have a pattern problem.** The patterns that are present are, with
one exception, correctly implemented and appropriate for the use case — several are better
than what you would find in a typical project of this size. The findings below are mostly
about *consistency* (two ways of doing one thing) and *one missing pattern* that would
close a real gap.

The one exception is P-08, where a Strategy registry had been spread across four parallel
maps such that a missing entry failed silently. That is fixed.

| Layer | Verdict |
|---|---|
| Creational | Correct. Singletons use ESM module caching, which is the right idiom in Node ESM |
| Structural | **Strongest layer.** The adapters around SNMP / RouterOS / `ping` / SMTP are exemplary |
| Behavioral | Correct, with one registry defect (fixed) and one absent pattern (P-11) |
| Domain | Service-layer, no Repository. Defensible at this size — see P-12 |

| ID | Layer | Finding | Imp | Status |
|----|-------|---------|-----|--------|
| **P-08** | Behavioral | Strategy registry split across **4 parallel maps**; 3 of 4 omissions fail silently | **7** | ✅ **Fixed** |
| **P-11** | Behavioral | **No Command/queue** — `pending` rows orphaned by a restart were never reconciled | **5** | ✅ **Fixed** (sweep) |
| **P-09** | Behavioral | Two competing ways to reach `io`; a pre-`init` emit dropped alerts silently | **4** | ✅ **Partly fixed** |
| **P-01** | Creational | MySQL pool has no explicit `connectionLimit` (silently 10, shared by 3 workloads) | **4** | ⏳ Open |
| **P-16** | Behavioral | Poller if/else dispatch on `device.type` — checked, **safe**; no change recommended | **2** | ✅ No action |
| **P-06** | Structural | Decorator (`asyncHandler`) only half adopted — 47 wrapped vs 54 hand-written | **3** | ✅ **Guarded by test** |
| **P-07** | Structural | Caching Proxy has no TTL — stale forever on an out-of-band DB edit | **3** | ⏳ Open |
| **P-12** | Domain | No Repository layer; ~190 `db.query` calls across 12 services | **3** | ⏳ By design |
| **P-14** | Domain | DTO mappers are consistent but share no contract | **2** | ⏳ Open |
| P-02, P-03, P-04, P-05, P-10, P-13, P-15 | — | Correct as implemented, no action | — | ✅ |

---

## 1. Creational patterns

### P-02 — Factory: `createCipherSuite()` ✅ exemplary, no action

`backend/services/secretCrypto.js:38` is a closure factory that binds AES-256-GCM to a
named env var, and `services/mikrotikCrypto.js:20` instantiates it as
`createCipherSuite(["MIKROTIK_ENC_KEY"])`.

What makes it a good factory rather than an indirection: the parameter changes behaviour
in a way that *matters*, and the reason is written down. `mikrotikCrypto` pins exactly one
key name and refuses the `SECRET_ENC_KEY` fallback, because accepting it would make every
RouterOS password already in the database undecryptable the day someone set that variable.

A simpler solution would **not** work here: two callers genuinely need different keys, and
`installKeyService` needs the fallback that `mikrotikCrypto` must refuse.

### P-01 — Singleton via ESM module caching ✅ correct, one config gap (importance 4)

`config/mysql.js`, `config/influx.js`, `frontend/src/socket/socket.ts` and the stateful
services all rely on ES module caching to guarantee one instance. **This is the correct
idiom** — a hand-rolled `getInstance()` in Node ESM adds ceremony for a guarantee the
module system already gives you.

The gap is configuration, not pattern. `config/mysql.js:4`:

```js
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  /* … */
  waitForConnections: true,
  port: process.env.DB_PORT || 3306,
  connectTimeout: 10000,
  queueLimit: 0
});
```

`connectionLimit` is not set, so mysql2 silently uses **10**. Three workloads share that
pool: the SNMP/MikroTik pollers (every 30–60s, several queries per device), the Go agents'
metric POSTs (every 10s per host), and every dashboard request. With `queueLimit: 0`
(unbounded queue) exhaustion does not error — requests just wait, which surfaces as "the
dashboard is slow" rather than as a connection-pool problem.

**Fix — state it, and make it tunable:**

```diff
 const pool = mysql.createPool({
   host: process.env.DB_HOST,
   user: process.env.DB_USER,
   password: process.env.DB_PASSWORD,
   database: process.env.DB_NAME,
   waitForConnections: true,
+  // Explicit, because the default (10) is shared by three very different workloads:
+  // the pollers, the agent metric POSTs, and every dashboard request. queueLimit: 0
+  // means exhaustion QUEUES rather than errors, so this shows up as latency, never as
+  // a pool error in the log.
+  connectionLimit: Number(process.env.DB_POOL_SIZE) || 10,
   port: process.env.DB_PORT || 3306,
   connectTimeout: 10000,
   queueLimit: 0
 });
```

⚠️ **Left unapplied deliberately.** Raising it without measuring just moves the bottleneck
to MySQL's `max_connections`, and lowering it could starve the pollers. **What would prove
the right number:** log `pool.pool._allConnections.length` and `_freeConnections.length`
once a minute for a day under real load. Add the line above with the default unchanged
(10) so the number is at least visible and tunable without a code change.

### P-03 — Builder ✅ correct via libraries, none needed of our own

InfluxDB's `Point` is used as a fluent builder throughout
(`handlers/networkMetricsHandler.js:27`, `upsMetricsHandler.js:24`), and pdfkit's
`PDFDocument` likewise. Both are library builders used as intended.

`upsMetricsHandler.js:31` adds the one thing a builder alone cannot give — a **field
counter**:

```js
let fields = 0;
const f = (key, v) => { if (v != null && Number.isFinite(Number(v))) { p.floatField(key, Number(v)); fields++; } };
```

so a point with tags but no fields is skipped rather than sent as invalid line protocol.
That is the correct place for that guard. **No custom Builder is warranted** — the report
payload (`{summary, table|tables}`) is a plain object assembled once, and a builder for it
would be ceremony.

---

## 2. Structural patterns

### P-04 — Adapter ✅ the strongest work in the codebase, no action

Four third-party/OS integrations, each wrapped:

| Adapter | Wraps | Notable |
|---|---|---|
| `services/snmpClient.js` | `net-snmp` | OID maps as named constants (`SYS_OID`, `IF_OID`, `UPS_OID`), `normalize()` folding Counter64 → BigInt at the boundary |
| `services/mikrotikClient.js` | RouterOS API | `collect()` / `testConnection()` — a two-function surface |
| `services/icmpPing.js` + `services/pingOutput.js` | the OS `ping` binary | **split into I/O and a pure parser** |
| `services/emailService.js` | nodemailer | no-op when SMTP is unconfigured, so the channel degrades instead of throwing |

The `icmpPing` / `pingOutput` split is the one to hold up as the model. `pingOutput.js` is
pure and import-free, so the localisation hazard it exists for — `ping` output differs by
locale, and a word-matching parser reports 100% loss on a German server — is covered by
`tests/pingOutput.test.js` with no subprocess. `icmpPing.js` keeps the messy half: argv
array (no shell), host re-validated as an IP, killed on a deadline, and **never throws**,
because total packet loss is a measurement rather than an error.

**This split is the pattern to copy** whenever a new integration appears: pure decisions in
one module with tests, I/O in a thin shell around it.

### P-05 — Facade ✅ correct

Each `services/*.js` is a facade over MySQL + InfluxDB for one domain, and routes talk only
to facades. `snmpClient.js:174`'s default export is a deliberate facade over its own named
exports. No action.

### P-06 — Decorator: `asyncHandler` is half adopted ✅ now guarded (importance 3)

`utils/asyncHandler.js` is a correct, minimal decorator:

```js
export default fn => (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); }
```

Adoption is split almost exactly down the middle:

| Using `asyncHandler` (8 files, 47 uses) | Hand-writing try/catch (9 files, 54 blocks) |
|---|---|
| `alertRules`, `alerts`, `analytics`, `environment`, `history`, `notifications`, `users`, `widgetLayout` | `agents` (12), `mikrotik` (10), `aircon` (9), `reports` (6), `servers` (6), `network` (5), `ups` (4), `auth` (1), `alertRules` (1) |

**The important part: I checked, and there is no bug here.** All **92** async route
handlers are either wrapped or guarded — zero unguarded. That matters because Express 4
does not catch a rejected promise from a handler: it becomes an unhandled rejection and the
request hangs until the client times out, which reads as "the dashboard froze" rather than
as an error.

**So the fix is not to rewrite 54 handlers.** Mechanically transforming working
error-handling carries more risk than the inconsistency does. The fix is to make the
current state *enforceable*:

✅ **Applied** — `backend/tests/routeErrorHandling.test.js` parses the route files as text
(no DB needed) and fails if any async handler is neither wrapped nor guarded. It includes a
self-check (`expected many async handlers, found N`) so a broken regex cannot make it pass
vacuously. **Verified by temporarily adding an unguarded handler: the test failed, naming
the file and line. The probe was then reverted.**

Adopt `asyncHandler` opportunistically when a route file is next touched, not as a campaign.

### P-07 — Proxy: read-through cache, no TTL (importance 3)

`services/alertRulesService.js:30-56` is a correctly-shaped caching proxy: lazy load on
first read (`if (!_cache) await reload()`), full invalidation on every mutation (`:215`,
`:244`, `:251`). Given rules are read on every metric POST and every 3s sensor reading,
caching is clearly justified.

The gap: invalidation is **only** triggered by this process's own writes. A row edited
directly in MySQL — which `CLAUDE.md` explicitly anticipates elsewhere ("or a hand-edited
row") — leaves the cache stale until the backend restarts. Alerting would then run on
thresholds nobody can see in the UI.

**Fix — a cheap safety net rather than a real invalidation channel:**

```js
const CACHE_TTL_MS = 5 * 60_000;
let _loadedAt = 0;

async function getCache() {
  if (!_cache || Date.now() - _loadedAt > CACHE_TTL_MS) {
    await reload();
    _loadedAt = Date.now();
  }
  return _cache;
}
```

One query every 5 minutes against a table with a handful of rows. ⚠️ Note the same sweep
reasoning `socketSessions.js` uses: a poll cannot miss a write path the way a
push-on-mutation can.

---

## 3. Behavioral patterns

### P-08 — Strategy registry was four parallel maps ✅ **Fixed** (importance 7)

`reportService.js` dispatched report generation through a Strategy map — the right pattern.
But the strategy was only one of **four** structures keyed by the same type string:

| Structure | Was at | Purpose |
|---|---|---|
| `REPORT_TYPES` | `:44` | the valid-type list |
| `TYPE_LABEL` | `:45` | human label |
| `SCOPE_TYPES` | `:58` | which `device_type`s it may be scoped to |
| `BUILDERS` | `:729` | the function that gathers the data |

Adding a type meant four edits, and **three of the four omissions fail silently**:

- miss `REPORT_TYPES` → rejected as invalid (loud — fine)
- miss `TYPE_LABEL` → the report title reads `undefined Report`
- miss `BUILDERS` → `BUILDERS[type] is not a function` inside `build()`, which is
  fire-and-forget, so the row flips to `failed` with nothing explaining why
- miss `SCOPE_TYPES` → treated as campus-wide — **which is exactly what `environment`
  relies on**, so a forgotten entry is indistinguishable from a deliberate one

That last case is the real defect: absence carried meaning.

✅ **Applied.** `backend/services/reportTypes.js` — pure and import-free — is now the single
registry, and `scope: null` states "campus-wide" outright instead of expressing it by
omission:

```js
export const REPORT_TYPE_META = {
  environment: { label: "Environment", scope: null },   // campus-wide, said out loud
  server:      { label: "Server Metrics", scope: ["server"] },
  network:     { label: "Network Traffic", scope: ["router", "mikrotik"] },
  /* … */
};
export const REPORT_TYPES = Object.keys(REPORT_TYPE_META);
export const TYPE_LABEL  = Object.fromEntries(REPORT_TYPES.map((t) => [t, REPORT_TYPE_META[t].label]));
export const SCOPE_TYPES = Object.fromEntries(
  REPORT_TYPES.filter((t) => REPORT_TYPE_META[t].scope !== null)
              .map((t) => [t, REPORT_TYPE_META[t].scope]),
);
```

`TYPE_LABEL` and `SCOPE_TYPES` are **derived**, so every call site is unchanged and
`SCOPE_TYPES.environment` is still `undefined` exactly as the `if (!allowed) throw` callers
expect. Plus a boot-time assertion:

```js
assertBuildersComplete(BUILDERS);   // reportService.js, right after BUILDERS
```

which throws on startup if the registry and the builders disagree in either direction —
turning the silent-failure case into a failure a developer sees immediately.

**Verified:** 7 new tests in `tests/reportTypes.test.js`, and `REPORT_TYPES` /
`SCOPE_TYPES` confirmed byte-identical to the previous values at runtime.

> **The good example already in the tree:** `frontend/src/pip/tiles/catalog.tsx:646` does
> this correctly — `TILE_CATALOG` is the single array and `TILE_BY_ID` is *derived* from it
> (`new Map(TILE_CATALOG.map((t) => [t.id, t]))`). That is the shape to reach for.

### P-11 — Command/queue is absent; a failed report has no retry (importance 5)

`reportService.create()` writes a `pending` row, the route answers **202**, and `build(id)`
runs fire-and-forget. `build()` never throws — it flips the row to `generated` or `failed`
and pushes `reportUpdated`.

That is a reasonable async design, but there is no Command object and therefore:

- **no retry.** A transient InfluxDB timeout permanently fails a report the user must
  re-request by hand.
- **no recovery across restart.** A backend restart mid-build leaves the row `pending`
  forever — nothing ever revisits it.

**Fix — the smallest thing that closes the second gap.** A full job queue is not warranted;
a startup sweep is:

```js
// services/reportService.js — call once from init(), beside the io wiring.
/** A `pending` row older than this cannot still be building: nothing survives a restart. */
const STUCK_AFTER_MS = 15 * 60_000;

async function failStuckBuilds() {
  const [r] = await db.query(
    `UPDATE reports SET status = 'failed'
      WHERE status = 'pending' AND created_at < (NOW() - INTERVAL 15 MINUTE)`,
  );
  if (r.affectedRows) console.warn(`[reports] marked ${r.affectedRows} stuck build(s) failed`);
}
```

✅ **Applied.** The schema was checked before writing it — `CREATE TABLE reports` in
`v13_cspc-ictu-monitoring-system.sql` has both `created_at` and `status
enum('pending','generated','failed')`, so the statement uses only columns and values that
exist. `failStuckBuilds()` runs once from `init()`, fire-and-forget like the build it
cleans up after, and is exported so it can be called by hand.

✅ **Verified against the live database** (MariaDB 10.4.32, XAMPP). The live
`reports` schema was confirmed to match the checked-in SQL — `created_at` present,
`status enum('pending','generated','failed')`, `type` enum matching the registry exactly —
and the sweep was then exercised end to end with two probe rows:

| Probe row | `created_at` | After `failStuckBuilds()` | |
|---|---|---|---|
| stale | `NOW() - INTERVAL 20 MINUTE` | `failed` | ✅ swept |
| fresh | `NOW()` | `pending` | ✅ correctly left alone |

`affectedRows = 1`, the `[reports] marked 1 stuck build(s) failed (orphaned by a restart)`
line printed, and both probe rows were deleted afterwards. There were **no pre-existing
`pending` rows**, so nothing real was touched.

Retry is a larger question and probably not worth it here: a user watching the Reports page
sees `failed` and clicks again, which is a perfectly good retry mechanism for a
human-triggered artifact.

### P-09 — Two competing ways to reach `io` (importance 4)

Both are in use for the same dependency:

| Mechanism | Where |
|---|---|
| `init(io)` + module-level `_io` | `notificationService.js:13`, `alertsService.js:13`, `reportService.js:39`, `esp32Monitor.js:26`, `socketSessions.js:34` |
| `req.app.get("io")` (service locator) | `routes/agents.js:60,200,277,311`, `routes/aircon.js:63,95,112,125`, and others |

Neither is wrong, and I verified all five `init(io)` calls **are** made at startup
(`src/server.js:227-238`), so nothing silently no-ops today. The cost is that the two
mechanisms fail differently: a missed `init()` makes `_io?.emit()` a silent no-op — an
event that simply never arrives, with no error anywhere — whereas `req.app.get("io")`
returns `undefined` and the optional-chaining call is equally silent.

**Fix — make the silent case loud, cheaply:**

```js
// services/notificationService.js (and the four siblings)
export function init(io) {
  _io = io;
}

function emit(room, event, payload) {
  if (!_io) {
    // A broadcast before init() is a wiring bug, not a runtime condition. Say so once
    // rather than dropping alerts silently for the life of the process.
    console.error(`[notify] emit("${event}") before init(io) — event dropped`);
    return;
  }
  _io.to(room).emit(event, payload);
}
```

✅ **Partly applied** — the costliest case is fixed. `notificationService.raiseAlert()` had
`if (_io) { …emit… }` with no `else`: a pre-`init` call still wrote the alert row and still
sent the email, but produced no bell, no toast and no OS popup, with nothing in the log.
That branch now logs which alert lost its in-app notifications. A dropped alert is the most
expensive silent failure in this system, so it should not be inferred from absence.

⏳ **Still open:** standardising the mechanism itself. I would keep `init(io)` for services,
treat `req.app.get("io")` as route-only, and record that in `CLAUDE.md`. The other four
`init(io)` services (`alertsService`, `reportService`, `esp32Monitor`, `socketSessions`)
still use `_io?.emit(...)`, which is silent — but they broadcast UI refreshes rather than
alerts, so a missed one costs a stale page until the next event, not a missed warning.

### P-10 — Chain of Responsibility ✅ correct

Express middleware is used as intended: `authMiddleware` → `requireRole(...)` → handler,
with `agentAuth` as a parallel chain for `AGT-` tokens. `requireRole("admin", "it_staff")`
is a correctly-parameterised link. `routes/alertRules.js` applies `requireRole("admin")`
from the top of the file — and `CLAUDE.md` already records why `GET /thresholds` lives on
`routes/environment.js` instead of being slipped in above that gate. No action.

### P-16 — Poller if/else dispatch: checked, and it is fine (importance 2, no action)

`snmpPollerService.js` branches on `device.type` in five places — `:254`, `:327`, `:341`,
`:370`, `:538` — and three of them are ternaries that **default to router**:

```js
const typeLabel = (d) => (d.type === "ups" ? "UPS" : "Router");
io?.emit(d.type === "ups" ? "upsStatus" : "networkStatus", { … });
```

My first reading flagged this as a trap: `devices.device_type` has six values, so a third
type would be labelled a router and broadcast on the wrong socket event. **That turned out
to be wrong, and the check is worth recording.** `loadDevices()` constrains the set in SQL:

```sql
WHERE d.device_type IN ('router','ups')
```

so only two types can ever reach the dispatch. The ternaries are exhaustive over their
actual domain, and a Strategy map here would add a table and an indirection to express what
one `if/else` over two cases already says clearly.

**No action.** If a third SNMP-pollable device type is ever added, the `IN` clause is the
line that changes — and at that point the `DEVICE_KIND` map becomes worth it. Until then it
would be pattern for its own sake.

---

## 4. Domain patterns

### P-12 — No Repository layer (importance 3 — by design, worth stating)

Roughly **190 `db.query` calls across 12 services**, densest in `userService.js` (35),
`agentService.js` (29), `airconService.js` (20), `reportService.js` (17).

**This is defensible and I am not recommending a Repository.** A repository layer earns its
keep when you need to swap the store, mock it in tests, or share queries across services —
none of which applies: MySQL is fixed, the tests deliberately target pure modules instead of
mocking a database, and the queries are service-specific.

What *is* worth borrowing from the pattern is the part the codebase already does well in
places: pushing the **decision** into a pure module and leaving I/O in the service. The
existing examples — `installKeyUtils` (rules) vs `installKeyService` (DB),
`pingOutput` vs `icmpPing`, `analyticsMath` vs `analyticsService`, and now
`alertRuleValidation` vs `alertRulesService` — are the pattern. Extend it when a service
grows a decision worth testing, not as a blanket refactor.

### P-13 — Service layer ✅ correct

One service per domain, routes depend only on services, no route touches `db` directly.
Verified — no `db.query` appears in `routes/`.

### P-14 — DTO mappers: consistent convention, no contract (importance 2)

Six `toClient(row)` mappers — `alertRulesService:159`, `alertsService:24`,
`historyService:147`, `installKeyService:111`, `notificationService:27`,
`reportService:740` — all doing snake_case row → camelCase client shape, all named
identically. **That consistency is genuinely good** and nothing is broken.

The only observation: they are private per module with no shared type, so the boundary is a
convention rather than a contract, and the frontend re-declares the shapes by hand
(`AppNotification` in `types/notification.ts` is annotated *"Mirrors the backend toClient()
shape"* — a comment doing a type's job). The codebase already has the right answer to this
elsewhere: `tests/contract.test.js` parses `agent/internal/collector/metrics.go` and fails
if its json tags drift from `NUMERIC_FIELDS`. **A drift test beats a comment.** Worth
applying to one or two of the higher-traffic DTOs if they ever cause a bug; not worth doing
speculatively.

### P-15 — Anemic domain model ✅ appropriate

Plain objects with logic in services, no entity classes. For a monitoring system whose
"entities" are readings and threshold comparisons, a rich domain model would add ceremony
without removing a branch. `alertBandState.js` — a small stateful module tracking per-device
severity bands — is the one place with genuine domain state, and it is correctly isolated.

---

## 5. Unable to verify

- **Whether the MySQL pool is actually saturating** (P-01). Static reading cannot show it.
  **What would prove it:** log `pool.pool._allConnections.length` /
  `_freeConnections.length` on a timer for a day under real load.
- **Frontend Context re-render cost.** `AuthContext` (Ca=20) and `NotificationContext`
  (Ca=8) are correct Provider usage, but I did not measure whether a notification arriving
  re-renders unrelated subscribers. **What would prove it:** React DevTools Profiler while
  a notification is pushed; if unrelated pages re-render, split the context value.
- **`agent/` (Go).** No pattern review was performed on the Go agent — the analysis was
  JS/TS only.

---

## 6. Applied this session

| ID | Change | Verification |
|----|--------|--------------|
| **P-08** | `services/reportTypes.js` — one registry replacing four parallel maps; `scope: null` states campus-wide explicitly; `assertBuildersComplete()` fails at boot on a mismatch | 7 new tests; `REPORT_TYPES` and `SCOPE_TYPES` confirmed identical at runtime |
| **P-06** | `tests/routeErrorHandling.test.js` — fails if any async route handler is neither `asyncHandler`-wrapped nor try/catch-guarded; includes an anti-vacuous-pass self-check | Proven to fail on a deliberately unguarded handler, which was then reverted |
| **P-08+** | `tests/reportTypes.test.js` also parses `CREATE TABLE reports` and fails if the `type` **SQL enum** drifts from the registry — the fifth place report types are written down, and the one the registry cannot derive | Proven to fail on an injected bogus type, which was then reverted |
| **P-09** | `notificationService.js` — a `raiseAlert()` before `init(io)` now logs which alert lost its in-app notifications instead of silently skipping them | Syntax + suite |
| **P-11** | `reportService.failStuckBuilds()` — called from `init()`, marks `pending` rows older than 15 min `failed`, reconciling builds orphaned by a restart | **Executed against live MariaDB**: stale row swept, fresh row untouched, probes cleaned up |

**Suite: 212 → 236 tests, all passing.**

---

## 7. Recommended order

1. **P-09** loud `emit()` guard in the five `init(io)` services — an alert that never
   arrives is the worst possible silent failure.
2. **P-01** add `connectionLimit` explicitly at its current default (10), so it is visible
   and tunable; instrument before changing the number.
4. **P-07** cache TTL — one query per 5 minutes.
5. **P-06** adopt `asyncHandler` opportunistically; the guard test now holds the line.
6. **P-14** a DTO drift test, only if a shape mismatch ever actually bites.

---

*Reviewed 2026-08-25. Pattern identification by direct reading of the modules named above,
plus mechanical checks: adapter/facade surfaces via export analysis, decorator adoption by
counting `asyncHandler` vs `catch (err)` per route file, and a brace-matching scan of all
92 async route handlers for unguarded error paths.*
