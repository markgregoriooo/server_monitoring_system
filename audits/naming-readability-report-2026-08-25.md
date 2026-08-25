# Naming & Readability Review — CSPC-ICTU Monitoring System

**Date:** 2026-08-25
**Scope:** `backend/`, `frontend/src/` — 171 modules, ~37,300 code lines
**Companions:** the five other 2026-08-25 audits in this folder

---

## 0. Verdict

**Naming in this codebase is above average, and most of the usual complaints do not
apply.** Four of the seven things the brief asks about turned out to be non-issues, and
saying so is more useful than manufacturing findings:

| Checked | Result |
|---|---|
| snake_case leaking into JS locals | **0** — the DB boundary is respected via `toClient()` mappers |
| British/American mixing **in identifiers** | **0** — every British spelling is in prose |
| Constant casing consistency | Consistent, and the UPPER_CASE/camelCase split is *meaningful* |
| Ternary abuse | Not present — 116 nested, but they are 2-level priority chains |
| Magic numbers | Mostly HTTP status codes and seconds-per-day. Not magic |
| Comment density | 17.5% — healthy, and they explain **why**, not what |

What tracing *did* find were three concrete hazards where a name actively misleads.

| ID | Finding | Imp | Status |
|----|---------|-----|--------|
| **N-01** | `makeCombinedOptions(…)` took **7 positional args, 4 adjacent numbers** — transposable silently | **5** | ✅ **Fixed** |
| **N-03** | **`num` defined 5×** with **4 different contracts** for invalid input | **5** | ✅ **Fixed** |
| **N-04** | 14 functions still take >3 positional params | **4** | ⏳ Mostly fine — see §4 |
| **N-02** | 6-deep ternary ladder used as a lookup table | **3** | ✅ **Fixed** |
| **N-05** | `u` for `user` in 5 closures | **2** | ⏳ Open |

**247/247 backend tests pass. 0 TypeScript errors. Clean build and boot.**

> ⚠️ **A note on method.** My first scan reported 24 over-parameterised functions and 81
> cryptic names. Both were wrong. The parameter counter treated destructured objects
> (`fn(id, { a, b, c })` — the *recommended* pattern) as 4 parameters, and trailing commas
> in multi-line signatures invented a phantom argument. After fixing the counter twice the
> real figure was **14**. The "cryptic names" were largely `W`/`H` in canvas code, `ts` for
> timestamp, `tl` for an anime.js timeline — all idiomatic. Numbers in a naming audit are
> easy to inflate; these were re-derived until they matched the source.

---

## 1. Naming conventions

### N-03 — `num` means four different things ✅ Fixed (importance 5)

Five module-private helpers, all called `num`, with **four different contracts for invalid
input**:

| File | Signature | Invalid input → | Also rejects |
|---|---|---|---|
| `analyticsAlerts.js:33` | `num(v, dflt)` | `dflt` | **zero and negatives** |
| `deviceAlerts.js:37` | `num(v)` | `NaN` | — |
| `envPersistPolicy.js:39` | `num(v, fallback)` | `fallback` | — |
| `mikrotikClient.js:17` | `num(v)` | `null` | — |
| `reportService.js:118` | `num(v, d = 1)` | `null` | — (also **rounds**) |

The name conveys nothing about which applies. Copy a line between these files — an easy
thing to do, since they are all sensor/metric code — and the behaviour changes silently:
`NaN` fails a comparison, `null` omits a field, `dflt` substitutes a value, and
`analyticsAlerts`'s version uniquely turns a legitimate `0` into the default.

✅ **Applied** — each renamed to state its contract, with a one-line note:

```diff
-const num = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt);
+const positiveEnvNum = (v, dflt) => …   // analyticsAlerts — rejects 0 and negatives too
-const num = (v) => (v == null || !Number.isFinite(Number(v)) ? NaN : Number(v));
+const numOrNaN = (v) => …               // deviceAlerts — NaN so a threshold test is false
-const num = (v, fallback) => { … }
+const numOrFallback = (v, fallback) => …// envPersistPolicy
-const num = (v) => { … return Number.isFinite(n) ? n : null; }
+const numOrNull = (v) => …              // mikrotikClient — omit rather than store a wrong 0
-const num = (v, d = 1) => …
+const roundOrNull = (v, d = 1) => …     // reportService — blank cell rather than NaN
```

All five are module-private (verified: zero exports), so each rename is file-local. 53
call sites updated across the five files; syntax-checked, 247 tests pass, server boots.

### What is already right ✅

**snake_case: zero leaks.** The scan found **0** snake_case local declarations. That is
notable because the codebase is full of snake_case *data* — `device_id`, `mq2_1_ppm`,
`threshold_value` — which is correct: those are MySQL column names and InfluxDB fields.
The six `toClient(row)` mappers are the boundary where snake_case becomes camelCase, and
nothing crosses it by accident.

**Constant casing is consistent AND meaningful.** 110 UPPER_CASE vs 55 camelCase at module
level, and the split is not sloppiness:

```js
const SNMP_TIMEOUT_MS = 5000;              // UPPER — immutable config
const STATUS_LABEL = { online: "Online" }; // UPPER — frozen lookup
const connFor = (d) => ({ … });            // camel — a function
const prevIface = new Map();               // camel — mutable container
```

**Underscore privates are consistent.** `_io` (20×) marks module-private mutable state.
The other underscore names — `_field`, `_value`, `_time`, `_measurement` — are **InfluxDB
result columns**, not our convention, and correctly left alone.

**Functions are verb-based**, modules are noun-based: `raiseAlert`, `checkThresholds`,
`resolveRange`, `describeError`, `confirmRecovery` vs `alertsService`, `backupService`,
`historyRange`. The pure modules are named for what they decide — `linkAlertPolicy`,
`envPersistPolicy`, `alertRuleValidation` — which reads well at the call site.

### N-05 — `u` for `user` (importance 2) ⏳ Open

Five occurrences, e.g. `notificationService.js:159`:

```js
const u = byUser.get(r.user_id);
if (!u || !u.email || !Number(u.email_enabled)) return;
```

Three lines of scope, so it is readable — but `user` costs three characters and the brief
names this pattern specifically. Change it when next editing those lines; not worth a
dedicated pass.

**Not findings, despite matching the pattern:** `W`/`H` (canvas width/height), `ts`
(timestamp), `tl` (anime.js timeline), `dt` (delta-time), `ev` (event). Each is a
single-purpose local in an idiom where the short form is the convention.

---

## 2. Naming consistency

### Spelling ✅ consistent — and the split is deliberate

| Word | In identifiers | In comments |
|---|---|---|
| colour/color | **0 / 704** | British used freely |
| normalise/normalize | **0 / 28** | — |
| centre/center | **0 / 2** | British used freely |

**Every British spelling in the codebase is inside prose.** Identifiers are 100% American,
which is not optional — CSS, Chart.js and the DOM all spell it `color`, so an identifier
named `colour` would sit next to the property `color` and read as a typo.

This is the right convention and it is already followed. §5 writes it down.

### Domain terminology ✅ consistent

The domain vocabulary is used precisely and identically across layers: `band` (normal/
warning/critical), `zone` (the aircon IR temperature bands), `reachable` vs `linkUp` vs
`adminUp`, `pingOnly`, `everUp`. Notably `band` and `zone` are kept **distinct** —
`utils/tempZone.ts` and `utils/envThresholds.ts` deliberately name different concepts, and
`CLAUDE.md` explains why. That is domain modelling, not accident.

**Abbreviations** are consistent: `Pct` (never `Percent`/`Perc`), `Ms` for milliseconds,
`Sec` for seconds, `Min` ambiguous only where context settles it (`runtimeRemainingMin` =
minutes, `NOTIFY_COOLDOWN_MIN` = minutes). No mixed forms found.

---

## 3. Code readability

### N-02 — A lookup table written as a ternary ladder ✅ Fixed (importance 3)

`api/api.ts` mapped HTTP status → message with a six-deep ternary chain. It was *readable*
(indented as a ladder), but a chain of equality tests against one variable **is** a map:

```diff
-  const fallback =
-    status === 429 ? "Too many requests. Please wait." :
-      status === 401 ? "Unauthorized. Please log in again." :
-        /* …four more rungs… */
-                "Cannot connect to server.";
+const STATUS_FALLBACK: Record<number, string> = {
+  401: "Unauthorized. Please log in again.",
+  403: "You don't have permission to do that.",
+  404: "Resource not found.",
+  429: "Too many requests. Please wait.",
+  500: "Server error. Please try again later.",
+  503: "Service temporarily unavailable. Please try again shortly.",
+};
+  const fallback = STATUS_FALLBACK[status ?? 0] ?? "Cannot connect to server.";
```

Adding a status is now a data line, not another rung. **Verified equivalent across 14
status values** including `undefined` and `null`.

### Ternaries elsewhere ✅ not abuse

116 nested ternaries, but nearly all are two-level **priority chains** that read as
prose:

```js
status: maintenance ? "Maintenance" : offline ? "Offline" : label(r.status)
```

That is clearer than the four-line `if/else` it replaces. **No action.**

### Magic numbers ✅ largely not magic

The most repeated bare numbers are `100` (99×), `400` (76×), `1000`, `404`, `300`, `3600`.
These are HTTP status codes, percentage ceilings, and seconds-per-hour/day/week:

```js
return w * 604800 + d * 86400 + h * 3600 + mi * 60 + sec;   // self-documenting
```

Genuine tunables are already named — `SNMP_TIMEOUT_MS`, `MAX_BUFFER_LINES`,
`ALERT_RECOVERY_SAMPLES`, `MULTI_DAY_SEC`, `STUCK_AFTER_MS`. **No action.**

### Comments ✅ a strength, not a smell

17.5% comment lines (7,913 of 45,200). The brief treats heavy commenting as a code smell —
here it is not, because the comments explain **why**, usually by naming a past failure:

> *"⚠️ It must NOT infer the direction from the bounds: an earlier version read
> `crit < warn` as lower-is-worse and flipped both comparisons, which broke precisely when
> someone TESTED a rule…"*

That is knowledge which cannot be expressed in code. The one thing to watch: a few comments
name files that no longer exist — I fixed two this session (`upsMetricsHandler` →
`upsSampleWriter`). A comment pointing at a renamed file is the failure mode of this style.

---

## 4. Function signatures

### N-01 — Seven positional arguments, four of them interchangeable ✅ Fixed (importance 5)

`pages/Environment.tsx:219` was called as:

```ts
makeCombinedOptions(isDark, isMobile, minTempY, maxTempY, minHumY, maxHumY, combinedColors)
```

**Four adjacent `number` arguments and two adjacent `boolean`s.** Transposing `maxTempY`
and `minHumY` compiles cleanly, passes every type check, and renders the chart with wrong
axis bounds — no error, no exception, just quietly incorrect. Booleans have the same
problem: `makeCombinedOptions(isMobile, isDark, …)` is undetectable at the call site.

✅ **Applied** — both chart builders take one options object:

```ts
makeCombinedOptions({
  isDark, isMobile,
  minTemp: minTempY, maxTemp: maxTempY,
  minHum: minHumY, maxHum: maxHumY,
  colors: combinedColors,
})
```

A transposition is now impossible: the field names carry the meaning. Same treatment for
`makeSmokeOptions` (5 params). `tsc` clean, production build succeeds.

### N-04 — The remaining 14 ⏳ mostly fine (importance 4)

| Function | Params | Verdict |
|---|---|---|
| `clampInt(v, min, max, dflt)` ×4 files | 4 | ✅ **Leave.** Universally understood shape; the order is unambiguous |
| `analyticsMath.js:437 diskAdvice`, `:29/:35 clampNum` | 4 | ✅ Leave |
| `envThresholds.ts:123 colorFor`, `:157 alertTint` | 4–5 | ⚠️ `(v, warn, crit, identity, fallback)` — the last two are both `string`. Worth an object if touched |
| `mikrotikClient.js:161 shape` | **6** | ⚠️ The worst remaining. Same fix as N-01 |
| `analyticsService.js:482 trendAdvice` | 5 | ⚠️ Worth an object |
| `format.ts:118 rateMBs(curr, prev, currT, prevT)` | 4 | ✅ Leave — pairs are ordered and named |

**Boolean parameters:** after N-01, no function in the codebase takes two adjacent
booleans. Single boolean flags remain (`remove(id, { silent })`, `setMaintenance(id,
enabled)`) but are passed as **named options**, which is the accepted form.

**Return-type clarity:** the pure modules carry JSDoc `@returns` with the shape
(`analyticsMath.js:381`, `historyRange.js`), and the TypeScript side is explicit. No
finding.

---

## 5. Naming convention guide

Derived from what this codebase already does well. This is a description of existing
practice, not a new standard to retrofit.

### Casing

| Thing | Convention | Example |
|---|---|---|
| Variables, functions, properties | `camelCase` | `latencyMs`, `raiseAlert` |
| Module-level **immutable config** | `UPPER_SNAKE` | `SNMP_TIMEOUT_MS`, `MAX_BUFFER_LINES` |
| Module-level **frozen lookups** | `UPPER_SNAKE` | `STATUS_LABEL`, `REPORT_TYPE_META` |
| Module-level **functions / mutable containers** | `camelCase` | `connFor`, `prevIface` |
| React components, classes, types | `PascalCase` | `ErrorBoundary`, `HttpError`, `AppNotification` |
| Module-private mutable state | `_camelCase` | `_io`, `_cache` |
| **Database columns / Influx fields** | `snake_case` — **never converted in place** | `device_id`, `mq2_1_ppm` |

> **The snake_case boundary:** a DB row keeps its `snake_case` keys until it passes through
> a `toClient(row)` mapper, which is the *only* place the two vocabularies meet. Do not
> rename columns in a query and do not hand a raw row to the frontend.

### Words

- **American spelling in identifiers, always.** `color`, not `colour` — the DOM and
  Chart.js decide this, not preference. British spelling in comments is fine and already
  used throughout.
- **Functions are verbs**: `resolve*`, `check*`, `raise*`, `describe*`, `confirm*`.
  Predicates read as questions: `isHealthy`, `isClientError`, `looksLikeKey`.
- **Modules are nouns**, named for the decision they own: `linkAlertPolicy`,
  `envPersistPolicy`, `alertRuleValidation`.
- **Fixed abbreviations**: `Pct`, `Ms`, `Sec`, `Min`, `Ppm`, `Id`. Never `Percent`,
  `Perc`, `Millis`.
- **A helper's name states its contract.** Not `num` — `numOrNull`, `numOrNaN`,
  `numOrFallback`, `positiveEnvNum`. If two files need different behaviour, they need
  different names (N-03).

### Signatures

```js
// ✓ 3 or fewer positional params, in an order nobody can transpose
function clampInt(value, min, max, fallback) { … }

// ✓ 4+ values, or ANY two adjacent same-typed args -> one named object
function makeCombinedOptions({ isDark, isMobile, minTemp, maxTemp, colors }) { … }

// ✓ a boolean is always named at the call site
await reportService.remove(id, { silent: true });

// ✗ two adjacent booleans, or a run of same-typed numbers
function makeChart(isDark, isMobile, minA, maxA, minB, maxB) { … }
```

**Rule of thumb:** if two arguments could be swapped without a type error, they belong in
an object.

### Readability

- **A chain of equality tests against one variable is a map.** Write it as a
  `Record`/object (N-02).
- **Two-level ternaries are fine** when they read as a priority chain. Three levels of
  *different* conditions is an `if`.
- **Comment the WHY**, especially the failure that made the code look this way. Comment
  density is not the metric; a comment restating the code is.
- ⚠️ **A comment naming another file is a maintenance liability.** When you move or rename
  a module, grep for its old name.

---

## 6. Unable to verify

- **Whether `envThresholds.colorFor`/`alertTint` transpositions have ever shipped.** Their
  last two params are both `string` (`identity`, `fallback`) and swappable without a type
  error. **What would prove it:** check each call site passes them in the declared order —
  or convert to an object and let the compiler answer.
- **The Go agent's naming.** Not reviewed; Go has its own conventions (short receivers,
  `MixedCaps`) and applying JS rules would be wrong. **What would prove it:**
  `gofmt -l ./agent` plus a read of `agent/internal/`.
- **Whether any of the 53 renamed `num` call sites changed meaning.** Each was a
  whole-word, module-scoped rename with a negative lookbehind for property access, then
  syntax-checked and test-covered — but not individually eyeballed. **What would prove
  it:** `git diff -U0 -- backend/services | grep -E "numOr|positiveEnv|roundOrNull"`.

---

## 7. Applied this session

| ID | Change | Verification |
|----|--------|--------------|
| N-01 | `makeCombinedOptions` (7 params) and `makeSmokeOptions` (5) → one options object | `tsc` 0 errors; production build |
| N-02 | `api.ts` status ladder → `STATUS_FALLBACK` lookup | Proven identical across 14 status values |
| N-03 | `num` ×5 → `positiveEnvNum` / `numOrNaN` / `numOrFallback` / `numOrNull` / `roundOrNull` (53 call sites) | Syntax; 247 tests; clean boot |
| — | Two stale comments naming the pre-move `*MetricsHandler` files | Zero stale references remain |

---

## 8. Recommended order

1. **`mikrotikClient.js:161 shape(6 params)`** — the worst remaining signature; same fix
   as N-01.
2. **`envThresholds.colorFor` / `alertTint`** — two adjacent `string` params that can be
   swapped silently.
3. **`analyticsService.js:482 trendAdvice(5)`** — options object when next touched.
4. **N-05 `u` → `user`** — five lines, do it in passing.

Leave `clampInt(v, min, max, dflt)` alone in all four files. It is a universally understood
shape, and "fixing" it would make the code less readable, not more.

---

*Reviewed 2026-08-25. Method: comment/string-blanked source, declaration and signature
extraction with depth-aware top-level parameter counting, identifier-position spelling
census, nested-ternary detection, and comment-density measurement across 171 modules. The
parameter counter was corrected twice — for destructured objects and for trailing commas —
before its figures matched the source.*
