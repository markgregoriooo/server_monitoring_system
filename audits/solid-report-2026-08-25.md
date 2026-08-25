# SOLID Review — CSPC-ICTU Monitoring System

**Date:** 2026-08-25
**Scope:** `backend/` (83 modules), `frontend/src/` (88 modules)
**Companions:** the seven other 2026-08-25 audits in this folder

---

## 0. Verdict — SOLID compliance: 7 / 10

**First, an honest framing.** SOLID is a set of *class-oriented* principles. This codebase
contains **four classes in 171 modules**, all of them extending a framework base:

```
backend/utils/httpError.js:25   class HttpError        extends Error
backend/utils/httpError.js:115  class AuthRejection    extends Error
backend/utils/httpError.js:126  class ServiceUnavailable extends Error
frontend/.../ErrorBoundary.tsx  class ErrorBoundary    extends Component
```

Everything else is modules and functions. So Liskov and Interface Segregation have to be
translated into the module idiom rather than applied literally — and where a principle
genuinely does not bite, saying so is more useful than inventing a violation.

| Principle | Score | Summary |
|---|---|---|
| **S**ingle Responsibility | 7/10 | Strong overall; two modules hold 6–7 concerns |
| **O**pen/Closed | **9/10** | The best-served principle — five registries, extend by adding a row |
| **L**iskov Substitution | 8/10 | Barely applicable, but there **was** a real violation. Fixed |
| **I**nterface Segregation | 6/10 | Fat default-export surfaces; low bite in ESM |
| **D**ependency Inversion | **5/10** | The weakest — 23 modules import the concrete DB; no injection |

| ID | Finding | Imp | Status |
|----|---------|-----|--------|
| **L-01** | `ServiceUnavailable` and `unavailable()` disagreed on `expose`; the central handler ignored `expose` entirely and swallowed deliberate 5xx messages | **6** | ✅ **Fixed** |
| **S-01** | `reportService.js` — 7 responsibilities in 1067 lines | **5** | ⏳ Deferred |
| **D-01** | 23 modules import `config/mysql.js` directly; no injection seam | **4** | ⏳ By design, with a cost |
| **S-02** | `analyticsService.js` — 15 exports across 6 concerns | **4** | ⏳ Open |
| **I-01** | Default-export surfaces of 7–12 members where consumers use 1–3 | **3** | ⏳ Low bite |
| **O-01** | Open/Closed — five registries, no polymorphism needed | — | ✅ No action |

**248/248 backend tests pass** (one was updated to a corrected contract), 0 TypeScript
errors, clean build and boot.

---

## 1. Single Responsibility

### Where it holds ✅

The pure-module tier is the clearest evidence that SRP is understood here. Each of these
owns exactly one decision and nothing else — no I/O, no imports:

| Module | Its one reason to change |
|---|---|
| `linkAlertPolicy.js` | when a dark port counts as a fault |
| `envPersistPolicy.js` | when an ESP32 reading is worth storing |
| `alertRuleValidation.js` | what a valid alert rule is |
| `pingOutput.js` | how `ping` output parses |
| `analyticsMath.js` | the forecasting mathematics |
| `historyRange.js` | what a chart range means |
| `reportTypes.js` | which report types exist |

That is textbook SRP, and it is *why* 248 tests run in under a second with no database.

### S-01 — `reportService.js` holds seven responsibilities (importance 5) ⏳ Deferred

1067 lines covering: Flux plumbing · **seven report builders** · persistence
(`create`/`build`/`generate`/`list`) · file I/O (`fileFor`/`remove`) · email · retention
(`purgeOld`) · socket lifecycle (`init`).

Seven reasons to change. Adding a report type, changing retention, and switching mail
provider all edit the same file.

**Fix — the seam already exists.** The builders share nothing with the persistence half
except the `BUILDERS` lookup:

```
services/reportService.js            -> lifecycle only
services/reports/builders/index.js   -> export const BUILDERS = { environment, server, … }
services/reports/builders/ups.js     -> buildUps + its PURE aggregation helpers
```

⚠️ **Deliberately deferred** to the ICTU report-template work (`report-template-ictu`
memory) — that work edits these same files, so doing both at once means one review instead
of two conflicting ones.

### S-02 — `analyticsService.js`: 15 exports, 6 concerns (importance 4) ⏳ Open

Disk forecasting, UPS battery, link saturation, trends, anomalies, threshold
recommendations, and MTTR summaries.

**Better structured than S-01**, and it shows the pattern: all the mathematics already
lives in `analyticsMath.js` (pure, tested). What remains is I/O and shaping. `reportService`
has no such split, which is why its aggregation cannot be tested without a live InfluxDB.

**Fix:** split by concern once the routes stabilise —
`analytics/forecasts.js`, `analytics/anomalies.js`, `analytics/summaries.js`.

---

## 2. Open/Closed — the strongest principle here ✅ 9/10, no action

**Five registries let you extend by adding a row, not by editing logic:**

| Registry | Extend by |
|---|---|
| `reportTypes.js:34` `REPORT_TYPE_META` | adding a type row (+ a builder, enforced at boot) |
| `reportService.js:746` `BUILDERS` | adding a builder |
| `alertRuleValidation.js:67` `RULE_FIELDS` | adding a field spec |
| `sensorHandler.js:35` `ENV_METRICS` | adding a metric |
| `pip/tiles/catalog.tsx:646` `TILE_CATALOG` | adding a tile (`TILE_BY_ID` derives) |

Two of these were *created* by this audit series — `RULE_FIELDS` replaced a 34-branch
`clean()` function, and `REPORT_TYPE_META` replaced four parallel maps. Both were closed
for extension before; both are open now.

### The switch statements are not violations

Six `switch` statements, and none should be polymorphic:

| Location | What it maps |
|---|---|
| `alertRulesService.js:77`, `:105` | comparison operators `> < >= <=` |
| `snmpUtils.js:75` | RFC 1628 UPS output-source enum |
| `snmpClient.js:121` | SNMP value types → JS types |
| `googleAuthService.js:164` | account status → response |
| `routes/auth.js:43` | auth outcome → response |

Each is a **flat, exhaustive mapping over a closed set defined by an external standard**.
`>` will never gain a subclass. Replacing an RFC's enum with a class hierarchy would add
five files to express what five `case` labels already say. **No action.**

---

## 3. Liskov Substitution

With four classes and no custom hierarchies, LSP has almost nothing to bite on — the three
`Error` subclasses each set `name`/`status`/`message` and preserve `instanceof`, `stack`
and `cause`, so they substitute for `Error` correctly.

But there **was** one real violation, and it had a user-visible consequence.

### L-01 — Two 503s that behaved differently ✅ Fixed (importance 6)

`utils/httpError.js` offered two ways to raise a 503 that were **not substitutable**:

| Constructor | status | `expose` |
|---|---|---|
| `new HttpError(503, msg)` | 503 | **false** |
| `unavailable(msg)` | 503 | **false** |
| `new ServiceUnavailable(msg)` | 503 | **true** |

A caller handling "a 503 error object" got different behaviour depending on which one it
received — the definition of an LSP violation, expressed through a flag rather than a
method.

**And it was worse than cosmetic.** The central handler in `src/server.js` gated purely on
the status range:

```js
const body = status >= 400 && status < 500 ? { error: err.message } : { error: "Internal Server Error" };
```

So `expose` was **dead code at the one place it mattered**, and every deliberate 5xx lost
its message. `reportService` raises two:

```js
"Email is not configured on this server (SMTP_USER / SMTP_PASS)."   // 503
"The email provider rejected the message."                          // 502
```

Both were written *for the operator*, and both reached the admin as a bare **"Internal
Server Error"** — the opposite of their purpose.

> **This was a regression I introduced** in the error-handling audit (E-02). The E-02 fix
> correctly stopped 5xx from leaking driver text, but it gated on the status range instead
> of on intent, which threw out the deliberate messages with the accidental ones.

✅ **Applied — three coordinated changes:**

```diff
  // src/server.js — exposure follows INTENT, not just the range
- const body = status >= 400 && status < 500 ? … : …;
+ const showMessage = err.expose === true || (status >= 400 && status < 500);
+ const body = showMessage ? { error: err.message, … } : { error: "Internal Server Error", … };
```

```diff
  // utils/httpError.js — unavailable() now agrees with ServiceUnavailable
- export const unavailable = (message = "…", options) => new HttpError(503, message, options);
+ export const unavailable = (message = "…", options) =>
+   new HttpError(503, message, { expose: true, ...options });
```

```diff
  // services/reportService.js — use the shared factories instead of ad-hoc errors
- const err = new Error("Email is not configured on this server (SMTP_USER / SMTP_PASS).");
- err.status = 503; throw err;
+ throw unavailable("Email is not configured on this server (SMTP_USER / SMTP_PASS).");
```

**Verified across every case:**

```
accidental 500 (mysql)    -> 500  "Internal Server Error"        <- still no leak
deliberate 503 (SMTP off) -> 503  "Email is not configured on this server (SMTP_USER / SMTP_PASS)."
deliberate 502 (provider) -> 502  "The email provider rejected the message."
ServiceUnavailable        -> 503  "Service temporarily unavailable. Please try again shortly."
400 validation            -> 400  "Invalid role."
forced-generic 503        -> 503  "Internal Server Error"        <- override still works
```

**A test caught the change**, which is the system working: `tests/httpError.test.js`
asserted `unavailable().expose === false`, pinning the old contract. Rewritten to assert
the corrected one — that exposure follows **intent**, that an accidental 5xx stays generic,
and that the two 503 constructors now agree. 248/248 pass.

---

## 4. Interface Segregation

### I-01 — Fat default-export surfaces (importance 3) ⏳ Low bite

Measured: for each module with a `export default { … }` object, how much of it each
importer actually touches.

| Module | Exports | Importers | Avg used |
|---|---|---|---|
| `notificationService.js` | 12 | 10 | **1.8** |
| `alertsService.js` | 7 | 10 | **1.3** |
| `backupService.js` | 9 | 6 | **1.2** |
| `alertRulesService.js` | 11 | 8 | 2.4 |
| `alertBandState.js` | 7 | 7 | 2.6 |

Most consumers use **one** member: `raiseAlert`, `autoResolveMetric`, `record`,
`resetDevice`. They import a 12-member object to call one function.

**Why this is importance 3, not 6.** In ESM there is no interface to implement — a consumer
is not *forced* to satisfy anything, and on the backend there is no tree-shaking cost. The
real costs are modest: the dependency graph shows coupling that isn't real, and a reader
cannot tell from the import line what a module actually uses.

**Fix — named imports, which document themselves:**

```diff
- import notificationService from "./notificationService.js";
- …
- await notificationService.raiseAlert({ … });
+ import { raiseAlert } from "./notificationService.js";
+ …
+ await raiseAlert({ … });
```

⚠️ Most of these services currently export **only** a default object (`alertsService`,
`backupService`, `alertBandState` have zero named exports), so this needs named exports
added first. Worth doing opportunistically when a service is next edited — not as a
campaign.

> ⚠️ **Measurement caveat.** The scanner counts `alias.member` on one line, so a
> multi-line call (`notificationService\n  .raiseAlert(…)`) is missed. It initially
> reported `backupService` using **0 of 12** members of `notificationService` — a
> non-existent dead import. Checking the source showed three real multi-line uses. The
> averages above are therefore *slightly understated*; the pattern holds, the exact
> figures should not be quoted.

### Where segregation is already right ✅

`middleware/auth.js` exports `authMiddleware`, `requireRole`, `JWT_SECRET`,
`sessionIsLive`, `fetchSessionRow`, `sessionRevocationReason` as **named** exports, and
consumers import exactly what they need. `src/server.js` takes three; `socketSessions.js`
takes one. That is ISP working, and it is the model for I-01's fix.

---

## 5. Dependency Inversion — the weakest principle, 5/10

### D-01 — 23 modules import the concrete database (importance 4)

```js
import db from "../config/mysql.js";   // in 23 modules
```

No abstraction, no injection, no way to substitute. Same for `config/influx.js` (14) and
the vendor clients (`new RouterOSAPI`, `new OAuth2Client`, `new InfluxDB`).

**The consequence is testability, and it is measurable.** `backend/tests/` contains 248
assertions and **not one of them exercises a service** — every test targets a pure module.
`userService`, `agentService`, `reportService` and the pollers have no coverage at all,
because reaching them means reaching MySQL.

### But the codebase already has the right instinct

Two genuine inversions are in place:

**1. Manual dependency injection for `io`.** Five services take their Socket.IO dependency
through `init(io)` rather than importing it:

```js
notificationService.init(io);  alertsService.init(io);  reportService.init(io);
esp32Monitor.init(io);         socketSessions.init(io);
```

That is constructor injection, spelled with a function.

**2. Pure modules as the abstraction seam.** The recurring split — decision in a pure
module, I/O in the service — is DIP applied without the vocabulary:

| Pure (the policy) | Concrete (the mechanism) |
|---|---|
| `installKeyUtils` | `installKeyService` |
| `pingOutput` | `icmpPing` |
| `analyticsMath` | `analyticsService` |
| `alertRuleValidation` | `alertRulesService` |
| `linkAlertPolicy` | the pollers |

The high-level policy does not depend on the low-level detail. **That is the principle,
and it is already the house style** — it just hasn't been extended to data access.

**Fix — the smallest real inversion, where it buys a test:**

```js
// services/userService.js — default to the real pool, allow a fake in tests
export function createUserService({ db: database = db } = {}) {
  return { approveUser, updateUser, /* … */ };
}
export default createUserService();
```

⚠️ **Not applied.** Retrofitting injection across 23 modules is a large, invasive change
whose only payoff is testability — and the tests do not exist yet either. **Do it the other
way round:** when a service bug needs a regression test, invert *that* service to get one.
Inverting speculatively produces a factory nobody calls, which is exactly how the
2026-08-10 audit's utility modules ended up deleted as unused scaffolding.

### `new` usage ✅ appropriate

Every `new` on a collaborator is either a **value** (`new Point`, `new Date`) or a vendor
client constructed once at module scope (`new InfluxDB`, `new OAuth2Client`,
`new RouterOSAPI`, `new PDFDocument`). None is a collaborator constructed deep inside a
function where it would defeat substitution.

---

## 6. Rating: 7 / 10

**Earning it:**
- A genuine pure-module tier — high-level policy separated from low-level mechanism
- Open/Closed served by five registries; two of them created during this audit series
- No inheritance to get wrong, and the four `Error` subclasses honour their base contract
- `middleware/auth.js` shows properly segregated named exports
- `init(io)` is real dependency injection

**Holding it back:**
- Two modules with 6–7 responsibilities (`reportService`, `analyticsService`)
- Data access is a hard concretion in 23 modules, with **zero service-level test coverage**
  as the direct consequence
- Default-export surfaces of 7–12 members where consumers use one

**To reach 9:** split `reportService` along its `BUILDERS` seam, and invert data access in
*one* service — the one that next needs a regression test.

---

## 7. Unable to verify

- **Whether service-level injection would actually be used.** The payoff is tests that do
  not exist. **What would prove it:** a bug in `userService` or `agentService` that needs a
  regression test — then invert that service and see whether the test is easy to write.
- **Whether the frontend has ISP issues.** The scan covered `backend/` default exports
  only; the frontend uses named exports and React props throughout. **What would prove
  it:** run the same measurement over `frontend/src` component prop interfaces.
- **Exact ISP ratios** — see the caveat in §4; the scanner undercounts multi-line access.
- **The Go agent.** Not reviewed. Go has no classes and its own composition idioms; SOLID
  as stated here would not translate. **What would prove it:** read
  `agent/internal/` for interface usage at the collector/sender boundary.

---

## 8. Applied this session

| ID | Change | Verification |
|----|--------|--------------|
| L-01 | Central handler honours `expose`; `unavailable()` exposes like `ServiceUnavailable`; `reportService`'s two ad-hoc 5xx use the shared factories | 6 error shapes checked end to end; test rewritten to the corrected contract; 248/248 pass |

---

## 9. Recommended order

1. **S-01** — split `reportService` along the `BUILDERS` seam, **bundled with the ICTU
   template work**.
2. **S-02** — split `analyticsService` by concern once the routes stabilise.
3. **D-01** — invert data access in **one** service, the next one that needs a regression
   test. Not speculatively.
4. **I-01** — add named exports and switch to named imports opportunistically, when a
   service is edited for another reason.

Leave the six `switch` statements and the four `Error` classes alone. Both are correct as
they are, and "fixing" them would add indirection without removing a branch.

---

*Reviewed 2026-08-25. Method: class and inheritance census; registry vs. conditional-dispatch
survey; measured default-export surface against actual member use per importer (with the
stated multi-line caveat); `new`-usage classification; and runtime verification of the
error-exposure contract across six error shapes.*
