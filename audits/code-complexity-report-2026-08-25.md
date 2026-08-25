# Code Complexity Audit — CSPC-ICTU Monitoring System

**Date:** 2026-08-25
**Scope:** `backend/`, `frontend/src/`, `agent/` — tests, `node_modules/`, `dist/` excluded
**Companion:** [`code-duplication-report-2026-08-25.md`](./code-duplication-report-2026-08-25.md) —
several findings here have a duplication twin, cross-referenced as **R-nn**.

---

## 0. Method, and one caveat that changes the whole ranking

Metrics computed by static analysis over **1,341 extracted functions in 171 files**. Before
counting, every file has its comments, string literals and template literals blanked out (each
character replaced by a space so line numbers survive). Without that step the backend's Flux
query builders top every chart on the word `or` inside their query strings.

- **Cyclomatic** — 1 + each `if` / `for` / `while` / `case` / `catch` / `&&` / `||` / `??` / ternary.
- **Cognitive** — SonarSource-style: each flow break costs `1 + current nesting depth`, so nesting
  is punished and flat code is not.
- **Control-nesting depth** — only braces opened by a control keyword, so object literals and JSX
  do not inflate it.
- **Coupling** — import graph: `Ce` (imports out), `Ca` (imported by), instability `I = Ce/(Ce+Ca)`.

### ⚠️ The caveat: raw cyclomatic complexity ranks the wrong functions in this codebase

The single most "complex" backend function by the textbook formula is
`backend/handlers/networkMetricsHandler.js:18 writeNetworkSample()` at **cyclomatic 55**.

It is not complex. Its decision points break down as:

| Construct | Count |
|---|---|
| `??` (nullish default, e.g. `sample.cpuPercent ?? null`) | **33** |
| `if` | 6 |
| `for` | 1 |
| ternary | 1 |
| `catch` | 1 |

`x ?? null` is a *default*, not a branch — nothing forks, and no reader has to track a second
path. Strip those and the function scores **14**: a flat field-mapping function, exactly what it
looks like. Refactoring on the raw number would rewrite the wrong function and make it worse.

The same distortion hits the frontend harder, where `cond && <Thing/>` and `a ? <X/> : <Y/>` are
*render guards*, not logic. `Analytics.tsx` scores 172 raw, and it is a rendering problem
(length), not a branching problem.

**Every ranking below uses `cycB` — cyclomatic minus `??`.** Raw is shown alongside so the gap is
visible.

### Project totals

| Metric | Value |
|---|---|
| Functions analysed | 1,341 |
| Raw cyclomatic > 10 | 165 (12.3%) |
| **Branching cyclomatic > 10** | **125 (9.3%)** |
| **Branching cyclomatic > 20** | **47 (3.5%)** |
| Functions > 50 significant lines | 127 (9.5%) |
| **Control-nesting depth ≥ 4** | **2** ✅ |
| Files > 300 significant lines | 33 of 171 |
| **Import cycles — backend** | **0** ✅ |
| Import cycles — frontend | 2, both **type-only** (erased at runtime) — see C-14 |
| Genuine recursion | 1 (+ one `requestAnimationFrame` loop) |

**Two of these are genuinely good results and should be said plainly.** Only **two functions in
the entire codebase** nest control flow four deep, and the backend's 83 modules contain **zero
import cycles**. The frontend has two cycles, but both are type-only and disappear at runtime
(C-14). The common shapes of unmaintainable code — deeply nested conditionals and tangled module
graphs — are essentially absent here. The problems that do exist are *size* and *repetition*,
which are far easier to fix.

---

## 1. Summary table

Importance is **1–10**: likelihood of causing a defect or blocking a change, not untidiness.

| ID | Category | Finding | Location | Metric | Imp | Effort |
|----|----------|---------|----------|--------|-----|--------|
| **C-01** | Cyclomatic | `clean()` — 7× repeated validate/default shape | `alertRulesService.js:158` | cycB **34**, cog **62**, 55 loc | **8** | M |
| **C-02** | LOC | Page components 456–838 lines | `Dashboard.tsx:485`, `Analytics.tsx:464`, `AlertRules.tsx:248` | 838 / 775 / 724 loc | **7** | L |
| **C-03** | Coupling | `agentService.js` in the painful zone | `backend/services/agentService.js` | Ca=11, Ce=7, I=0.39 | **7** | M |
| **C-04** | Cognitive | `forecastAccuracy()` — 3-branch dispatcher, depth 4 | `analyticsService.js:677` | cog **54**, depth **4** | **6** | S–M |
| **C-05** | Cohesion | `reportService.js` holds 7 responsibilities | `backend/services/reportService.js` | 821 sig / 1,047 raw lines | **6** | M |
| **C-06** | Cognitive | `maybeRaiseEnvAlert()` — depth 4, two concerns in one loop | `sensorHandler.js:39` | cog **32**, depth **4** | **5** | S |
| **C-07** | Cyclomatic | `register()` — enroll + re-arm + reject in one | `agentService.js:130` | cycB **23**, 69 loc | **5** | M |
| **C-08** | LOC | `buildNetwork()` / `buildUps()` | `reportService.js:232` / `:429` | 158 / 116 loc | **5** | M |
| **C-09** | Cyclomatic | `recommendThresholds()`, `authenticate()` | `analyticsService.js:597`, `googleAuthService.js:60` | cycB 22 each | **5** | M |
| **C-10** | Cyclomatic | `serverMetricsHandler()` | `serverMetricsHandler.js:75` | cycB 18, cog 32, 100 loc | **4** | S–M |
| **C-11** | LOC | `api.ts` — 950 significant lines | `frontend/src/api/api.ts` | see R-11 | **4** | M |
| **C-12** | Cognitive | `resolveColor()` recursion has no depth guard | `utils/canvasColor.ts:29` | recursive, unbounded | **3** | S |
| **C-13** | Method | Raw cyclomatic mis-ranks `writeNetworkSample()` | `networkMetricsHandler.js:18` | raw 55 → cycB 14 | **2** | — |
| **C-14** | Coupling | Two frontend import cycles, both type-only today | `ServerMetrics.tsx:4` ↔ `ServerDetail.tsx:10`; `NotificationContext.tsx:13` ↔ `notificationUtils.ts:1` | 2 cycles | **3** | S |

---

## 2. Cyclomatic complexity

### C-01 — `clean()` is the genuinely most complex function in the backend (importance 8)

`backend/services/alertRulesService.js:158` — **cycB 34, cognitive 62, in 55 lines.** The worst
complexity *density* anywhere in the project, and unlike the frontend entries it is all real
branching: **18 `if` statements**, 4 `||`, 2 `&&`.

The cause is one shape written out seven times, once per field:

```js
if (data.deviceId !== undefined) {
  out.device_id = data.deviceId === null || data.deviceId === "" ? null : Number(data.deviceId);
  if (out.device_id !== null && !Number.isInteger(out.device_id))
    throw err(400, "deviceId must be an integer or null (null = global default).");
} else if (!partial) {
  out.device_id = null;
}

if (data.metricName !== undefined) {
  const m = String(data.metricName ?? "").trim().toLowerCase();
  if (!m || m.length > 50) throw err(400, "metricName is required (max 50 chars).");
  out.metric_name = m;
} else if (!partial) {
  throw err(400, "metricName is required.");
}
// …five more of the same shape…
```

Every field repeats: *present? → validate → assign. absent and not a patch? → default or throw.*

This matters because `clean()` is **the only validation gate on alert thresholds**, and alerting
is rules-only — a rule that slips through wrong is either a silent alarm or a false one.

**Fix — a field spec table plus one loop.** Drops cycB from 34 to about 8, and makes adding a
field a one-line data change instead of a new branch:

```js
// One row per field: where it lands, how to validate it, what happens when it is absent.
// The shape below was written out seven times; the differences between the copies were
// only ever these four values.
const FIELDS = [
  { in: "deviceId", out: "device_id", parse: nullableInt,
    dflt: null,
    msg: "deviceId must be an integer or null (null = global default)." },
  { in: "interfaceName", out: "interface_name", parse: (v) => nullableStr(v, 50),
    dflt: null,
    msg: "interfaceName must be 50 characters or fewer." },
  { in: "metricName", out: "metric_name", parse: (v) => requiredSlug(v, 50),
    required: true,
    msg: "metricName is required (max 50 chars)." },
  { in: "thresholdValue", out: "threshold_value", parse: finiteNum,
    required: true,
    msg: "thresholdValue must be a number." },
  { in: "comparison", out: "comparison", parse: oneOf(COMPARISONS),
    required: true,
    msg: `comparison must be one of: ${COMPARISONS.join(" ")}` },
  { in: "severity", out: "severity", parse: oneOf(SEVERITIES),
    required: true,
    msg: `severity must be one of: ${SEVERITIES.join(", ")}` },
  { in: "isActive", out: "is_active", parse: (v) => (v ? 1 : 0), dflt: 1 },
];

function clean(data, { partial = false, existing = null } = {}) {
  const out = {};
  for (const f of FIELDS) {
    if (data[f.in] !== undefined) {
      const parsed = f.parse(data[f.in]);
      if (parsed === INVALID) throw err(400, f.msg);
      out[f.out] = parsed;
    } else if (!partial) {
      if (f.required) throw err(400, f.msg);
      out[f.out] = f.dflt;
    }
  }
  return applyCrossFieldRules(out, { partial, existing });  // keep this part as-is
}
```

⚠️ **Keep the cross-field validation as its own function.** The `existing` parameter exists so a
PATCH can validate the *merged* result — that logic is genuinely conditional and does not belong
in the table. Splitting it out is most of the readability win on its own.

**Verify:** this function has no direct unit test today. Add one before refactoring — it is pure
(`data` in, object or throw out), so it is cheap to cover:

```js
// backend/tests/alertRulesClean.test.js
test("create requires metricName", () => {
  assert.throws(() => clean({ thresholdValue: 1, comparison: ">=", severity: "warning" }),
    /metricName is required/);
});
test("patch tolerates every field being absent", () => {
  assert.deepEqual(clean({}, { partial: true }), {});
});
```

---

### C-07 — `register()` does three different jobs (importance 5)

`backend/services/agentService.js:130` — cycB **23** in 69 lines, depth 2. Per `CLAUDE.md` this
one function handles **first enrollment**, **re-arming a `revoked` enrolment onto the same
`device_id`**, and **rejection** — three outcomes with different postconditions, selected by
branches inside one body.

**Fix** — keep `register()` as the decision, move each outcome out:

```js
async function register(payload) {
  const existing = await findEnrolment(payload);
  if (!existing)            return enrolNew(payload);
  if (existing.status === "revoked") return reArm(existing, payload);   // same device_id — keeps history
  return refreshEnrolment(existing, payload);
}
```

The re-arm path is the one worth isolating: it must land on the **same** `device_id` or the
server's InfluxDB history forks silently. That guarantee is currently a branch in the middle of a
69-line function; as `reArm()` it is a named thing that can be tested.

**Effort:** M — this is auth-adjacent. **Verify:** enrol, revoke, re-enrol; assert `device_id` is
unchanged and history is continuous.

---

### C-09 — `recommendThresholds()` and `authenticate()` (importance 5)

Both at cycB 22. `googleAuthService.js:60 authenticate()` is 81 lines covering code exchange →
ID-token verify → domain gate → login-or-create-pending, plus the denial paths that must each be
audited. It is **security-critical and untested**; that combination is why it is listed despite
being readable.

**Fix:** extract the four stages (`exchangeCode`, `verifyAndGate`, `resolveAccount`,
`recordDenial`) so each denial reason can be asserted independently. The `switch (existing.status)`
at `:163` is already the clearest part — leave it.

---

## 3. Cognitive complexity & nesting

Only **two functions in the codebase reach control-nesting depth 4.** Both are worth fixing
precisely *because* they are the outliers.

### C-04 — `forecastAccuracy()`: a dispatcher with one branch 35 lines long (importance 6)

`backend/services/analyticsService.js:677` — cognitive **54**, depth **4**, 76 lines.

The structure is `if (metric === "disk") { …35 lines… } else if (meta.source === "env") { …3
lines… } else { …10 lines… }`. The `disk` branch nests a `for` inside an `if` inside the branch,
with a `map` + conditional inside that. The other two branches are trivial by comparison — the
asymmetry is what makes it hard to read: you must hold 35 lines of disk-specific logic in your
head to find the two lines that handle everything else.

**Fix — one dispatcher, three named strategies:**

```js
const ACCURACY_STRATEGIES = {
  disk: backtestDisk,     // per-volume, headlines the worst — mirrors forecastDiskFull
  env:  backtestRoom,     // one series, no device
};

async function forecastAccuracy({ metric = "disk", deviceId = null, lookbackDays = 30, horizonDays = 7, folds = 5 } = {}) {
  const meta = METRICS[metric];
  if (!meta) return null;
  const opts = { days: clampInt(lookbackDays, 2, 365, 30),
                 horizonMs: clampNum(horizonDays, 0.25, 90, 7) * 86_400_000,
                 folds: clampInt(folds, 1, 20, 5), deviceId };

  const strategy = ACCURACY_STRATEGIES[metric]
    ?? (meta.source === "env" ? backtestRoom : backtestPerDevice);
  const results = await strategy(meta, opts);
  return shapeAccuracy(results);   // the sort + envelope, unchanged
}
```

⚠️ **Preserve the comment on the `disk` branch verbatim** when you move it. It explains that the
graded series must be the *same* series `forecastDiskFull` headlines, or the page scores one
volume while projecting another. That is the kind of reasoning a refactor loses by accident.

**Verify:** `npm run analytics:check` — the dry-run script exists precisely so this path can be
exercised without waiting 6 hours for the job.

---

### C-06 — `maybeRaiseEnvAlert()` mixes hysteresis with alert construction (importance 5)

`backend/handlers/sensorHandler.js:39` — cognitive **32**, depth **4** in 38 lines.

One `for` over `ENV_METRICS` contains: rule lookup, band computation, **recovery-confirmation
state machine**, escalation gate, then alert-title construction. The depth-4 point is the
`if (alertBandState.confirmRecovery(...))` nested inside `if (band === "normal" && prev !==
"normal")` inside the loop inside the `try`.

The recovery logic is the subtle part — and per its own comment it is the *fail-safe* part
(gas readings are noisy, so an all-clear needs confirmation while escalation stays instant).
It deserves to be a named, testable function rather than a nested branch.

**Fix — extract the band decision; the loop keeps only "should I alert, and what do I say":**

```js
/** Resolve the band to ACT on, applying recovery confirmation.
 *  Escalation is instant; only the all-clear is delayed — see ALERT_RECOVERY_SAMPLES. */
async function settleBand(key, value) {
  const rules = await alertRulesService.getEffectiveRules(null, key);
  const prev = alertBandState.getBand(null, key);
  const { band, rule } = alertRulesService.nextBand(rules, value, prev);

  let effective = band;
  if (band === "normal" && prev !== "normal") {
    if (alertBandState.confirmRecovery(null, key)) await alertsService.autoResolveMetric(null, key);
    else effective = prev;                      // not convinced yet — hold it open
  } else if (band !== "normal") {
    alertBandState.breakRecovery(null, key);
  }
  alertBandState.setBand(null, key, effective);
  return { band, effective, prev, rule };
}
```

The loop body then drops to roughly eight lines and depth 2.

**Verify:** feed a series that oscillates across a threshold and assert exactly one alert and one
resolve — `ALERT_RECOVERY_SAMPLES` behaviour is the regression risk.

---

### C-12 — `resolveColor()` recurses with no depth guard (importance 3)

`frontend/src/utils/canvasColor.ts:29`. The one genuinely recursive function in the codebase:

```ts
// A var() may itself name another var(); one hop is all this codebase uses.
if (value.startsWith("var(")) return resolveColor(value);
```

The comment states the assumption but nothing enforces it. A CSS custom property that resolves to
itself — `--a: var(--a)` — or any two-token cycle produces **unbounded recursion inside a canvas
draw**, i.e. a hung tab rather than a wrong colour.

**Fix — two tokens:**

```diff
-export function resolveColor(color: string): string {
+export function resolveColor(color: string, hops = 0): string {
@@
-  if (value.startsWith("var(")) return resolveColor(value);
+  // Bounded: the comment above says one hop, so allow a couple and then stop. A CSS
+  // cycle (--a: var(--a)) would otherwise hang the tab inside a canvas draw.
+  if (value.startsWith("var(") && hops < 4) return resolveColor(value, hops + 1);
```

Low importance because it needs a malformed stylesheet to trigger — but the fix is two tokens and
the failure mode is a hang, not a glyph.

**The other 29 "recursive" hits are extraction artifacts** — React state setters (`setLoading`,
`setError`, `setResult`) whose names appear inside the arrow functions the extractor attributed to
them. `HeroDashboard.tsx:224 tick()` is a genuine `requestAnimationFrame` loop, which is idiomatic
and correct.

### Switch statements

**12 `switch` statements in project code, and none is a complexity problem.** The largest,
`snmpUtils.js:75` (the RFC 1628 output-source enum) and `alertRulesService.js:105` (comparison
operators), are flat exhaustive mappings — the shape `switch` is *for*. No action.

---

## 4. Lines-of-code metrics

### C-02 — Five page components between 456 and 838 lines (importance 7)

| Function | Location | Body loc | cycB / raw |
|---|---|---|---|
| `Dashboard()` | `pages/Dashboard.tsx:485` | **838** | 116 / 143 |
| `Analytics()` | `pages/Analytics.tsx:464` | **775** | 146 / 172 |
| `AlertRules()` | `pages/AlertRules.tsx:248` | **724** | 118 / 133 |
| `Reports()` | `pages/Reports.tsx:144` | **548** | 63 / 74 |
| `InstallKeysPanel()` | `components/servers/InstallKeysPanel.tsx:244` | **456** | 44 / 49 |

And by file: `Analytics.tsx` is **1,868 significant lines** (2,266 raw) — the largest file in the
project by a wide margin.

⚠️ **Do not "fix" these by splitting the JSX into smaller components in the same file.** That
moves lines without reducing what a reader must hold. The lever is *state*, not markup: these
components are large because each owns a dozen `useState` hooks plus the effects that feed them.

**Fix — extract data ownership into hooks, one concern each:**

```tsx
// pages/Analytics.tsx — before: ~12 useState + 6 useEffect inline in the component
function Analytics() {
  const disk     = useForecast("disk");        // loading / error / data / refetch
  const ups      = useForecast("ups-battery");
  const link     = useForecast("link-saturation");
  const anomalies = useAnomalies(range);
  // …component now renders, and does not also fetch, poll and reconcile
}
```

Each `useForecast` is testable on its own and reusable by the PiP widgets in `src/pip/`, which
currently re-fetch the same endpoints (`LiveSummaryContext.tsx:181 useEffect()` — cycB 49 in 187
lines — is that duplication in hook form).

**Effort:** L. This is the largest single item in the report; do it one page at a time, starting
with `Analytics.tsx`, and only when that page is otherwise stable.

### C-08 — `buildNetwork()` 158 lines, `buildUps()` 116 lines (importance 5)

`reportService.js:232` and `:429`. Each fetches from two or three Influx measurements, joins to
MySQL identities, and shapes two output tables. `buildUps()` scores raw 36 but **cycB 17** — 11 of
its 36 are `??` defaults and 13 are ternaries formatting cells.

**Fix:** each `build*` splits cleanly into `fetch → aggregate → shape`:

```js
async function buildUps(start, stop, deviceId) {
  const rows = await fetchUpsRows(start, stop, deviceId);   // Influx + MySQL
  const per  = aggregateUpsByDevice(rows);                  // pure — testable with no DB
  return { summary: upsSummary(per), tables: upsTables(per) };
}
```

The middle step being **pure** is the win: report aggregation currently cannot be tested without a
live InfluxDB, which is why none of the seven builders has a test.

### File-size distribution

33 of 171 files exceed 300 significant lines. That is not alarming on its own — `analyticsMath.js`
(435) and `snmpPollerService.js` (618) are cohesive. The ones worth splitting are named under
C-05 and C-02. **No classes exceed 500 lines because the codebase has essentially no classes** —
it is modules-and-functions throughout, which is why the "class size" check finds nothing.

---

## 5. Coupling

### The healthy parts, stated first

**Zero import cycles across the 83 backend modules.** This is the single best structural result in
the audit and it is not an accident of size — a service layer this large usually has at least one
service ↔ service cycle. The frontend's 88 modules have two, both benign — see C-14.

**Five stable abstractions** in the ideal shape (`Ca ≥ 3, Ce = 0` — widely used, depends on
nothing):

| Module | Ca |
|---|---|
| `backend/config/env.js` | 10 |
| `backend/utils/asyncHandler.js` | 8 |
| `backend/services/alertBandState.js` | 7 |
| `backend/services/snmpUtils.js` | 6 |
| `backend/services/historyRange.js` | 3 |

This is exactly the pattern `CLAUDE.md` describes as deliberate — the pure, import-free modules
that `backend/tests/` can run without MySQL or InfluxDB. **It is working.** The instruction to
keep new pure logic import-free should be treated as load-bearing, not stylistic.

`backend/src/server.js` shows `Ce=32, I=1.00`, which looks alarming and is fine: it is the
composition root. Maximum instability is correct for the file whose job is wiring.

### C-03 — `agentService.js` is the one module in the painful zone (importance 7)

| Module | Ca | Ce | I |
|---|---|---|---|
| **`services/agentService.js`** | **11** | **7** | **0.39** |
| `services/snmpPollerService.js` | 3 | 10 | 0.77 |
| `services/mikrotikPollerService.js` | 3 | 10 | 0.77 |
| `services/alertsService.js` | 10 | 3 | 0.23 |
| `services/notificationService.js` | 10 | 3 | 0.23 |

`agentService` is both **heavily depended on** (11 modules) and **heavily dependent** (7 modules,
including `notificationService`, `alertRulesService`, `alertsService`, `alertBandState`). That
combination is the hard one: it cannot be changed safely because 11 modules rely on it, and it
cannot be tested in isolation because it pulls in 7.

The cause is visible in its exports: it owns **agent enrollment**, **server CRUD**, **the offline
sweep**, **device logs**, **threshold evaluation** (`checkThresholds`, cycB 17) and
**`getDeviceLogs`** — which is why three unrelated route files import it just for that last one
(see duplication R-13).

**Fix — split along the seam that already exists.** Threshold evaluation is why `agentService`
imports the four alerting modules; nothing else in the file needs them:

```
services/agentService.js       → enrollment, CRUD, sweep, host info   (Ce drops 7 → 3)
services/serverThresholds.js   → checkThresholds + its alerting imports (new, Ca=2)
services/deviceLogs.js         → getDeviceLogs + appendDeviceLog       (new, Ca=4)
```

`deviceLogs.js` is the cheapest and highest-value piece: `routes/network.js:70`,
`routes/ups.js:49` and `routes/mikrotik.js:98` currently import the whole of `agentService`
to call one function.

**Effort:** M. **Verify:** `npm test` plus the module-load check —
`node -e "import('./services/agentService.js')"` — after each move.

### C-14 — Two frontend import cycles, both type-only (importance 3)

| Cycle | Direction A | Direction B |
|---|---|---|
| `ServerMetrics` ↔ `ServerDetail` | `ServerMetrics.tsx:4` → `import ServerDetail from "./ServerDetail"` (**value**, rendered at `:753`) | `ServerDetail.tsx:10` → `import type { Volume } from "./ServerMetrics"` (**type-only**) |
| `NotificationContext` ↔ `notificationUtils` | `NotificationContext.tsx:13` → `import { routeFor }` (**value**) | `notificationUtils.ts:1` → `import type { AppNotification, Severity }` (**type-only**) |

**Neither is a runtime cycle.** TypeScript erases `import type` entirely, so the emitted JS has a
one-way edge in both cases. Nothing is broken today.

They are listed because the safety is *incidental*. Change either `import type` to a value import
— importing a const, an enum, or a helper that happens to live in the same file — and it becomes
a real circular dependency, whose symptom is an `undefined` import at module-init time in a
production build only. That is a genuinely nasty class of bug to diagnose.

**Fix — move the shared type to a module neither side owns:**

```ts
// frontend/src/types/server.ts
export interface Volume { /* …as currently declared in ServerMetrics.tsx:10… */ }
```

```diff
-import type { Volume } from "./ServerMetrics";
+import type { Volume } from "../types/server";
```

Same shape for `AppNotification` / `Severity`. `ServerMetrics` rendering `ServerDetail` is then a
plain one-way dependency, which is what it actually is.

**Effort:** S. **Verify:** `npx tsc --noEmit` and re-run the cycle check.

### Frontend

One module in the painful zone: `context/AuthContext.tsx` (Ca=20, Ce=3, I=0.13). **Leave it.**
Low instability with high afferent coupling is the correct shape for an auth context — 20 modules
depending on it is what a context is for, and it depends on almost nothing itself.

`api/api.ts` (Ca=30, Ce=1) and `socket/socket.ts` (Ca=22, Ce=1) are likewise correct: single
shared entry points to the backend, near-zero instability.

---

## 6. Cohesion

### C-05 — `reportService.js` holds seven responsibilities (importance 6)

821 significant lines (1,047 raw). Its top-level functions group into:

| Responsibility | Functions |
|---|---|
| Flux plumbing | `fluxDeviceFilter`, `fluxRows` |
| **Seven report builders** | `buildEnvironment`, `buildServer`, `buildNetwork`, `buildUps`, `buildAlerts`, `buildAircon`, `buildForecast` |
| Persistence | `create`, `getRaw`, `list`, `build`, `generate` |
| File I/O | `fileFor`, `remove` |
| Email | `email` |
| Retention | `purgeOld` |
| Socket lifecycle | `init` |

The builders are ~60% of the file and share nothing with the persistence half except the
`BUILDERS` lookup at `:729` — which is precisely the seam.

**Fix — move the builders out, keep the registry:**

```
services/reportService.js          → lifecycle: create/build/generate/list/file/email/purge
services/reports/builders/index.js → export const BUILDERS = { environment, server, network, … }
services/reports/builders/ups.js   → buildUps + its pure aggregation helpers
…one file per type
```

`reportService.js` then imports one thing (`BUILDERS`) and drops to roughly 400 lines. Each
builder becomes independently testable, and adding a report type stops meaning "edit the
1,000-line file".

⚠️ **Not urgent.** Cohesion here is *poor* but not *tangled* — the builders genuinely don't touch
the persistence code, so the file is long rather than confusing. Do this when ICTU's report
template lands (see the `report-template-ictu` memory), since that work touches these files
anyway.

### Modules with good cohesion, for contrast

`analyticsMath.js` (435 lines, pure math), `snmpUtils.js` (176, pure SNMP vocabulary),
`pingOutput.js`, `linkAlertPolicy.js`, `envPersistPolicy.js`, `installKeyUtils.js`,
`historyRange.js` — each is one idea, import-free, and unit-tested. **These are the model.** The
pattern to copy when splitting anything above: put the *decision* in a pure module with a test,
leave the I/O in the service.

---

## 7. Unable to verify

- **Whether the frontend page components can be decomposed without prop-drilling.** C-02 assumes
  the state extracts cleanly into hooks, but I did not trace which `useState` values are read by
  which JSX subtree. **What would prove it:** for `Analytics.tsx`, list each `useState` and the
  line ranges that read it; if the clusters are disjoint, hooks work — if they interleave, a
  reducer or context is the better shape.
- **Runtime hot paths.** This audit is entirely static. `snmpPollerService.collectRouter()`
  (cycB 19, depth 3) runs every 60s per device and `sensorHandler()` (cycB 14) runs every 3s, but
  nothing here measures whether either is actually slow. **What would prove it:** `--cpu-prof` on
  the backend across one poll cycle.
- **`agent/` (Go).** Included in the file scan; the complexity extractor is JS/TS-only, so no Go
  function was scored. **What would prove it:** `gocyclo -over 10 ./agent/...`.
- **Test coverage as a complexity multiplier.** `backend/tests/` covers the pure modules well
  (212 assertions), but none of the high-complexity functions named here — `clean()`,
  `register()`, `authenticate()`, the seven builders — has a direct test. I did not measure
  coverage. **What would prove it:** `node --test --experimental-test-coverage`.

---

---

## ✅ Remediation status — 2026-08-25 (same day)

| Metric | Before | After |
|---|---|---|
| Functions at control-nesting depth ≥ 4 | 2 | **1** |
| Branching cyclomatic > 10 | 125 | **124** |
| Frontend import cycles | 2 | **0** |
| Backend tests | 212 | **225** |

| ID | Status |
|----|--------|
| C-01 `clean()` cycB 34 / cog 62 | ✅ **Fixed** — extracted to `services/alertRuleValidation.js` (pure, import-free) as a field table. Now **cycB 6 / cog 17**. Proven equivalent by a differential test over **297 input combinations, 0 mismatches**, plus 13 new unit tests in `tests/alertRuleValidation.test.js` |
| C-03 `agentService` coupling | ✅ **Fixed** — device logging split to `services/deviceLogs.js`; five dead `agentService` imports removed. **Ca 11 → 6** |
| C-06 `maybeRaiseEnvAlert` depth 4 | ✅ **Fixed** — `settleBand()` extracted. cycB 15 → 11, cognitive 32 → 16, **depth 4 → 2** |
| C-12 `resolveColor` recursion | ✅ **Fixed** — bounded at 4 hops |
| C-14 Frontend import cycles | ✅ **Fixed** — `types/server.ts` + `types/notification.ts`; **cycles 2 → 0** |
| C-04 `forecastAccuracy` depth 4 | ⏳ Open — the last depth-4 function |
| C-02 Page components 456–838 loc | ⏳ Open — largest item; needs hook extraction, one page at a time |
| C-05 `reportService` cohesion | ⏳ Open — deliberately deferred to the ICTU report-template work |
| C-07 `register()`, C-08, C-09, C-10, C-11 | ⏳ Open |
| C-13 `writeNetworkSample` | ✅ No action, by design — a measurement artifact |

## 8. Recommended order

Ordered by risk removed per unit of effort.

1. **C-01** `clean()` → spec table. Highest real complexity in the backend, it is the only gate on
   alert thresholds, and it is pure enough to test first. Write the test, then refactor.
2. **C-12** `resolveColor()` depth guard. Two tokens, removes a hang.
   **C-14** shared-type extraction alongside it — also small, and it stops two latent cycles.
3. **C-06** `maybeRaiseEnvAlert()` → extract `settleBand()`. Isolates the fail-safe recovery logic.
4. **C-03** `agentService` → extract `deviceLogs.js` first (cheapest, unblocks duplication R-13),
   then `serverThresholds.js`.
5. **C-04** `forecastAccuracy()` → three named strategies. Verify with `npm run analytics:check`.
6. **C-07** `register()` → three outcomes. Auth-adjacent; do it with a re-enrolment test.
7. **C-08 / C-05** `reportService` builders → `fetch/aggregate/shape`, then split the file. Bundle
   this with the ICTU template work.
8. **C-02** page components → hooks. Largest item; one page at a time, `Analytics.tsx` first.
9. **C-09**, **C-10**, **C-11** — as they are next touched, not as a campaign.

**Do not act on C-13.** `writeNetworkSample()` will keep topping any off-the-shelf cyclomatic
report; it is a flat field mapping and should be left alone. If you add a linter rule, configure
it to ignore `??` or it will point at this function forever.

---

*Generated 2026-08-25. Static analysis over 1,341 functions in 171 files: comment/string-blanked
source, brace-matched function extraction, cyclomatic (with and without `??`), SonarSource-style
cognitive complexity, control-only nesting depth, and an import-resolved coupling graph.*
