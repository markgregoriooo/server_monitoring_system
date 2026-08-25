# Error Flow Trace — CSPC-ICTU Monitoring System

**Date:** 2026-08-25
**Scope:** `backend/`, `frontend/src/` — five critical failure paths, traced layer by layer
**Companion:** [`error-handling-report-2026-08-25.md`](./error-handling-report-2026-08-25.md)
(structure and categories). This one follows real errors through the system.

---

## 0. Summary

The best result first: **there are zero truly empty catch blocks** in the codebase. Every
one of the 20 that swallow deliberately carries a comment saying why —
`/* already gone */`, `/* private mode / quota — non-fatal */`,
`/* no document (SSR / test) */`. That is the correct way to swallow, and it is rare.

What tracing found instead was four places where an error is **caught, converted into a
plausible-looking value, and the reason discarded** — so the failure surfaces later as
something else entirely. Three of them are on the paths that matter most: the database,
the MikroTik credentials, and the backup integrity check.

The headline is F-01, and it is not subtle:

```
BEFORE:  "[audit] failed to record action: "
AFTER:   "[audit] failed to record action: ECONNREFUSED (no message)"
```

mysql2's connection errors carry an **empty** `.message`. 46 log lines printed
`err.message`. During a database outage — precisely when someone is reading the log —
they printed nothing at all.

| ID | Path | Finding | Imp | Status |
|----|------|---------|-----|--------|
| **F-01** | Database | `err.message` is empty for mysql2 connection errors — 46 log lines printed blank | **7** | ✅ **Fixed** |
| **F-02** | Third-party | `safeDecrypt` swallowed the `MIKROTIK_ENC_KEY` mismatch — the "no obvious cause" CLAUDE.md warns about | **7** | ✅ **Fixed** |
| **F-03** | Third-party | `toBig` returns `0n` on parse failure — indistinguishable from a counter reset | **6** | ✅ **Fixed** |
| **F-04** | Filesystem | Backup rot-detector silently skipped files it could not read | **6** | ✅ **Fixed** |
| **F-05** | All | Zero empty catch blocks; 20 deliberate swallows all documented | — | ✅ No action |
| **F-06** | Third-party | Errors used for flow control in 2 places — both justified | **2** | ✅ No action |
| **F-07** | All | Central catch-all is generic by design, and now logs method + path + status | — | ✅ Fixed earlier (E-02) |

**247/247 backend tests pass.** Server boots clean.

---

## 1. The five paths

### Path 1 — Database connection failure ⚙️ traced empirically

Induced by pointing the pool at a dead port and following the value through every layer:

```
LAYER 1 — driver (mysql2):
   throws Error  code=ECONNREFUSED  message=""          ← note the EMPTY message

LAYER 2 — service: does it add a .status?
   err.status = undefined  -> central handler will default to 500

LAYER 3 — central handler (src/server.js):
   HTTP 500  body={"error":"Internal Server Error","message":"Internal Server Error"}

LAYER 4 — browser handleError():
   toast: "Server error. Please try again later."
```

| Question | Answer |
|---|---|
| **Where caught?** | Route handlers via `asyncHandler`/`next(err)`; background jobs in their own `.catch`; `socketSessions.js:99` explicitly ("a DB blip must not take the process down — the next sweep retries") |
| **How transformed?** | Statusless → `500` at `src/server.js` |
| **What logged?** | `[ERR] 500 GET /api/... <full error>` — the object, so `code` is visible. **But 46 other sites logged `err.message` and printed nothing** — F-01 |
| **User sees** | "Server error. Please try again later." Correct: no SQL state, no table names |
| **State consistent?** | Yes for reads. ⚠️ For multi-statement writes, see the note below |

⚠️ **One genuine consistency exception, and it is handled:** `policyService.accept()`
writes the acceptance **and** its `system_logs` evidence row in one transaction —
deliberately, because the audit row *is* the evidence. Every other audit write is
best-effort by design. **Unable to verify** whether any other multi-row write needs the
same treatment. **What would prove it:** grep for consecutive `db.query` INSERT/UPDATE
pairs in one function and check whether a partial application is meaningful.

### Path 2 — Third-party API timeout ✅ the best-handled path

| Dependency | Timeout | Where caught | Result |
|---|---|---|---|
| SNMP | `snmpClient.js:87` `timeout: 5000, retries: 1` | `snmpPollerService.js:541` per device | Device marked Offline, **reason logged**, loop continues |
| RouterOS API | `MIKROTIK_API_TIMEOUT_MS` (5000) | `mikrotikPollerService` per device | Same |
| ICMP | `PING_TIMEOUT_MS` | `icmpPing.js` — **never throws** | Total loss is a *measurement*, not an error |
| SMTP | nodemailer pool | `emailService` returns `{ok:false}` | Bell + toast unaffected |
| Google OAuth | `googleAuthService.authenticate()` | Route → 4xx | Denial audited to `system_logs` |

The per-device catch is textbook, and its comment explains the reasoning:

```js
// The reason is logged, not swallowed: "Request timed out" (device down or
// firewalled), "Unknown community" (wrong credential) and a genuine bug in
// the collector all previously looked identical from outside.
console.error(`[SNMP_POLLER] ${d.type} "${d.name}" (${d.ip}) poll failed:`, describeError(err));
await setReachable(io, d, false);
```

One device failing never stops the loop, and the outer `finally { polling = false; }`
means a throw cannot wedge the poller permanently. **This is the pattern the rest of the
codebase should copy.**

### Path 3 — Invalid user input ✅ correct after the E-04 fix

```
route → service validation → HttpError(400|404|409) → central handler → body.error → toast
```

Verified live: `400 "Name, username, email, password, and role are required."`,
`400 "Invalid role."`, `404 "User not found."` — each with `expose: true`, so the real
message reaches the user instead of the old generic 500.

### Path 4 — Authentication failure ✅ correct after the E-07 fix

Verified against the running server:

```
no token             -> 401
garbage token        -> 401  {"error":"Invalid or expired token."}
expired-shaped token -> 401  {"error":"Invalid or expired token."}
```

`middleware/auth.js` logs the real `jwt.verify` reason (`TokenExpiredError` vs
`invalid signature` vs `jwt malformed`) plus `from=` and `ua=`, while the client is told
only the vague form. That asymmetry is deliberate and right.

### Path 5 — Filesystem errors ⚠️ two gaps, both fixed

| Failure | Before | After |
|---|---|---|
| Backup dir missing | Logged an error, then printed the **success line** below it | Prints only the warning, and says what it costs (E-13) |
| Backup file unreadable during checksum | `catch { continue; }` — silently excluded from the integrity manifest | Logged as excluded — **F-04** |
| Report file missing on download | `fileFor()` returns null → 404 | Correct |
| Report file delete | `catch { /* best-effort cleanup */ }` | Correct — documented |

---

## 2. Error flow diagram

```
                          ┌──────────────── ORIGIN POINTS ────────────────┐
                          │                                               │
   MySQL (ECONNREFUSED)   SNMP/RouterOS timeout   fs (ENOENT)   bad input   bad/expired JWT
          │                        │                   │            │             │
          ▼                        ▼                   ▼            ▼             ▼
  ┌───────────────┐      ┌──────────────────┐  ┌────────────┐ ┌──────────┐ ┌─────────────┐
  │ config/mysql  │      │ snmpClient /     │  │ backup /   │ │ service  │ │ middleware/ │
  │  (pool)       │      │ mikrotikClient   │  │ report svc │ │ validate │ │  auth.js    │
  └───────┬───────┘      └────────┬─────────┘  └─────┬──────┘ └────┬─────┘ └──────┬──────┘
          │                       │                  │             │              │
          │                       │                  │             │   throws     │ responds
          │                       │                  │             ▼   HttpError  ▼  directly
          │                       │                  │        ┌──────────────┐  401/403
          │                       │                  │        │ utils/       │
          │                       │                  │        │ httpError.js │
          │                       │                  │        └──────┬───────┘
          │                       │                  │               │
          ▼                       ▼                  ▼               ▼
  ╔═══════════════════════════════════════════════════════════════════════════╗
  ║                        TRANSFORMATION LAYER                                ║
  ║                                                                            ║
  ║  HTTP request path            Background / poll path        Socket path     ║
  ║  ─────────────────            ────────────────────────      ───────────     ║
  ║  asyncHandler ─┐              per-device try/catch          guard(name,fn)  ║
  ║  or try/catch ─┴─ next(err)   → log + mark Offline          → log + drop    ║
  ║                    │          → CONTINUE the loop             one payload   ║
  ║                    │                    │                          │        ║
  ╚════════════════════╪════════════════════╪══════════════════════════╪════════╝
                       │                    │                          │
                       ▼                    ▼                          ▼
        ┌──────────────────────────┐  ┌──────────────┐   ┌───────────────────────┐
        │ CENTRAL HANDLER          │  │ console.*    │   │ console.error(...)    │
        │ src/server.js            │  │ + device_logs│   │ payload dropped,      │
        │  4xx → err.message       │  │ + alerts     │   │ next one in ~3s       │
        │  5xx → "Internal Server  │  └──────────────┘   └───────────────────────┘
        │        Error" (generic)  │
        └────────────┬─────────────┘
                     │ JSON { error, message }
                     ▼
        ┌──────────────────────────┐
        │ api/client.ts            │  401 → session-expired event → sign out
        │  interceptor             │  otherwise → pass through
        └────────────┬─────────────┘
                     ▼
        ┌──────────────────────────┐
        │ api/api.ts handleError() │  → ApiResult { success:false, status, error }
        └────────────┬─────────────┘
                     ▼
        ┌──────────────────────────┐        ┌────────────────────────────────┐
        │ page renders the message │        │ ErrorBoundary (render crashes) │
        └──────────────────────────┘        │ keyed on route, inside <main>  │
                                            └────────────────────────────────┘

  ── LAST-RESORT NETS ────────────────────────────────────────────────────────
     process.on("unhandledRejection") → log with context → rethrow
     process.on("uncaughtException")  → log + exit(1); 'exit' flushes the backup
     shutdown(SIGINT|SIGTERM)         → flushSync → server.close → 3s hard cap
```

**Recovery mechanisms by path:** poll paths retry next cycle (30–60 s); the socket path
drops one payload and takes the next; HTTP has no retry (correct — the user retries);
the backup buffer re-queues failed writes with a 100 000-line cap.

---

## 3. Anti-patterns

### F-05 — Swallowed exceptions ✅ genuinely clean

A brace-matched scan classified **every** catch block in `backend/` and `frontend/src`:

| Category | Count |
|---|---|
| **Truly empty** (no code, no comment) | **0** |
| Comment-only, reason stated | 20 |
| Logs but does not rethrow | 61 |
| Rethrows / `next()` / responds | majority |

Zero empty catches is an unusually good result. The 20 deliberate swallows each say why —
`icmpPing.js:105 /* already gone */`, `canvasColor.ts:37 /* no document (SSR / test) */`,
`Sidebar.tsx:240 /* private mode / quota — the sidebar still works, it just won't
remember */`. **No action.**

### F-01 — The error was caught, but the reason printed blank ✅ Fixed (importance 7)

Not a swallowed exception — a swallowed *message*. `err.message` is not reliable:
mysql2's connection errors carry an empty string. 46 log lines across 25 files did
`console.error("[x] failed:", err.message)`.

✅ **Applied** — `describeError(err)` in `utils/httpError.js`, falling back
`message` → `code` → error type → `String()`, and handling a thrown non-Error. Applied to
all 46 sites (25 files), each verified by `node --check`.

```
mysql2 ECONNREFUSED  ->  "ECONNREFUSED (no message)"
Error with code      ->  "nope (ENOENT)"
normal Error         ->  "boom"
thrown string        ->  "just a string"
null                 ->  "unknown error"
```

### F-02 — A caught error hid the one thing you needed to know ✅ Fixed (importance 7)

`mikrotikPollerService.js:28`:

```js
const safeDecrypt = (v) => {
  if (!v) return "";
  try { return decrypt(v); } catch { return ""; }   // ← the reason is gone
};
```

A decrypt failure here means one thing: `MIKROTIK_ENC_KEY` is not the key the password was
encrypted under. `CLAUDE.md` warns about exactly this and describes the symptom:

> *"⚠️ **NEVER change this once MikroTik credentials are saved** — every stored password
> was encrypted under it and becomes undecryptable, and the poller then **fails to log in
> with no obvious cause**"*

**This catch was the reason there was no obvious cause.** It returned `""`, RouterOS
rejected an empty password, and the log showed an *authentication* error — pointing at the
credentials rather than at the key. The documentation had to warn about a symptom the code
could simply have explained.

✅ **Applied** — logged once per process (the poller runs every 30 s):

```
[MIKROTIK] ⚠️  Cannot decrypt a stored API password: <reason>
[MIKROTIK] ⚠️  This almost always means MIKROTIK_ENC_KEY in backend/.env is not the key
[MIKROTIK] ⚠️  the password was encrypted under. Logins will fail with an empty password
[MIKROTIK] ⚠️  until the key is restored, or the credentials are re-entered in the dashboard.
```

### F-03 — A parse failure disguised as a counter reset ✅ Fixed (importance 6)

`mikrotikClient.js:21`:

```js
function toBig(v) {
  try { return BigInt(String(v ?? "0").trim() || "0"); }
  catch { return 0n; }        // ← 0 bytes, silently
}
```

Used for `rx-byte` / `tx-byte` (`:151-152`) — **cumulative** counters. Downstream,
`counterDelta` sees the value drop from e.g. 5 000 000 to 0 and reads it as a counter
**reset**, discarding the interval. So an unreadable counter looked exactly like a rebooted
router, and there was nothing in the log to tell them apart.

✅ **Applied** — still returns `0n` (throwing would abort the whole poll over one field)
but now warns once, saying explicitly that the interval will read as a reset rather than
as real zero traffic.

### F-04 — The rot detector skipped what it could not read ✅ Fixed (importance 6)

`backupService.js:250`:

```js
try { hash = await sha256File(path.join(BACKUP_DIR, name)); }
catch { continue; }
```

This is the **backup integrity check**. Silently skipping a file it cannot read means the
file most likely to be damaged is the one excluded from the check — an unreadable backup
would pass "no rot detected" by not being looked at.

✅ **Applied** — the exclusion is now logged as an exclusion, naming the file and the
reason.

### F-06 — Errors used for flow control ✅ Two instances, both justified (importance 2)

1. `mikrotikClient.js:196` — calls `/interface/print` with `=stats=`, and on rejection
   retries without it. Older RouterOS builds do not support the flag, and there is no
   capability query to ask first. Logged, not silent. **Correct.**
2. `installKeyService.resolveKey` — falls back to the deprecated `.env`
   `AGENT_INSTALL_KEY` only when the table misses. A miss, not a throw. **Correct.**

Neither is the anti-pattern proper (using exceptions for an expected, cheap-to-test
condition). No action.

### F-07 — Generic catch-all hiding specific errors ✅ Fixed earlier

The central handler is intentionally generic *to the client* — that is the E-02 fix. It is
no longer generic in the **log**: it prints method, path and status, splitting 4xx (warn,
no stack) from 5xx (error, full stack).

One remaining catch-all worth naming: `backupService.js:338`
`setInterval(() => flush().catch(() => {}), FLUSH_MS)`. The empty catch is acceptable
**because `flush()` already logs each per-file failure internally** (`:108`) and re-queues
the lines; the outer catch only stops the timer's promise from becoming an unhandled
rejection. Left as-is.

---

## 4. Standardized error handling template

Copy these four shapes. They are what the codebase already does in its best places.

### 4.1 A service that validates input

```js
import { badRequest, notFound, conflict } from "../utils/httpError.js";

async function approveUser(id, role) {
  if (!ROLES.includes(role)) throw badRequest("Invalid role.");           // 400
  const user = await findById(id);
  if (!user) throw notFound("User not found.");                          // 404
  if (user.status !== "pending") throw conflict("User is not awaiting approval."); // 409
  // …
}
```

**Rule:** every throw that a user can trigger carries a status. A statusless throw means
*"this is a bug, not a user error"* — and the client is correctly told nothing about it.

### 4.2 A route

```js
import asyncHandler from "../utils/asyncHandler.js";

router.post("/:id/approve", authMiddleware, requireRole("admin"), asyncHandler(async (req, res) => {
  const user = await userService.approveUser(req.params.id, req.body.role);
  res.json({ user });
}));
```

**Rule:** no try/catch in a route. `asyncHandler` routes rejections to the central handler,
which owns the status→body mapping. Enforced by `tests/routeErrorHandling.test.js`.

### 4.3 A background loop (poller, sweep, cron)

```js
async function pollAll(io) {
  if (polling) return;                       // re-entry guard
  polling = true;
  try {
    for (const d of await loadDevices()) {
      try {
        await pollOne(io, d);
      } catch (err) {
        // ONE device failing must never stop the loop, and the reason must survive.
        console.error(`[POLLER] "${d.name}" (${d.ip}) failed:`, describeError(err));
        await markOffline(io, d);
      }
    }
  } catch (err) {
    console.error("[POLLER] load error:", describeError(err));
  } finally {
    polling = false;                         // a throw must not wedge the loop forever
  }
}
```

**Rule:** inner catch per item, outer catch for the batch, `finally` to release the guard,
`describeError` so a connection failure is not a blank line.

### 4.4 A deliberate swallow

```js
try {
  localStorage.setItem(KEY, value);
} catch {
  /* private mode / quota — persistence is a convenience, not a requirement */
}
```

**Rule:** an empty catch is allowed **only** with a comment saying why the failure is
acceptable. If you cannot write that sentence, it is not acceptable — log it.

### 4.5 What NOT to do

```js
// ✗ swallows the reason and returns a plausible value
try { return decrypt(v); } catch { return ""; }

// ✗ blank during a DB outage — mysql2 connection errors have an empty message
console.error("[x] failed:", err.message);

// ✗ becomes a 500; the user is told "Server error" for their own typo
throw new Error("Email already exists.");

// ✗ Socket.IO cannot catch this; Node 22 exits the process
socket.on("data", (d) => asyncHandler(d));
```

---

## 5. Unable to verify

- **Multi-statement write consistency** beyond `policyService.accept()`. **What would prove
  it:** find functions issuing 2+ INSERT/UPDATE statements and decide whether a partial
  application is meaningful; wrap those in a transaction.
- **Whether any of the 46 rewritten log lines changed meaning.** Each was a mechanical
  `err.message → describeError(err)` inside a `console.*` call, syntax-checked and
  test-covered, but not individually eyeballed. **What would prove it:**
  `git diff -U0 -- backend | grep describeError`.
- **The Go agent's error flow.** Not traced — this audit is JS/TS only. **What would prove
  it:** read the retry/backoff around the metric POST in `agent/cmd/agent/main.go`.
- **Frontend unhandled rejections.** There is no `window.addEventListener("unhandledrejection")`.
  The ErrorBoundary does not catch those (it catches render errors only). Low priority —
  the failure mode is a console warning, not a blank page — but it is a gap.

---

## 6. Applied this session

| ID | Change | Verification |
|----|--------|--------------|
| F-01 | `describeError()` in `utils/httpError.js`; applied to 46 log sites across 25 files | Before/after on a real ECONNREFUSED; `node --check` on every file; 247 tests |
| F-02 | `safeDecrypt` names the `MIKROTIK_ENC_KEY` mismatch, once per process | Syntax + boot |
| F-03 | `toBig` warns that an unparseable counter reads as a reset | Syntax + boot |
| F-04 | Backup checksum failure logged as an exclusion from the integrity manifest | Syntax + boot |

**247/247 backend tests pass. Server boots clean.**

---

*Traced 2026-08-25. Method: brace-matched classification of every `catch` block in
`backend/` and `frontend/src`; empirical layer-by-layer trace of a MySQL outage through
driver → service → central handler → client; live verification of the auth and validation
paths against the running server.*
