# Alerts & Notifications — CSPC-ICTU Monitoring

Persisted alerts delivered on **three channels**: the **bell feed** (per-user, with unread state),
a **live popup** (in-app toast + optional OS notification), and **email** (SMTP).

> **Status: built and working.** Live end-to-end verified except the ESP32 firmware, which needs
> flashing. The only outstanding deployment item is the ICTU mailbox — see §9.
>
> Design history (how each decision was reached) lives in `SESSION_NOTES.md` Sessions 11–13.
> This file is the working reference.

---

## 1. The data model — the thing to understand first

An alert has **two independent states**. Keep them apart and everything else follows:

| | `alerts` | `alert_notifications` |
|---|---|---|
| What | the **event** — happened once | the **delivery** — one row per recipient |
| Holds | device, type, title, message, severity, `status`, `acknowledged_by` | `user_id`, `is_read`, `sent_at`, `emailed` |
| Question | "has **the team** dealt with this?" | "have **I** seen this?" |
| Scope | shared, one row | per user, N rows |
| Drives | Alerts page + email content | bell feed + unread badge |

There's also a **third, in-memory** state: `alertBandState` — "what severity did the trigger last
see for this device+metric?" It isn't persisted and resets on restart. It exists to stop a metric
sitting at critical from re-alerting every poll.

**Supporting tables:** `notification_prefs` (per-user email on/off + min severity; missing row =
defaults) and `alert_rules` (configurable thresholds).

---

## 2. The flow

Everything funnels through one function — `notificationService.raiseAlert()`:

```
trigger fires (threshold crossed / device offline / room hot)
   │
   ▼
raiseAlert({ deviceId, type, title, message, severity, metricValue, alertRuleId })
   1. cooldown check — skip if an identical device+type+severity alert is still OPEN
      and newer than NOTIFY_COOLDOWN_MIN  (DB query, so it survives restarts)
   2. INSERT alerts                                          ── the event
   3. SELECT active users + their notification_prefs
   4. INSERT alert_notifications, one per user               ── the deliveries
   5. io.to("user:<id>").emit("notification", …)             ── bell + toast + OS popup
   6. severity-gated email per user, concurrent               ── SMTP
   ▼
persisted + delivered
```

Two invariants worth remembering:

- **Best-effort.** The whole function is wrapped in try/catch. Monitoring must never break because
  a notification failed — which also means a broken email channel is **silent**. That's why
  `npm run mail:check` exists.
- **One payload shape.** `toClient()` builds both the socket push and the REST feed, so live
  updates and post-reload state can never disagree.

---

## 3. Triggers

| Source | Where | Rule-driven? |
|---|---|---|
| Server CPU / Mem / Disk | `agentService.checkThresholds` (disk = **worst volume**, not just root) | ✅ `alert_rules` |
| Environment temp / gas / humidity | `handlers/sensorHandler.js` | ✅ `alert_rules` (room-level, `device_id` NULL) |
| Router / UPS / MikroTik metrics | `services/deviceAlerts.js` — `checkRouter` / `checkUps`, called by the SNMP **and** MikroTik pollers | ✅ `alert_rules` |
| Server offline | offline sweep in `src/server.js` | ❌ hardcoded |
| Interface down · UPS on battery · device unreachable | `deviceAlerts.js` (boolean events, `checkReachability`) | ❌ hardcoded — but interface-down is **gated** by `linkAlertPolicy.js`: only a port that is enabled in RouterOS, not muted by an admin, and has carried a link at least once can raise one. Empty sockets and deliberately-disabled ports stay silent. |

**Alerting is rules-only: no matching rule = no alert.** The schema seeds global defaults; an
empty `alert_rules` table means total silence. Scope is a global default (`device_id = NULL`) with
an optional per-server override.

`metric_name` values: `cpu`/`mem`/`disk` · `temperature`/`gas`/`humidity` ·
`router_cpu`/`router_mem`/`router_clients`/`link_util`/`ups_charge`/`ups_runtime`/`ups_load`.
The last two UPS ones are **lower-is-worse**, so they use `<=`.

---

## 4. Files

**Backend**

| File | Role |
|---|---|
| `services/notificationService.js` | `raiseAlert` + the bell feed (`listForUser`, `unreadCount`, `markRead`, `dismiss`, prefs, `purgeOld`) |
| `services/alertsService.js` | shared lifecycle: acknowledge / resolve / auto-resolve / `openCount`; broadcasts `alertUpdated` |
| `services/alertRulesService.js` | `alert_rules` cache, `getEffectiveRules`, `nextBand` hysteresis, admin CRUD |
| `services/alertBandState.js` | in-memory per-(device, metric) severity band **+ recovery-confirmation streaks** |
| `services/deviceAlerts.js` | router/UPS/MikroTik thresholds + boolean events; shared by the SNMP and MikroTik pollers |
| `services/emailService.js` | SMTP send for **alerts and reports**, `verify()`, `close()` — §8 |
| `routes/notifications.js` | per-user bell feed + prefs |
| `routes/alerts.js` | shared lifecycle (admin + it_staff) |
| `routes/alertRules.js` | threshold CRUD (admin only) |
| `scripts/mailCheck.js` | `npm run mail:check` |

**Frontend**

| File | Role |
|---|---|
| `context/NotificationContext.tsx` | the hub — feed, unread count, socket subscription, `subscribe()` for toasts |
| `components/notifications/NotificationPanel.tsx` | bell dropdown (All/Unread tabs, mark read, dismiss) |
| `components/notifications/ToastHost.tsx` | corner toast stack |
| `components/notifications/notificationUtils.ts` | `SEVERITY_COLOR`, `routeFor()`, `relativeTime()` — **add routing for new alert types here** |
| `components/notifications/NotificationPreferences.tsx` | Settings card (email on/off, min severity) |
| `pages/Alerts.tsx` · `pages/AlertRules.tsx` | lifecycle UI · threshold UI |
| `utils/browserNotify.ts` · `utils/notificationSound.ts` | OS popup · chime |

---

## 5. Socket events

| Event | Direction | When |
|---|---|---|
| `notification` | → one user's room (`user:<id>`) | new alert raised |
| `alertUpdated` | → all browsers | acknowledge / resolve / auto-resolve |
| `envConfig` | → ESP32 | on connect + after any Alert Rules change (LED/buzzer track the dashboard) |
| `acConfig` | → ESP32 | on connect + after an Auto-Cooling Thresholds change |

> ⚠️ `notification.id` is the **`alert_notifications.id`** (what you mark read).
> `notification.alertId` is the shared **`alerts.id`**. The `alertUpdated` patch matches on
> `alertId`.

---

## 6. Behaviours that surprise people

**Cooldown is scoped to open alerts.** The de-dup query includes `status <> 'resolved'`, so a
resolved alert stops suppressing — a genuine recurrence re-alerts immediately rather than waiting
out `NOTIFY_COOLDOWN_MIN`. This is how real incident tools de-dup: per open incident, not a blind
clock.

**Resolving re-arms detection; acknowledging does not.** A new alert must pass two gates: the
trigger's escalation guard (band must go *up*) and the cooldown. Resolving clears **both** —
including the in-memory band — so a still-breaching metric re-alerts on the next reading.
Acknowledge is the "I'm on it, stop nagging" tool and deliberately leaves the band alone.

**Recovery is confirmed, escalation is instant.** An alert auto-resolves only after
`ALERT_RECOVERY_SAMPLES` (default 3) *consecutive* normal readings. ⚠️ That counts **samples, not
seconds** — wall-clock is the count × that source's interval, so ~30s for a default Go agent
(`-interval 10`, per-agent: an `-interval 60` server takes 3 **minutes**) and ~9s for the ESP32
(`LOG_INTERVAL 3000`). The streak only advances on normal readings; a breaching one resets it to
zero. A single normal sample can be a dip in an oscillating metric, and because a
**resolved** alert stops suppressing (above), one premature auto-resolve would let the next swing
raise a fresh alert — an alert/email storm for one unstable device. Holding the band keeps it to
one alert. Escalation is not delayed, so a smoke spike still alerts immediately; only the
all-clear waits, which is the fail-safe direction.

**Resolve attribution folds into `acknowledged_by`.** If user 1 acknowledges and user 2 resolves,
the UI shows "by user 1". A `resolved_by` column exists in the schema but is **dormant and unused**.

**Environment metrics are room-level.** temperature / gas / humidity have no `devices` row, so
their alerts carry `device_id = NULL` and can only be global rules.

---

## 7. Migrations (all applied)

```
2026-06-13_notifications.sql          defaults, `emailed` column, notification_prefs
2026-06-13_alerts_nullable_device.sql device_id NULL → room-level environment alerts
2026-06-14_alert_rules.sql            device_id nullable + seeds 12 global rules
2026-06-14_alerts_rule_fk_setnull.sql deleting a rule no longer cascades away its alert history
2026-06-14_alert_rules_updated_by.sql who last edited a rule
2026-06-14_alerts_resolved_by.sql     applied but DORMANT (see §6)
2026-06-15_aircon_ir_config.sql       AC auto-cooling boundaries
```

---

## 8. Email — transport & config

Alert **and report** mail goes out over **SMTP via nodemailer** (`services/emailService.js` —
`sendAlertEmail` and `sendReportEmail`, the latter attaching the stored PDF). Resend was removed
on 2026-08-06.

**Why SMTP.** Email has no built-in proof of sender, so receiving servers check **SPF/DKIM** DNS
records on the sending domain to decide whether a sender may send as `@cspc.edu.ph`. A third-party
sending API is an outside service acting on your domain's behalf, so it must be authorized — someone
with DNS access has to add that provider's records to the live campus domain, and until then it only
delivers to the account that owns it. Sending through a real Workspace mailbox sidesteps this
entirely: Google already publishes SPF/DKIM for `cspc.edu.ph`, so the mail is authorized exactly
like a staff member's. **No DNS changes, and it delivers to anyone.**

**`.env`**

```
SMTP_HOST=                 # blank = smtp.gmail.com
SMTP_PORT=                 # 587 STARTTLS (default) | 465 implicit TLS
SMTP_USER=                 # FULL mailbox address. BLANK = email channel off
SMTP_PASS=                 # 16-char App Password, NOT the account password. Spaces stripped for you
MAIL_FROM=                 # "Name <addr@domain>"; blank = SMTP_USER. Sets the display name
NOTIFY_EMAIL_MIN_SEVERITY= # info | warning | critical; blank = critical
NOTIFY_EMAIL_TO=           # ⚠ testing override: forces ALL mail to ONE address. Blank in production
NOTIFY_COOLDOWN_MIN=       # de-dup window; blank = 30
NOTIFY_RETENTION_DAYS=     # daily purge of old alerts; blank = 30
```

Blank `SMTP_USER`/`SMTP_PASS` disables email cleanly — the bell and toasts still work.

**App Password:** requires 2-Step Verification on the account, then
`https://myaccount.google.com/apppasswords`. Google displays it spaced (`abcd efgh ijkl mnop`);
the spaces are stripped for you.

**Verify:**

```bash
cd backend
npm run mail:check                        # connect + authenticate, sends nothing
npm run mail:check -- you@example.com     # also send one real test alert
```

---

## 9. Deployment

### 9.1 First — get the mailbox from ICTU (do this early, it's the long pole)

Production must send from an **ICTU-owned departmental account**, not a student account, which gets
deprovisioned at graduation — alerts would then stop silently.

**Target account:** `ictusupport@cspc.edu.ph`

📄 **The full request — reasoning, a copy-paste email, anticipated objections and fallbacks — is in
`ictu-email-account-request.md`.** Send it to `ictusupport@cspc.edu.ph`.

What you're asking them for is only:

1. **2-Step Verification** enabled on that account
2. An **App Password** generated from it

No new account, no license, no DNS changes, nothing to monitor. ICTU can type the App Password into
`.env` on the server themselves rather than share it.

*Already verified (2026-08-06):* an App Password on `magregorio@my.cspc.edu.ph` authenticated
against `smtp.gmail.com:587` and delivered to both CSPC and external addresses — so App Passwords
are not disabled tenant-wide.

**This does not block deployment.** With `SMTP_USER`/`SMTP_PASS` blank the bell, toasts and OS
popups all still work; only email is lost. Ship without it if the request is slow.

### 9.2 Then — `.env` changes

Values are read once at module load, so **restart the backend** after editing.

| Var | Production value | Why |
|---|---|---|
| `NOTIFY_EMAIL_TO` | **blank** | 🚨 Set, it redirects *every* staff member's mail to one inbox — and fails **silently**, because the bell and toasts still work so nothing looks wrong |
| `SMTP_USER` | `ictusupport@cspc.edu.ph` | Departmental mailbox → Google's SPF/DKIM authorize it |
| `SMTP_PASS` | that account's App Password | ⚠️ **Revoked when the account's main password changes** — first thing to check if alerts go quiet |
| `MAIL_FROM` | `CSPC ICTU Monitoring <ictusupport@cspc.edu.ph>` | Display name only |
| `NOTIFY_EMAIL_MIN_SEVERITY` | `critical` | If lowered to `info` for testing, it emails everyone on every warning |
| `NOTIFY_COOLDOWN_MIN` | `30` | Lower values are a testing convenience |

`users.email` needs no migration — Google login already populates each staff member's real address.

### 9.3 Then — verify

1. `npm run mail:check` → expect `✓ Verify OK`
2. `npm run mail:check -- someone@cspc.edu.ph` → confirm it arrives, and check **inbox vs spam**
3. Trigger one real critical alert and confirm **more than one person** received it — that's the
   specific thing a stray `NOTIFY_EMAIL_TO` breaks
4. Confirm all four surfaces fire: bell badge, toast, email, Alerts page row

### 9.4 Note for the handover document

- Alert thresholds are editable by admins on the **Alert Rules** page — no redeploy needed.
- **Rules-only:** deleting the last active global rule for a metric silently disables alerting for
  it. The UI warns, but it can be overridden.
- If alert emails stop with no other symptom, regenerate the App Password (§9.2).
- Flashing `iot/esp32/env_monitor_v2.ino` is still pending; until then the device ignores
  `envConfig`/`acConfig` and keeps its compiled-in thresholds.

---

## 10. Testing

| Channel | How |
|---|---|
| Bell + toast + sound | Drive a server CPU ≥ 90%, or stop an agent → offline in ~15s |
| Environment | Let the ESP32 report a hot/smoke reading |
| Email | `npm run mail:check -- addr`, then a real **critical** alert. Temporarily set `NOTIFY_EMAIL_MIN_SEVERITY=info` to email everything |
| Lifecycle | Alerts page → Acknowledge → Resolve. Raise the threshold back → watch it **auto-resolve** |
| Re-arm | Resolve a still-breaching metric → it re-alerts on the next reading (§6) |
| Cooldown | Trigger the same alert twice inside the window → only the first fires |
| Prefs | Settings → Notification Preferences → toggle email / change min severity |

**Multi-user fan-out.** With one user account you never exercise the fan-out. Add plus-addressed
test rows — distinct `users.email` values that all land in your inbox:

```sql
INSERT INTO users (name, username, email, role, status, auth_provider) VALUES
  ('Test Admin',    'test_admin',   'magregorio+admin@my.cspc.edu.ph',   'admin',    'active', 'local'),
  ('Test IT Staff', 'test_itstaff', 'magregorio+itstaff@my.cspc.edu.ph', 'it_staff', 'active', 'local');
```

⚠️ Create **new** rows — don't edit an existing user's email. Login matches accounts by email
(`googleAuthService.js`), so changing a real user's address locks them out of their own account.
Delete the test rows when done.
