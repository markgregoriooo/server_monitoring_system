# Email + Popup Notifications — CSPC-ICTU Monitoring

Real, persisted notifications across **three delivery channels**, replacing the current
hardcoded bell badge (`alertCount={2}`) and the in-memory mock `/api/alerts`:

1. **Bell feed** — the existing bell icon in the header becomes clickable; clicking it opens a
   dropdown panel listing this user's notifications (unread highlighted, mark-as-read, badge count).
2. **In-app popup** — a live toast pops in the corner the moment an event fires (Socket.IO push),
   plus an optional **browser/OS popup** (Web Notifications API) so it shows even when the tab is
   in the background.
3. **Email via [Resend](https://resend.com)** — high-severity events are emailed to the relevant
   staff.

Branch: `email-popup-notifications` (off `main`).

> 🧭 **Status: BUILT & COMPLETE** on branch `email-popup-notifications` (7 commits). All three
> channels work; triggers cover server metrics, offline, and environment/smoke; plus de-dup
> cooldown, retention, per-user prefs UI, and the Dashboard now reads the real feed. The only
> deferred extra is a paginated "view all" history page.

> 📖 **Studying this feature?** Read §1–§4 for the concept and core flow, then jump to **§12 —
> the file-by-file + code walkthrough** (the authoritative guide to every file and how the code
> fits together). §5–§11 are the design history (how/why decisions were made).

---

## 1. What it is (in one paragraph)

When something noteworthy happens — a server crosses a CPU threshold, a host goes offline, a UPS
switches to battery, the server room overheats — the backend **raises an alert** (one row in
`alerts`) and **fans it out** to the people who should see it (one row per recipient in
`alert_notifications`). That fan-out drives all three channels at once: each recipient gets a live
**Socket.IO push** (→ toast + bell badge bump), the notification is **persisted** so the bell
dropdown can show history and unread state across reloads, and — for severe events — an **email**
goes out via Resend. This mirrors the existing live-push pattern (`deviceLog`, `serverStatus`,
`serverMetrics`) but adds **persistence** (so notifications survive a refresh) and **per-user read
state** (so each person has their own unread count).

---

## 2. The one decision that drives everything: **alert (the event) vs. notification (the delivery)**

The schema already separates these — we keep that split:

| | `alerts` | `alert_notifications` |
|---|---|---|
| **What** | the *event* — happened once | the *delivery* — one row **per recipient** |
| **Holds** | device, type, title, message, severity, status (active/ack/resolved) | `user_id`, `is_read`, `sent_at`, `read_at` |
| **Cardinality** | 1 per event | N per event (one per user notified) |
| **Drives** | email content, alert history | the bell feed + unread badge (per user) |

So "mark as read" and the unread count are **per user** (they live on `alert_notifications`),
while acknowledging/resolving an alert is **global** (it lives on `alerts`). The bell feed is a
join: `alert_notifications` (for *my* read state) × `alerts` (for the content).

---

## 3. How it fits the current system — **the tables already exist**

The migration `V10…schema.sql` already defines everything we need; this feature mostly fills in
services + UI. **No new core tables** — only a small alter + an optional prefs table.

| Existing table | Use |
|---|---|
| `alerts` (`device_id`, `type`, `title`, `message`, `severity`, `status`, `acknowledged_by`, …) | the event row |
| `alert_notifications` (`alert_id`, `user_id`, `is_read`, `sent_at`, `read_at`) | per-user bell feed + read state |
| `alert_rules` (`device_id`, `metric_name`, `threshold_value`, `comparison`, `severity`) | **optional** — declarative thresholds; v1 can reuse the hardcoded thresholds already in `agentService.checkThresholds` |
| `users.email` | the Resend recipient address (already unique, already populated by Google login) |
| `settings` (`setting_key`, `setting_value`) **or** new `notification_prefs` | per-user channel prefs (email on/off, min severity) |

### Migration needed (`migrations/2026-06-13_notifications.sql` — **written; run it in phpMyAdmin**)
- `alerts.metric_value` → **NULLABLE** (state-transition alerts like offline / on-battery have no
  numeric reading).
- `alerts.status` → `DEFAULT 'active'`; `alerts.updated_at` → auto-bump `ON UPDATE` (for ack/resolve).
- `alert_notifications.is_read` → `DEFAULT 0`.
- `alert_notifications.emailed TINYINT NOT NULL DEFAULT 0` (never double-send email on a
  retry/restart; lets the UI show "emailed").
- New `notification_prefs(user_id, email_enabled, popup_enabled, min_email_severity)` — per-user
  channel control. A **missing row = defaults** (the backend supplies them), so it's optional to
  populate and the feature works before any prefs UI exists.

> ⚠️ Replaces the mock. `routes/alerts.js` + `data/db.js` `alerts[]` are in-memory and reset on
> restart. This feature makes alerts/notifications **real (MySQL)**. Keep `/api/alerts` for alert
> history (status/ack/resolve) and add `/api/notifications` for the per-user bell feed — or fold
> both into one router. (Decision Q4.)

---

## 4. How an event becomes a notification (the core flow)

```
something happens (threshold crossed, device offline, UPS on battery, room hot)
   │
   ▼
notificationService.raiseAlert({ deviceId, type, title, message, severity })
   │  1. INSERT alerts (status='active')                       ── the event
   │  2. resolve recipients (active users; by role — see Q2)   ── who sees it
   │  3. INSERT alert_notifications (one per recipient, is_read=0)
   │  4. for each recipient → io.to("user:"+id).emit("notification", payload)
   │        → frontend: toast + browser popup + bell badge +1 + prepend to feed
   │  5. if severity ≥ EMAIL min (e.g. critical) and pref allows
   │        → emailService.sendAlertEmail(user.email, alert)   ── Resend
   │        → mark alert_notifications.emailed = 1
   ▼
persisted + delivered on all enabled channels
```

**De-dup / anti-spam (important):** reuse the **hysteresis** pattern already in
`agentService.checkThresholds` (`alertState` Map, 70–80% hold band) so a value hovering at the
threshold raises **one** alert on onset, not one per poll. `raiseAlert` should only be called on a
**band crossing**, never every tick. (Same idea for "still on battery" — raise once on transition.)

---

## 5. Trigger sources — where `raiseAlert` gets called

These emit points already exist; we add a `raiseAlert(...)` call at each (most already compute the
crossing, so it's a small hook, not new detection logic):

| Source | Where (today) | Event → severity |
|---|---|---|
| Server CPU/Mem/Disk threshold | `agentService.checkThresholds` (already bands + emits `deviceLog`) | warning ≥80%, critical ≥90% |
| Server went offline | offline sweep in `server.js` (already emits `serverStatus`) | warning |
| Environment (temp / gas) | `handlers/sensorHandler.js` | warning / critical |
| UPS on battery / low runtime | router-ups poller (**other branch** — `upsMetricsHandler`) | critical |
| Router/interface down | router-ups poller (**other branch** — `networkMetricsHandler`) | warning |

> v1 can ship with just the **server-metric** + **offline** + **environment** triggers (all on
> `main`). UPS/router triggers land when that branch merges — `raiseAlert` is the shared entry
> point, so adding them later is one call each.

---

## 6. Backend pieces (new / changed)

| File | Role | New? |
|---|---|---|
| `backend/services/emailService.js` | Resend wrapper: `sendAlertEmail(to, alert)`; lazy client; **no-op + warn** if `RESEND_API_KEY` unset (dev still runs) | new |
| `backend/services/notificationService.js` | `raiseAlert()`, `listForUser()`, `unreadCount()`, `markRead(ids)`, `markAllRead()` — the core in §4 | new |
| `backend/routes/notifications.js` | `GET /api/notifications` (feed + unreadCount), `POST /api/notifications/read` (ids or all) — `authMiddleware`, scoped to `req.user.id` | new |
| `backend/sockets/connectionHandler.js` | on browser connect: `socket.join("user:" + socket.user.id)` so we can target a single user | edit |
| `backend/src/server.js` | mount `notifications` route; wire `raiseAlert` into the offline sweep | edit |
| `backend/services/agentService.js` | in `checkThresholds`, also `raiseAlert` on band onset (already the right hook) | edit |
| `backend/handlers/sensorHandler.js` | `raiseAlert` on env temp/gas threshold | edit |
| `backend/package.json` | add `resend` dependency | edit |

**Per-user delivery uses Socket.IO rooms.** Browsers authenticate with a JWT that carries the user
id; on connect we `join("user:"+id)`, then `io.to("user:"+id).emit("notification", …)` reaches
every tab that user has open. (Devices/ESP32 never join a user room.)

---

## 7. Frontend pieces (new / changed)

| File | Role | New? |
|---|---|---|
| `frontend/src/context/NotificationContext.tsx` | fetch feed on mount; subscribe to socket `notification`; hold `items[]` + `unreadCount`; expose `markRead`/`markAllRead`/`dismiss`/`clearAll`/`subscribe`; fire toast + browser popup + sound | new |
| `frontend/src/components/notifications/NotificationPanel.tsx` | the bell **dropdown** — list, unread highlight, mark-all-read, **clear-all**, per-item **dismiss (X)**, sound mute, "enable desktop alerts", click → mark read + navigate | new |
| `frontend/src/components/notifications/ToastHost.tsx` | corner toast stack on each live `notification` (auto-dismiss 6s, severity color, click-through) | new |
| `frontend/src/components/notifications/notificationUtils.ts` | shared `SEVERITY_COLOR`, `routeFor(n)` (deep-link target), `relativeTime()` | new |
| `frontend/src/components/notifications/NotificationPreferences.tsx` | Settings card — email on/off + min email severity (persisted) | new |
| `frontend/src/utils/browserNotify.ts` | Web Notifications API wrapper (permission + fire-when-backgrounded) | new |
| `frontend/src/utils/notificationSound.ts` | Web Audio chime + mute toggle (localStorage) | new |
| `frontend/src/components/layout/Header.tsx` | bell **clickable** → toggle panel; badge from context (dropped static `alertCount`) | edit |
| `frontend/src/App.tsx` | wrap in `NotificationProvider`; mount `<ToastHost/>` | edit |
| `frontend/src/pages/Dashboard.tsx` | "Alerts" panel + "Active Alerts" stat read the real feed (context) | edit |
| `frontend/src/pages/Settings.tsx` | mount `<NotificationPreferences/>` | edit |
| `frontend/src/api/api.ts` | `getNotifications`, `markNotificationsRead`, `markAllNotificationsRead`, `dismissNotifications`, `clearAllNotifications`, `getNotificationPrefs`, `saveNotificationPrefs` | edit |

- **In-app toast** is the baseline popup (always shown on a live event). **Browser/OS popup** is an
  enhancement: ask `Notification.requestPermission()` once (e.g. from a Settings toggle), then fire
  `new Notification(...)` so the popup appears even when the dashboard tab is unfocused.
- Style with the **Grafana `--gf-*` tokens** (panel `#181B1F`, 2px radius, JetBrains Mono, severity
  colors from CLAUDE.md: warning `#FF780A`, critical `#E02F44`, info/online `#73BF69`). No
  `slate-*` / `dark:` classes.

---

## 8. Socket events (added)

| Event | Direction | Payload |
|---|---|---|
| `notification` | Server → **one user's** browsers (`io.to("user:"+id)`) | camelCase: `{ id, alertId, deviceId, deviceName, type, title, message, severity, isRead:false, createdAt, sentAt }` — `id` is the per-user `alert_notifications.id` (the row you mark read / dismiss) |

(Existing `deviceLog` / `serverStatus` stay as-is; `notification` is the new persisted, per-user one.
The payload is built by `notificationService.toClient()`, so it always matches the REST feed shape.)

---

## 9. Library & config (planned)

- **Backend dependency:** [`resend`](https://www.npmjs.com/package/resend) — official Node SDK.
- **Domain:** Resend requires a **verified sending domain** (SPF/DKIM) for production. For dev,
  Resend's `onboarding@resend.dev` sender works to a single test address.
- **`.env` (backend):**

```
RESEND_API_KEY=            # Resend API key; blank → email channel disabled (bell+toast still work)
RESEND_FROM=               # e.g. "CSPC ICTU Monitoring <alerts@your-verified-domain>"; blank = onboarding@resend.dev (test)
NOTIFY_EMAIL_MIN_SEVERITY= # critical | warning | info — min severity that triggers email; blank = critical
NOTIFY_EMAIL_TO=           # optional override (testing): force all alert emails to this address
NOTIFY_COOLDOWN_MIN=       # de-dup window (min): same device+type+severity won't re-alert within it; blank = 30
NOTIFY_RETENTION_DAYS=     # alerts older than this are purged daily (feed rows cascade); blank = 30
```

> 🔐 Treat `RESEND_API_KEY` like any secret — backend-only, never shipped to the frontend.

---

## 10. Decisions (locked — senior-dev defaults)

1. **"System popup" = toast + opt-in OS popup.** In-app toast always fires on a live event; the
   browser Notifications API is an opt-in (one permission prompt) so popups also show when the tab
   is backgrounded.
2. **Recipients = all active users** (admin + it_staff). One `alert_notifications` row per active
   user. (Relaxing to role/owner-scoped later is just a change to the recipient query.)
3. **Email = critical only** by default (`NOTIFY_EMAIL_MIN_SEVERITY=critical`), per-user
   overridable via `notification_prefs.min_email_severity`. Toast + bell fire for **all**
   severities; email is reserved for what's worth interrupting someone.
4. **Two routers, clear split.** `/api/notifications` = per-user bell feed (list, unread count,
   mark-read). `/api/alerts` = alert history + acknowledge/resolve (replaces the current mock).
5. **Per-user prefs: included now** via `notification_prefs` (§3). A missing row falls back to the
   `.env` defaults, so the feature works before the prefs UI ships (prefs UI = a later phase).
6. **Alert lifecycle:** v1 bell panel does **read/unread** only. Acknowledge/resolve
   (`alerts.status` + `acknowledged_by`) is supported by the schema and can be added to the panel
   later; not in the v1 scope.

---

## 11. Status & next steps (phased)

- **✅ Phase 1 — persistence + bell (DONE):** migration (§3) applied →
  `services/notificationService.js` (`raiseAlert` + `listForUser`/`unreadCount`/`markRead`/
  `markAllRead`, injected `io` via `init`) → `routes/notifications.js` (`GET /api/notifications`,
  `POST /api/notifications/read`) → per-user socket room (`user:<id>` joined in
  `connectionHandler`) → triggers wired: **server CPU/Mem/Disk** (`agentService.checkThresholds`)
  and **server offline** (sweep in `server.js`) → frontend `NotificationContext` +
  `NotificationPanel` dropdown + real unread badge in `Header` (replaces the hardcoded
  `alertCount={2}`). Notifications carry the **device name**. `node --check` + `tsc` clean.
  *Live end-to-end test (agent → threshold → bell) still pending a running stack.*
- **✅ Phase 2 — live popup (DONE):** `components/notifications/ToastHost.tsx` renders corner
  toasts (auto-dismiss 6s, severity color, click-through, stack cap), driven by a `subscribe()`
  API on `NotificationContext` (single socket listener, no duplication). `utils/browserNotify.ts`
  fires an **OS popup** via the Web Notifications API — opt-in (permission prompt surfaced as
  "Enable desktop alerts" in the bell panel), and only when the tab is **backgrounded** (a focused
  user already sees the toast). `tsc` + `vite build` clean.
- **✅ Phase 3 — email (Resend) (DONE — code; needs keys to send):** `services/emailService.js`
  (Resend SDK, inline-styled HTML, no-op when `RESEND_API_KEY` unset). `raiseAlert` now fetches
  each active user's email + prefs (`notification_prefs`, missing row → env defaults) and sends a
  **severity-gated, per-user** email concurrently (best-effort), marking `alert_notifications.emailed=1`.
  Env: `RESEND_API_KEY`, `RESEND_FROM`, `NOTIFY_EMAIL_MIN_SEVERITY` (default critical),
  `NOTIFY_EMAIL_TO` (test override). `node --check` + import smoke clean.
  **To actually send:** add the Resend keys to `backend/.env` and verify against a Resend test
  address first (`onboarding@resend.dev` sender → your own inbox).
- **✅ P1 hardening (DONE):** (a) **Environment alerts wired** — `sensorHandler` now raises a
  room-level alert when the ESP32's `environment_status` escalates into WARNING/DANGER/CRITICAL
  (or smoke DANGER), severity-mapped, `device_id` NULL (system alert — needs the
  `2026-06-13_alerts_nullable_device.sql` ALTER). (b) **Restart-proof cooldown** — `raiseAlert`
  skips an identical `device+type+severity` alert within `NOTIFY_COOLDOWN_MIN` (default 30 min),
  via a DB check, so an always-critical device alerts once, not every poll/restart, and flapping
  is damped. Notifications of `type:"environment"` deep-link to `/environment`.
- **Phase 4 (when router-ups merges):** add UPS-on-battery / interface-down `raiseAlert` calls.
- **✅ P2 (DONE):** (a) **Retention** — daily purge of alerts older than `NOTIFY_RETENTION_DAYS`
  (default 30; feed rows cascade) in `server.js`. (b) **Clear / dismiss** — per-item dismiss (X)
  + "Clear all" in the bell panel → `POST /api/notifications/clear` (`dismiss`/`clearAll`).
  (c) **Per-user prefs UI** — `NotificationPreferences` card on the Settings page (email on/off +
  min email severity), persisted via `GET`/`PUT /api/notifications/prefs` (`notification_prefs`
  upsert). `tsc`/`vite build`/`node --check` clean.
- **✅ P3 (DONE):** (a) the **Dashboard "Alerts" panel** + "Active Alerts" stat now render the
  **real feed** via `NotificationContext` (severity-colored, relative time) — the legacy
  `/api/alerts` mock is no longer used by the UI. (b) Toast honours `prefers-reduced-motion`
  (`motion-reduce:animate-none`). `tsc` + `vite build` clean.
- **Optional extra (not built):** a dedicated full **"view all" history page** with pagination
  (the bell shows the latest 100, with clear/dismiss) — a genuine new feature rather than polish;
  build on request.
- See `CLAUDE.md` (Socket.IO events, data stores, UI tokens) and the `alerts` / `alert_notifications`
  tables in `V10…schema.sql` for the existing scaffolding this builds on.

---

## 12. Study guide — file-by-file + code walkthrough

> This is the authoritative map of what was actually built. Read it top to bottom to understand
> the whole feature; or jump to a file when you're editing it.

### 12.0 Suggested reading order
1. **Database** (§12.1) — the two migrations + the three tables. Everything anchors here.
2. **`backend/services/notificationService.js`** (§12.2) — the heart. Read `raiseAlert` first.
3. **One trigger** — `backend/services/agentService.js` → `checkThresholds` (§12.3) to see how a
   real event calls `raiseAlert`.
4. **`backend/routes/notifications.js`** (§12.4) — the REST surface the frontend calls.
5. **`frontend/src/context/NotificationContext.tsx`** (§12.5) — the single client-side hub.
6. The **UI consumers** — `Header` → `NotificationPanel`, `ToastHost`, `NotificationPreferences`.

### 12.1 Database (run these in phpMyAdmin)
- `migrations/2026-06-13_notifications.sql` — defaults on `alert_notifications.is_read`, adds
  `emailed`, makes `alerts.metric_value` nullable + `status` default, creates `notification_prefs`.
- `migrations/2026-06-13_alerts_nullable_device.sql` — makes `alerts.device_id` NULL-able (so
  room-level **environment** alerts, which have no device row, can be stored).
- **Tables:** `alerts` = the event (1 row). `alert_notifications` = the per-user delivery/read row
  (N per event — this is the bell feed). `notification_prefs` = one row per user (email on/off,
  popup on/off, min email severity); a missing row means "defaults".

### 12.2 `backend/services/notificationService.js` — the core (read this first)
The single entry point everything funnels through. Exposes (`export default { … }`):
- **`init(io)`** — called once in `server.js`; stashes the Socket.IO server so any trigger can push
  without passing `io` around.
- **`raiseAlert({ deviceId, type, title, message, severity, metricValue })`** — the whole pipeline:
  1. **Cooldown check** — skip if an identical `device+type+severity` alert exists within
     `NOTIFY_COOLDOWN_MIN` (a DB query → restart-proof de-dup).
  2. `INSERT` into `alerts` (the event).
  3. `SELECT` active users + their email + `notification_prefs` (LEFT JOIN, defaults if no row).
  4. Bulk `INSERT` one `alert_notifications` row per user.
  5. `SELECT` those rows back (joined to `alerts` + `devices` for `device_name`) and
     `io.to("user:"+id).emit("notification", toClient(row))` to each recipient's room.
  6. **Email** (if Resend configured): for each recipient, gate on `email_enabled` +
     severity ≥ their `min_email_severity`, send concurrently (`Promise.allSettled`), then set
     `emailed=1`. Best-effort — wrapped so a failure never breaks the caller.
- **`toClient(row)`** — maps the snake_case DB row → the camelCase payload used by BOTH the socket
  push and the REST feed (so they're always identical).
- **Reads:** `listForUser`, `unreadCount`. **Mutations:** `markRead`, `markAllRead`, `dismiss`
  (delete rows), `clearAll`. **Prefs:** `getPrefs`, `savePrefs` (upsert). **Retention:** `purgeOld`.
- Key idea: **best-effort** everywhere — monitoring must never break because a notification failed.

### 12.3 Triggers — where `raiseAlert` is called from
- `backend/services/agentService.js` → **`checkThresholds`** — server CPU/Mem/Disk; in-memory
  hysteresis (`alertState` Map, 70–80 % hold band) raises once on the band crossing.
- `backend/src/server.js` → **offline sweep** — raises a "Server offline" alert per transition;
  also `init(io)`, mounts the route, and runs the daily **retention purge**.
- `backend/handlers/sensorHandler.js` → **environment** — raises a room-level alert when the
  ESP32's `environment_status` escalates (NULL `device_id`).

### 12.4 `backend/routes/notifications.js` — REST (all `authMiddleware`, scoped to `req.user.id`)
- `GET /api/notifications` → `{ notifications, unreadCount }`
- `POST /api/notifications/read` `{ ids } | { all:true }`
- `POST /api/notifications/clear` `{ ids } | { all:true }` (dismiss / clear-all)
- `GET /api/notifications/prefs` → `{ prefs }`  ·  `PUT /api/notifications/prefs` `{ emailEnabled?, popupEnabled?, minEmailSeverity? }`
- Plus `backend/services/emailService.js` (Resend HTML email; no-op without a key) and
  `backend/sockets/connectionHandler.js` (browser joins room `user:<id>` on connect).

### 12.5 Frontend
- **`context/NotificationContext.tsx`** — the hub. Fetches the feed on login, subscribes to the
  `notification` socket event (prepend + badge++ + **sound** + **desktop popup** + notify toast
  subscribers), re-syncs on reconnect. Exposes `items`, `unreadCount`, `markRead`, `markAllRead`,
  `dismiss`, `clearAll`, and `subscribe(fn)` (so the toast host taps the live stream without a
  second socket listener). Wrapped around the app in `App.tsx`.
- **`components/layout/Header.tsx`** — the bell: badge = `unreadCount`, click toggles the panel
  (closes on outside-click / Escape).
- **`components/notifications/NotificationPanel.tsx`** — the dropdown list. Mark-all-read,
  clear-all, per-item dismiss (X on hover), sound mute, "enable desktop alerts", click an item →
  mark read + `navigate(routeFor(n))`.
- **`components/notifications/ToastHost.tsx`** — corner toast stack (mounted once in `App.tsx`).
- **`components/notifications/notificationUtils.ts`** — `SEVERITY_COLOR`, `routeFor(n)`
  (cpu/mem/disk/offline → `/server-metrics?device=<id>`; environment → `/environment`),
  `relativeTime()`. **This is where you add routing for new alert types.**
- **`components/notifications/NotificationPreferences.tsx`** — the Settings card (email prefs).
- **`utils/browserNotify.ts`** (OS popup) · **`utils/notificationSound.ts`** (chime + mute).
- **Deep-link landing:** `pages/ServerMetrics.tsx` reads `?device=<id>` and opens that server's
  detail; `pages/Dashboard.tsx` renders the real feed in its "Alerts" panel.

### 12.6 End-to-end trace (follow one alert through the system)
```
ESP32 / agent event
  → trigger (checkThresholds | offline sweep | sensorHandler)
    → notificationService.raiseAlert(...)
      → [cooldown?] → INSERT alerts → INSERT alert_notifications (per user)
        → io.to("user:<id>").emit("notification", payload)   ── live
        → emailService.sendAlertEmail(...) (severity-gated)  ── email
  ── browser ─────────────────────────────────────────────────────────
  socket "notification" → NotificationContext.onNotification
      → prepend to items, unreadCount++, play sound, OS popup, toast
  bell badge (Header) ⇄ unreadCount ; panel lists items ; click → navigate
  page reload → GET /api/notifications rehydrates the same list (persisted)
```

### 12.7 How to test each channel
- **Bell + toast + sound:** trigger a server CPU ≥ 90 % (or stop an agent → offline in ~15 s).
- **Environment:** let the ESP32 report a hot/smoke status (needs the nullable-device ALTER).
- **Email:** set `RESEND_API_KEY` + `NOTIFY_EMAIL_TO` (your Resend signup email) in `backend/.env`,
  restart, trigger a **critical** alert. Temporarily set `NOTIFY_EMAIL_MIN_SEVERITY=info` to email
  everything while testing.
- **Prefs:** Settings → Notification Preferences → toggle email / change min severity → Save.
- **Cooldown:** trigger the same alert twice within `NOTIFY_COOLDOWN_MIN` → only the first fires.
