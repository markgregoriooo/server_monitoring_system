# Error Handling Review — CSPC-ICTU Monitoring System

**Date:** 2026-08-25
**Scope:** `backend/`, `frontend/src/` — the whole request/socket/poll error surface
**Companions:** [`design-patterns-report-2026-08-25.md`](./design-patterns-report-2026-08-25.md) ·
[`code-complexity-report-2026-08-25.md`](./code-complexity-report-2026-08-25.md) ·
[`code-duplication-report-2026-08-25.md`](./code-duplication-report-2026-08-25.md)

---

## 0. Summary

The conventions here were sound — `err.status` on an Error, a central Express handler, a
consistent `handleError` on the client — but there were **three gaps where a single
transient failure could take the whole backend down or blank the whole dashboard**, and
one where internal error text was being sent to browsers under a comment claiming it
wasn't.

The most serious is E-01/E-03, and it is not theoretical. I verified it:

```
$ node -e 'async function h(){throw new Error("blip")}; setTimeout(()=>{h()},10); …'
Error: blip
---> exit code: 1        # "STILL ALIVE" never printed
```

Node 22 terminates the process on an unhandled rejection. `sockets/connectionHandler.js`
invoked `sensorHandler` — an async function that reaches MySQL and InfluxDB — **fire and
forget, with no `.catch()`**, on an event the ESP32 emits every ~3 seconds. One transient
database blip inside it and the backend exits. On a monitoring system, that stops every
alarm in the building.

| ID | Area | Finding | Imp | Status |
|----|------|---------|-----|--------|
| **E-01** | Async | No `unhandledRejection` / `uncaughtException` handler — a stray rejection exits the process silently | **9** | ✅ **Fixed** |
| **E-03** | Async | Async socket handlers invoked fire-and-forget; `sensorData` fires every ~3 s | **8** | ✅ **Fixed** |
| **E-02** | Info | 5xx responses leaked `err.message` — SQL state, table names, absolute paths | **7** | ✅ **Fixed** |
| **E-04** | Categories | 32 statusless `throw new Error(...)` → all became 500; users saw "Server error" for "Email already exists" | **7** | ✅ **Fixed** |
| **E-05** | Recovery | No React error boundary — one render exception blanked the entire dashboard | **6** | ✅ **Fixed** |
| **E-06** | Async | No `connect_error` listener — a rejected socket handshake killed live data in silence | **6** | ✅ **Fixed** |
| **E-07** | Categories | Expired token answered **403** (should be 401); client compensated by matching the message *string* | **5** | ✅ **Fixed** — now 401 |
| **E-09** | Categories | Two rate-limiter `ValidationError`s at every boot; one was a real IPv6 bypass in a fallback | **4** | ✅ **Fixed** |
| **E-08** | Consistency | No shared error type — 8 modules rolled their own 3-line factory | **4** | ✅ **Fixed** |
| **E-10** | Recovery | Shutdown was owned by `backupService`, a leaf; `server.close()` never ran | **3** | ✅ **Fixed** |
| **E-13** | Recovery | Backup writer logged the **success line even when the drive was missing** | **7** | ✅ **Fixed** |
| **E-11** | Recovery | No circuit breaker | **2** | ✅ No action — see §4 |
| **E-12** | Info | `NODE_ENV` is never read; no dev/prod distinction | **2** | ✅ Moot after E-02 |

**Backend tests: 236 → 247.** All passing. Frontend typechecks and builds clean.

---

## 1. Error handling consistency

### E-08 — The convention was shared; the implementation wasn't ✅ Fixed (importance 4)

`src/server.js`'s central handler reads `err.status`, and every service honoured that —
but each rolled its own factory:

| Module | Its own factory |
|---|---|
| `reportService.js:82` | `badRequest(msg)` |
| `installKeyService.js:22` | `err(status, message)` |
| `airconService.js:339` | `irCfgErr(status, message)` |
| `alertRuleValidation.js:28` | `ruleError(status, message)` |
| `historyRange.js:22`, `snmpUtils.js:13`, `userService.js:36`, `widgetPrefsService.js:85` | inline `e.status = 400` |

✅ **Applied** — `backend/utils/httpError.js`: an `HttpError` class plus
`badRequest` / `unauthorized` / `forbidden` / `notFound` / `conflict` / `unavailable`,
pure and import-free so `backend/tests/` reaches it with no database. It carries an
`expose` flag (true for 4xx, false for 5xx) that names the rule the central handler
enforces, supports `cause` for wrapping a lower-level failure, and an optional
machine-readable `code`. **7 tests** in `tests/httpError.test.js`.

The existing per-module factories still work and were left alone — they are correct, just
duplicated. New code should use the shared one.

---

## 2. Error categories

### E-04 — 32 statusless throws all became 500, and users were told the server had broken ✅ Fixed (importance 7)

`throw new Error("Email already exists.")` has no `status`, so the central handler
defaulted it to **500**. That is not merely the wrong number:

1. `src/server.js` only puts `error` on the body for **4xx**.
2. The client's `handleError` (`api/api.ts:32`) reads exactly that field.
3. With `error` absent it falls through to `status === 500 ? "Server error. Please try again later."`

**So a user typing a duplicate email was told the server had broken.** Same for
"Username already taken.", "Invalid role.", "User not found.", "Current password is
incorrect." — every one of them.

✅ **Applied** — 26 throws across three services now carry a status:

| Message shape | Was | Now |
|---|---|---|
| `"Invalid role."`, `"Invalid status."`, `"Username cannot be empty."`, `"Current password is incorrect."`, … | 500 | **400** |
| `"User not found."` (userService ×5, authService ×2, policyService ×1) | 500 | **404** |
| `"Email already exists."`, `"Username already taken."`, `"User is not awaiting approval."`, `"Cannot delete your own account."` | 500 | **409** |

**Verified end to end against the live database:**

```
missing-fields  -> status 400 | expose true | "Name, username, email, password, and role are required."
invalid role    -> status 400 | expose true | "Invalid role."
missing user    -> status 404 | expose true | "User not found."
```

`grep -c "throw new Error(" services/userService.js` → **0**.

### E-07 — Expired token answered 403; the client compensated with a string match ✅ Fixed (importance 5)

`middleware/auth.js:68` answers a failed `jwt.verify` with **403 "Invalid or expired
token."** Semantically that should be **401** — the credential is missing or invalid, so
the client should re-authenticate; 403 means *authenticated but not permitted*. The same
middleware already returns 401 for a revoked session at `:77`, so the two auth failures
are categorised differently.

The frontend works around it (`api/client.ts:235`):

```ts
status === 401 || (status === 403 && serverError === "Invalid or expired token.")
```

**Functionally this works** — expiry does sign the user out. The problem is that two files
in different packages are coupled by a **literal message string** with nothing checking
they agree. Reword the backend message — a typo fix, dropping the period — and the client
silently stops signing users out on expiry, leaving a dashboard that 403s every request
while still looking signed in.

✅ **Applied — the real fix, both sides in one change.**

- `middleware/auth.js:68` now returns **401**. Every authentication failure in that file
  is 401: no token (`:36`), invalid/expired token, dead session (`:77`).
- `api/client.ts` drops the string match entirely: `const isAuthFailure = status === 401 && !isAuthEndpoint;`
- **403 keeps its real meaning** — `requireRole` still answers 403 "Insufficient
  permissions.", and that must never end a session.

`tests/authContract.test.js` was rewritten to pin the *correct* invariant: every
auth-failure line in the middleware carries 401, 403 is still used for authorization, and
`client.ts` no longer contains the 403 + message-text special case.

**Verified against the running server:**

```
no token             -> 401
garbage token        -> 401  {"error":"Invalid or expired token."}
expired-shaped token -> 401  {"error":"Invalid or expired token."}
```

### E-09 — Two rate-limiter warnings at every boot; one was a real IPv6 bypass ✅ Fixed (importance 4)

The server printed these on **every startup**:

```
ValidationError: Custom keyGenerator appears to use request IP without calling the
ipKeyGenerator helper ... could allow IPv6 users to bypass limits  (ERR_ERL_KEY_GEN_IPV6)
ValidationError: 'ipv6Subnet' is ignored when a custom 'keyGenerator' is also set
```

The first was real. `routes/servers.js:58` fell back to a **raw** `req.ip`:

```js
keyGenerator: (req) =>
  req.device?.device_id != null ? `agent:${req.device.device_id}` : `ip:${req.ip}`,
```

A raw IPv6 address is one address out of a /64 the same host owns — precisely the bypass
`CLAUDE.md` documents for the global limiter ("any IPv6 /64 could then rotate addresses
for unlimited budget"). The global limiter gets this right via
`ipKeyGenerator(req.ip, RATE_IPV6_SUBNET)`; this one did not. The branch is unreachable
today (`agentAuthMiddleware` runs first), but an unreachable branch is exactly where this
survives a refactor.

The second was harmless but noisy: `globalLimiter` set `ipv6Subnet` **and** a custom
`keyGenerator`, and the option is ignored in that combination. The subnet grouping was
real — `userOrIpKey` applies it itself — it was just declared twice, once where it did
nothing.

✅ **Applied.** Fallback now uses `ipKeyGenerator(req.ip, 56)`; the redundant option is
removed with a comment saying why. **The server now boots with zero warnings** — which
matters beyond tidiness: a startup that always prints `ValidationError` trains everyone to
scroll past the next one.

### Categories that were already correct ✅

| Code | Where | Verdict |
|---|---|---|
| **401** | `auth.js:36` (no token), `:77` (dead session), `:126`; `agentAuth.js:13`; `agents.js:48` | Correct |
| **403** | `auth.js:130` (insufficient permissions); `agentAuth.js:19`; `auth.js` route `:54-64` (pending/rejected/disabled) | Correct |
| **404** | `src/server.js:277` catch-all `{ error: "Route not found" }` | Correct |
| **429** | `globalLimiter` + `metricsIpLimiter` + `metricsAgentLimiter`, each with a `[RATE]` log line naming the key | **Better than typical** — a 429 is otherwise invisible server-side and looks like a broken page client-side |
| **503 / 502** | `reportService.js:1003`, `:1030` | Correct — used for a dependency failure, not a generic 500 |

---

## 3. Async error handling

### E-01 — No process-level safety net ✅ Fixed (importance 9)

Before this session, the **only** `process.on` in the entire backend was
`backupService.js:364`. There was no `unhandledRejection` handler and no
`uncaughtException` handler.

Verified on this machine (Node v22.19.0): a fire-and-forget async call that rejects exits
with **code 1**, printing a bare stack with no application context.

✅ **Applied** — `src/server.js` now has both. They deliberately **do not swallow**:

```js
process.on("unhandledRejection", (reason, promise) => {
  console.error("[FATAL] Unhandled promise rejection — the process will exit.");
  console.error("  reason:", reason instanceof Error ? reason.stack : reason);
  console.error("  promise:", promise);
  throw reason;              // let the uncaughtException path run
});

process.on("uncaughtException", (err, origin) => {
  console.error(`[FATAL] Uncaught exception (origin: ${origin}) — the process will exit.`);
  console.error(err?.stack ?? err);
  process.exit(1);
});
```

⚠️ **Continuing after an unknown exception would be worse than exiting.** A process in an
unknown state that keeps serving is how corrupt data gets written. Restart belongs to the
process supervisor; the handler's job is to make sure the cause is *written down* first.
`backupService`'s `'exit'` listener still fires on this path, so buffered samples reach
the micro SD before the process goes.

**Verified:**

```
[FATAL] caught by the net: simulated blip in an async socket handler
[FATAL] uncaught (origin: uncaughtException): simulated blip in an async socket handler
-> logged with context, exiting deliberately
---> exit code: 1
```

### E-03 — Async socket handlers were fire-and-forget ✅ Fixed (importance 8)

`sockets/connectionHandler.js` delegated three events to async handlers with no `await`
and no `.catch()`:

```js
const handleSensorData  = (socket, data) => sensorHandler(socket, data);      // async
const handleOfflineData = (socket, data) => offlineDataHandler(socket, data); // async
```

Socket.IO does not await a handler and has nowhere to send a rejection. Inside
`sensorHandler` (106 lines), the InfluxDB write, the broadcast and `maybeRaiseEnvAlert`
are each individually try/caught — but `esp32Monitor.markSeen()` and
`backupService.record()` are not, and `sensorData` arrives **every ~3 seconds**.

✅ **Applied** — a `guard(name, fn)` wrapper that catches both a synchronous throw and a
rejected promise, logs which handler failed, and drops that one payload:

```js
const guard = (name, fn) => (socket, payload) => {
  try {
    const r = fn(socket, payload);
    if (r && typeof r.then === "function") {
      r.catch((err) => console.error(`[socket:${name}] handler rejected —`, err?.stack ?? err));
    }
  } catch (err) {
    console.error(`[socket:${name}] handler threw —`, err?.stack ?? err);
  }
};
```

**Losing one sample is the correct trade for a telemetry stream; losing the backend is
not.** The next reading arrives three seconds later. `changeRange` got an equivalent
try/catch. `irFired` already had one and was left alone.

### E-06 — A rejected socket handshake reached nobody ✅ Fixed (importance 6)

`src/server.js`'s `io.use()` rejects with `next(new Error("Unauthorized"))` and
`next(new Error("Session is no longer valid"))`. Both surface on the client as
`connect_error` — **and there was no `connect_error` listener anywhere in the frontend.**

Socket.IO retried forever in silence. HTTP kept working, so the dashboard looked fine
while every live panel quietly stopped updating. On a monitoring wall that is
indistinguishable from "nothing is happening".

✅ **Applied** — `context/AuthContext.tsx` now listens, and treats the two auth rejections
exactly like `sessionRevoked`:

```ts
const AUTH_REJECTIONS = ["Unauthorized", "Session is no longer valid"];
```

⚠️ **Transport failures are deliberately left alone** — a backend restart or a LAN blip
logs a warning and lets Socket.IO's own reconnection do its job. Signing someone out
because the network hiccuped would be worse than the problem.

### Route-level async ✅ already sound

All **92** async route handlers are either `asyncHandler`-wrapped or try/catch-guarded —
zero unguarded. That is now enforced by `tests/routeErrorHandling.test.js`, added in the
design-pattern review (P-06).

---

## 4. Error recovery

### What is already right ✅

| Strategy | Where |
|---|---|
| **Retry** | `snmpClient.js:87` `retries: 1`; `mikrotikClient.js:196` retries `/interface/print` without `=stats=` when the router rejects it |
| **Retry-next-cycle** | The dominant strategy, and the right one for a poller — `snmpPollerService` marks a device offline and continues; `socketSessions.js:99` "a DB blip must not take the process down — the next sweep retries" |
| **Graceful degradation** | `emailService` no-ops when SMTP is unconfigured (bell + toast still work); `backupService` writes independently of MySQL/InfluxDB; `drawLogo` in `reportRenderer` costs the logo, never the report |
| **Never-throw by design** | `icmpPing` returns total packet loss as a *measurement*; `reportService.build()` flips a row to `failed` rather than throwing |

### E-13 — The backup writer claimed success while writing nothing ✅ Fixed (importance 7)

Found while testing E-10, and it was **live on this machine**. `backupService.init()`:

```js
try {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
} catch (err) {
  console.error("[BACKUP] cannot create dir:", BACKUP_DIR, err.message);
}
console.log(`[BACKUP] on-site backup → ${BACKUP_DIR} (flush ${FLUSH_MS}ms, retain ${RETENTION_DAYS}d)`);
```

The success line printed **unconditionally, one line below the error**. The real boot log
on this machine read:

```
[BACKUP] cannot create dir: D:/backups ENOENT: no such file or directory, mkdir 'D:ackups'
[BACKUP] on-site backup → D:/backups (flush 5000ms, retain 30d)
```

The second line is the one people read. `BACKUP_DIR=D:/backups` points at a drive that is
not attached, so the on-site backup — **the copy that exists specifically to survive a
database wipe plus a power cut** — has been writing nothing, while the log reported it
configured. Every sample buffers in memory and is dropped at the 100,000-line cap.

✅ **Applied.** The success line is now conditional, the failure is stated in terms of what
it costs, and the module tracks whether it can actually write (`isHealthy()`):

```
[BACKUP] ⚠️  NOT RUNNING — cannot write to Z:/definitely-not-here: ENOENT: …
[BACKUP] ⚠️  Samples will buffer in memory and be DROPPED at the 100000-line cap.
[BACKUP] ⚠️  This is the on-site copy that survives a database wipe and a power cut.
[BACKUP] ⚠️  Attach the drive, or point BACKUP_DIR at a path that exists, then restart.
```

**Both paths verified by booting the real server** — the warning above with a missing
directory, and the unchanged `[BACKUP] on-site backup → …` line with a good one.

> ⚠️ **Operational, not just code:** attach the backup drive or repoint `BACKUP_DIR`
> before go-live. `isHealthy()` is exported so a future health endpoint can surface this
> in the dashboard rather than only in the boot log — worth doing, since nobody reads a
> boot log three months later.

### E-11 — No circuit breaker ✅ No action (importance 2)

There is none, and I do not recommend adding one. A circuit breaker earns its keep when
retries against a failing dependency are expensive or amplify load. Here the pollers run
on a fixed 30–60 s timer against a fixed device list: a dead router costs one timed-out
SNMP walk per minute, the device is already marked `Offline`, and the transition is logged
once rather than every cycle. That *is* the breaker, expressed as a poll interval.

### E-10 — Shutdown is owned by a leaf service (importance 3) ⏳ Open

`backupService.js:357-364` registers the only signal handlers:

```js
const shutdown = (sig) => { flushSync(); console.log(`[BACKUP] flushed on ${sig}`); process.exit(0); };
process.once("SIGINT",  () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
```

The flush itself is **correct and well-reasoned** — the comment even explains that Node
does not emit `'exit'` for an unhandled signal, which is exactly right and easy to get
wrong.

The issue is ownership: a *backup writer* decides when the whole process dies, and calls
`process.exit(0)` immediately. So on the UPS low-battery SIGTERM this is built for:

- `server.close()` is never called — in-flight HTTP requests are cut mid-response
- open sockets are not told anything
- the MySQL pool is not drained
- any other service that later registers a SIGTERM handler may not finish before the exit

✅ **Applied — ownership moved to `src/server.js`**, the composition root:

```js
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;                 // a second Ctrl+C must not re-enter
  shuttingDown = true;
  console.log(`[shutdown] ${sig} — flushing and closing`);
  try { backupService.flushSync(); }        // 1. synchronous, FIRST — the power is going
  catch (err) { console.error("[shutdown] backup flush failed:", err?.message ?? err); }
  server.close(() => { console.log("[shutdown] http closed"); process.exit(0); });  // 2.
  setTimeout(() => {                        // 3. hard cap — an idle keep-alive would
    console.warn("[shutdown] close timed out — exiting anyway");                    //    otherwise hold close() open forever
    process.exit(0);
  }, 3000).unref();
}
process.once("SIGINT",  () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
```

`backupService` keeps `flushSync()` and its `'exit'` listener (the last-resort net, which
still fires on the `uncaughtException` path) but no longer registers signal handlers and
no longer calls `process.exit`.

**Verified end to end** — booted the real server, buffered a sample, emitted SIGTERM:

```
[probe] sample buffered; files on disk: 1
[probe] emitting SIGTERM ...
[shutdown] SIGTERM — flushing and closing
[shutdown] http closed                 <- server.close() now actually runs
[probe] exit code 0 | files: 2 | sample persisted: true
```

`flushSync()` was separately proven to persist a buffered sample (0 files before, 1 after,
content present).

⚠️ **The OS delivery path is unverifiable on Windows.** `kill -TERM` from MSYS maps to
`TerminateProcess`, which does not let handlers run — so the probe emits the signal
in-process to exercise the handler. On the **on-prem Linux** deployment target SIGTERM is
a real deliverable signal and the handler runs as tested.

⚠️ **Still unable to verify:** whether 3 s is enough headroom on the actual UPS. **What
would prove it:** the UPS's configured shutdown delay (NUT / PowerChute config).

---

## 5. Error information

### E-02 — 5xx responses leaked internal error text ✅ Fixed (importance 7)

The old handler:

```js
const body = { message: err.message || "Internal Server Error" };
if (status >= 400 && status < 500) body.error = err.message;   // ← only `error` was gated
```

directly under a comment reading *"5xx stays generic so unexpected internals aren't
leaked"*. Only `error` was gated; **`message` carried `err.message` for every status**. So
a 500 sent the client whatever the underlying library said — a mysql2 error carries the
SQL state and table name (`ER_NO_SUCH_TABLE: Table 'cspc.reports' doesn't exist`), a
filesystem error carries an absolute server path.

The client never even read it — `handleError` reads `data.error` — so it was leakage with
no consumer.

✅ **Applied:**

```js
const body =
  status >= 400 && status < 500
    ? { error: err.message, message: err.message }
    : { error: "Internal Server Error", message: "Internal Server Error" };
```

Logging was split at the same time, because the detail *does* belong server-side:

```js
if (status >= 500) console.error(`[ERR] ${status} ${req.method} ${req.originalUrl}`, err);
else               console.warn (`[ERR] ${status} ${req.method} ${req.originalUrl} — ${err.message}`);
```

The old `console.error(err)` printed a bare stack with no method, path or status — the
three things you need to find it. 4xx are expected (bad input, wrong role) so they log at
warn without a stack; 5xx keep the full stack.

**Stack traces have never been sent to the client**, and still aren't.

### E-05 — No React error boundary ✅ Fixed (importance 6)

There was no `componentDidCatch` / `getDerivedStateFromError` anywhere in `frontend/src`.
React's default on an uncaught render error is to **unmount the entire tree**: one
null-dereference in one panel blanked the whole dashboard to a white page, with the cause
only in the console.

On a monitoring system that is the worst failure mode available — the operator cannot
distinguish "the app broke" from "everything is quiet".

✅ **Applied** — `components/ErrorBoundary.tsx`, mounted inside `<main>` in `App.tsx` and
keyed on `location.pathname`:

- **Inside `<main>`**, so the sidebar and header stay usable — a broken page is something
  you navigate out of, not a dead tab.
- **Keyed on the path**, so navigating away clears the caught error.
- The panel says **"Live monitoring and alerting are unaffected — they run on the server"**,
  which is the fact an operator most needs at that moment.
- Shows `error.message` only, **never the stack** — it can carry API payload fragments,
  and this screen lives in a shared server room.

⚠️ A boundary catches render/lifecycle errors only — **not** event handlers, timers or
promise rejections. Those never unmounted the tree, so nothing regresses; they simply
remain the responsibility of the code that starts them.

### E-12 — No dev/prod distinction ✅ Moot (importance 2)

`NODE_ENV` is read **nowhere** in the backend. Normally that means verbose errors reach
production clients. After E-02 the response body is generic for 5xx in *all* environments
— the safe default — and the detail goes to the server log either way. Nothing further is
needed; adding a dev-only verbose branch would reintroduce exactly the leak E-02 removed.

---

## 6. Unable to verify

- **UPS shutdown headroom** (E-10). The proposed 3 s cap is a guess. **What would prove
  it:** the UPS's configured shutdown delay.
- **Whether any statusless throw remains reachable from a route.** I fixed `userService`,
  `authService` and `policyService` (26 throws). Other services still contain
  `throw new Error(...)` — mostly internal invariants (`reportTypes.js` boot assertions,
  `secretCrypto.js` key errors) that *should* be 500. **What would prove it:** exercise
  each route and assert no 500 carries a human-written message.
- **Client-side rendering of the new 409s.** `handleError` has no 409 case, so it falls to
  the `serverMessage || fallback` path — the real message shows because `error` is set for
  4xx. Reasoned, not exercised in a browser. **What would prove it:** submit a duplicate
  email in User Management and read the toast.
- **The Go agent's error handling.** Not reviewed — this audit is JS/TS only. **What would
  prove it:** read `agent/cmd/agent/main.go`'s retry/backoff around the metric POST.

---

## 7. Applied this session

| ID | Change | Verification |
|----|--------|--------------|
| E-01 | `unhandledRejection` + `uncaughtException` handlers in `src/server.js` | Probe: logged with context, exit 1 |
| E-02 | Central handler: 5xx generic, split warn/error logging with method+path+status | Syntax + boot |
| E-03 | `guard()` around `sensorData` / `offlineData`; try/catch on `changeRange` | Syntax + boot |
| E-04 | `utils/httpError.js` + 26 throws given 400/404/409 across 3 services | Live DB: 400/400/404 with `expose: true` |
| E-05 | `components/ErrorBoundary.tsx`, keyed on route, inside `<main>` | `tsc` clean + production build |
| E-06 | `connect_error` listener in `AuthContext` | `tsc` clean + production build |
| E-07 | `tests/authContract.test.js` — 3 assertions holding the string contract | Suite |
| E-08 | `utils/httpError.js` + `tests/httpError.test.js` (7 tests) | Suite |
| E-09 | IPv6-safe key fallback; removed the ignored `ipv6Subnet` | **Server boots with zero warnings** |
| E-07 | Expired token → **401** on both sides; client's 403 string-match deleted; contract test rewritten | Live: no-token / garbage / expired all → 401 |
| E-10 | Shutdown moved to `src/server.js` — flush, then `server.close()`, then a 3 s hard cap | Live SIGTERM probe: `[shutdown] http closed`, exit 0, sample persisted |
| E-13 | `backupService` no longer prints the success line when it cannot write; added `isHealthy()` | Booted both a missing and a good `BACKUP_DIR` |

**247/247 backend tests pass. Frontend: 0 TypeScript errors, production build succeeds.**

---

## 8. Recommended order for what remains

1. **Attach the backup drive** (E-13) — `BACKUP_DIR=D:/backups` does not exist on the
   current machine, so the on-site backup is writing nothing. This is configuration, not
   code, and it is the highest-value item on the list.
2. **E-04 (remainder)** — audit the other services' `throw new Error(...)` for any that a
   route can reach and that should not be a 500.
3. Adopt `utils/httpError.js` in new code; retire the per-module factories opportunistically.

---

*Reviewed 2026-08-25. Method: read every `catch`, `throw`, `process.on`, status-code call
and socket listener in `backend/` and `frontend/src`; brace-matched scan of all 92 async
route handlers; empirical verification of Node 22's unhandled-rejection behaviour; live
verification of the new status codes against the running MariaDB instance.*
