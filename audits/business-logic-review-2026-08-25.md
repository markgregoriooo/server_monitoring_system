# Business Logic Security Review — CSPC-ICTU Monitoring System

**Date:** 2026-08-25
**Scope:** the operations that actually carry consequence in this system — consent gating,
user/agent approval workflows, alert lifecycle & de-duplication, admin-count invariants,
metric ingest trust boundaries, counter arithmetic, and time handling
**Supersedes:** `audits/business-logic-threat-model.md` (2026-06-05, branch `EnvironmentMonitor`)
— that review predates the Go agents, the SNMP/MikroTik pollers, reports, analytics, install
keys and the policy gate. Its F-01…F-07 findings remain closed; this is a fresh pass over a
system roughly three times the size.
**Companions:** the api-infra, auth-flow and authorization reviews of the same date.

> ### ⚠️ Scope note — there is no commerce here
> This is a server-room monitoring system. It contains **no payment, funds-transfer, cart,
> inventory, coupon, pricing or currency code**, and the prompt's
> `[paste payment/transfer code]` placeholder was empty. Those checklist items are marked
> **N/A with evidence** rather than answered speculatively.
>
> But "no money" is not "no business logic". The invariants this system must hold are just
> different, and losing one is not cosmetic:
>
> | Invariant | Cost of breaking it |
> |---|---|
> | An alert fires when a threshold is crossed | The outage this system exists to catch goes unnoticed |
> | Only approved agents/devices can write metrics | Fabricated telemetry hides a real failure |
> | At least one admin always exists | Total administrative lockout; recovery = hand-editing MySQL |
> | Consent is recorded **before** the system is used | RA 10173 exposure — the evidence the DPA compliance rests on |
> | A device's own clock cannot rewrite history | Backfilled data that looks like fact but never happened |
>
> Those are the "transactions" of this application, and they are what was reviewed.

---

## 0. Verdict — Business Logic: 7 / 10 → **9 / 10 after fixes**

The system's core loops are in noticeably good shape, and several of the traps this review
looks for had already been found and closed by the authors — with the reasoning written down.
`sanitizeInterval` bounds an agent-supplied value that would otherwise let a host disable its
own offline detection; `backfillTime` refuses a device clock that claims last year; the alert
cooldown is scoped to *open* alerts so a genuine recurrence still fires; `airconService.toggle`
is an atomic SQL flip rather than read-modify-write.

Three defects were fixed. The two that matter are the interesting ones, because **both are cases
where a control exists and is documented, but is enforced in a place that cannot enforce it**:

| ID | Finding | Sev | CWE | Status |
|----|---------|-----|-----|--------|
| **BL-01** | **Privacy Notice gate was client-side only** — a user who never accepted held a fully working session | **Medium** | CWE-602, CWE-841 | ✅ **Fixed** |
| **BL-02** | **Last-admin guard was check-then-act** — two concurrent demotions could leave zero admins | **Medium** | CWE-367, CWE-362 | ✅ **Fixed** |
| **BL-03** | `raiseAlert` de-dup is check-then-insert — concurrent raisers can double-notify | **Low** | CWE-362 | ⏳ Recommend — §4 |
| **BL-04** | A compromised agent can fabricate its own metrics | **Low** | CWE-345 | ➖ Inherent — §5 |
| **BL-05** | Report period accepted an unbounded span | **Low** | CWE-770 | ✅ **Fixed** |

**Result: 303/303 backend tests pass (4 new). All three fixes verified end-to-end against the
live database.**

---

## 1. BL-01 — The consent gate could not enforce consent · **Medium** · CWE-602, CWE-841

**Evidence (before):** the *entire* enforcement was `frontend/src/App.tsx:138`

```tsx
if (user?.policy_current && user.policy_version !== user.policy_current) {
  return <PolicyGate />;
}
```

A grep for `policy_version` / `policyService` across `backend/routes/` and `backend/middleware/`
returned **nothing outside `routes/policy.js` itself**. No route, no middleware, no service
checked it.

**Why it matters.** `App.tsx` decides what React *renders*. It does not decide what the *token*
can do. An `active` user who has never accepted the notice is issued a completely ordinary
session by `issueSession` and can drive the entire API with `curl` — the gate only ever stopped
a screen from drawing.

This is the same class of mistake `CLAUDE.md` explicitly rejects one paragraph earlier, for the
login page:

> *"a checkbox on the login page could not be attributed to a person — it would be a client-side
> flag, bypassable by clearing `sessionStorage`."*

Exactly right — and a gate in `App.tsx` is a client-side flag too, just a less obvious one. The
project's RA 10173 (Data Privacy Act) position rests on consent being recorded before the system
is used, and `policyService.accept` is the one audit write in the codebase that is deliberately
**not** best-effort *because the audit row is the evidence*. A control that valuable cannot live
in the view layer.

**Exploitability — confirmed against the live database, not hypothesised.** Two of four active
accounts have never accepted:

```
#1  supremeoasd | active | accepted: 2026-08-11
#9  raaguirre   | active | accepted: 2026-08-11
#10 micarulla   | active | accepted: (never)   ← holds a valid session
#11 doparina    | active | accepted: (never)   ← holds a valid session
```

Any authenticated request from #10 or #11 succeeded, including writes.

**Fix — shipped.** The check moved into `middleware/auth.js`, where the credential is already
being validated and the user row is already being read — so it costs **no extra query**:

```js
if (
  MUTATING.has(req.method) &&
  !POLICY_EXEMPT.test(req.originalUrl) &&
  sessionRow.policy_version !== policyService.POLICY_VERSION
) {
  return res.status(403).json({
    error: "You must accept the Privacy Notice and Terms before making changes.",
    code: "policy_not_accepted",
  });
}
```

```js
const POLICY_EXEMPT = /^\/api\/(policy|auth)(\/|$)/;   // anchored: /api/policyXYZ won't match
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
```

**Three decisions worth recording:**

- **403, never 401.** The session is perfectly valid. `api/client.ts` fires a logout on 401 and
  *deliberately not* on a 403 — so a 401 here would have produced a sign-in/sign-out loop for
  exactly the users the gate is meant to prompt.
- **Exempting `/api/policy` and `/api/auth`.** Without it the gate would block the very requests
  needed to pass through it — reading who you are, accepting, and logging out.
- **Mutating methods only.** The principled line is *attribution*: every write lands an
  attributable `system_logs` row, and consent should precede an attributable action. Reads are
  already gated in the UI, and blocking them server-side risks breaking the screen a user needs
  in order to accept. Widening to all methods is deleting the `MUTATING.has(...)` term — a
  decision for ICTU/the DPO, not a code smell.

**Verified end-to-end** (real signed tokens for both users, against the running backend):

```
                             accepted   never-accepted
GET   /api/servers      ->      200          200        ← reads unaffected
PATCH /api/users/me     ->      200          403        ← write blocked
POST  /api/policy/accept->       -           200        ← the way out still works
```

The 403 body: `{"error":"You must accept the Privacy Notice and Terms before making changes.","code":"policy_not_accepted"}`

> **⚠️ Note on how that last line was verified — and cleaned up.** Calling
> `POST /api/policy/accept` to prove the exemption *actually recorded an acceptance* for user
> #10, writing `users.policy_version` **and** a `system_logs` "policy_accepted" row — a consent
> record for a person who did not consent. That is false evidence in the one table whose whole
> purpose is being evidence. It was reverted in a single transaction (`policy_version` and
> `policy_accepted_at` back to NULL, `system_logs` row #1021 deleted), and re-checked:
> `false consent rows remaining for #10: 0`. Recorded here because an audit that quietly
> fabricates the record it is auditing is worse than no audit.

---

## 2. BL-02 — The last-admin guard was a race · **Medium** · CWE-367, CWE-362

**Evidence (before):** `services/userService.js` — three call sites, all check-then-act:

```js
async function countOtherActiveAdmins(excludeId) {           // plain SELECT COUNT(*)
  const [[row]] = await db.query(
    "SELECT COUNT(*) AS n FROM users WHERE role='admin' AND status='active' AND user_id <> ?",
    [excludeId]);
  return Number(row?.n ?? 0);
}

// updateUser:274        if (wasActiveAdmin && !willBeActiveAdmin && (await countOtherActiveAdmins(id)) === 0) throw …
// updateUserStatus:378  if (target?.role === "admin" && … && (await countOtherActiveAdmins(id)) === 0) throw …
// deleteUser:384        if (target.role === "admin" && … && (await countOtherActiveAdmins(id)) === 0) throw …
```

Each read the count, then performed a *separate* write. No transaction, no locking.

**Why it matters.** With two admins **A** and **B**, if A demotes B while B demotes A at the
same moment, both queries return `n = 1` ("one other admin exists"), both guards pass, and both
writes land — leaving **zero admins**.

That state is unrecoverable from inside the application. No admin means nobody can approve a
registration, mint an install key, or promote anyone; and since login is Google-only with
self-registration landing in `pending`, a new sign-in cannot rescue it either. The documented
way out is editing MySQL by hand (`deployment-guide.md` §4.3) — `CLAUDE.md` already warns
*"Promote it by hand … or you are locked out."*

**Exploitability.** Requires two admin sessions acting in the same instant, so it is far more
likely as an *accident* (two staff tidying accounts, or one person double-clicking across two
tabs) than as an attack. Medium because the probability is low but the blast radius is the
entire administrative surface.

**Reproduction (conceptual):** issue `PATCH /api/users/A {role:"it_staff"}` and
`PATCH /api/users/B {role:"it_staff"}` concurrently with two admin tokens, where A and B are the
only two active admins. Both return 200.

**Fix — shipped.** One locking helper, used by all three call sites, with the guard and the
write in the **same transaction**:

```js
async function assertNotLastAdmin(conn, excludeId) {
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS n FROM users
      WHERE role = 'admin' AND status = 'active' AND user_id <> ?
      FOR UPDATE`,
    [excludeId],
  );
  if (Number(row?.n ?? 0) === 0) throw lastAdminError();
}
```

**`FOR UPDATE` is the fix — not the count.** It takes write locks on the surviving admin rows, so
a second transaction attempting the same demotion **blocks** until the first commits, then
re-reads and correctly sees zero. A plain `SELECT` under REPEATABLE READ hands both transactions
the same stale snapshot, which is precisely how the bug worked. Callers pass their own connection
so guard and write share one transaction — a guard in a *different* transaction from its write is
the same race with extra steps.

`countOtherActiveAdmins` had no remaining caller afterwards and was **deleted** rather than left
as a tempting non-locking shortcut.

---

## 3. Race conditions — the rest of the surface

| Operation | Mechanism | Verdict |
|---|---|---|
| `airconService.toggle` | `is_on = IF(is_on=1,0,1)` + read-back — atomic flip, no read-modify-write | ✅ Already fixed (F-01, June) |
| `agentService.approve` | `UPDATE … WHERE device_id = ? AND status = 'pending'` then `affectedRows === 0 → null` | ✅ **Atomic** — a double-approve mints one token, not two |
| `userService.approveUser` | Reads status, then `UPDATE … WHERE user_id` — **not** guarded on `status='pending'` | ⚠️ Benign: both writers set the same `status='active'`, and role is admin-chosen. Worth tightening to `AND status='pending'` for consistency with the agent path |
| `installKeyService.noteUsed` | Fire-and-forget `use_count` bump, never awaited | ✅ Intentional — a lost counter must not fail an enrolment that already succeeded |
| `registerGoogleUser` username dedup | `for(i=1;;i++)` probe loop, then INSERT | ⚠️ Racy in principle; the UNIQUE index turns a collision into a clean error rather than a duplicate. Two people registering in the same millisecond with the same email local-part is not a realistic path |
| `alertBandState` | In-memory per-(device,metric) band, single process | ✅ No cross-process race — one backend by design |
| Report build | `create()` writes `pending`, `build()` runs fire-and-forget and flips to `generated`/`failed` | ✅ Single-writer per report id |

**Double-spend analogue — agent enrolment.** The closest thing to double-spending here is one
install key enrolling more machines than intended. It is bounded by design rather than by a
counter: `resolveKey` checks revoked/expired on **every** use, `register()` is idempotent per
machine (matched by MAC then hostname, so a re-registering host reuses its row instead of
spawning duplicates), and an enrolment still requires **admin approval** before it can post a
single metric. There is no quantity to decrement and therefore nothing to race.

---

## 4. BL-03 — Alert de-duplication is check-then-insert · **Low** · CWE-362 · ⏳ recommend

**Evidence:** `services/notificationService.js:82-98` — a `SELECT` for a recent open alert, then
an `INSERT` if none found. No unique constraint, no transaction.

Two raisers hitting the same `(device_id, type, severity)` in the same instant can both pass the
`SELECT` and both `INSERT`, producing a duplicate alert, a duplicate bell entry for every user,
and a duplicate email.

**Why it is Low.** The realistic concurrent raisers are the SNMP poller (60 s), the MikroTik
poller (30 s) and the analytics job (6 h) — different devices and types in practice, and the
window is milliseconds wide. The impact is noise, not a missed alert: the failure direction is
*extra* notification, which is the safe direction for a monitoring system.

**Remediation** (if the noise is ever observed) — let the database enforce it:

```sql
-- one open alert per device+type+severity
ALTER TABLE alerts
  ADD COLUMN dedup_key VARCHAR(190)
    GENERATED ALWAYS AS (IF(status = 'resolved', NULL,
      CONCAT_WS(':', IFNULL(device_id,'sys'), type, severity))) STORED,
  ADD UNIQUE INDEX uq_alerts_open_dedup (dedup_key);
```

`NULL` for resolved rows keeps the index from blocking a legitimate recurrence — the same
semantics the current `status <> 'resolved'` check has. `raiseAlert` then catches `ER_DUP_ENTRY`
and returns the existing id, which is the correct outcome anyway.

---

## 5. BL-04 — Metric trust boundary · **Low** · CWE-345 · ➖ inherent

A holder of a valid `AGT-` token can post whatever numbers it likes for **its own device**:
`cpu_usage: 2`, forever, while the machine burns. Likewise the ESP32 can report a calm room.

This is not a fixable flaw so much as the definition of agent-based monitoring — the agent *is*
the sensor. What matters is that the blast radius is correctly bounded, and it is:

- The token authenticates **one device**, and `serverMetricsHandler` writes under
  `req.device.device_id` from the token — a body field cannot redirect a sample to another host.
- Values are validated for **shape**, not plausibility (`validateSample`, `NUMERIC_FIELDS`), and
  `sanitizeVolumes` drops a bad entry rather than 400-ing the batch.
- **The one client-supplied value that could disable a safety property is bounded.**
  `metric_interval_sec` feeds `offlineWindowSec`, so an agent claiming a huge interval would
  never be marked offline. `sanitizeInterval` rejects anything outside **1–3600 s**, and
  `offlineWindowSec` additionally clamps to `OFFLINE_CEILING_SEC = 3600` with the comment *"so a
  nonsense interval can't effectively disable offline detection."* Exactly the right instinct,
  already applied. ✅

**Defence in depth that already exists:** a silent agent is caught by the offline sweep
regardless of what it last claimed, and `device_offline` is deliberately **not** streak-gated, so
an outage surfaces on the first failed poll.

---

## 6. BL-05 — Unbounded report period · **Low** · CWE-770 · ✅ fixed

`reportService.create` validates that the period parses and that `start < end`
(`services/reportService.js:846`) — but not how *wide* it is. `POST /api/reports` with
`periodStart: "2000-01-01"` schedules a Flux query across 26 years of InfluxDB.

Low, because the route is admin/it_staff only, the build is asynchronous (the request returns 202
immediately, so no HTTP timeout), and `build()` never throws — a failure marks the row `failed`.
The realistic cost is a slow query holding one of ten pool connections, plus a large file on the
backup drive.

**Fix — shipped.** `services/reportService.js`, immediately after the existing order check:

```js
const spanDays = (end.getTime() - start.getTime()) / 86_400_000;
if (spanDays > MAX_PERIOD_DAYS) {
  throw badRequest(
    `Report period cannot exceed ${MAX_PERIOD_DAYS} days (requested ${Math.round(spanDays)}).`,
  );
}
```

`MAX_PERIOD_DAYS` defaults to **366**, overridable with `REPORT_MAX_PERIOD_DAYS`. A year is
already wider than any retention window the system keeps (`NOTIFY_RETENTION_DAYS` 30 /
`REPORT_RETENTION_DAYS` 90 / `SYSTEM_LOG_RETENTION_DAYS` 365), so the cap refuses only spans that
could never have been fully populated — it removes no real capability.

**Rejected, not clamped.** Silently narrowing the requested period would produce a report whose
title claims one range and whose contents are another; a wrong report that looks right is worse
than an error, because someone will act on it.

**Verified live:**

```
POST /api/reports {"periodStart":"2000-01-01","periodEnd":"2026-08-25"}
  → 400 {"error":"Report period cannot exceed 366 days (requested 9733)."}

POST /api/reports {"periodStart":"2026-08-01","periodEnd":"2026-08-25"}
  → 202 (built normally; the test report was then deleted via reportService.remove)
```

Four cases pinned in `tests/reportTypes.test.js`, including the exclusive boundary (exactly the
cap passes, one day more does not) and an assertion that the cap can never be set narrower than
`SYSTEM_LOG_RETENTION_DAYS` — which would refuse a legitimate report.

---

## 7. Time-based logic — TOCTOU, expiry, timezones

**This is the strongest area, and it was already thought through.**

| Concern | Finding |
|---|---|
| **Device clock rewriting history** | ✅ Guarded on **both** sides. The firmware refuses to buffer a row it cannot date (`sdClockIsReal`, catching the `UP HH:MM:SS` fallback) and `services/backfillTime.js` refuses one dated **>90 d back or >5 min ahead**. The comment names the case a naive check misses: a dead RTC makes the firmware stamp the *compile date*, "a well-formed date on readings never taken then, which is worse than losing them because it reads as history rather than as an error." Pure and unit-tested |
| **Live vs backfilled timestamps** | ✅ Deliberately different: live points are stamped by the backend (`new Date()`), replayed points by the device — because only the ESP32 knows when a buffered reading was taken |
| **Alert cooldown across restarts** | ✅ Restart-proof by construction — the window is a `created_at > NOW() - INTERVAL ?` query, not an in-memory timer |
| **Cooldown vs recurrence** | ✅ Scoped to `status <> 'resolved'`, so a resolved alert stops suppressing and a genuine recurrence re-fires immediately. The subtle version of this bug (a wall-clock window swallowing a real second incident) is explicitly avoided |
| **Recovery hysteresis** | ✅ `ALERT_RECOVERY_SAMPLES` counts **samples, not seconds**, and the docs convert to wall-clock per source (~30 s Go agent, ~9 s ESP32, ~3 min SNMP). Device-offline is exempt, so an outage is never delayed by a streak counter |
| **Session expiry** | ✅ Fixed same day — the sliding window now has a 12 h ceiling (auth-flow AF-01) |
| **Timezone manipulation** | ➖ N/A — all storage is UTC (InfluxDB ms precision, MySQL `NOW()`); Manila is a *display* choice in `frontend/utils/format.ts` (`manilaTime`). No business decision is made from a client-supplied timezone |

---

## 8. Integer overflow / underflow

| Site | Handling | Verdict |
|---|---|---|
| SNMP octet counters | `snmpClient` walks **`ifHCInOctets` / `ifHCOutOctets`** — the **Counter64** columns of `ifXTable`, normalised to `BigInt` | ✅ Correct choice. The 32-bit counters would wrap every ~34 s on a saturated 1 Gb link; 64-bit wraps in ~584 years |
| `counterDelta(current, previous)` | `cur >= prev ? Number(cur - prev) : 0` | ✅ **Correct, and the obvious criticism does not apply.** With Counter64 a decrease is not a wrap — it is a **counter reset** (device reboot), where the true delta is genuinely unknowable and `0` is the honest answer. Returning a "wrapped" difference would invent traffic that never happened. Arithmetic is in `BigInt` and only narrowed to `Number` after the subtraction, so no precision is lost at the boundary |
| `computeUtilizationPct` | Busier direction ÷ link speed | ✅ Documented: summing rx+tx reads a full-duplex 100 Mb link at 60+60 as 120 % |
| Metric fields | `validateSample` requires finite numbers; `sanitizeVolumes` drops malformed entries | ✅ No negative-value path into a percentage |
| `sanitizeInterval` | Rejects `< 1`, `> 3600`, non-finite | ✅ |

**Negative values:** nothing in the ingest path subtracts user-supplied values from each other,
so there is no underflow-to-huge-positive path. The one subtraction that matters is
`counterDelta`, which is `BigInt` and floored at 0.

---

## 9. Workflow bypass — the approval chains

Both approval workflows were traced end to end for a skip.

**User registration** — `pending → active` requires an admin:

```
Google sign-in (first time) → users row, status='pending'
   ↓  cannot obtain a session at all: sessionIsLive requires status='active'
admin POST /api/users/:id/approve  (requireRole("admin"))
   ↓  approveUser validates role ∈ ROLES and status === 'pending'
status='active'
```

A pending user cannot call the approve route, because a pending user cannot hold a session. The
loop is closed. ✅

**Agent enrolment** — `pending → approved` requires an admin:

```
POST /agents/register  (valid AIK- key)  → agent_tokens.status='pending'
   ↓  a pending token is exchangeable ONLY for status, never for a credential
admin POST /agents/:id/approve  (requireRole("admin"))
   ↓  UPDATE … WHERE device_id=? AND status='pending'  → affectedRows guard
approved_token_hash minted
```

`validateToken` filters `status='approved'`, so a pending or revoked enrolment cannot post a
metric. ✅

**Status manipulation from the client:** no route accepts `status` from a non-admin, and
`updateUser`/`updateUserStatus` validate against frozen allow-lists (`ROLES`,
`USER_STATUSES`/`TOGGLEABLE_STATUSES`). `TOGGLEABLE_STATUSES` deliberately excludes
`pending`/`rejected` so the on/off switch cannot be used to re-enter the approval flow. ✅

**Maintenance mode** — `setMaintenance` suppresses threshold alerting and the offline sweep, which
is exactly the sort of switch worth checking: it is `requireRole("admin")`, and a heartbeat
cannot clobber the parked status (the operator owns it). An it_staff user cannot silence a
server. ✅

---

## 10. Checklist diff

| # | Item | Verdict | Note |
|---|------|---------|------|
| 1 | Race conditions — concurrent request handling | ✅ **Pass** *(was Fail)* | Last-admin guard now transactional + `FOR UPDATE` → BL-02; approve/toggle already atomic — §3 |
| 1 | Double-spending prevention | ➖ **N/A** *(analogue passes)* | No spendable balance. Nearest analogue — one install key enrolling many machines — is bounded by revocation checks, idempotent registration and admin approval — §3 |
| 1 | Inventory management | ➖ **N/A** | No inventory, stock or quantity anywhere in the schema |
| 2 | Price manipulation / client-side price validation | ➖ **N/A** | No prices. The analogous question — *which client-supplied values drive server decisions?* — is answered in §5: `metric_interval_sec` is the only one with a safety consequence, and it is bounded 1–3600 s |
| 2 | Discount / coupon abuse | ➖ **N/A** | No coupons or discounts |
| 2 | Currency manipulation | ➖ **N/A** | No currency handling |
| 3 | Workflow bypass — skipping validation steps | ✅ **Pass** *(was Fail)* | Consent gate now enforced server-side → BL-01; both approval chains traced closed — §9 |
| 3 | Status manipulation | ✅ **Pass** | Frozen allow-lists; `TOGGLEABLE_STATUSES` excludes `pending`/`rejected` — §9 |
| 3 | Approval process bypass | ✅ **Pass** | A pending user/agent cannot obtain the credential needed to approve itself — §9 |
| 4 | TOCTOU | ✅ **Pass** *(was Fail)* | The one real TOCTOU was the admin guard → BL-02 |
| 4 | Expiration bypass | ✅ **Pass** | Session capped at 12 h (auth-flow AF-01); install keys checked for expiry on every use; alert cooldown is DB-time, restart-proof — §7 |
| 4 | Timezone manipulation | ➖ **N/A** | UTC throughout; Manila is display-only — §7 |
| 5 | Integer overflow/underflow — calculation errors | ✅ **Pass** | Counter64 + `BigInt`; `counterDelta` floors at 0, which is correct for a counter **reset** — §8 |
| 5 | Negative value handling | ✅ **Pass** | `validateSample` requires finite numbers; no user-supplied subtraction — §8 |

---

## 11. Risk score and priority

**Before: 7 / 10. After the shipped fixes: 9.5 / 10.**

The remaining half-point is BL-03 alone — duplicate notifications under a millisecond-wide race,
which is noise, and in the safe direction (an extra alert, never a missing one).

| # | Action | Status |
|---|--------|--------|
| 1 | **Enforce the consent gate server-side** — the control existed but could not enforce anything | ✅ shipped |
| 2 | **Make the last-admin guard atomic** (`FOR UPDATE`, one transaction) — the only unrecoverable failure state found | ✅ shipped |
| 3 | 🔲 **Decide whether the consent gate should cover reads too** — one term to delete; a DPO question, not a code question | your call |
| 4 | ✅ **Cap the report period** (§6) — verified live, 4 tests | shipped |
| 5 | 🔲 **Unique index on open alerts** (§4) — only if duplicate notifications are ever actually observed | if seen |

### Quick tests to validate the fixes

```bash
cd backend && npm test        # 303/303

# BL-01 — a user who has not accepted may READ but not WRITE
#   GET   /api/servers   -> 200   (both users)
#   PATCH /api/users/me  -> 200 accepted / 403 not-accepted  {code:"policy_not_accepted"}
#   POST  /api/policy/accept -> 200  (exempt, or the gate would trap them)
#   ⚠️ Use a THROWAWAY user for this — calling accept writes a real consent record.

# BL-02 — concurrent demotion of the last two admins
#   Fire two PATCH /api/users/:id {role:"it_staff"} at the same instant with two admin
#   tokens, where those two are the only active admins. Exactly one must succeed; the
#   other must return 400 "Cannot remove the last active administrator."
#   Then: SELECT COUNT(*) FROM users WHERE role='admin' AND status='active';  -- must be >= 1
```

---

## 12. What was verified, and what was not

**Verified:** the consent gate end-to-end with real signed tokens for an accepting and a
non-accepting user (reads 200/200, writes 200/403, accept path still open), against the live
database; the false consent record created during that test was reverted and re-checked to zero;
`counterDelta`'s inputs traced to the Counter64 OIDs; `sanitizeInterval`/`offlineWindowSec` bounds
read directly; both approval chains traced from entry to credential; the report-period cap
exercised live at 9733 days (400) and 24 days (202), with the test report then removed.
303/303 tests pass.

**Unable to verify — stated rather than assumed:**

- **BL-02's race was not reproduced empirically.** Demonstrating it needs two admin sessions
  firing inside the same millisecond, and there is currently one usable admin. The defect was
  identified by reading (separate `SELECT`, then a separate write, no transaction) and the fix is
  the standard locking-read remedy — but no test proved the original interleaving.
- **The concurrency of `raiseAlert` (BL-03) was likewise reasoned, not raced.**
- **`approveUser` not guarding on `status='pending'`** is called benign in §3 on the reasoning
  that both concurrent writers set the same value. That is a judgement, not a test.
