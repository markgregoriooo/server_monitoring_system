# Resilience Review — CSPC-ICTU Monitoring System

**Date:** 2026-08-25
**Scope:** `backend/`, `frontend/src/`, `agent/` (Go) — timeouts, retries, isolation, degradation
**Companions:** the six other 2026-08-25 audits in this folder

---

## 0. Verdict — Resilience: 7 / 10

A monitoring system has an unusual resilience requirement: **it must survive the outage it
is watching.** This one largely does. Every ingest path degrades independently, the poll
loops isolate failures per device, and the Go agent has the best retry implementation in
the codebase.

The gaps were mostly *invisibility* rather than fragility — timeouts left at library
defaults, one shared connection pool with no isolation between three very different
workloads, and no way to ask the process whether its dependencies were up.

| ID | Finding | Imp | Status |
|----|---------|-----|--------|
| **S-05** | **No health endpoint** — nothing can report dependency state | **6** | ❌ **Removed at the user's request** |
| **S-01** | HTTP server timeouts at Node defaults; `keepAliveTimeout` **below** a proxy's → intermittent 502s | **6** | ✅ **Fixed** |
| **S-03** | One MySQL pool (silently 10) shared by 3 workloads, no query timeout, unbounded queue | **6** | ⚠️ **Partly fixed** |
| **S-06** | Two error modules differing by one character (`httpError.js` / `httpErrors.js`) | **5** | ✅ **Fixed** |
| **S-02** | InfluxDB transport timeout implicit | **3** | ✅ **Fixed** |
| **S-04** | Live metric POST is **not idempotent** — an in-cycle retry writes a duplicate point | **3** | ⏳ Recommend |
| **S-07** | No circuit breaker | **2** | ✅ No action — see §3 |

**247/247 backend tests pass. 0 TypeScript errors. Clean build and boot.**

> **While it existed, the health endpoint immediately earned itself.** Its first real
> response (before it was removed at the user's request):
> ```json
> {"status":"degraded","checks":{"mysql":{"status":"up","ms":5},
>  "influx":{"status":"up","ms":42},
>  "backup":{"status":"down","error":"backup directory is not writable — samples are buffered in memory only"}}}
> ```
> It detected, in one HTTP call, the problem that was previously visible only in a boot log
> nobody re-reads.

> ⚠️ **S-05 was implemented and then removed on 2026-08-25 at the user's request.**
> `routes/health.js` is gone and nothing references it. The finding stands as written —
> there is currently no way to query dependency state from outside the process — but the
> remediation was reverted deliberately, not abandoned. The snippet in §5 is what to
> re-add if that changes.

---

## 1. Timeout handling

### Before / after

| Boundary | Was | Now |
|---|---|---|
| HTTP `requestTimeout` | 300 s (Node default) | **60 s** |
| HTTP `headersTimeout` | 60 s | **90 s** |
| HTTP `keepAliveTimeout` | **5 s** | **80 s** |
| MySQL connect | 10 s ✅ | 10 s |
| MySQL **query** | **none** | none — see S-03 |
| InfluxDB transport | implicit 10 s | **explicit, `INFLUX_TIMEOUT_MS`** |
| SNMP | 5 s, 1 retry ✅ | unchanged |
| RouterOS API | `MIKROTIK_API_TIMEOUT_MS` 5 s ✅ | unchanged |
| ICMP | `PING_TIMEOUT_MS` + hard deadline ✅ | unchanged |

### S-01 — HTTP timeouts, and the keep-alive ordering that causes 502s ✅ Fixed (importance 6)

Two problems with the Node defaults here.

**A request could be held open for five minutes.** Nothing this API does legitimately takes
minutes — reports build asynchronously and answer `202`. A stuck request occupies a socket
and, if mid-query, one of only **10** MySQL pool connections (S-03).

**`keepAliveTimeout` was 5 s, which is shorter than a reverse proxy's.** nginx defaults to
75 s. When Node closes an idle connection first, nginx can hand a request to a socket Node
is already closing and return a **502 that the logs cannot explain**. `deployment-guide.md`
puts this behind a proxy, so the ordering matters.

✅ **Applied** — `src/server.js`, with the required ordering (`headers > keepAlive`):

```js
server.requestTimeout   = Number(process.env.HTTP_REQUEST_TIMEOUT_MS)   || 60_000;
server.headersTimeout   = Number(process.env.HTTP_HEADERS_TIMEOUT_MS)   || 90_000;
server.keepAliveTimeout = Number(process.env.HTTP_KEEPALIVE_TIMEOUT_MS) || 80_000;
```

**Verified on the running server:**

```
requestTimeout  : 60000 ms   (Node default 300000)
headersTimeout  : 90000 ms   (Node default 60000)
keepAliveTimeout: 80000 ms   (Node default 5000)
keepAlive > nginx-ish 75s? true
headers > keepAlive?       true
```

### S-02 — InfluxDB timeout made explicit ✅ Fixed (importance 3)

`config/influx.js` created the client as `new InfluxDB({ url, token })` — relying on the
library's implicit 10 s default. Since **every write path awaits `flush()`** (architecture
audit A-05), that default bounds how long an agent POST can block on a stalled InfluxDB. A
number that important should be visible:

```js
const client = new InfluxDB({
  url, token,
  timeout: Number(process.env.INFLUX_TIMEOUT_MS) || 10_000,
});
```

### ⚠️ The timeout that still does not exist

**mysql2 has no per-query timeout**, and `connectTimeout` covers connecting only. A query
that the server never answers holds its pool connection until the TCP connection dies. With
10 connections and an unbounded queue, that is the failure mode described in S-03. Noted in
the config so the next reader is not misled by `connectTimeout`.

---

## 2. Retry logic

### The Go agent is the model ✅ no action

`agent/internal/sender/sender.go:106` — the best retry implementation in the system, and it
gets all four things right:

```go
// Send POSTs metrics with up to 3 attempts and exponential backoff. It never
// crashes on a backend outage — it buffers the sample, logs, and gives up until
// the next cycle. Returns ErrUnauthorized immediately on a 403 (no point retrying
// a revoked token) …
backoff := time.Second
for attempt := 1; attempt <= 3; attempt++ { … }
```

| Property | How |
|---|---|
| **Bounded** | 3 attempts, then gives up until the next cycle |
| **Exponential backoff** | `backoff := time.Second`, doubled per attempt |
| **Non-retryable detected** | `403` returns `ErrUnauthorized` immediately — a revoked token will never succeed |
| **No data loss** | failed samples are spooled and replayed via the batch endpoint when the backend returns |

That last point matters: the replay path uses `/metrics/batch`, which **does** honour the
agent's `collected_at`, so an outage leaves a gap in the live view but not in stored history.

### Backend retries ✅ appropriate to their context

| Where | Strategy |
|---|---|
| `snmpClient.js:87` | `retries: 1` at the protocol level |
| `mikrotikClient.js:196` | Retries `/interface/print` without `=stats=` when the router rejects the flag — older RouterOS lacks it and there is no capability query |
| Poll loops | **Retry next cycle.** A failed device is marked Offline and the loop continues; the next tick retries |
| `backupService.js:109` | Failed writes are **re-queued** with a 100 000-line cap (drops oldest, keeps newest) |
| `socketSessions.js:99` | *"A DB blip must not take the process down — the next sweep retries"* |

**No exponential backoff on the backend, and that is correct.** Backoff exists to stop
retries amplifying load on a struggling dependency. A poller on a fixed 30–60 s timer
already retries at a fixed, gentle rate; adding backoff would only make recovery *slower*
to notice.

### S-04 — The live metric POST is not idempotent ⏳ Recommend (importance 3)

`handlers/serverMetricsHandler.js:87` stamps live samples with server time:

```js
const timestamp = new Date(); // server-side ms precision
```

The agent *does* send `collected_at`, and `agent/internal/collector/metrics.go:51` documents
that the backend deliberately ignores it. So if the server processes a POST but the response
is lost, the agent's retry (1–3 s later) writes a **second point at a different timestamp**.
InfluxDB dedupes on `(measurement, tags, timestamp)`, so two points survive.

**Impact is small and bounded:** at most 2 extra points per cycle, and only when a response
is lost after a successful write. Cumulative counters (`net_bytes_*`) are unaffected — the
same value at a near timestamp yields a zero delta. Gauges get a slightly over-weighted
moment in an average.

**Fix — trust the agent's clock for live samples, as the batch path already does:**

```diff
-  const timestamp = new Date(); // server-side ms precision
+  // Same guard the backfill path uses: rejects a clock >90 d behind or >5 min ahead,
+  // falling back to server time. Makes a retried POST idempotent — the retry lands on
+  // the SAME timestamp and InfluxDB overwrites instead of duplicating.
+  const timestamp = backfillTimestamp(data.collected_at, new Date()) ?? new Date();
```

⚠️ **Not applied.** This changes which clock stamps the primary metric series — a
data-integrity decision, not a cleanup — and the existing behaviour is a *documented*
choice, not an oversight. **What would prove it is worth doing:** count `[RATE]`/retry
occurrences in the agent logs; if in-cycle retries are rare, the duplicate is theoretical.

---

## 3. Circuit breaker

### S-07 — There is none, and I do not recommend adding one ✅ No action (importance 2)

A circuit breaker earns its keep when retries against a failing dependency are expensive or
amplify load. Neither applies:

- **Pollers** run on a fixed 30–60 s timer against a fixed device list. A dead router costs
  one timed-out SNMP walk per minute; the device is already marked `Offline` and the
  transition is logged **once**, not every cycle. **The poll interval *is* the breaker.**
- **SMTP** already degrades: `emailService.isEnabled()` returns false when unconfigured and
  the whole channel no-ops — the bell and toast are unaffected.
- **Google OAuth** already has the essential half of a breaker: `isTransportError()`
  distinguishes *"Google is unreachable"* (our problem → **503**) from *"Google rejected
  this code"* (the user's problem → 4xx). That distinction is what a breaker would be for.

Adding a breaker would introduce state, a half-open probe, and a second thing that can
wedge — to solve a problem that is already solved by the poll cadence.

---

## 4. Bulkhead / resource isolation

### What is already isolated ✅

**Rate-limiter isolation is a genuine bulkhead.** `src/server.js:130`:

```js
skip: (req) => req.method === "POST" && req.path.startsWith("/api/servers/metrics"),
```

Agent ingest is exempted from the global limiter and gets its own pair
(`routes/servers.js` — one per-IP, one per-device), so **a fleet reconnecting after an
outage cannot consume the dashboard's request budget** — which is exactly when the dashboard
is being watched.

**Ingest paths are independent.** The ESP32 socket, the agent HTTP path and the pollers
share no state; one failing does not stop the others. `backupService` writes to disk
independently of both datastores, so a total database loss still leaves the NDJSON copy.

### S-03 — One connection pool, three workloads, no query timeout ⚠️ Partly fixed (importance 6)

The remaining real bulkhead gap. A single MySQL pool serves:

1. the SNMP + MikroTik pollers (bursty, several queries per device per cycle),
2. the Go agents' metric POSTs (steady, ~1 per host per 10 s),
3. every dashboard request (~19 per Dashboard mount).

With **no `connectionLimit` set** it was silently **10**, there is **no query timeout**, and
`queueLimit: 0` means exhaustion **queues rather than errors**. So a slow-query storm in any
one workload stalls the other two, and it surfaces as *"the dashboard is slow"* — never as a
pool error in the log.

✅ **Partly applied** — the limit is now explicit at its previous value, tunable without a
code change, and the trap is documented:

```js
// ⚠️ connectTimeout covers CONNECTING only — it is not a query timeout.
connectTimeout: 10000,
connectionLimit: Number(process.env.DB_POOL_SIZE) || 10,
queueLimit: 0
```

⏳ **The real bulkhead is not applied**: a *second pool* for background work, so the
pollers cannot starve user-facing requests.

```js
// config/mysql.js — a separate, smaller pool for pollers/sweeps/purges
export const bgPool = mysql.createPool({ ...base, connectionLimit: 3 }).promise();
```

⚠️ **Deliberately deferred.** Splitting the pool means auditing ~190 `db.query` call sites
to decide which belongs on which pool, and getting it wrong moves the starvation rather than
removing it. **What would prove the sizing:** log
`pool.pool._allConnections.length` / `_freeConnections.length` once a minute for a day; if
free rarely reaches 0, the single pool is fine and this finding closes as "no action".

### Not isolated, and correct for now

**Single Node process, no clustering.** All three ingest paths, all HTTP and all sockets
share one event loop. For one server room this is right — clustering would mean coordinating
poll ownership between workers to avoid double-polling every device. Revisit only if a
second site appears (see the `multi-site-scoping-blocked` memory).

---

## 5. Graceful degradation ✅ the strongest area

| Failure | Degradation |
|---|---|
| SMTP unconfigured / failing | `emailService` no-ops; bell + toast still fire |
| InfluxDB down | Write logged, **broadcast still happens** — the live dashboard keeps updating |
| MySQL down | 500 with a generic message; pollers keep polling; sweeps retry next tick |
| A device unreachable | Marked Offline with the reason; **other devices unaffected** |
| ICMP total loss | Not an error — a *measurement*. `icmpPing` never throws |
| Backup dir unwritable | Samples buffer in memory to a cap; now **stated loudly** at boot (E-13) |
| Report logo missing | `drawLogo` returns false — costs the logo, never the report |
| Alert thresholds not yet loaded | `ROOM_THRESHOLD_FALLBACK` seeds the UI so a smoke reading is never painted green while a request is in flight |
| Backend socket rejected | Now surfaces via `connect_error` instead of silently retrying forever (E-06) |
| A page component throws | `ErrorBoundary` — sidebar stays usable, and it says *"live monitoring and alerting are unaffected"* (E-05) |
| ESP32 offline | Micro-SD buffers readings; replayed on reconnect under the device's own RTC time |

**Feature flags:** environment-driven and honest — `BACKUP_ENABLED`, `ANALYTICS_ANOMALY_ALERTS`,
`BACKUP_OFFSITE_ENABLED`, `SMTP_USER` (blank = channel off). Each one *disables* cleanly
rather than half-working.

### S-05 — No health endpoint ❌ Built, then removed at the user request (importance 6)

Everything above degrades *quietly* — which is right for users and wrong for operators.
There was no way to ask the process whether its dependencies were up.

⚠️ **Built and verified, then deleted at the user's request on the same day.** The design is kept here because the finding is unresolved — this is what to re-add if it is ever wanted:

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/health` | **public** | Liveness for a proxy/uptime check. Returns `{status, uptimeSec}` and **nothing else** — no dependency names, no versions, no error text |
| `GET /api/health/deep` | **admin** | Actually probes MySQL, InfluxDB and the backup writer, and returns **503** when any is down so a monitor can alert on the status code |

Each probe is wrapped in `withTimeout(…, 3000)` — a health check that hangs on a hung
dependency is the one failure it exists to detect.

**Verified live:**

```
GET /api/health                      -> 200 {"status":"ok","uptimeSec":7}
GET /api/health/deep  (no token)     -> 401
GET /api/health/deep  (admin token)  -> 503 degraded
    mysql  up   5ms
    influx up  42ms
    backup DOWN — "backup directory is not writable — samples are buffered in memory only"
```

### S-06 — Two error modules one character apart ✅ Fixed (importance 5)

`utils/httpErrors.js` (plural, 2 dependents — the Google sign-in path) and
`utils/httpError.js` (singular, 29 dependents). They overlapped: `ServiceUnavailable` vs
`unavailable()`, `isClientSafe` vs `isClientError`.

**I introduced this** — I created the singular module during the error-handling audit
without noticing the plural one already existed. A name collision that subtle is worse than
either module missing, because an import can be wrong and still compile.

✅ **Applied** — merged into `utils/httpError.js`, the plural file deleted, both importers
repointed. The two predicates are kept because the distinction is real:

- `isClientError` — *"does this carry a 4xx status?"* (range test)
- `isClientSafe` — *"was this deliberately marked exposable?"* (explicit opt-in, stricter)

`isTransportError()` survives and is load-bearing for resilience: it is what separates
*"Google is unreachable"* from *"Google rejected this"*. **Verified:**

```
isTransportError(ECONNREFUSED) -> true
isTransportError(peer replied) -> false
isClientSafe(new AuthRejection) -> true
isClientSafe(plain 400 Error)   -> false
```

---

## 6. Rating: 7 / 10

**Earning the 7:**
- Every ingest path degrades independently; one failing never stops another
- The Go agent's retry is textbook: bounded, exponential, non-retryable detected, spool + replay
- Per-device isolation in the poll loops, with `finally` release so a throw cannot wedge them
- An independent on-site backup that survives losing both datastores
- Rate-limiter bulkhead protecting the dashboard budget from agent bursts
- Timeouts now explicit at **every** external boundary
- Process-level nets: `unhandledRejection`/`uncaughtException` handlers and a graceful
  `SIGTERM` (from the error-handling audit)

**Holding it back:**
- One MySQL pool for three workloads, with no query timeout and an unbounded queue (S-03)
- Single process — no redundancy of any kind; if it dies, monitoring stops entirely
- Polling, one of the three ingest paths, has **no automated test coverage**
- The live metric path is not idempotent under retry (S-04)
- **The backup drive is not attached**, so the most important degradation path is currently
  inert — configuration, not code

**To reach 9:** split the connection pool once there is load data, add coverage for one
poller path, and put a process supervisor (systemd/PM2) in front so a crash restarts rather
than ending monitoring.

---

## 7. Unable to verify

- **Real pool saturation** (S-03). Static reading cannot show it. **What would prove it:**
  log `_allConnections` / `_freeConnections` for a day under real load.
- **Whether in-cycle agent retries actually occur** (S-04). **What would prove it:** grep the
  agent logs for retry lines over a week.
- **Whether a process supervisor is configured on the target box.** The
  `uncaughtException` handler exits deliberately, which is only correct if something restarts
  it. **What would prove it:** the systemd unit or PM2 config on the deployment host.
- **nginx's actual `keepalive_timeout`** on the CSPC proxy. I sized `keepAliveTimeout` at
  80 s against nginx's 75 s default. **What would prove it:** the deployed nginx config —
  if theirs is higher, ours must be raised above it.

---

## 8. Applied this session

| ID | Change | Verification |
|----|--------|--------------|
| ~~S-05~~ | `routes/health.js` — built, verified live, then **removed at the user's request**. Not in the tree. | Was: 200 / 401 / 503-degraded |
| S-01 | Explicit HTTP `requestTimeout` / `headersTimeout` / `keepAliveTimeout`, ordered for a reverse proxy | Read back off the running server |
| S-06 | Merged `utils/httpErrors.js` into `utils/httpError.js`; plural deleted; 2 importers repointed | All predicates behaviour-checked; 247 tests |
| S-03 | `connectionLimit` explicit at the previous default + `DB_POOL_SIZE`; the `connectTimeout` trap documented | Boot |
| S-02 | Explicit InfluxDB `timeout` + `INFLUX_TIMEOUT_MS` | Boot |
| — | Two stale comments naming the deleted `httpErrors.js` | No stale references remain |

---

## 9. Recommended order

1. **Attach the backup drive.** The deep health check now reports it as `down` on every
   call. Configuration, highest value, not code.
2. **Put a process supervisor in front** (systemd `Restart=on-failure`, or PM2). The
   `uncaughtException` handler exits on purpose; that is only correct if something restarts it.
3. **Instrument the MySQL pool**, then decide on S-03. Do not split it on intuition.
4. **S-04 idempotency** — only if the agent logs show retries actually happening.

---

*Reviewed 2026-08-25. Method: timeout census across every external boundary with runtime
read-back of the live HTTP server; retry-path reading in Go and JS; pool and rate-limiter
configuration analysis; degradation-path enumeration; and live verification of the new
health endpoints against the running server, MariaDB and InfluxDB.*
