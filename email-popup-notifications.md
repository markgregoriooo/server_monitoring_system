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
6. **Alert lifecycle:** v1 bell panel did **read/unread** only. Acknowledge/resolve
   (`alerts.status` + `acknowledged_by`/`acknowledged_at`/`resolved_at`) was deferred in v1 — and is
   **now BUILT** (2026-06-14) as a separate shared lifecycle on the new **Alerts** page, distinct
   from the per-user bell. See **§13**. (The bell remains read/unread; ack/resolve is team-wide.)

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
- **✅ Configurable alert thresholds (DONE — 2026-06-14):** the `alert_rules` table now drives all
  threshold alerting (global default + per-server override; rules-only fallback). New
  `alertRulesService` + admin-only `routes/alertRules.js` + **Alert Rules** page; `checkThresholds`
  and `sensorHandler` refactored off their hardcoded values; `raiseAlert` stamps `alert_rule_id`.
  Migration `2026-06-14_alert_rules.sql` (seeds the old defaults). Full detail: **§13**.
- **✅ Firmware threshold unification (DONE — 2026-06-14):** new `envConfig` socket event pushes the
  room-level thresholds to the ESP32 so its **LED/buzzer/status** track the dashboard with no reflash
  (firmware `#define`s → runtime globals). *Needs flashing to take effect on the device.* See **§13**.
- **✅ Alert lifecycle — acknowledge/resolve (DONE — 2026-06-14):** completes decision #6.
  `routes/alerts.js` is now **real** (`alertsService`): list + acknowledge + resolve (admin + it_staff),
  **auto-resolve on metric recovery**, broadcast `alertUpdated`, new **Alerts** page. FK fix
  `2026-06-14_alerts_rule_fk_setnull.sql` (CASCADE → SET NULL) preserves alert history when a rule is
  deleted. See **§13**.
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

---

## 13. Configurable thresholds, firmware unification & alert lifecycle (2026-06-14)

> Built after the notification core (§1–§12). Three connected features that turn the **hardcoded /
> mock** alerting into a real, admin-configurable, full-lifecycle system. This section is the
> authoritative map for them.

### 13.1 Configurable alert thresholds (`alert_rules`)

**What changed:** thresholds used to be hardcoded — server CPU/Mem/Disk at 80/90 in
`agentService.checkThresholds`, and environment thresholds inside the ESP32 firmware. They are now
rows in the **`alert_rules`** table, editable by admins from a new **Alert Rules** page.

**Model (locked decisions):**
- **Scope = global default + per-server override.** `device_id = NULL` → a global rule that applies to
  every server / the room; a real `device_id` → an override for that one server. The resolver picks
  the device-specific rule if one exists, else the global one.
- **Fallback = rules-only.** A metric with no active rule raises **nothing**. So the migration
  **seeds the global defaults** (matching the old behavior) — without them the system would go silent.
- **Permissions:** managing rules is **admin-only**.
- **Metrics:** servers `cpu`/`mem`/`disk`; environment `temperature`/`gas`/`humidity` (room-level,
  `device_id = NULL`). These exact `metric_name` strings are the contract between the rules and the
  trigger sites.

**Migration — `migrations/2026-06-14_alert_rules.sql`:**
- `ALTER TABLE alert_rules MODIFY device_id INT NULL` (enables global rules).
- Idempotent **seed** of 12 global rules: cpu/mem/disk `≥80 warning`/`≥90 critical`; temperature
  `≥29`/`≥32`; gas `≥150`/`≥300`; humidity `≥85`/`≥95`.

**Backend:**
- **`services/alertRulesService.js`** (new) — in-memory cache (reloaded on startup + every mutation);
  `getEffectiveRules(deviceId, metric)` (override-else-global); `worstBreach` + `nextBand`
  (hysteresis-aware: a band only clears once the value falls 5% past the threshold, generalizing the
  old fixed 70–80 zone across %, °C, ppm); `getRoomThresholds()` (for the firmware push, §13.2); and
  admin CRUD with validation.
- **`routes/alertRules.js`** (new) — `GET/POST/PUT/DELETE /api/alert-rules`, `requireRole("admin")`.
  After every mutation it re-pushes `envConfig` to the ESP32 (§13.2).
- **Refactors:** `checkThresholds` now evaluates rules (dropped hardcoded `bandFor`) and stamps
  `alert_rule_id`; `sensorHandler` raises **per-metric** environment alerts (types `temperature`/
  `gas`/`humidity` instead of one `environment` type — this also fixed a cooldown collision where one
  metric's alert suppressed another's). `notificationService.raiseAlert` accepts + stores
  `alert_rule_id`.

**Frontend:** **`pages/AlertRules.tsx`** (admin, sidebar nav) — table of rules with global-vs-server
scope, add/edit/delete, active toggle; `api.ts` gains `getAlertRules`/`createAlertRule`/
`updateAlertRule`/`deleteAlertRule`. `routeFor` maps the new env types to `/environment`.

### 13.2 Firmware threshold unification (`envConfig`)

**Goal:** the ESP32's **RGB LED, buzzer and reported status** should alarm at the *same* thresholds
the dashboard alerts on — without reflashing when an admin retunes them.

**Mechanism:** the 7 threshold `#define`s in `iot/esp32/env_monitor_v2.ino` became **mutable
globals** (same names, so the status calculators are untouched). A new **`envConfig`** socket event
(server → ESP32) carries the room-level thresholds (`{tempWarn,tempCrit,gasWarn,gasCrit,humWarn,
humCrit}`, null fields omitted). It's emitted on **device connect** (`connectionHandler`) and after
**any rule change** (`routes/alertRules.js` → `io.to("devices")`). The LED + buzzer derive entirely
from the status strings (`calcTempStatus`/`calcSmokeStatus`/`calcEnvironmentStatus`), so feeding
those functions runtime values makes everything follow automatically.

**Notes / boundaries:**
- `envConfig` sets `TEMP_DANGER = TEMP_CRITICAL`, collapsing the firmware's 3 temp bands to
  warning/critical to match the dashboard's two severities.
- **Not** rule-driven (by design): the IR/AC comfort zones (`getIRZone`, 22/24/27/29 °C — these are
  cooling setpoints, not alarms) and `TEMP_COLD` (the blue "too cold" LED).
- A metric with no rule keeps the device's compiled default (dashboard silent, device retains its
  last threshold).
- ⚠️ The firmware was **not compiled** in this environment — it must be **flashed + tested on
  hardware**. Until then the backend pushes `envConfig` but old firmware ignores it.

### 13.3 Alert lifecycle — acknowledge / resolve

**Concept:** the **shared incident state** (`alerts.status`: `active → acknowledged → resolved`) —
one row per alert, the same for everyone — as opposed to the per-user bell (`alert_notifications.
is_read`, "have *I* seen it"). Acknowledge = manual ("I'm on it"); resolve = **manual or auto**.

**Backend:**
- **`services/alertsService.js`** (new) — `list({status?,limit})`, `acknowledge(id,userId)`,
  `resolve(id,userId)` (stamps the resolver as handler if never acknowledged), and
  **`autoResolveMetric(deviceId,type)`** (closes open alerts when a metric returns to normal — called
  from `checkThresholds` + `sensorHandler` on the band-drop-to-normal path). Broadcasts
  **`alertUpdated`**; `init(io)` in `server.js`.
- **`routes/alerts.js`** — **replaced the old `data/db.js` mock** with the real API:
  `GET /api/alerts` (`?status=` filter), `POST /api/alerts/:id/acknowledge`,
  `POST /api/alerts/:id/resolve`, gated **admin + it_staff** (handling incidents is operational).
- **FK fix — `migrations/2026-06-14_alerts_rule_fk_setnull.sql`:** now that `alerts.alert_rule_id` is
  populated, the original `ON DELETE CASCADE` meant deleting a rule would cascade-delete its alert
  history (and bell rows). Changed to **`ON DELETE SET NULL`** so history survives. *(Applied +
  verified.)*

**Frontend:** **`pages/Alerts.tsx`** (admin + it_staff, sidebar nav) — filter tabs
(all/active/acknowledged/resolved), severity + status badges, a single **"by {handler} · when"** line
(see §13.8 on attribution), Acknowledge/Resolve buttons, **live** via `alertUpdated` + `notification`.
`api.ts` gains `acknowledgeAlert`/`resolveAlert` and a real `getAlerts(status)`; dead `getAuditLog` removed.

### 13.4 New socket events
| Event | Direction | When |
|---|---|---|
| `envConfig` | server → ESP32 | on device connect + after any Alert Rules change → `{tempWarn,tempCrit,gasWarn,gasCrit,humWarn,humCrit}` (nulls omitted) |
| `alertUpdated` | server → browsers | on acknowledge / resolve / auto-resolve → the Alerts page refreshes live |

### 13.5 Migrations (run once in phpMyAdmin)
- `2026-06-14_alert_rules.sql` — `device_id` nullable + seed 12 global rules. *(Already applied.)*
- `2026-06-14_alerts_rule_fk_setnull.sql` — `alerts.alert_rule_id` FK → `ON DELETE SET NULL`.
  *(Applied + verified this session.)*
- `2026-06-14_alerts_resolved_by.sql` — adds `alerts.resolved_by`. *(Applied, but the feature was
  reverted — see §13.8 — so the column is DORMANT/unused; kept, not dropped.)*

### 13.6 How to test (no hardware needed for the dashboard side)
- **Alert Rules CRUD:** login as admin → **Alert Rules** → see the 12 seeded rules → add/edit/toggle/
  delete.
- **Firing + lifecycle:** with the go-agent running, set CPU `warning` to `>= 1` → an alert fires
  (bell + toast) and appears on the **Alerts** page (Active) → Acknowledge → Resolve. Raise the
  threshold back → the alert **auto-resolves** when CPU is "below" it. (Resolved drops off the Active
  tab; see it under All/Resolved.)
- **Firmware:** flash `env_monitor_v2.ino`, change a temperature rule, watch the device's LED/buzzer
  bands shift (serial logs `[ENV] Thresholds: …`).

### 13.7 Status
Backend `node --check`, frontend `tsc --noEmit`, and `vite build` clean. Live end-to-end run and the
firmware flash/hardware test are still pending. See **SESSION_NOTES.md → SESSION 11**.

### 13.8 Refinements (post-build) + one reverted experiment
- **Sidebar "Alerts" badge.** A small red count on the Alerts nav item shows alerts still needing
  attention (status ≠ resolved). Backend: `alertsService.openCount()` + `GET /api/alerts/count`.
  Frontend: `NotificationContext.openAlertCount` (loaded on login; **+1** on a `notification`;
  **refetched** on every `alertUpdated` so resolve/auto-resolve tick it down; re-synced on reconnect),
  rendered by `Sidebar`. It updates live without a refresh.
- **Cooldown resets on resolve.** `notificationService.raiseAlert`'s de-dup query gained
  `AND status <> 'resolved'`, so only **open** alerts suppress duplicates. Once an alert is resolved
  (manually or auto), the same condition recurring raises a **fresh** alert immediately instead of
  being swallowed for `NOTIFY_COOLDOWN_MIN`. This is how real incident tools de-dup (per open
  incident, not a blind clock). Restart-proofing for *open* alerts is preserved; flapping is still
  damped by the band hysteresis + escalation-only raising.
- **`resolved_by` — built, then reverted (kept simple).** We briefly added separate resolve
  attribution (a `resolved_by` column → "resolved by Y" / "auto-resolved", shown apart from
  "acknowledged by X"). By preference we **reverted to the simpler single-name model**: `resolve()`
  folds the handler into `acknowledged_by` (COALESCE) and the UI shows one **"by {acknowledger}"**
  line. So if user 1 acknowledges and user 2 resolves, it displays "by user 1". This is a valid
  real-world simplification (single "handled by" attribution). ⚠️ The `resolved_by` **column +
  migration remain applied but DORMANT** (NULL, untouched by code) — left in place, not dropped; it's
  there if separate resolve attribution is ever wanted again.

---

## 14. Study guide — Alert Rules UX, accountability & the bell's ack/resolve (2026-06-14, cont.)

> 📖 **Written to study from.** Follows §13. Three features were added on the alerting surface this
> session: (A) the **Alert Rules page** got a Grafana redesign + two safety guards, (B) **rule
> accountability** (who last edited a rule), and (C) the **bell now shows acknowledge/resolve**.
> Read §14.0 first — it's the mental model the rest hangs on.
>
> (A parallel "last-admin" hardening of **User Management** happened the same day. It's *not* a
> notification feature, so it lives in `SESSION_NOTES.md → SESSION 12`, not here.)

### 14.0 The 30-second mental model (read this first)
An alert has **two independent states**. Keep them apart and everything below is easy:

| # | State | Lives in | Question it answers | Scope |
|---|---|---|---|---|
| 1 | **Read state** | `alert_notifications.is_read` | "Have **I** seen this in my bell?" | per user (one row each) |
| 2 | **Lifecycle** | `alerts.status` (`active→acknowledged→resolved`) | "Has **the team** dealt with this incident?" | shared (one row total) |

State 1 is the bell feed (built in §1–§12). State 2 is the Alerts page (built in §13). **This session
makes the bell (state 1) also *display* the lifecycle (state 2)**, and gives the **Alert Rules** that
produce alerts a better UI + an editor's name on each rule.

### 14.A Alert Rules page — the UI redesign (`frontend/src/pages/AlertRules.tsx`)
All in one file (plus the existing `api.ts` CRUD methods). What to look at:
- **Data in:** `load()` calls `api.getAlertRules()` + `api.getServers()`.
- **Shape:** rules are filtered (`filtered` useMemo: search + metric + severity + scope) then
  **grouped by scope** (`groups` useMemo: a `Map` keyed `"global"` or `"dev-<id>"`). Global first,
  then per server. Each group is a collapsible panel.
- **Each row:** metric icon (`MetricIcon`) + human sentence ("when value ≥ 90%") + severity pill +
  active toggle + edit/delete. The add/edit form is a **modal** with a **live preview**
  (`RulePreview`) and a severity segmented picker.
- **Stat panels** (`StatCard`) up top come from the `stats` useMemo (counts).

> Mostly presentational — no new backend. The two pieces of *logic* worth understanding are the
> guards (§14.B).

### 14.B The two guards on the Alert Rules page (the logic to understand)
Both exist because alerting is **rules-only** (§13.1): *no matching rule → no alert*. So the UI must
stop you from silently blinding the system.

**1) Last-global-rule coverage guard.** A global rule (`device_id = NULL`) is the default for every
server. If you delete or repurpose the **last** global rule for a metric, every server *without its
own override* goes silent for that metric. The guard warns first.

```ts
// counts only ACTIVE global rules for a metric (paused ones give no coverage)
const activeGlobalCount = (metric, excludeId?) =>
  rules.filter(r => r.deviceId == null && r.isActive && r.metricName === metric && r.id !== excludeId).length;

// EDIT: would saving this form stop the edited global rule from covering its metric,
//       with no other global left? → return a warning string (else null)
const coverageLossMessage = () => {
  if (!editingRule || editingRule.deviceId != null) return null;     // only a global rule can lose global coverage
  const metric = editingRule.metricName;
  if (activeGlobalCount(metric) === 0) return null;                  // nothing was covered anyway
  const stillCovers = form.deviceId === "" && form.isActive && form.metricName === metric;
  const after = activeGlobalCount(metric, editingRule.id) + (stillCovers ? 1 : 0);
  return after > 0 ? null : "This is the last global … rule. By …, every OTHER server will have no … alerts.";
};
```
When that returns a string, the modal shows an amber banner and the Save button becomes **"Save
anyway"**. The delete path uses the sibling `deleteLossMessage(rule)` → inline warning +
**"Delete anyway"**.

**2) Server scope hides environment metrics.** temperature / gas / humidity are *room-level* (the
ESP32 isn't a `devices` row — see §13.1), so they can only be global. The metric dropdown filters
them out for a per-server scope, and switching Global→server auto-resets an env metric to `cpu`:
```ts
const isServerScope  = form.deviceId !== "";
const metricOptions  = isServerScope ? METRICS.filter(m => !m.env) : METRICS;  // m.env === true for temp/gas/humidity
```

### 14.C Accountability — who last edited a rule
**Goal:** every rule row shows "edited by {name} · {when}" (or "system default" for the seeded ones).

**Flow (one edit):**
```
admin saves a rule on the Alert Rules page
  → PUT /api/alert-rules/:id   (routes/alertRules.js passes req.user.id)
    → alertRulesService.update(id, data, userId)
        UPDATE alert_rules SET …, updated_by = <userId>, updated_at = NOW()
    → list()/getById() re-read with  LEFT JOIN users u ON u.user_id = r.updated_by
        → toClient() returns updatedByName + updatedAt
  → page reloads the rules → row shows "edited by {name} · {when}"
```

**Files:**
| File | Change |
|---|---|
| `migrations/2026-06-14_alert_rules_updated_by.sql` | **NEW.** adds `alert_rules.updated_by` (FK → `users`, `ON DELETE SET NULL`) + index |
| `backend/services/alertRulesService.js` | `create`/`update` take `userId`, write `updated_by` (+ `update` bumps `updated_at = NOW()`); `list`/`getById` join `users`; `toClient` returns `updatedBy` + `updatedByName` |
| `backend/routes/alertRules.js` | pass `req.user.id` into `create`/`update` |
| `frontend/src/pages/AlertRules.tsx` | `Rule` gains `updatedByName`/`updatedAt`; row renders the line via `fmtWhen()` |

> Note: the **activate/pause toggle** also goes through `update`, so toggling a rule is recorded too.
> `ON DELETE SET NULL` means deleting a user never deletes their rules — the name just falls back to
> "system default".

### 14.D The bell shows acknowledge / resolve (the main notification change)
This is the part most relevant to studying the notification feature. **No migration** — `alerts`
already has `status`, `acknowledged_by`, `acknowledged_at`, `resolved_at` (§13).

**Flow (follow one acknowledge end-to-end):**
```
Admin clicks "Acknowledge" on the Alerts page
  → POST /api/alerts/:id/acknowledge
    → alertsService.acknowledge(id, userId)
        UPDATE alerts SET status='acknowledged', acknowledged_by=?, acknowledged_at=NOW()
        notificationService.markReadByAlert(userId, id)        // the actor's OWN bell row → read
        io.emit("alertUpdated", <full alert incl. acknowledgedByName>)   // broadcast to ALL browsers
  ── every browser ─────────────────────────────────────────────────────
  socket "alertUpdated" → NotificationContext.onAlertUpdated(alert)
        → patch items where item.alertId === alert.id   (status + acknowledgedByName + …)
        → refreshAlertCount()                            (sidebar badge)
  NotificationPanel re-renders that row → "● Acknowledged by {name}"
  ── on reload ─────────────────────────────────────────────────────────
  GET /api/notifications → listForUser() now SELECTs the lifecycle columns → same line shows (persisted)
```

**The key idea — two delivery paths, one shape:**
- **Live:** the `alertUpdated` socket patch (no refetch needed).
- **Reload:** the feed query (`listForUser`) now selects the lifecycle columns.
- They must agree, so `notificationService.toClient()` is the **single** payload shape used by BOTH
  the socket push and the REST feed (same principle as §12.2).

**Files:**
| File | Change | Why |
|---|---|---|
| `backend/services/notificationService.js` | `toClient` returns `status`/`acknowledgedByName`/`acknowledgedAt`/`resolvedAt`; both queries (live push in `raiseAlert` + `listForUser`) select those columns + `LEFT JOIN users` for the name | bell payload now carries the lifecycle, live and on reload |
| `frontend/src/context/NotificationContext.tsx` | `AppNotification` gains the fields; `onAlertUpdated(alert)` patches matching items by `alertId` | live update without a refetch |
| `frontend/src/components/notifications/NotificationPanel.tsx` | render a status line per item | the actual "Acknowledged/Resolved by X" UI |

**Key code — the live patch (`NotificationContext`):**
```ts
const onAlertUpdated = (a) => {
  if (a && typeof a.id === "number") {
    setItems(prev => prev.map(n =>
      n.alertId === a.id                                   // a.id is the alert_id
        ? { ...n, status: a.status ?? n.status ?? "active",
                  acknowledgedByName: a.acknowledgedByName ?? n.acknowledgedByName ?? null,
                  acknowledgedAt:     a.acknowledgedAt     ?? n.acknowledgedAt     ?? null,
                  resolvedAt:         a.resolvedAt         ?? n.resolvedAt         ?? null }
        : n));
  }
  refreshAlertCount();
};
```
> ⚠️ Easy to confuse: `notification.id` = the per-user `alert_notifications.id` (what you mark
> read), but `notification.alertId` = the shared `alerts.id`. The patch matches on **`alertId`**
> because `alertUpdated` is about the shared alert.

**Key code — the panel line (`NotificationPanel`):**
```tsx
{n.status && n.status !== "active" && (
  <span style={{ color: n.status === "resolved" ? "#73BF69" : "var(--gf-accent)" }}>
    {n.status === "resolved" ? "✓ Resolved" : "● Acknowledged"}
    {n.acknowledgedByName ? ` by ${n.acknowledgedByName}` : ""}
  </span>
)}
```
Resolve folds the resolver into `acknowledged_by` (§13.8), so "Resolved by {name}" shows the handler.
An **auto-resolve** (metric recovered, no human) has no name → just "Resolved".

### 14.E Migrations (run once in phpMyAdmin)
- `2026-06-14_alert_rules_updated_by.sql` — **NEW, required.** Run it **before restarting the
  backend** — the Alert Rules list query now joins `updated_by`, so the page errors without it.
- The bell ack/resolve display needs **no** migration (`alerts` already has the columns).

### 14.F How to study / test each piece
- **Alert Rules UI:** login as admin → Alert Rules. Add/edit/toggle/delete; try the search + filters;
  collapse a group.
- **Coverage guard:** edit a global rule (e.g. CPU warning) and switch its Scope to a server → amber
  warning + "Save anyway". Cancel to keep coverage.
- **Scope filter:** in the modal, set Scope = a server → temperature/gas/humidity disappear from Metric.
- **Accountability:** edit any rule → its row now reads "edited by {your name} · {time}".
- **Bell ack/resolve:** open the bell, then on the Alerts page Acknowledge an alert → its bell row
  gains "● Acknowledged by you" **live**; Resolve → "✓ Resolved by you". Reload → the line persists
  (it now comes from `GET /api/notifications`).

---

## 15. Re-arm on resolve, bell filter, personal prefs & configurable AC cooling (2026-06-15)

> 📖 **Study section.** Four changes on the alerting/notification surface. **§15.1 is the most
> important** — it changes *when* an alert re-fires. §15.4 reuses the exact "push config to the
> ESP32" pattern as the Alert Rules `envConfig` (§13.2): learn one, you know both.

### 15.1 Re-arm on resolve — a resolved-but-still-true alert re-alerts
**The bug it fixes:** you Resolve a CPU / temperature alert, but the metric is *still* over the
threshold. It used to stay silent forever. Now it re-alerts on the next reading.

**Two gates — only one was the problem.** A new alert must pass BOTH:
1. **Escalation guard** (in the trigger): `raiseAlert` is called only when the band goes *up* —
   `if (SEV_RANK[band] <= SEV_RANK[prev]) continue;`. A metric sitting at critical never re-fires.
2. **Cooldown** (`notificationService.raiseAlert`): the `status <> 'resolved'` de-dup query.

Resolving already reset gate #2 — but gate #1's **in-memory band** ("we're already critical") was
never reset, so `raiseAlert` was never even reached. **That in-memory band was the real blocker**,
not the cooldown.

**The fix — centralize the band so the lifecycle can reset it:**

| File | Role |
|---|---|
| `services/alertBandState.js` (**new**) | shared in-memory band per `(deviceId, metric)`: `getBand`/`setBand`/`resetBand`/`resetDevice`. `deviceId = null` = room-level (environment) |
| `services/agentService.js` | `checkThresholds` reads/writes via `alertBandState` (its private `alertState` Map is gone); reject / offline-sweep / remove call `resetDevice` |
| `handlers/sensorHandler.js` | env alerting reads/writes via `alertBandState` (its `envBand` object is gone) |
| `services/alertsService.js` | `resolve()` + `autoResolveMetric()` call `resetBand(deviceId, type)` → **re-arm** |

**Result:** Resolve a still-breaching metric → next reading re-escalates → **one** fresh alert
(then the cooldown re-engages, so no flood). **Acknowledge does NOT re-arm** — it's the "I'm on it,
stop nagging" tool. This is the PagerDuty/Opsgenie model (resolving a still-firing source re-opens).

**Why it's correct:** the system must not silently hide an ongoing critical condition (server room
still hot) just because someone cleared the badge.

> ⚠️ Mental model: **two states per alert** still hold (§14.0) — `alert_notifications.is_read`
> (per-user bell) vs `alerts.status` (shared lifecycle). The band tracker is a **third, separate**
> in-memory thing: "what severity did the trigger last see?" Resolving (a lifecycle action) now
> also resets that tracker so detection re-arms.

### 15.2 Bell — All / Unread filter
`components/notifications/NotificationPanel.tsx` gained a 2-tab filter (`All (N)` / `Unread (N)`)
over the already-loaded feed: `visibleItems = filter === "unread" ? items.filter(n => !n.isRead) :
items`. Pure client-side (instant, no refetch). "Mark all read" / "Clear all" still act on the
whole feed regardless of the active tab.

### 15.3 Notification preferences moved to a per-user Settings page
The `NotificationPreferences` card (email on/off + min severity; per-user `notification_prefs`) now
lives on a rebuilt **personal** Settings page reachable by **both roles** — it_staff previously
couldn't open Settings (`"settings"` missing from their `roleConfig.pages`) so they had no prefs at
all. The backend `/api/notifications/prefs` was always scoped to `req.user.id`; this was a UI-access
fix. (Full detail: `SESSION_NOTES.md → SESSION 13 §2`.)

### 15.4 Configurable auto-cooling (AC IR) thresholds — the `acConfig` event
Parallels the Alert Rules → `envConfig` firmware push (§13.2), but for the **AC** instead of alarms.

**The design decision (important).** The AC IR comfort zones are kept **separate** from the Alert
Rules temperature thresholds because they answer different questions:

| | Alert Rules (temperature) | AC IR zones |
|---|---|---|
| Purpose | when to **alarm** | how hard to **cool** |
| Levels | 2 (warning, critical) | 5 (28/26/24/22/20 °C set temps, cold → hot) |

Cooling must ramp *before* the alarm thresholds (to **prevent** ever reaching them), so its
thresholds are independent and typically sit at/below the alert thresholds. Only the **boundaries**
(when IR fires) are configurable — the per-zone target temps are fixed captured raw IR codes.

**Flow (one save):**
```
admin edits Auto-Cooling Thresholds (AirConditioner page)
  → PUT /api/aircon/ir-config        (admin; airconService.saveIRConfig validates ascending + 10–40°C)
    → aircon_ir_config (single global row, id = 1)
    → io.to("devices").emit("acConfig", { coldBelow, normalMax, acceptableMax, nearCritMax })
  ── ESP32 ────────────────────────────────────────────────
  "acConfig" → getIRZone's mutable globals update → IR fires at the new boundaries (no reflash)
```
Also pushed on device connect (`connectionHandler`), exactly like `envConfig`.

**Files:**
| File | Change |
|---|---|
| `migrations/2026-06-15_aircon_ir_config.sql` | **new** single-row config table, seeded with the firmware defaults (22/24/27/29) |
| `backend/services/airconService.js` | `getIRConfig` / `saveIRConfig` (validation) / `getDeviceIRConfig` (firmware payload) |
| `backend/routes/aircon.js` | `GET /api/aircon/ir-config` (both roles), `PUT` (admin) + `pushACConfig` |
| `backend/sockets/connectionHandler.js` | emit `acConfig` on ESP32 connect |
| `iot/esp32/env_monitor_v2.ino` | `getIRZone` boundaries → mutable globals + `acConfig` handler |
| `frontend/src/api/api.ts` | `getAirconIRConfig` / `saveAirconIRConfig` |
| `frontend/src/pages/AirConditioner.tsx` | **Auto-Cooling Thresholds** panel (admin edit, both roles view) |

**To activate:** run the migration **and re-flash** `env_monitor_v2.ino` (the firmware can't be
compiled here; until flashed the device keeps its compiled-in defaults and ignores `acConfig`).

**How to test:** AirConditioner page (admin) → Auto-Cooling Thresholds → change a boundary → Save →
device serial logs `[AC] IR zones: …` and IR fires at the new points. it_staff sees the panel
read-only.
