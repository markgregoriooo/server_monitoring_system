# Business Logic Security Threat Model — CSPC-ICTU Monitoring System

**Date:** 2026-06-05
**Branch:** EnvironmentMonitor
**Scope reviewed:** `backend/` — auth/session, RBAC middleware, user management, aircon
control (REST + Socket.IO), upload, server bootstrap.

> ⚠️ **Scope note.** This codebase is a **server-room environment monitor**. It contains
> **no payment, funds-transfer, inventory, cart, coupon/discount, or currency code**. The
> task's `[paste payment/transfer code]` placeholder was empty. The commerce-specific
> checklist items are therefore marked **Not Applicable** with evidence, and the analysis
> targets the *actual* sensitive business operations present: **authentication & session
> lifecycle, role-based authorization, user administration, and air-conditioner state
> mutation** (which physically actuates hardware via IR).

---

## Remediation Status — all findings addressed (2026-06-05)

> **Update (2026-06-08) — reconciled with code.** Verified still present: **F-02**
> (`middleware/auth.js` selects `token_version` + `status` and rejects on mismatch), **F-03**
> (`routes/reports.js` = `requireRole("admin","it_staff")`), **F-04 partial**
> (`src/server.js:69` reads `handshake.auth.deviceKey ?? handshake.query.deviceKey`). The
> standalone `backend/migrations/2026-06-05_add_token_version.sql` cited below **no longer
> exists as a separate file** — the column + an idempotent `ADD COLUMN` block were folded into
> `V9cspc-ictu-monitoring-system-schema.sql` (line 35 + lines 567–594), so a fresh schema load
> already includes it. **Still open:** F-04 firmware — `env_monitor_v2.ino` continues to send
> `deviceKey` in the Socket.IO URL query (the server accepts the off-URL auth payload, but the
> firmware hasn't been migrated to send it there).

| ID | Status | Change |
|----|--------|--------|
| F-01 | ✅ Fixed | Atomic SQL flip in `airconService.toggle` (`is_on = IF(is_on=1,0,1)` + read-back) |
| F-02 | ✅ Fixed | `token_version` column + `tv` JWT claim; enforced in `authMiddleware` and socket `io.use`; bumped on logout / disable / role change / password reset / own-password change. **Requires running `backend/migrations/2026-06-05_add_token_version.sql`.** |
| F-03 | ✅ Fixed | `reports.js` gate corrected to `requireRole("admin","it_staff")` |
| F-04 | ✅ Partial | Server now accepts `handshake.auth.deviceKey` (off-URL); query kept as EIO3 fallback. **Firmware still sends the key in the URL — migrate `env_monitor_v2.ino` to the auth payload to fully close.** |
| F-05 | ✅ Fixed | CORS / Socket.IO origins restricted to `WEB_ORIGIN` (default localhost+LAN dashboard) |
| F-06 | ✅ Fixed | Status check moved after password verification; no pre-auth account disclosure |
| F-07 | ✅ Fixed | `ir_channel` route bound clamped to 1–4 (firmware `MAX_IR_CHANNELS`) |

**Follow-ups required by the operator:**
1. Run the SQL migration above (or recreate from the updated V9 schema) **before** deploying — `authMiddleware` now selects `token_version` and will fail closed if the column is missing.
2. Set `WEB_ORIGIN` in `backend/.env` for non-default deployments (comma-separated origins).
3. (F-04) Move the firmware's `deviceSecret` out of the Socket.IO URL into the auth payload and rotate `DEVICE_SECRET`.

> Note: with F-02, changing your own password or being disabled/role-changed now invalidates
> the active token immediately — the frontend must handle the resulting `401` by redirecting
> to login.

---

## Summary Risk Score: **5.5 / 10** (Moderate) — residual after fixes: ~2.5/10 (pending migration + firmware follow-up)

Rationale: No financial logic, and the system is LAN-scoped. But there are real
authorization-lifecycle gaps (non-revocable sessions, a broken role gate that locks admins
out / lets the wrong role through), a state-mutation race in aircon toggling, and a static
device secret transmitted in a URL query that can be logged. None are catastrophic in
isolation; combined they allow privilege persistence and unauthorized actuation on the LAN.

### Top 5 prioritized fixes (fastest risk reduction)
1. **F-02 — Make session state enforceable** (revoke on logout / disable / role change). Currently a 1 h JWT survives account disable, logout, and role downgrade. *High.*
2. **F-03 — Fix the `reports` role gate** (`super_admin` doesn't exist; admin is locked out, `it_staff` is silently the only writer). *Medium, trivial fix.*
3. **F-01 — Serialize the aircon toggle** read-modify-write to remove the TOCTOU race / duplicate IR + log storms. *Medium.*
4. **F-04 — Stop sending `DEVICE_SECRET` in the Socket.IO URL query**; move to an auth header/payload and rotate the shared secret. *Medium.*
5. **F-05 — Constrain CORS / Socket.IO origins** away from `"*"` to the known dashboard origin. *Low/Medium.*

---

## Findings

### F-01 — Race condition (TOCTOU) in aircon toggle read-modify-write
- **Severity:** Medium
- **CWE:** CWE-362 (Concurrent Execution using Shared Resource w/o Sync), CWE-367 (TOCTOU)
- **Evidence:** `backend/services/airconService.js:125-153` (`toggle`), invoked by
  `backend/routes/aircon.js:69-88` (`PATCH /:id/toggle`).
- **Why it matters:** `toggle` reads `is_on` (line 126-128), computes `newState` in app code
  (line 131), then writes it (line 132-136). Two concurrent toggle requests for the same
  `device_id` both read the same `is_on`, both compute the same flip, and the unit ends in a
  non-deterministic state. Each request also independently emits `irCommand`
  (`aircon.js:79-82`) → the ESP32 fires **conflicting ON/OFF IR** and writes **duplicate
  `aircon_logs`** rows, corrupting the audit trail and desyncing DB vs. physical AC.
- **Exploitability:** Authenticated `admin`/`it_staff` only; no privilege gain. Triggered by
  double-click or scripted parallel requests. Reproduction:
  ```bash
  # two parallel toggles on the same unit
  ID=5; T="<jwt>"
  curl -s -X PATCH localhost:3000/api/aircon/$ID/toggle -H "Authorization: Bearer $T" &
  curl -s -X PATCH localhost:3000/api/aircon/$ID/toggle -H "Authorization: Bearer $T" &
  wait   # observe two log rows + two irCommand emits for one intended action
  ```
- **Remediation (drop-in):** flip atomically in SQL so the DB serializes it, and use the
  returned row to decide the new state:
  ```js
  // airconService.toggle — atomic flip
  async function toggle(id, userId, userName) {
    const [res] = await db.query(
      `UPDATE aircon_state
         SET is_on = NOT is_on,
             last_trigger = 'manual',
             triggered_by_user_id = ?,
             updated_at = NOW()
       WHERE device_id = ?`,
      [userId, id]
    );
    if (res.affectedRows === 0) return null;            // unit not found
    const [[row]] = await db.query(
      "SELECT is_on, ir_channel FROM aircon_state WHERE device_id = ?", [id]
    );
    // ...build action/log/return from row.is_on as before
  }
  ```
  **Defense-in-depth:** debounce the toggle button client-side; add a UNIQUE/idempotency key
  per user-action; wrap the read-back + log insert in a transaction.

---

### F-02 — Sessions cannot be revoked; privilege/disable/logout changes don't take effect for up to 1h
- **Severity:** High
- **CWE:** CWE-613 (Insufficient Session Expiration), CWE-565 (Reliance on Untrusted JWT claims)
- **Evidence:**
  - Token minted with only `expiresIn: "1h"`, no server-side session store —
    `backend/services/authService.js:57`.
  - Authorization derives entirely from JWT claims (`role`) —
    `backend/middleware/auth.js:17-19, 34`.
  - Logout is **cosmetic**: it only writes an audit row, never invalidates the token —
    `backend/services/authService.js:110-132`, `backend/routes/auth.js:70-84`.
  - Disable (`status='inactive'`) is only checked **at login** —
    `backend/services/authService.js:31-33`; `updateUserStatus`
    (`backend/services/userService.js:165-195`) changes the DB but not any live token.
- **Why it matters:** A user who is **disabled, deleted, role-downgraded, or "logged out"**
  keeps full access until the 1 h token expires. An admin demoted to `it_staff` keeps
  `manage:users`/`manage:aircon` for up to an hour. This is a workflow/status-manipulation
  bypass: the "approval/disable" control is not actually enforced.
- **Exploitability:** Any holder of a still-valid token after a privilege change. No special
  tooling. Reproduce: log in, have an admin set your account `inactive`, then call
  `GET /api/users` with the old token → still `200`.
- **Remediation:** introduce a server-checkable session/version. Minimal approach — a
  `token_version` column bumped on logout/disable/role-change, verified in middleware:
  ```js
  // authService.login: include the current version in the JWT
  const payload = { id: user.user_id, role: user.role, tv: user.token_version, /* ... */ };

  // auth.js authMiddleware: verify the claim still matches the DB
  const decoded = jwt.verify(token, JWT_SECRET);
  const [[u]] = await db.query(
    "SELECT token_version, status FROM users WHERE user_id = ? LIMIT 1", [decoded.id]
  );
  if (!u || u.status !== "active" || u.tv !== decoded.tv) {
    return res.status(401).json({ error: "Session no longer valid." });
  }
  req.user = decoded;
  ```
  Bump `token_version` in `logout`, `updateUserStatus(inactive)`, `updateUser` (role change),
  `deleteUser`, and `resetPassword`/`changeOwnPassword`.
  **Defense-in-depth:** shorten token TTL + refresh tokens, or a Redis denylist of revoked
  `jti`s.

---

### F-03 — Broken authorization on report creation (non-existent role; admin locked out, wrong role allowed)
- **Severity:** Medium
- **CWE:** CWE-285 (Improper Authorization), CWE-863 (Incorrect Authorization)
- **Evidence:** `backend/routes/reports.js:16` —
  `requireRole("super_admin", "it_staff")`. Valid DB roles are only `admin` and `it_staff`
  (`backend/services/permissionService.js:1-12`, `backend/services/userService.js:41,100`).
- **Why it matters:** `super_admin` is never issued, so the intended privileged role can't
  create reports, **`admin` is denied** (`POST /api/reports` → 403 for admin), while
  **`it_staff` — the lower-privilege role — is the only role that can write reports**. This
  is an authorization-model inconsistency: the gate does the opposite of intent. (At audit
  time the `reports` store was an in-memory mock — `backend/data/db.js` — so impact was
  limited, but the gate was a latent privilege bug that would mislead once persisted.)

  > **Since resolved on both counts.** The gate is now `requireRole("admin","it_staff")`
  > (F-03 above), and reports are no longer a mock: they persist to the `reports` table
  > with CSV/PDF on disk (`services/reportService.js`, `report-page.md`). `data/db.js` has
  > been deleted.
- **Exploitability:** `it_staff` token → `POST /api/reports` succeeds; `admin` token → 403.
- **Remediation (drop-in):**
  ```js
  // reports.js
  requireRole("admin", "it_staff"),   // match actual roles + intended privilege
  ```
  **Defense-in-depth:** centralize role names in one exported enum (e.g. extend
  `permissionService`) and gate on a permission string (`manage:reports`) instead of raw
  role names, so typos can't create silent bypasses.

---

### F-04 — Static device secret transmitted in Socket.IO URL query (loggable), and over-broad device authority
- **Severity:** Medium
- **CWE:** CWE-598 (Sensitive Info in Query String), CWE-522 (Insufficiently Protected
  Credentials), CWE-639 (Authorization bypass via shared secret)
- **Evidence:** secret read from `socket.handshake.query.deviceKey`
  (`backend/src/server.js:51-62`); firmware sends it in the connection **URL query string**
  (`iot/esp32/env_monitor_v2.ino:931-934`,
  `"/socket.io/?EIO=3&transport=websocket&deviceKey=%s"`). A device-authenticated socket can
  call `applyAutoIR`, which **overwrites every aircon unit's state**
  (`backend/services/airconService.js:190-219`, `UPDATE ... WHERE device_id IN (all
  aircons)`).
- **Why it matters:** Query-string secrets are routinely captured in reverse-proxy/access
  logs, browser history, and APM traces. The secret is a single static constant shared by
  firmware and `.env`; anyone who recovers it can impersonate "the device," emit `irFired`,
  and force **all** AC units on/off and to arbitrary set-temperatures, plus inject false
  sensor history (`sensorData`/`offlineData`). It is also a long-lived secret with no
  rotation path.
- **Exploitability:** Requires LAN access + knowledge/capture of `DEVICE_SECRET`. PoC (no
  real secret shown):
  ```
  # connect as a fake device and broadcast a critical-zone IR event
  socket = io("http://host:3000", { query: { deviceKey: "<captured-secret>" } });
  socket.emit("irFired", { zone: 4, label: "20C_HIGH" });  // forces all ACs on @20°C
  ```
- **Remediation:** send the secret in the handshake **auth payload** (WebSocket frame body),
  not the URL:
  ```js
  // server.js — prefer auth payload; keep query only as legacy fallback if unavoidable
  const deviceKey = socket.handshake.auth?.deviceKey ?? socket.handshake.query?.deviceKey;
  ```
  Move firmware to `socketIO.begin(host, port, path, "", "arduino")` with the key in the auth
  object (library permitting), or use a per-device key table instead of one global constant.
  **Defense-in-depth:** scope device authority (an `irFired` should target a known
  channel/unit, not blindly all units); rate-limit device events; rotate `DEVICE_SECRET`;
  put the broker behind TLS so the handshake isn't sniffable.

---

### F-05 — Wildcard CORS / Socket.IO origin
- **Severity:** Low (Medium if ever exposed beyond LAN)
- **CWE:** CWE-942 (Permissive Cross-domain Policy)
- **Evidence:** `backend/src/server.js:37-39` (`io` cors `origin: "*"`) and `:45`
  (`app.use(cors({ origin: "*" }))`).
- **Why it matters:** Any web origin can script authenticated requests/sockets against the
  API if it can obtain a token. Tokens live in `sessionStorage` (per CLAUDE.md), so this is
  not classic cookie-CSRF, but `*` removes a useful defense layer and allows any site to
  attempt cross-origin calls.
- **Remediation:**
  ```js
  const ORIGIN = process.env.WEB_ORIGIN; // e.g. http://192.168.100.9:5173
  app.use(cors({ origin: ORIGIN }));
  const io = new Server(server, { cors: { origin: ORIGIN, methods: ["GET","POST"] }, allowEIO3: true });
  ```
  **Defense-in-depth:** keep `allowEIO3` only as long as the ESP32 needs Engine.IO v3.

---

### F-06 — Account-status enumeration via distinct login error
- **Severity:** Low
- **CWE:** CWE-204 (Observable Response Discrepancy)
- **Evidence:** `backend/services/authService.js:31-33` returns `"Your account has been
  disabled."` for valid-but-inactive emails, vs. the generic `"Invalid email or password."`
  (line 39) for unknown emails.
- **Why it matters:** Lets an attacker confirm which emails are real (disabled) accounts.
  Minor, but combined with a target list it aids social engineering.
- **Remediation:** return the generic message for inactive accounts too (still log the real
  reason server-side), or surface "disabled" only **after** a correct password match.

---

### F-07 — Backend accepts IR channels the firmware can't address
- **Severity:** Low (data-integrity / logic gap)
- **CWE:** CWE-20 (Improper Input Validation)
- **Evidence:** `backend/routes/aircon.js:38-39` accepts `ir_channel` 1–8, but firmware
  defines `MAX_IR_CHANNELS 4` with `IR_CHANNEL_PINS` of length 4
  (`iot/esp32/env_monitor_v2.ino:86-87`); `irCommand`/`irConfig` for channels 5–8 are
  silently ignored on-device (`...esp32...:789, 812`).
- **Why it matters:** A unit registered on channel 5–8 appears controllable in the DB/UI but
  never actuates hardware — a silent workflow inconsistency, not a security breach.
- **Remediation:** clamp the route bound to the hardware limit (e.g. `ch < 1 || ch > 4`) or
  source the max from shared config.

---

## Business Logic Threat Model (STRIDE-lite, present operations)

| Operation | Asset | Threat | Mitigated? | Finding |
|-----------|-------|--------|-----------|---------|
| Login | Credentials, session | Brute force | ✅ `loginLimiter` per IP+email, `skipSuccessfulRequests` (`routes/auth.js:9-29`) | — |
| Login | Account existence | Enumeration | ⚠️ partial | F-06 |
| Session use | Privilege | Stale/over-privileged token | ❌ no revocation | F-02 |
| Authorization | Protected routes | Role bypass / wrong gate | ⚠️ inconsistent | F-03 |
| User admin | Self-deletion | Admin deletes own account | ✅ guarded (`userService.js:203-205`, numeric `===` numeric) | — |
| User admin | Mass assignment | Self-escalate role via `/users/me` | ✅ only `name/username/email/profile_image` destructured (`userService.js:220-221`) | — |
| Upload | Server FS | Malicious file / path traversal | ✅ random filename, ext+MIME allowlist, 2MB cap (`middleware/upload.js`) | — |
| Aircon toggle | Physical actuation + audit | Race / double-actuation | ❌ read-modify-write | F-01 |
| Aircon auto IR | All-unit state | Spoofed device | ⚠️ shared static secret, broad authority | F-04 |
| History query | Time-series store | Flux injection | ✅ whitelist + strict ISO regex (`querySensorHistoryHandler.js:3-32`) | — |
| Transport | Tokens/secrets | Cross-origin abuse | ⚠️ `origin:"*"` | F-05 |

---

## Checklist Diff (from the requested "Check for" list)

| Item | Status | Evidence / Note |
|------|--------|-----------------|
| **Race conditions** | | |
| Concurrent request handling | **Fail** | F-01 aircon toggle read-modify-write (`airconService.js:125-153`) |
| Double-spending prevention | **N/A** | No funds/credits in system |
| Inventory management | **N/A** | No inventory; aircon add-unit dup is correctly guarded by DB UNIQUE + `ER_DUP_ENTRY` (`aircon.js:49-51`) |
| **Price manipulation** | | |
| Client-side price validation only | **N/A** | No pricing |
| Discount/coupon abuse | **N/A** | No coupons |
| Currency manipulation | **N/A** | No currency |
| **Workflow bypass** | | |
| Skipping validation steps | **Pass*** | Aircon mode/temp/channel validated server-side (`aircon.js:91-118, 38-39`); *minor gap F-07 |
| Status manipulation | **Fail** | F-02 disabled/role-change not enforced on live tokens |
| Approval process bypass | **Fail** | F-03 report role gate inverted (`reports.js:16`) |
| **Time-based** | | |
| TOCTOU | **Fail** | F-01 (check-then-act on `is_on`) |
| Expiration bypass | **Fail** | F-02 logout doesn't expire token; 1h window |
| Timezone manipulation | **Pass** | Server overrides device time for live writes (`sensorHandler.js:28`); history uses strict UTC ISO (`querySensorHistoryHandler.js:13`) |
| **Integer overflow/underflow** | | |
| Calculation errors | **N/A / Pass** | No monetary math; `setTemp` numeric-range-checked 16–30 (`aircon.js:108`) |
| Negative value handling | **Pass** | `ir_channel` `parseInt` + range, `temp` typeof+range; negatives rejected |

\*Pass with the noted minor gap.

---

## Unable to verify (need more code/config to confirm)
- **`.env` contents** (`JWT_SECRET` strength/entropy, `DEVICE_SECRET` rotation). Provide
  `backend/.env` (redacted lengths only) to assess secret strength. JWT signing uses
  `process.env.JWT_SECRET` with no fallback (`middleware/auth.js:4`) — if unset, `jwt.verify`
  throws and all auth fails closed (acceptable), but a weak/short secret would be guessable.
- **DB schema constraints** — F-01's atomic fix and the aircon dup-channel guard assume a
  UNIQUE constraint on `aircon_state.ir_channel`; confirm in
  `V9cspc-ictu-monitoring-system-schema.sql`. Would prove whether `ER_DUP_ENTRY` handling in
  `aircon.js:49` is actually reachable.
- **Reverse proxy / TLS** — F-04/F-05 severity depends on whether traffic is plaintext HTTP
  on the LAN and whether access logs capture query strings. Provide the deployment/proxy
  config to confirm.
