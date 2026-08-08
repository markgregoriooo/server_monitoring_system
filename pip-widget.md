# Pop-Out Live Widget — Picture-in-Picture, **Customizable** (CSPC-ICTU Monitoring)

> Status: **PLAN** (branch `pip-widget`). Nothing implemented yet — this is the design
> of record. Update the Status section (§11) as phases land.

---

## 1. What it is (in one paragraph)

A small, always-on-top floating window — the kind Google Meet pops out when you leave the
tab — that keeps a **compact, user-customizable live status panel** on the desktop while the
user works in other apps. The user **drags & drops** which tiles to show (room temp,
humidity, gas, server summary, open-alert count, latest alert, aircon, …) from a builder on
the dashboard; the floating window renders exactly that, updating in real time. Click it to
jump back to the dashboard. It is **launched by a button** (a user gesture is mandatory) and
is **Chromium-only**.

The browser feature is **Picture-in-Picture (PiP)**. There are two APIs; we use the second:

| API | Renders | Why / why not |
|-----|---------|---------------|
| **Picture-in-Picture API** | a `<video>` element only | Wrong tool — we have no video |
| **Document Picture-in-Picture API** | **arbitrary HTML/DOM** | ✅ What Google Meet uses; lets us render our own React widget |

---

## 2. The one decision that drives everything: **same React tree, separate document**

The Document PiP window (`window.documentPictureInPicture.requestWindow()`) returns a real,
separate `Window` with its own empty `document`. The key architectural move:

- We do **not** spin up a second React root, a second socket, or a second auth session.
- We render the widget with **`createPortal`** into `pipWindow.document.body`. It stays part
  of the **main app's React tree**, so it already has `AuthContext`, `NotificationContext`,
  the shared `socket`, theme, and every hook — for free. Live data "just works."
- The only thing that does **not** cross the document boundary automatically is **CSS**. The
  PiP document starts blank, so we must **copy our stylesheets into it** (see §6).

This mirrors how `ToastHost` already works: a shell-level, route-independent overlay fed by
the existing contexts. The PiP host is the same pattern, just portaled into another window.

---

## 3. Customization model — **tile catalog + ordered layout** (the heart of this feature)

Customization is the user choosing **which tiles** appear and **in what order**. Two concepts:

### 3.1 The tile catalog (the menu of what's available)
A single registry — `frontend/src/pip/tiles/catalog.tsx` — defines every available tile as a
small descriptor. Each tile is a self-contained React component that reads live data from the
**existing hooks** (no new data source):

```ts
interface TileDef {
  id: string;            // stable key persisted in the layout, e.g. "env.temp"
  label: string;         // shown in the builder, e.g. "Temperature"
  group: string;         // "Environment" | "Servers" | "Alerts" | "Aircon"
  span?: 1 | 2;          // grid columns it occupies (default 1)
  Render: React.FC;      // reads useLiveSummary()/useNotifications(), draws the tile
}
```

First-cut catalog:

| Tile id | Shows | Live source |
|---------|-------|-------------|
| `env.temp` | room temperature, zone-colored | `sensorData` |
| `env.humidity` | humidity % | `sensorData` |
| `env.gas` | gas band (NORMAL/WARN/DANGER) | `sensorData` |
| `servers.summary` | online count + worst CPU/mem | `serverMetrics` / `serverStatus` |
| `servers.list` | each server **by name** on one divider-separated line, **problem-first sorted** (offline → busiest), with exact `cpu·mem` + a single **LOAD bar gauge** (worst of the two). Names follow the admin display label, live via `serverRenamed` | `serverMetrics` / `serverStatus` / `serverRenamed` |
| `ups.summary` | fleet-worst battery %, runtime and an **ON BATTERY** state. While discharging, **runtime leads and is red** — it is the only metric on the widget with a deadline attached. Fleet-worst, not per-unit: one UPS on battery is the story regardless of how many are healthy | `upsMetrics` / `upsStatus` / `upsRemoved` |
| `network.summary` | **ports** up/total across every router — SNMP *and* MikroTik — plus peak link utilization, or an offline-router count when one is unreachable. Counts ports rather than devices: a router answering SNMP while three buildings' links are down is "online" by device count and broken by any measure that matters | `networkMetrics` / `networkStatus` / `networkRemoved` |
| `ups.list` | **every UPS by name**, one line each, sorted on-battery → least runtime → name | `upsMetrics` / `upsStatus` |
| `network.list` | **every router by name** (SNMP + MikroTik), ports up/total, sorted offline → most ports down → name | `networkMetrics` / `networkStatus` |
| `ups.device:<id>` | **one pinned UPS** — its own name, charge/runtime/load, ON BATTERY state | `upsMetrics` / `upsStatus` |
| `network.device:<id>` | **one pinned router** — its own name, ports up/total, SNMP-vs-MikroTik, peak link | `networkMetrics` / `networkStatus` |
| `alerts.count` | open-alert badge (red when >0) | `useNotifications().openAlertCount` |
| `alerts.latest` | most recent alert title + severity | `useNotifications().items[0]` |
| `aircon.summary` | how many AC units on + mode | `airconStatus` |
| `meta.clock` | time + connection dot | `socket` connected state |

> Adding a tile later = add one `TileDef` to the catalog. Nothing else changes.

### 3.2 The layout (the user's choice)
The saved layout is just an **ordered array of tile ids** — small, forward-compatible:

```json
{ "tiles": ["env.temp", "alerts.count", "servers.summary", "env.humidity"] }
```

Unknown ids (a tile removed in a future build) are ignored on render, so old layouts never
break. The widget renders the catalog entries named here, in order, into an auto-flow grid.

### 3.3 The builder (where drag-and-drop happens) — on the main page, not in PiP
A **"Customize Widget"** panel on the **Settings page** (beside `NotificationPreferences`,
where per-user prefs already live). Two columns:

```
Settings → Customize Widget
┌─ Available tiles ──────┐        ┌─ Your widget ──────────────┐
│ Environment            │        │ ⠿ Temperature        [×]  │
│  + Temperature         │  drag  │ ⠿ Open alerts        [×]  │
│  + Humidity   + Gas    │  ───▶  │ ⠿ Servers summary    [×]  │
│ Servers  + Summary     │        │ ⠿ Humidity           [×]  │
│ Alerts + Count +Latest │        │   (drag ⠿ to reorder)     │
│ Aircon + Summary       │        └────────────────────────────┘
└────────────────────────┘        [ Reset ]   [ Save layout ]
                                   [ Pop out ▣ ]  ← live preview/launch
```

Drag-and-drop = **@dnd-kit** (`@dnd-kit/core` + `@dnd-kit/sortable`) — modern, accessible
(keyboard-draggable), maintained. (`react-beautiful-dnd` is deprecated; `react-grid-layout`
is overkill for a compact fixed widget.) The "Your widget" column is a dnd-kit **sortable**
list; "Available tiles" add on click or drag-in. A **live preview** of the widget renders
right there so the user sees the result before popping it out.

> Why the builder lives on the main page, not inside the floating window: dragging in a
> ~320px PiP window is fiddly, and PiP has focus/quirk issues. Build big, render small —
> this is how Grafana/Datadog dashboards work.

---

## 4. Persistence — **backend per-user, localStorage-cached** (matches `notification_prefs`)

Best practice for a per-user layout: the **server is the source of truth** (so it follows the
user across machines), with a **localStorage cache** for instant first paint. This mirrors
the existing `notification_prefs` design exactly (`migrations/2026-06-13_notifications.sql`,
`notificationService.getPrefs/savePrefs`, `GET/PUT /api/notifications/prefs`).

**New table** (`migrations/2026-06-1X_widget_prefs.sql`) — one row per user, missing row =
default layout supplied by the backend:

```sql
CREATE TABLE IF NOT EXISTS `widget_prefs` (
  `user_id`    INT NOT NULL,
  `layout_json` JSON NOT NULL,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_widget_prefs_users1` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;
```

**Load flow (optimistic):**
1. `useWidgetLayout()` reads `localStorage['cspc_pip_layout']` synchronously → instant paint.
2. In the background it `GET /api/widget-layout`; if the server differs, reconcile + update
   the cache. Missing row → backend returns a sensible **default layout**.

**Save flow:** builder "Save" → `PUT /api/widget-layout` (server validates ids against the
catalog, drops unknowns) → on success write the cache. Optimistic UI, reconcile on failure —
the same pattern as `NotificationContext.markRead`.

> Validation lives server-side too: the backend keeps the canonical tile-id allow-list and
> strips anything not in it, so a stale/hand-edited layout can't inject junk.

---

## 5. Proposed pieces (new)

### Frontend
```
frontend/src/pip/
  usePictureInPicture.ts    ← API wrapper: feature-detect, open/close, style cloning,
                              theme sync, lifecycle/cleanup. → { supported, isOpen, open, close, pipWindow }
  PipHost.tsx               ← shell-level owner (sibling of ToastHost). Holds the PiP
                              window and createPortal(<PipWidget/>, body).
  PipWidget.tsx             ← renders the user's layout: maps saved tile ids → catalog
                              entries → tiles, in an auto-flow grid. Grafana tokens.
  useLiveSummary.ts         ← one hook owning the live sensor/server summary so Dashboard,
                              tiles, and the preview share ONE subscription (not many).
  useWidgetLayout.ts        ← layout state: localStorage cache + GET/PUT reconcile + save.
  tiles/catalog.tsx         ← the TileDef registry (every available tile).
  WidgetBuilder.tsx         ← the drag-and-drop builder (dnd-kit) + live preview.
```

Wiring:
- Mount `<PipHost />` in `App.tsx` `AppShell`, beside `<ToastHost />` (route-independent).
- Launch button in `components/layout/Header.tsx` — rendered only when `supported`.
- `<WidgetBuilder />` rendered on `pages/Settings.tsx`, beside `NotificationPreferences`.

### Backend (mirrors the notification-prefs trio)
```
backend/migrations/2026-06-1X_widget_prefs.sql   ← the table above (run in phpMyAdmin)
backend/services/widgetPrefsService.js           ← getLayout(userId) / saveLayout(userId, layout)
                                                   + DEFAULT_LAYOUT + tile-id allow-list validation
backend/routes/widgetLayout.js                   ← GET/PUT /api/widget-layout (authMiddleware,
                                                   scoped to req.user.id), mounted in server.js
```

> No new socket events. No firmware changes. The widget is a pure **consumer** of streams the
> dashboard already subscribes to (`sensorData`, `serverMetrics`, `serverStatus`,
> `airconStatus`, `notification`) — see §10.

---

## 6. The browser-specific problems and how we solve them

PiP is finicky. These bite, and the plan for each:

1. **Styles don't carry over.** The PiP document is blank. On open, clone every `<style>` and
   `<link rel="stylesheet">` from the main `document.head` into `pipWindow.document.head`.
   All theming is **CSS custom properties on `:root`** (`--gf-*`, `index.css:8`) + Tailwind
   utilities, so cloning the stylesheets makes the whole design system work unchanged.
2. **Theme (dark/light).** Light mode = a `light` class on `:root` (`index.css:39`
   `:root.light`). Copy `documentElement.className` onto the PiP doc's root on open, and keep
   it in sync if `ThemeContext` toggles while the widget is open.
3. **Fonts.** JetBrains Mono comes via `@import` at `index.css:1`, so cloning the stylesheet
   pulls it in.
4. **Lifecycle / cleanup.** The window closes three ways: user closes it, we `close()`, or
   the tab navigates away. Listen for the PiP window's `pagehide` to reset `isOpen`, tear down
   the portal, restore the button. Also `close()` on unmount so we never leak a window.

---

## 7. What a tile looks like (glanceable, reused colors)

Compact, ~`320×280`, auto-flow grid of whatever tiles the user picked. Grafana tokens,
JetBrains Mono, 2px radius. Example with `["env.temp","alerts.count","servers.summary"]`:

```
┌────────────────────────────────┐
│ CSPC-ICTU · Live      ● online  │  ← meta.clock (if added)
├───────────────┬────────────────┤
│  TEMP         │  ⚠ ALERTS      │
│  24.5°C       │  2 open        │
├───────────────┴────────────────┤
│  Servers   4/5 online          │
│  worst CPU 82% · mem 61%       │
└────────────────────────────────┘
   (click anywhere → focus tab + route)
```

Color logic is **reused** from the Dashboard helpers (`tempColor`, `loadColor`, severity
colors) — tiles never re-derive thresholds.

---

## 8. Decisions (locked — best-practice / real-world defaults)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Document PiP API, not video PiP | We render live HTML, not a video stream |
| 2 | Portal into the existing React tree | Free access to socket/contexts; one source of truth |
| 3 | Customization = tile catalog + ordered id list | Small, forward-compatible; unknown ids ignored |
| 4 | Builder lives on the **main page** (Settings), PiP renders | Dragging in a tiny window is poor UX (Grafana/Datadog model) |
| 5 | Persist **backend per-user**, localStorage-cached | Layout follows the user across devices; instant first paint |
| 6 | **@dnd-kit** for drag-and-drop | Modern, accessible, maintained; rbd is deprecated |
| 7 | Reorderable tile list, not a free resizable grid | Right altitude for a compact widget; lighter dep |
| 8 | Server validates tile ids against the catalog | Stale/edited layouts can't inject junk |
| 9 | No new socket / firmware; one new tiny REST pair | Widget is a pure consumer; persistence is the only new I/O |
| 10 | Launch from a Header button (user gesture); feature-detect | API requires a gesture; Chromium-only → hide elsewhere |
| 11 | Single widget instance | The API allows only one PiP window per browser |

---

## 9. Constraints & gotchas (know these before building)

- **Chromium only** (Chrome / Edge **116+**). Firefox / Safari: no Document PiP → don't
  render the launch button (`'documentPictureInPicture' in window`). The **builder still
  works everywhere** (it's just a normal page) — only the *pop-out* is Chromium-gated.
- **User gesture required** — cannot auto-open on load or on an alert. An alert can only
  *update* an already-open widget.
- **One PiP window** per browser, app-wide. Re-opening focuses/replaces, never stacks.
- **Secure context** — needs HTTPS or `localhost`. Fine for dev; note for LAN/prod over HTTP.
- **No persistence of the *window* across reload** — the *layout* persists (backend), but the
  floating window itself must be re-opened. Acceptable; it's a live view.
- **Sizing** — some Chromium versions clamp tiny dimensions; pick sane defaults.
- **React events across the document boundary** — React 18 attaches its event
  delegation at the main root container, so `onClick` on portaled nodes living in the
  *PiP document* may not fire. Phase 1 content is non-interactive, so it's a no-op there;
  for the click-through (Phase 5) attach a **native** listener on the PiP window/body
  (e.g. `pipWindow.addEventListener("click", …)`) rather than relying on React `onClick`.

---

## 10. Data sources — **all already flowing** (no backend data work)

| Data | Source already in place | File |
|------|------------------------|------|
| Room temp / humidity / gas | `socket.on("sensorData")` | `pages/Dashboard.tsx:546` |
| Server CPU/mem/online | `socket.on("serverMetrics")` + `"serverStatus"` | `pages/Dashboard.tsx:547` |
| Aircon state | `socket.on("airconStatus")` | `pages/Dashboard.tsx:548` |
| Open alert count / latest | `useNotifications()` (`openAlertCount`, `items`) | `context/NotificationContext.tsx:48` |

The widget consumes these via the same hooks the Dashboard uses — ideally lifted into
`useLiveSummary` so Dashboard + tiles + preview share **one** subscription.

---

## 11. Status & next steps (phased)

- [x] **Phase 1 — PiP plumbing.** `usePictureInPicture.ts` (open/close, feature-detect, style
      clone, theme sync, cleanup) + `PipHost` in `AppShell` + Header launch button.
      Acceptance: button opens a blank-but-styled window that closes cleanly. ✅ `c0506da`
- [x] **Phase 2 — Tiles + live data.** `LiveSummaryContext` (one shared subscription) +
      `tiles/catalog.tsx` + `PipWidget` rendering the **hardcoded `DEFAULT_LAYOUT`**.
      Acceptance: values tick live, match Dashboard. ✅
      (Note: `useLiveSummary` shipped as a context provider, not a bare hook, so all tiles
      share ONE subscription regardless of count.)
- [x] **Phase 3 — Persistence.** Migration (`2026-06-17_widget_prefs.sql`) +
      `widgetPrefsService` + `routes/widgetLayout.js` (mounted `/api/widget-layout`) +
      `useWidgetLayout` (localStorage cache + GET/PUT reconcile). Acceptance: a saved layout
      survives reload and another device. ✅ **Run the migration in phpMyAdmin** before the
      cross-device part works; until then it falls back to the localStorage cache.
- [x] **Phase 4 — Builder (drag & drop).** `WidgetBuilder` on Settings: @dnd-kit sortable
      "Your widget" column + grouped "Available tiles" + live `PipWidget` preview, wired to
      `useWidgetLayout` (Save / Reset to default / Discard). Acceptance: drag to
      add/reorder/remove → Save → pop-out reflects it. ✅ (added dep: `@dnd-kit/*`)
- [x] **Phase 5 — Polish.** Click-through (native click on the PiP window → `window.focus()`,
      per the §9 gotcha), connection-lost banner + red dot, reduced-motion on the ping,
      reset-to-default + discard in the builder, keyboard-draggable list (@dnd-kit
      KeyboardSensor) + aria labels, theme-toggle-while-open sync (Phase 1 MutationObserver). ✅
- [x] **Post-1.0 — `servers.list` tile (S14).** Names each server (not just counts): one
      glanceable line per server, problem-first sorted (offline → busiest), `cpu·mem` + a single
      LOAD bar, divider between rows. Names follow the admin display label and stay live
      (`LiveSummaryContext` now handles `serverRenamed`). Added to `DEFAULT_LAYOUT` + the backend
      tile allow-list. Existing saved layouts must add it from **Settings → Customize Widget**. ✅

- [x] **Post-1.0 — `ups.summary` + `network.summary` tiles.** The catalog was frozen when this
      branch forked (2026-06-15), so every monitoring domain built afterwards was invisible to
      the widget even though its streams were already reaching the browser. `LiveSummaryContext`
      now also consumes `upsMetrics`/`upsStatus`/`upsRemoved` and
      `networkMetrics`/`networkStatus`/`networkRemoved` (SNMP routers **and** MikroTik share the
      latter), seeded from REST on mount and re-seeded on reconnect — these sources are POLLED
      (60s SNMP / 30s RouterOS), so without a seed a freshly-opened widget would show dashes for
      up to a minute. Both tiles are **opt-in** from Settings → Customize Widget, matching how
      `servers.list` shipped; `DEFAULT_LAYOUT` is unchanged. ✅
      ⚠️ Adding a tile means editing **two** allow-lists — `tiles/catalog.tsx` and
      `backend/services/widgetPrefsService.js` — or the server silently strips it on save.

- [x] **Post-1.0 — list + per-device tiles for UPS / Network.** The aggregate tiles above are
      thin once there are several units, so: `ups.list` / `network.list` name every device
      (mirroring `servers.list`), and **parameterised** ids pin a single one.
      **This is the one place tile ids stop being a fixed vocabulary** — `ups.device:7` carries
      its device in the id, deliberately keeping the saved layout a plain array of strings so
      persistence, dedupe and the `MAX_TILES` cap all keep working untouched (§3.2/§4).
      - `resolveTile(id)` in `tiles/catalog.tsx` is now the **only** correct lookup. The static
        `TILE_BY_ID` map cannot see device ids, so anything matching on it silently deletes
        pinned tiles — that bug was live in `useWidgetLayout.known()` and is fixed.
      - The backend validates these by **shape**, never against `devices`: a decommissioned
        unit already renders "Unavailable" client-side, so an existence check would only add a
        DB round-trip per read and risk deleting a tile during a blip. Id pattern is
        `^(ups|network)\.device:[1-9]\d{0,9}$` — **no leading zeros**, so `ups.device:07` can't
        become a second string for device 7 and slip past the dedupe. Keep the regex in
        `catalog.tsx` and `widgetPrefsService.js` in step.
      - Device picking lives in the **builder**, not the widget — React events don't fire on
        nodes portaled into the PiP document (§9), so an in-widget selector could never be
        clicked. Each of the UPS / Network groups gets a **"+ Specific …" dropdown** listing
        live units (already-added ones filtered out, resetting after each pick so it reads as
        an action, not a setting). A dropdown rather than one "+" per unit because a campus
        with a dozen routers would otherwise bury the static tiles above them. ✅

- [x] **Post-1.0 — per-stream staleness.** The connection dot reflects the SOCKET, not each
      data source. If a collector died while the socket stayed healthy — the SNMP poller
      crashing, the ESP32 dropping off — nothing emitted an offline status (the poller is what
      would have emitted it), so a tile froze on its last reading and went on looking green.
      On a glance surface, a confidently-wrong number is worse than an obvious gap.
      `LiveSummaryContext` now timestamps every stream (`env` / `servers` / `ups` / `network`,
      REST seeds included) and exposes a `stale` flag per stream; `Shell` dims the reading to
      45% and marks the label orange. Notes:
      - Thresholds are a generous multiple of each source's real cadence (env 60s, servers
        210s — `-interval` is per-agent and 60s is supported — UPS/network 240s), because a
        missed sample is normal and only a RUN of them means anything.
      - Re-evaluated on a 10s tick: staleness is the ABSENCE of events, so nothing else would
        ever trigger the render that flips the flag.
      - A stream that has never reported is **not** stale — that's an empty state, and the
        tiles already say "No UPS" / "—".
      - Alerts / Aircon / Clock are exempt: they're event-driven, so "no update recently"
        carries no information there. Device-level failure is still covered by the offline
        sweep and poller reachability — this catches the layer above them. ✅

> **Feature complete.** Remaining manual step: run `migrations/2026-06-17_widget_prefs.sql`
> in phpMyAdmin so layouts persist server-side (cross-device). Until then it works off the
> localStorage cache. Verify the pop-out in Chrome/Edge (see below).

---

## 12. Key files (when building)

| File | Role |
|------|------|
| `frontend/src/pip/usePictureInPicture.ts` | PiP API wrapper hook (new) |
| `frontend/src/pip/PipHost.tsx` | shell-level owner + portal (new) |
| `frontend/src/pip/PipWidget.tsx` | renders the user's saved layout (new) |
| `frontend/src/pip/useLiveSummary.ts` | shared live sensor/server summary hook (new) |
| `frontend/src/pip/useWidgetLayout.ts` | layout state: cache + GET/PUT reconcile (new) |
| `frontend/src/pip/tiles/catalog.tsx` | the TileDef registry (new) |
| `frontend/src/pip/WidgetBuilder.tsx` | dnd-kit builder + live preview (new) |
| `frontend/src/App.tsx` | mount `<PipHost />` in `AppShell` |
| `frontend/src/components/layout/Header.tsx` | launch button (gated on `supported`) |
| `frontend/src/pages/Settings.tsx` | host `<WidgetBuilder />` (beside NotificationPreferences) |
| `backend/routes/widgetLayout.js` | `GET/PUT /api/widget-layout` (new) |
| `backend/services/widgetPrefsService.js` | getLayout/saveLayout + default + validation (new) |
| `backend/migrations/2026-06-1X_widget_prefs.sql` | `widget_prefs` table (new) |
| `frontend/src/socket/socket.ts` | existing shared socket — reused, not changed |
| `frontend/src/context/NotificationContext.tsx` | `openAlertCount`, `items` — reused |
| `frontend/src/index.css` | `--gf-*` tokens + `:root.light` + font — cloned into PiP doc |
| `frontend/src/components/notifications/ToastHost.tsx` | the pattern `PipHost` mirrors |
| `backend/services/notificationService.js` | the prefs pattern `widgetPrefsService` mirrors |
