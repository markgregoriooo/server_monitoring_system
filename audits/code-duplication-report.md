# Code Duplication Audit — CSPC-ICTU Monitoring System

**Date:** 2026-06-06
**Scope:** `backend/` + `frontend/src/` (firmware `.ino` excluded — single file).
**Method:** pattern search + manual diff of the files read this session. Line numbers
reflect state at audit time; a few may shift after edits.

> Deliverable note: the requested **utilities module** has been created (see
> [§7](#7-utilities-modules-created)). One trivial, 100%-identical duplication (**D-04
> `initials`**) was already wired in to demonstrate adoption; the rest are provided as
> drop-in snippets to keep this change low-risk.

---

## 1. Summary table

| ID | Type | What | Locations | ~Dup % | Importance /10 | Effort |
|----|------|------|-----------|--------|----------------|--------|
| D-01 | Near | Chart options builders | `Environment.tsx` `makeCombinedOptions` 125–206 vs `makeSmokeOptions` 208–283 | ~85% | **7** | M |
| D-02 | Near | InfluxDB write handlers | `sensorHandler.js` 14–47 vs `offlineDataHandler.js` 10–44 | ~80% | **7** | M |
| D-03 | Data | `GF` design-token object | `Environment.tsx:84`, `AirConditioner.tsx:33`, `Dashboard.tsx` | ~95% | **6** | S–M |
| D-05 | Struct | `aircon_logs` INSERT | `airconService.js` 104,145,167,183,218 (×5) | 100% stmt | **6** | S–M |
| D-07 | Struct | `system_logs` INSERT | `authService.js` 64–68, 124–129 (×2) | 100% stmt | **5** | S |
| D-12 | Near | Session validity check (F-02) | `middleware/auth.js` + `src/server.js` io.use | ~90% | **5** | S |
| D-04 | Exact | `initials()` | `ProfileModal.tsx:22`, `UserManagement.tsx:40` (+ 2 inline in `userService.js`) | 100% | **4** ✅ fixed | S |
| D-06 | Struct | aircon log `entry` object | `airconService.js` 147–152,172,188 (×3) | 100% | **4** | S |
| D-10 | Data | `validRoles`/`validStatuses` arrays | `userService.js` 41,100,101,177 | 100% | **4** | S |
| D-13 | Struct | hover color-swap inline handlers | 29 sites across 5 files | pattern | **4** | M |
| D-08 | Data | aircon avatar/initials inline | `userService.js` 60–65, 243–251 | ~90% | **3** | S |
| D-09 | Struct | Flux query prefix | `querySensorHistoryHandler.js` 35–60 | ~60% | **3** | S |
| D-11 | Struct | rate-limiter config | `auth.js` 9–29, `server.js` 22–31 | ~50% | **3** | S |
| D-14 | Near | socket live-data wiring | `Environment.tsx`, `Dashboard.tsx` | Unable to verify | **4** | M |

---

## 2. High-importance findings

### D-01 — Chart option builders are ~85% identical (importance 7)
**Type:** Near duplicate. **Files:** `frontend/src/pages/Environment.tsx`
`makeCombinedOptions` (125–206) and `makeSmokeOptions` (208–283).

The `tooltip` shell, the entire `zoom` plugin block, and the **whole x-axis `ticks`
block** (now including the mobile `splitLabel`/`maxTicksLimit` logic) are byte-identical;
only the tooltip `label` callback and the y-scales differ. The mobile fix had to be edited
in **both** places — exactly the cost duplication imposes.

**DRY fix:** extract a shared base, override per chart.
```ts
function baseLineOptions(
  isDark: boolean, isMobile: boolean,
  gridColor: string, dateColor: string, timeColor: string,
  onZoom?: (s: string, e: string) => void,
): Pick<ChartOptions<"line">, "responsive" | "maintainAspectRatio" | "animation" | "interaction"> & {
  plugins: ChartOptions<"line">["plugins"]; xScale: NonNullable<ChartOptions<"line">["scales"]>["x"];
} {
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { display: false }, /* zoom block here */ },
    xScale: { /* the shared x ticks block here */ },
  };
}
```
Then `makeCombinedOptions`/`makeSmokeOptions` spread the base and only supply their own
tooltip `label` + `scales.y*`. **Effort: Medium** (1 file, careful typing).

---

### D-02 — `sensorHandler` and `offlineDataHandler` share validation + Point build (importance 7)
**Type:** Near duplicate. **Files:** `backend/handlers/sensorHandler.js` 14–47,
`backend/handlers/offlineDataHandler.js` 10–44.

Both validate the same 7 numeric/string fields and build an identical
`new Point("sensor_environment")…floatField/tag` chain. Differences: offline adds a
`timestamp` string field, uses the RTC time (not `new Date()`), skips throttle/broadcast.

**DRY fix:** one module owning the schema.
```js
// backend/handlers/sensorPoint.js
import { Point } from "../config/influx.js";
const NUM = ["temperature","humidity","mq2_1_ppm","mq2_2_ppm","heat_index"];
const STR = ["smoke_status","temp_status","environment_status"];

export function isValidReading(d) {
  return d && NUM.every(k => typeof d[k] === "number")
           && STR.every(k => typeof d[k] === "string");
}
export function buildSensorPoint(d, timestamp) {
  const p = new Point("sensor_environment");
  NUM.forEach(k => p.floatField(k, d[k]));
  STR.forEach(k => p.tag(k, d[k]));
  return p.timestamp(timestamp);
}
```
Both handlers then call `isValidReading` + `buildSensorPoint`. **Effort: Medium.**

---

### D-03 — `GF` design-token object duplicated across 3 pages (importance 6)
**Type:** Data duplication. **Files:** `Environment.tsx:84`, `AirConditioner.tsx:33`,
`Dashboard.tsx`. ~13 identical `var(--gf-*)` mappings copy-pasted, **with drift**:
`AirConditioner.tsx` exposes `border`, `Environment.tsx` exposes `panelBorder` for the
same token — the kind of inconsistency duplication breeds.

**DRY fix:** created `frontend/src/theme/gfTokens.ts` (exports `GF` with both `border` and
`panelBorder` aliases). Per page: delete the local `const GF = {…}` and
`import { GF } from "../theme/gfTokens"`. **Effort: Small–Medium** (3 files, mechanical).

---

## 3. Backend SQL/boilerplate findings

### D-05 — `aircon_logs` INSERT repeated 5× (importance 6)
`airconService.js` lines 104, 145, 167, 183, 218 — same statement, 5 copies.
**Fix:** use the created `logAirconEvent` (see §7). Example for `toggle`:
```js
import { logAirconEvent, buildLogEntry } from "../utils/auditLog.js";
// …
await logAirconEvent({ deviceId: id, userId, action, reason: `By ${userName}`, triggerType: "manual" });
return { enabled: Boolean(newState), ir_channel: current.ir_channel, entry: buildLogEntry(action, `By ${userName}`) };
```
For `addUnit`, pass the transaction connection: `logAirconEvent({…}, conn)`. **Effort: Small–Medium.**

### D-06 — aircon log `entry` object repeated 3× (importance 4)
`airconService.js` 147–152, 172, 188 each build `{ time: new Date().toLocaleTimeString("en-PH"), action, reason }`.
**Fix:** `buildLogEntry(action, reason)` (created in §7).

### D-07 — `system_logs` INSERT duplicated (importance 5)
`authService.js` 64–68 (login) and 124–129 (logout). **Fix:** `logSystemEvent` (§7):
```js
import { logSystemEvent } from "../utils/auditLog.js";
await logSystemEvent({ userId: user.user_id, module: "auth", action: "login",
  description: `User ${user.username} logged in`, ip, userAgent });
```

### D-10 — role/status arrays duplicated (importance 4)
`userService.js` 41, 100–101, 177. **Fix:** import from created `utils/constants.js`:
```js
import { ROLES, STATUSES } from "../utils/constants.js";
if (!ROLES.includes(role)) throw new Error("Invalid role.");
if (status !== undefined && !STATUSES.includes(status)) throw new Error("Invalid status.");
```
**Defense-in-depth:** `ROLES` could derive from `Object.keys(ROLE_PERMISSIONS)` in
`permissionService.js` so roles have one source of truth.

### D-12 — session validity check duplicated (importance 5)
The F-02 block (`SELECT status, token_version … && status==='active' && token_version===tv`)
exists in both `middleware/auth.js` and `src/server.js` io.use. **Fix:** extract once:
```js
// middleware/auth.js
export async function isSessionValid(decoded) {
  const [[u]] = await db.query(
    "SELECT status, token_version FROM users WHERE user_id = ? LIMIT 1", [decoded.id]);
  return !!u && u.status === "active" && u.token_version === decoded.tv;
}
```
Call it from both sites. **Effort: Small.** (Created during this session's F-02 work — worth
collapsing now before it drifts.)

---

## 4. Frontend boilerplate findings

### D-04 — `initials()` exact duplicate ✅ FIXED (importance 4)
Was identical in `ProfileModal.tsx:22` and `UserManagement.tsx:40` (and inline in
`userService.js`). **Applied:** moved to `frontend/src/utils/format.ts`; both files now
`import { initials } from ".../utils/format"`. Type-checked clean.

### D-08 — avatar initials inline in backend (importance 3)
`userService.js` 60–65 (`createUser`) and 243–251 (`updateOwnProfile`) build initials
inline (same `split/map/join/toUpperCase/slice`). **Fix:** add a backend `initials()` to
`utils/format` equivalent, or compute client-side only.

### D-13 — hover color-swap handlers repeated ~29× (importance 4)
`onMouseEnter={e => (e.currentTarget.style.color = …)} onMouseLeave={…}` across
`Header.tsx`(2), `Sidebar.tsx`(4), `AirConditioner.tsx`(7), `Environment.tsx`(15),
`Dashboard.tsx`(1). **Fix:** a tiny helper returns the handler pair:
```ts
export const hoverColor = (from: string, to: string) => ({
  onMouseEnter: (e: React.MouseEvent<HTMLElement>) => (e.currentTarget.style.color = to),
  onMouseLeave: (e: React.MouseEvent<HTMLElement>) => (e.currentTarget.style.color = from),
});
// usage:  <button {...hoverColor(GF.textMuted, GF.textPrimary)}>
```
**Effort: Medium** (many sites; adopt incrementally).

---

## 5. Lower-importance / structural

- **D-09** (importance 3) — `querySensorHistoryHandler.js` `numericQuery`/`tagQuery` share
  `from(bucket)`/`range`/`_measurement` prefix (35–60). Extract a `base(rangeClause)` template.
- **D-11** (importance 3) — `loginLimiter` (`auth.js` 9–29) and `globalLimiter`
  (`server.js` 22–31) share `windowMs/standardHeaders/legacyHeaders/handler`. Extract
  `makeLimiter(overrides)`.

---

## 6. Unable to verify

- **D-14** — `Environment.tsx` and `Dashboard.tsx` both call `socket.on("sensorData"/…)`.
  They likely share parse/state-update logic, but I did not read `Dashboard.tsx`’s socket
  block in full this session. **What would prove it:** diff the `useEffect` that registers
  `sensorData`/`sensorHistory` handlers in both files. If ≥70% identical, extract a
  `useLiveSensorData()` hook.
- **D-08 backend** assumes `userService.updateOwnProfile` still contains the inline initials
  block (lines 243–251 as last read); re-confirm before extracting.

---

## 7. Utilities modules created

> ⚠️ **Superseded (2026-06-08):** three of the files below were **removed** in SESSION 3 as
> unused scaffolding and **do not exist** in the current tree — `backend/utils/auditLog.js`,
> `backend/utils/constants.js`, and `frontend/src/theme/gfTokens.ts`. The adoption snippets in
> §2–§6 that `import` from them will not resolve as-is; re-create the helper first. Only
> `frontend/src/utils/format.ts` (D-04) still exists and is wired in.

| File | Exports | Replaces |
|------|---------|----------|
| `frontend/src/utils/format.ts` | `initials`, `manilaTime` | D-04 ✅, D-06/Dashboard time strings |
| `frontend/src/theme/gfTokens.ts` | `GF` | D-03 |
| `backend/utils/constants.js` | `ROLES`, `STATUSES` | D-10 |
| `backend/utils/auditLog.js` | `logSystemEvent`, `logAirconEvent`, `buildLogEntry` | D-05, D-06, D-07 |

> The backend util files are **created but not yet imported** (except where noted) — adopt
> them via the snippets above. They were left unwired to keep this audit low-risk; wiring
> `logAirconEvent`/`logSystemEvent` touches transaction code and warrants its own tested PR.

---

## 8. Recommended order (fastest risk/clutter reduction)
1. **D-03** `GF` tokens → import the new module in the 3 pages (kills the `border`/`panelBorder` drift).
2. **D-12** session check → collapse the F-02 duplication before it diverges.
3. **D-05 + D-07** → adopt `auditLog.js` (6 INSERTs → 2 helpers).
4. **D-01 / D-02** → the two big near-duplicates; highest LOC saved, do with tests.
5. **D-10**, then **D-13** incrementally.
