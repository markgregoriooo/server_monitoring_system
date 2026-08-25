# Code Duplication Re-Audit — CSPC-ICTU Monitoring System

**Date:** 2026-08-25
**Scope:** `backend/`, `frontend/src/`, `agent/` — tests, `node_modules/`, `dist/` excluded
**Supersedes:** [`code-duplication-report.md`](./code-duplication-report.md) (2026-08-10). That report's
findings are re-checked in §7; most are still open and two have **grown**.

---

## 0. Method (so the numbers are reproducible, not vibes)

Three passes, all mechanical:

1. **Token-window clone detection** — every file normalised (comments stripped, whitespace
   collapsed, brace-only lines dropped), hashed in rolling 6- and 7-line windows, windows
   appearing 2+ times reported. This is what produces the "% of file duplicated" column.
2. **Exact-duplicate function bodies** — top-level `function` declarations extracted by
   brace-matching, bodies normalised and hashed. Reports functions that are *character-identical*
   after comment/whitespace removal, even when the **names differ**.
3. **Targeted greps** for constants, SQL statements and config literals.

> ⚠️ Pass 2 initially missed every React component, because searching for the first `{` after
> the function name lands on a **destructured parameter** (`function Panel({ title, children })`)
> and brace-matches that instead of the body. Fixed by walking the parameter list to its
> closing `)` first. Any future run of this check needs the same correction — with the naive
> version, `GhostButton` (4 identical copies) is invisible.

**Headline number:**

| Metric | Value |
|---|---|
| Significant lines (backend + frontend/src, tests excluded) | **32,594** |
| Lines inside a ≥6-line block that appears 2+ times | **2,915** |
| **Project duplication** | **8.9%** |
| Redundant lines from *exact-duplicate functions alone* | **303** |

8.9% is not alarming for a project this size. The concentration is: **four files are between
39% and 51% duplicated**, and that is where the defects live.

| % duplicated | File |
|---|---|
| **51.0%** | `frontend/src/pages/NetworkDetail.tsx` |
| **48.7%** | `frontend/src/pages/NetworkMonitoring.tsx` |
| **48.6%** | `frontend/src/pages/MikrotikDetail.tsx` |
| **39.6%** | `frontend/src/pages/MikrotikMonitoring.tsx` |
| 35.8% | `backend/handlers/sensorHandler.js` |
| 31.1% | `frontend/src/pages/UpsDetail.tsx` |
| 29.4% | `frontend/src/pages/UpsMonitoring.tsx` |
| 14.3% | `backend/services/snmpPollerService.js` |

The MikroTik pages are the newest in the tree and the most duplicated. They were built by
copying the SNMP pages — which is why the copy is so clean, and why nothing has diverged **yet**.

---

## 1. Summary table

Importance is **1–10**: how likely this is to cause a *defect*, not how untidy it looks.

| ID | Kind | What | Where | Dup % | Imp | Effort | Status |
|----|------|------|-------|-------|-----|--------|--------|
| **R-01** | Data | `gf` token object — **14 copies, one already diverged into an a11y bug** | 14 files, see §2 | ~95% | **8** | M | Module created, call sites open |
| **R-02** | Exact | `loadInterfaceLabels()` in both pollers | `snmpPollerService.js`, `mikrotikPollerService.js` | 100% | **7** | S | ✅ **fixed** |
| **R-03** | Near | Session-validity check — now **3 sites**, was 2 (old D-12) | `middleware/auth.js:77`, `src/server.js:206`, `services/socketSessions.js:82` | ~90% | **7** | S | Open |
| **R-04** | Exact | `formatUptime()` ×5, `fmtDateTime()` ×4, `formatSpeed()` ×2, `fmtAxisTime()` ×2 | 6 frontend pages + backend | 100% | **6** | S | Helpers added, call sites open |
| **R-05** | Exact | `networkSegment()` in two backends | `agentService.js`, `snmpUtils.js` | 100% | **6** | S | ✅ **fixed** |
| **R-06** | Data | `MULTI_DAY_SEC` ×4, in **two spellings** of the same number | see §2.4 | 100% | **6** | S | Helper added, call sites open |
| **R-07** | Data | Aircon zone boundaries 22/24/27/29 in **5 places across 3 languages** | see §5.1 | 100% | **6** | M | Open — partly unavoidable |
| **R-08** | Struct | History-handler envelope (id guard + `resolveRange` + response) ×3 | `serverHistoryHandler.js`, `upsHistoryHandler.js`, `networkHistoryHandler.js` | ~70% | **5** | S–M | Open |
| **R-09** | Exact | UI primitives: `GhostButton` ×4, `Stat` ×3, `StatPanel` ×3, `Field` ×3, `Meta` ×3, `PortChip` ×2, `Th` ×2, `Panel` ×11 | 9 pages | 100% (mostly) | **5** | M | Open |
| **R-10** | Data | Status hexes `#73BF69`/`#FF780A`/`#F2495C`/`#5794F2`/`#E02F44` | 77 local `const` decls, 256 literal uses, 39 files | 100% | **5** | M | Module created, call sites open |
| **R-11** | Struct | `api.ts` try/catch wrapper ×93 | `frontend/src/api/api.ts` | 100% | **4** | M | Open |
| **R-12** | Struct | Route `id` parse-and-400 guard ×23 | 6 route files + 3 handlers | 100% | **4** | S | Open |
| **R-13** | Struct | CRUD route bodies (`POST`/`DELETE`/`:id/logs`) | `routes/network.js`, `routes/ups.js`, `routes/mikrotik.js` | ~85% | **4** | M | Open |
| **R-14** | Near | Env sample field-list, written **3× per handler** | `sensorHandler.js`, `offlineDataHandler.js` | ~80% | **4** | M | Open (old D-02) |
| **R-15** | Data | `validRoles` ×3, `validStatuses` ×2 — **and the two status lists disagree** | `userService.js` | see §5.3 | **5** | S | Open (old D-10) |

---

## 2. High-importance findings

### R-01 — The `gf` token object is copied 14× and has already caused a real defect (importance 8)

Fourteen files declare their own `const gf = { … }` mapping the same `--gf-*` CSS variables:

```
components/servers/InstallKeysPanel.tsx   pages/MikrotikMonitoring.tsx
pages/AlertRules.tsx                      pages/NetworkDetail.tsx
pages/Alerts.tsx                          pages/NetworkMonitoring.tsx
pages/Analytics.tsx                       pages/Reports.tsx
pages/Dashboard.tsx                       pages/ServerMetrics.tsx
pages/History.tsx                         pages/UpsDetail.tsx
pages/MikrotikDetail.tsx                  pages/UpsMonitoring.tsx
```

**This is not cosmetic — the copies have diverged, and the divergence shipped a bug.**

Thirteen files write `accent: "var(--gf-accent)"`. `pages/Dashboard.tsx:168` writes:

```ts
accent:      "#5794F2",     // ← hardcoded hex, not the variable
```

and then uses it as **text colour** at `Dashboard.tsx:1099` and `Dashboard.tsx:1268`:

```ts
style={{ color: gf.accent, background: "rgba(87,148,242,0.12)" }}
```

`index.css:28-32` documents exactly why this is wrong:

> *"Accent safe to put on TEXT. Same colour as `--gf-accent` on dark; the light theme needs a
> darker one … `--gf-accent` for surfaces and graphics, `--gf-accent-text` for type."*
> `index.css:84`: `--gf-accent-text: #1F62E0; /* … (--gf-accent is 2.76:1 here) */`

So on the **light theme**, Dashboard's accent text renders at **2.76:1** — below the 4.5:1
WCAG AA requires for body text. The other pages carry an `accentText` key and are fine. A
hardcoded hex structurally *cannot* follow that light/dark split. The second literal,
`rgba(87,148,242,0.12)`, is a hand-inlined `--gf-accent-dim`.

**Fix — `frontend/src/theme/gf.ts` is created (§6).** Per file:

```diff
-const gf = {
-  bg:          "var(--gf-bg)",
-  panel:       "var(--gf-panel)",
-  /* …10 more lines… */
-} as const;
+import { GF as gf } from "../theme/gf";
```

Aliasing to `gf` on import means **zero changes to the ~1,900 `gf.*` call sites**. Then fix the
two Dashboard lines the copy was hiding:

```diff
-            style={{ color: gf.accent, background: "rgba(87,148,242,0.12)" }}
+            style={{ color: gf.accentText, background: gf.accentDim }}
```

**Effort:** M — 14 one-line import swaps, then a light-theme pass on Dashboard.
**Verify:** `npx tsc --noEmit`, then toggle to light and read the two Dashboard labels.

---

### R-02 — `loadInterfaceLabels()` duplicated across both pollers (importance 7) ✅ FIXED

Byte-identical 9-line function in `snmpPollerService.js` and `mikrotikPollerService.js`. These
are the two halves of one feature — a port's admin label must read the same whether the device
is walked over SNMP or read over the RouterOS API — so two copies could only ever be identical
or wrong.

**Fixed this session.** Extracted to `backend/services/interfaceLabels.js`; both pollers import
it. 212 tests pass; all three services verified to import cleanly.

---

### R-03 — The session-validity check has grown from 2 sites to 3 (importance 7)

The 2026-08-10 report flagged this as D-12 with two sites. There are now three:

| Site | Code |
|---|---|
| `backend/middleware/auth.js:77-80` | `SELECT status, token_version …` + `!user \|\| user.status !== "active" \|\| user.token_version !== decoded.tv` |
| `backend/src/server.js:206-209` | **byte-identical** SQL and condition |
| `backend/services/socketSessions.js:82-83` | same rule, different shape: `row.status !== "active"` / `row.token_version !== socket.user.tv` |

This is the **authorisation** rule. Three expressions of "is this session still alive" is three
places to forget when a fourth account state is added — and `users.status` already has four
values (`pending`/`active`/`inactive`/`rejected`).

**Fix** — one predicate, in `middleware/auth.js` beside `JWT_SECRET`:

```js
/** The single definition of "this token still corresponds to a live session".
 *  Used by the HTTP middleware, the socket handshake, and the revocation sweep —
 *  three call sites that must never disagree about what `active` means. */
export function sessionIsLive(userRow, tvClaim) {
  return Boolean(userRow) && userRow.status === "active" && userRow.token_version === tvClaim;
}
```

```diff
-    if (!user || user.status !== "active" || user.token_version !== decoded.tv) {
+    if (!sessionIsLive(user, decoded.tv)) {
```

`socketSessions.js` keeps its *reason* strings — it needs to distinguish `account_inactive` from
`session_revoked` — but should call `sessionIsLive` for the pass/fail decision and only branch
on the reason afterwards.

**Effort:** S. **Verify:** disable an account and confirm HTTP 401 *and* socket `sessionRevoked`.

---

### R-04 — `formatUptime()` exists five times; two spellings already (importance 6)

| Location | Form |
|---|---|
| `frontend/src/pages/MikrotikMonitoring.tsx:43` | 10-line |
| `frontend/src/pages/NetworkMonitoring.tsx:73` | 10-line |
| `frontend/src/pages/MikrotikDetail.tsx:114` | 7-line, comma-declaration |
| `frontend/src/pages/NetworkDetail.tsx:76` | 7-line, comma-declaration |
| `backend/services/serverMetricUtils.js:90` | no null branch |

The comment above `MikrotikDetail.tsx:113` says it outright:

> *"— three copies is how the same router starts reading differently per page."*

Same story: `fmtDateTime()` ×4 (`MikrotikDetail:120`, `NetworkDetail:89`, `ServerDetail:96`,
`UpsDetail:116`), `formatSpeed()` ×2, and `fmtAxisTime()` ×2 — the last pair under **different
names** (`ServerDetail.tsx:64` calls it `fmtTime`), which is why a name-based search never found it.

**Fix — done, helpers added.** `frontend/src/utils/format.ts` now exports `formatUptime`,
`fmtDateTime`, `fmtAxisTime`, `formatSpeed`, `rateMBs`, `MULTI_DAY_SEC`. Per file:

```diff
-function formatUptime(sec: number | null): string { /* …7-10 lines… */ }
-function fmtDateTime(iso: string) { /* …5 lines… */ }
+import { formatUptime, fmtDateTime } from "../utils/format";
```

**Keep the backend copy separate.** `serverMetricUtils.js` is deliberately import-free so
`backend/tests/` runs with no MySQL/InfluxDB/.env. That is a real constraint, not laziness —
the new JSDoc records it so the next reader doesn't "helpfully" merge them.

**Effort:** S — 6 files, mechanical. **Verify:** `npx tsc --noEmit`.

---

### R-05 — `networkSegment()` duplicated across two backend services (importance 6) ✅ FIXED

`agentService.js` carried a byte-identical private copy of `snmpUtils.networkSegment`. The
comment on the `snmpUtils` copy admitted it — *"mirrors agentService.networkSegment so
device_network.network_segment stays consistent"* — which is a duplication that has already been
noticed and left in.

It matters because both write the **same column** in the **same table**: a Go-agent host and an
SNMP-polled router each populate `device_network.network_segment`. Two functions that merely
*happen* to agree.

**Fixed this session.** `agentService` imports from `snmpUtils` (which is pure and import-free,
so this adds no dependency weight); the stale comment is corrected. 212 tests pass.

---

## 3. Structural duplication

### R-08 — The three history handlers share an envelope (importance 5)

`CLAUDE.md` already predicted this: *"networkHistoryHandler + upsHistoryHandler have the
identical shape and should adopt it."*

Three copies of the same four-part shape — id guard, `resolveRange` try/catch, `queryRows`
promise, response envelope:

```js
// serverHistoryHandler.js:16-19, upsHistoryHandler.js:15-18, networkHistoryHandler.js:35-38
const deviceId = parseInt(req.params.id, 10);
if (!Number.isInteger(deviceId)) return res.status(400).json({ error: "Invalid …" });

// …:24-30 / :19-25 / :44-50  — identical
let resolved;
try { resolved = resolveRange(req.query); }
catch (err) { return res.status(err.status ?? 400).json({ error: err.message }); }
```

The response envelope has **already drifted**: `serverHistoryHandler.js:82` returns `spanSec`;
the UPS and network handlers do not. `spanSec` is what lets the client decide whether the x-axis
needs dates — so the same range choice labels differently depending on the page.

**Fix** — add to `backend/services/historyRange.js` (which already owns the range contract):

```js
/** The id guard + range resolution every history endpoint repeats.
 *  Returns null and answers the request itself on bad input. */
export function resolveHistoryRequest(req, res, label = "device") {
  const deviceId = parseInt(req.params.id, 10);
  if (!Number.isInteger(deviceId)) {
    res.status(400).json({ error: `Invalid ${label} id.` });
    return null;
  }
  try {
    return { deviceId, resolved: resolveRange(req.query) };
  } catch (err) {
    res.status(err.status ?? 400).json({ error: err.message });
    return null;
  }
}

/** One response envelope, so every page gets spanSec — not just servers. */
export function historyEnvelope(resolved, extra) {
  return {
    range: resolved.custom ? "custom" : resolved.preset,
    start: resolved.startISO ?? null,
    stop: resolved.stopISO ?? null,
    spanSec: resolved.spanSec ?? null,
    every: resolved.every,
    ...extra,
  };
}
```

```diff
-  const deviceId = parseInt(req.params.id, 10);
-  if (!Number.isInteger(deviceId)) return res.status(400).json({ error: "Invalid device id." });
-  let resolved;
-  try { resolved = resolveRange(req.query); }
-  catch (err) { return res.status(err.status ?? 400).json({ error: err.message }); }
-  const { rangeExpr, every } = resolved;
+  const parsed = resolveHistoryRequest(req, res);
+  if (!parsed) return;
+  const { deviceId, resolved } = parsed;
+  const { rangeExpr, every } = resolved;
```

⚠️ Adding `spanSec` to the UPS/network responses is a **behaviour change** (a widening one —
clients that ignore it are unaffected). Do it deliberately, not as a side effect.

**Effort:** S–M. **Verify:** `curl` each of the three endpoints, diff the JSON keys.

---

### R-09 — Eight UI primitives are copy-pasted across nine pages (importance 5)

Verified **character-identical** after comment/whitespace normalisation:

| Component | Copies | Locations | Redundant lines |
|---|---|---|---|
| `GhostButton` | **4** | `MikrotikMonitoring:165`, `NetworkMonitoring:176`, `ServerMetrics:319`, `UpsMonitoring:159` | 33 |
| `Stat` | 3 | `MikrotikDetail:208`, `NetworkDetail:178`, `UpsDetail:205` | 30 |
| `StatPanel` | 3 | `MikrotikMonitoring:147`, `NetworkMonitoring:158`, `UpsMonitoring:132` | 30 |
| `Field` | 3 | `NetworkMonitoring:188`, `Reports:817`, `UpsMonitoring:171` | 16 |
| `Meta` | 3 | `MikrotikMonitoring:180`, `NetworkMonitoring:225`, `UpsMonitoring:284` | 16 |
| `Sparkline` | 2 exact (+2 variants) | `AirConditioner:114`, `ServerMetrics:206` | 44 |
| `PortChip` | 2 | `MikrotikMonitoring:254`, `NetworkMonitoring:203` | 18 |
| `Panel` | **11 defs**, 2 pairs exact | 9 pages | 38 |
| `Th` | 2 | `MikrotikDetail:240`, `NetworkDetail:204` | 10 |

`GhostButton` is the cleanest case — four files, same 11 lines, same props:

```tsx
function GhostButton({ children, onClick, danger }: { children: React.ReactNode; onClick: (e: React.MouseEvent) => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className="gf-btn text-[13px] font-medium px-2.5 py-1"
      style={{ color: danger ? RED : gf.textMuted }}>
      {children}
    </button>
  );
}
```

**Fix** — `frontend/src/components/ui/` already exists (`AlertCard`, `RangePicker`,
`StatusBadge`). Add `primitives.tsx` there and delete the local copies. Do `GhostButton`,
`Stat`, `StatPanel`, `Field`, `Meta` first — all exact, so a passing `tsc` plus a page load is
sufficient proof.

⚠️ **`Panel` is 11 definitions but only 2 exact pairs** — the others differ in props
(`subtitle`, `action`, `bodyStyle`, `noPad`, optional vs required `title`). Do **not** force one
signature; unify the two exact pairs, then converge the rest deliberately. A universal `Panel`
with eight optional props is worse than three honest ones.

**Effort:** M. **Verify:** `npx tsc --noEmit` + `npm run build`, then open each page.

---

### R-11 — 93 identical try/catch wrappers in `api.ts` (importance 4)

`frontend/src/api/api.ts` is 1,169 lines. 93 of its 94 methods are:

```ts
  getServers: async (): Promise<ApiResult> => {
    try {
      const res = await apiClient.get("/servers");
      return { success: true, data: res.data };
    } catch (err: any) {
      return handleError(err);
    }
  },
```

**≈558 lines — about 48% of the file — is that wrapper.**

**Fix** — one combinator beside `handleError`:

```ts
/** Every method in this file is "call the endpoint, wrap the result, funnel errors
 *  through handleError". Written out 93 times, that shape is most of the file. */
async function call<T>(fn: () => Promise<{ data: T }>): Promise<ApiResult<T>> {
  try {
    return { success: true, data: (await fn()).data };
  } catch (err: any) {
    return handleError(err);
  }
}
```

```diff
-  getServers: async (): Promise<ApiResult> => {
-    try {
-      const res = await apiClient.get("/servers");
-      return { success: true, data: res.data };
-    } catch (err: any) { return handleError(err); }
-  },
+  getServers: () => call(() => apiClient.get("/servers")),
```

**Importance only 4, despite the line count** — it is boilerplate that has *not* drifted, and
`handleError` is already shared, so the actual error behaviour is single-sourced. This is
clutter, not risk. **Do it last**, and mechanically: 93 hand-edits is where a typo'd endpoint
string gets introduced.

**Effort:** M. **Verify:** `tsc` catches shape errors; smoke-test one call per page.

---

### R-12 / R-13 — Route boilerplate (importance 4)

23 occurrences of:

```js
const id = parseInt(req.params.id, 10);
if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid device id." });
```

across `routes/{analytics,mikrotik,network,reports,servers,ups}.js` and the three history handlers.

`GET /:id/logs` is **identical in three route files** — `mikrotik.js:98`, `network.js:70`,
`ups.js:49`:

```js
router.get("/:id/logs", authMiddleware, async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid device id." });
  try { res.json({ logs: await agentService.getDeviceLogs(id) }); }
  catch (err) { next(err); }
});
```

and the `POST /` + `DELETE /:id` pairs in `network.js:20-45` / `ups.js:20-45` differ only in the
service method, the socket event name, and the noun in the 404.

**Fix** — an Express param middleware, which removes the guard entirely rather than shortening it:

```js
// backend/middleware/numericId.js
export function numericId(label = "device") {
  return (req, res, next, value) => {
    const id = parseInt(value, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: `Invalid ${label} id.` });
    req.deviceId = id;
    next();
  };
}
```

```js
router.param("id", numericId("device"));   // once per router file
// then: const id = req.deviceId;
```

**Effort:** S for R-12. For R-13, a `deviceRoutes(service, { noun, addedEvent, removedEvent })`
factory is possible but **I'd leave it** — three near-identical readable route files beat one
clever factory, and the drift risk is low because the bodies are three lines each.

---

## 4. Near-duplicates

### R-14 — Environment sample field-list written 3× per handler (importance 4)

Carried over from D-02, still open. The 8-field env sample shape appears at
`sensorHandler.js:131`, `:176`, `:190` and `offlineDataHandler.js:123` — once for the Influx
point, once for the backup record, once for the broadcast:

```js
temperature: data.temperature,
humidity: data.humidity,
mq2_1_ppm: data.mq2_1_ppm,
mq2_2_ppm: data.mq2_2_ppm,
heat_index: data.heat_index,
smoke_status: data.smoke_status,
temp_status: data.temp_status,
```

`sensorHandler.js` is **35.8% duplicated** — the highest of any backend file.

The same three-way pattern (Influx fields → backup record → socket broadcast) recurs in
`networkMetricsHandler.js` and `upsMetricsHandler.js`, where the field list appears three times
in snake_case, snake_case and camelCase respectively.

**Fix** — one field manifest per stream:

```js
const ENV_FIELDS = ["temperature", "humidity", "mq2_1_ppm", "mq2_2_ppm", "heat_index"];
const ENV_TAGS   = ["smoke_status", "temp_status", "environment_status"];

const envRecord = (d) => Object.fromEntries([...ENV_FIELDS, ...ENV_TAGS].map((k) => [k, d[k] ?? null]));
```

⚠️ **Do not unify the three uses.** They are legitimately different: the Influx write is gated
by `envPersistPolicy`, the broadcast is not, and `offlineDataHandler` must *not* broadcast or
alert at all (replayed history must not fire a siren for air that cleared an hour ago). Share
the **field list**, not the control flow. This is why the finding is importance 4 and not 7 —
the risk is a field silently missing from the backup, not a logic bug.

**Effort:** M. **Verify:** ingest one reading, diff the NDJSON backup line against the Influx point.

---

## 5. Data duplication

### R-07 — Aircon zone boundaries `22 / 24 / 27 / 29` exist in five places (importance 6)

| # | Location | Form |
|---|---|---|
| 1 | `frontend/src/utils/tempZone.ts:28` | `ZONE_DEFAULTS = { coldBelow: 22, normalMax: 24, acceptableMax: 27, nearCritMax: 29 }` |
| 2 | `backend/services/airconService.js:337` | `IR_CFG_DEFAULTS = { coldBelow: 22, … }` |
| 3 | `v13_cspc-ictu-monitoring-system.sql:78-81` | column `DEFAULT 22.0` … `29.0` |
| 4 | `v13_cspc-ictu-monitoring-system.sql:91` | seeded row `(1, 22.0, 24.0, 27.0, 29.0, …)` |
| 5 | `iot/esp32/env_monitor_v2/env_monitor_v2.ino:277-280` | `float IR_TEMP_COLD_BELOW = 22.0; …` |

**Partly unavoidable, and the report should say so rather than demand a heroic fix.** The ESP32
copy is a genuine fallback for a device that boots before the backend pushes `acConfig`, and the
SQL default is what a fresh install starts from. Realistically:

- **#3 and #4 are redundant with each other** — the seeded row restates the column defaults.
  Drop the literals from the INSERT and let the defaults apply.
- **#1 and #2 can be one** — `tempZone.ts` is pure and import-free, so the backend cannot import
  it directly, but the frontend fallback could be fetched from `GET /api/aircon/ir-config`
  rather than hardcoded. Lower value: the frontend needs *something* before the request lands.
- **#5 stays.** Document it. `CLAUDE.md` already warns "change one, change the other" for the
  related `TEMP_COLD`.

**Minimum viable fix:** a comment block in `airconService.js` naming all five sites, so the next
person changing a boundary has the checklist. Importance 6 because a silent mismatch means the
dashboard names a zone the ESP32 is not in.

### R-10 — Status colours: 77 local declarations, 256 literal occurrences (importance 5)

| Hex | Meaning | Occurrences | Files |
|---|---|---|---|
| `#73BF69` | NORMAL / Online | 71 | 39 |
| `#5794F2` | TOO_COLD / accent | 55 | 32 |
| `#FF780A` | WARNING | 52 | 32 |
| `#F2495C` | DANGER | 47 | 30 |
| `#E02F44` | CRITICAL | 31 | 15 |

77 of those are local `const GREEN = "#73BF69"` style declarations. The `CRITICAL` vs `DANGER`
pair is the dangerous one — `#E02F44` and `#F2495C` are visually close and semantically ordered,
and `CLAUDE.md` already has to warn: *"CRITICAL is `#E02F44` — not `#F2495C`, which is DANGER."*
A warning in prose is what you write when the value has no single home.

**Fix — `STATUS` exported from the new `frontend/src/theme/gf.ts`:**

```diff
-const GREEN = "#73BF69";
-const ORANGE = "#FF780A";
-const RED = "#F2495C";
-const BLUE = "#5794F2";
+import { STATUS } from "../theme/gf";
+const { green: GREEN, orange: ORANGE, red: RED, blue: BLUE } = STATUS;
```

Destructuring to the existing local names keeps every call site unchanged.

⚠️ These must stay **literal hexes, not `var(--gf-*)`** — several consumers paint onto a
`<canvas>`, which cannot resolve a CSS variable. That is what `utils/canvasColor.resolveColor`
exists for, and it is why this module does not simply alias the CSS tokens.

### R-15 — `validRoles` ×3 and `validStatuses` ×2 — and the status lists disagree (importance 5)

`backend/services/userService.js`:

| Line | Declaration |
|---|---|
| 166 | `validRoles = ["admin", "it_staff"]` |
| 208 | `validRoles = ["admin", "it_staff"]` |
| 274 | `validRoles = ["admin", "it_staff"]` |
| 275 | `validStatuses = ["pending", "active", "inactive", "rejected"]` |
| 344 | `validStatuses = ["active", "inactive"]` |

The two status lists are **different**, and that may well be correct — one validates an admin
edit (any state), the other a toggle (only two). But nothing in the code says so, and they read
as a copy that drifted. That ambiguity is the finding.

**Fix:**

```js
export const ROLES = Object.freeze(["admin", "it_staff"]);
/** Every state a user row may hold. */
export const USER_STATUSES = Object.freeze(["pending", "active", "inactive", "rejected"]);
/** The subset an admin may TOGGLE between — deliberately narrower than USER_STATUSES:
 *  `pending`/`rejected` are outcomes of the approval flow, not switchable states. */
export const TOGGLEABLE_STATUSES = Object.freeze(["active", "inactive"]);
```

Naming the narrower list turns an apparent inconsistency into a stated rule. **Effort:** S.

---

## 6. Utilities modules

> ⚠️ **Why these are wired, not just written.** The 2026-08-10 audit created four utility
> modules; three were deleted a month later as "unused scaffolding" (see that report's §7). An
> unwired module is not a fix — it is a second copy that happens to have no callers. Modules
> below are marked with their actual adoption state.

| File | Exports | Replaces | State |
|---|---|---|---|
| `backend/services/interfaceLabels.js` | `loadInterfaceLabels` | R-02 | ✅ **created and wired** — both pollers import it |
| `backend/services/snmpUtils.js` | `networkSegment` (existing) | R-05 | ✅ **wired** — `agentService` now imports it; local copy deleted |
| `frontend/src/utils/format.ts` | + `formatUptime`, `fmtDateTime`, `fmtAxisTime`, `formatSpeed`, `rateMBs`, `MULTI_DAY_SEC` | R-04, R-06 | ⚠️ **created, call sites not yet migrated** |
| `frontend/src/theme/gf.ts` | `GF`, `STATUS` | R-01, R-10 | ⚠️ **created, call sites not yet migrated** |

**Nothing that changes rendering was migrated in this pass**, deliberately: the report is the
deliverable, and a 14-file token swap deserves its own reviewable change with a light-theme pass.
The two backend fixes were taken because they are byte-identical, compiler-checkable, and
covered by `npm test`.

**Verification of what was changed:** 212/212 backend tests pass; `node --check` clean on all
four touched backend files; all three affected services confirmed to import cleanly at runtime;
`npx tsc --noEmit` clean on the frontend.

---

## 7. Status of the 2026-08-10 findings

| Old ID | Finding | Status now |
|---|---|---|
| D-01 | Chart option builders ~85% identical | **Open** — `Environment.tsx:219` / `:307` |
| D-02 | `sensorHandler` / `offlineDataHandler` | **Open** → re-filed as **R-14** |
| D-03 | `GF` token object ×3 | **WORSE — now ×14** → re-filed as **R-01**, with a defect attached |
| D-04 | `initials()` | ✅ Fixed (2026-08-10), still fixed |
| D-05 | `aircon_logs` INSERT ×5 | **Open** — still 5 in `airconService.js` |
| D-06 | aircon log `entry` object ×3 | **Open** |
| D-07 | `system_logs` INSERT ×2 | **WORSE — now 5**, across `auditService.js`(1), `authService.js`(3), `policyService.js`(1) |
| D-08 | avatar initials inline in backend | Not re-checked this pass |
| D-09 | Flux query prefix | Partly addressed — `historyRange.js` now shared; see **R-08** |
| D-10 | `validRoles`/`validStatuses` | **Open** → re-filed as **R-15** with the list-mismatch detail |
| D-11 | rate-limiter config | Not re-checked this pass |
| D-12 | Session validity check ×2 | **WORSE — now ×3** → re-filed as **R-03** |
| D-13 | hover colour-swap handlers ×29 | Not re-counted this pass |
| D-14 | socket live-data wiring | Still **Unable to verify** — see §8 |

**Three findings grew.** D-03 went from 3 copies to 14, D-07 from 2 to 5, D-12 from 2 to 3. The
pattern is consistent: each new feature (MikroTik, policy acceptance, socket revocation) was
built by copying the nearest existing thing. That is a reasonable way to move fast, and it is
exactly why a duplication audit needs re-running rather than filing once.

---

## 8. Unable to verify

- **D-14 / live-socket wiring.** `Environment.tsx`, `Dashboard.tsx` and `LiveSummaryContext.tsx`
  all subscribe to `sensorData`. They plausibly share parse/state-update logic, but the three
  `useEffect` blocks were not read in full this pass. **What would prove it:** diff the
  `useEffect` that registers `sensorData`/`sensorHistory` in all three; if ≥70% identical,
  extract a `useLiveSensorData()` hook.
- **Whether the `Panel` variants can share one signature.** 11 definitions with differing props
  were counted, but I did not audit every call site's prop usage. **What would prove it:** list
  the props actually passed at each of the ~40 `<Panel` usages; if the union is ≤5 props, one
  component works.
- **`agent/` (Go).** Scanned and included in the clone pass; **no cross-file duplication above
  the 6-line threshold was found.** The Go↔Node metric contract is already guarded by
  `backend/tests/contract.test.js`, which parses `agent/internal/collector/metrics.go` and fails
  if its json tags drift from `NUMERIC_FIELDS`. **This is the model the rest of the codebase
  should follow** — where duplication across a boundary is genuinely unavoidable, a test that
  fails on drift beats a comment asking people to remember.
- **Hover-handler count (old D-13).** Not re-counted; the original figure of 29 sites across
  5 files is carried forward unverified.

---

---

## ✅ Remediation status — 2026-08-25 (same day)

Findings were fixed in the same session the audit was written. Verified after every batch
with `cd backend && npm test`, `cd frontend && npx tsc --noEmit` and `npm run build`.

| Metric | Before | After |
|---|---|---|
| Project duplication | 8.9% | **7.8%** |
| Redundant lines from exact-duplicate functions | 303 | **110** |
| Backend tests | 212 | **225** (13 added) |

| ID | Status |
|----|--------|
| R-01 `gf` token object ×14 | ✅ **Fixed** — all 14 files import `theme/gf.ts`; the Dashboard light-theme contrast defect is corrected (`accent` → `accentText`, inline rgba → `accentDim`) |
| R-02 `loadInterfaceLabels` | ✅ Fixed — `services/interfaceLabels.js`, both pollers wired |
| R-03 Session-validity check ×3 | ✅ **Fixed** — `sessionRevocationReason`/`sessionIsLive`/`fetchSessionRow` in `middleware/auth.js`; all three sites use it. Verified identical on all five account states |
| R-04 `formatUptime` ×5 etc. | ✅ **Fixed** — 6 pages import `utils/format.ts` |
| R-05 `networkSegment` ×2 | ✅ Fixed — `agentService` imports `snmpUtils` |
| R-06 `MULTI_DAY_SEC` ×4 | ✅ **Fixed** — one export in `utils/format.ts` |
| R-08 History envelope ×3 | ✅ **Fixed** — `resolveHistoryRequest` + `historyEnvelope` in `historyRange.js`. ⚠️ UPS and network responses now carry `spanSec`, which only the server endpoint returned before — a widening change |
| R-09 UI primitives | ✅ **Fixed** — `components/ui/primitives.tsx` (`GhostButton`, `Stat`, `StatPanel`, `Field`, `Meta`, `Th`); 8 pages migrated. `Panel` deliberately left local — 11 definitions, only 2 identical |
| R-10 Status colour hexes | ✅ **Fixed** — `STATUS` in `theme/gf.ts`, 26 files migrated |
| R-15 `validRoles`/`validStatuses` | ✅ **Fixed** — `ROLES` / `USER_STATUSES` / `TOGGLEABLE_STATUSES`, the narrower list now named rather than looking like drift |
| R-07 Aircon zone boundaries ×5 | ⏳ Open — partly unavoidable (firmware fallback + SQL default are legitimate) |
| R-11 `api.ts` ×93 wrappers | ⏳ Open — clutter, not risk; 93 mechanical edits best done alone |
| R-12 Route id guard ×23 | ⏳ Open |
| R-13 CRUD route bodies | ⏳ Partly — the dead `agentService` imports in all three route files were removed |
| R-14 Env sample field list | ⏳ Open |
| D-01, D-05, D-06, D-07 (2026-08-10) | ⏳ Still open |

## 9. Recommended order

Ordered by defect-risk removed per unit of effort, not by lines saved.

1. **R-01** — `gf` tokens → the module, then fix the two Dashboard `accentText` lines. *This one
   has a live a11y defect attached.*
2. **R-03** — collapse the session check to one predicate before a fourth call site appears.
3. **R-15** — name `TOGGLEABLE_STATUSES` so the narrower list stops looking like a bug.
4. **R-04 / R-06** — swap the six formatter call sites to `utils/format.ts` (helpers already there).
5. **R-08** — history envelope; decide deliberately about adding `spanSec` to UPS/network.
6. **R-09** — UI primitives, exact ones first (`GhostButton`, `Stat`, `StatPanel`, `Field`, `Meta`).
7. **R-07** — drop the redundant SQL seed literals; comment the remaining four sites.
8. **R-10** — status colours, incrementally, page by page.
9. **R-14**, then **D-05/D-07** (the SQL INSERT helpers the last audit specified).
10. **R-11 / R-12 / R-13** — pure clutter. Last, and mechanically.

---

*Generated 2026-08-25. Clone detection: 6- and 7-line normalised token windows plus
brace-matched function-body hashing over 178 files / 33,236 significant lines.*
