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

> 🧭 **Status: PLANNED — not started.** This doc is the design. The schema already ships the
> tables (`alerts`, `alert_notifications`, `alert_rules`) and the bell button already exists in
> `Header.tsx`; nothing wires them together yet.

> 📖 **New to this?** Read §1 (concept) and §2 (the one decision: what *is* a notification here).
> Then §3 (data model — we reuse existing tables) and §4 (how an event becomes a notification).

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
| `frontend/src/context/NotificationContext.tsx` | fetch feed on mount; subscribe to socket `notification`; hold `items[]` + `unreadCount`; expose `markRead`/`markAllRead`; fire toast + browser popup | new |
| `frontend/src/components/notifications/NotificationPanel.tsx` | the bell **dropdown** — list, unread highlight, "mark all read", click → mark read + navigate to source page | new |
| `frontend/src/components/notifications/Toast.tsx` (+ host) | corner toast on each live `notification` (auto-dismiss; severity color) | new |
| `frontend/src/components/layout/Header.tsx` | make the bell **clickable** → toggle panel; badge count from context (drop the static `alertCount`) | edit |
| `frontend/src/App.tsx` | wrap app in `NotificationProvider`; mount `<ToastHost/>`; remove hardcoded `alertCount={2}` | edit |
| `frontend/src/api/api.ts` | `getNotifications()`, `markNotificationsRead(ids)`, `markAllNotificationsRead()` (all `ApiResult<T>`) | edit |

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
| `notification` | Server → **one user's** browsers (`io.to("user:"+id)`) | `{ id, alert_id, device_id, type, title, message, severity, created_at, is_read:false }` |
| `notificationRead` *(optional)* | Server → same user's other tabs | `{ ids:[…] }` — keeps multiple open tabs' unread counts in sync |

(Existing `deviceLog` / `serverStatus` stay as-is; `notification` is the new persisted, per-user one.)

---

## 9. Library & config (planned)

- **Backend dependency:** [`resend`](https://www.npmjs.com/package/resend) — official Node SDK.
- **Domain:** Resend requires a **verified sending domain** (SPF/DKIM) for production. For dev,
  Resend's `onboarding@resend.dev` sender works to a single test address.
- **`.env` (backend):**

```
RESEND_API_KEY=            # Resend API key; blank → email channel disabled (bell+toast still work)
RESEND_FROM=               # e.g. "CSPC ICTU Monitoring <alerts@your-verified-domain>"
NOTIFY_EMAIL_MIN_SEVERITY= # critical | warning | info — min severity that triggers email; blank = critical
NOTIFY_EMAIL_TO=           # optional override (testing): force all alert emails to this address
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
