# Session & Cookie Security Audit — 2026-08-26

**Scope.** Every session-bearing path: `backend/middleware/auth.js`, `backend/services/authService.js`,
`backend/routes/auth.js`, `backend/services/socketSessions.js`, the Socket.IO handshake in
`backend/src/server.js`, `backend/middleware/securityHeaders.js`, and the client halves —
`frontend/src/api/client.ts` and `frontend/src/context/AuthContext.tsx`. Plus a full sweep
for cookie APIs, session middleware and CSRF libraries across backend, frontend and the Go agent.

---

## The finding that reframes the whole checklist

**This application sets no cookies. Anywhere.**

```
git grep -nIE "cookie|res\.cookie|setCookie|withCredentials|credentials:" -- backend/ frontend/src/ agent/
  → frontend/src/pages/legal/PolicyDocument.tsx:118   (the words "tracking cookies" in the Privacy Notice)

grep -icE "express-session|cookie-parser|csurf|csrf|redis|connect-redis" backend/package.json
  → 0
```

Sessions are **stateless JWTs**, sent as `Authorization: Bearer <token>` and held in
`sessionStorage`. `app.use(cors(...))` at `backend/src/server.js:240` does **not** set
`credentials: true`, and the Socket.IO CORS block at `:171-174` does not either.

That is not a gap — it is a design choice that deletes an entire vulnerability class.
**Sections 1 and 2 of the checklist (`Secure` / `HttpOnly` / `SameSite` / domain / path
scoping) are Not Applicable, and CSRF (section 3) is structurally Not Applicable**: a
browser never attaches a bearer token on its own, so a cross-origin page cannot make an
authenticated request no matter what it forges. There is no ambient authority to ride.

The trade-off is real and stated honestly in SC-06: a token in `sessionStorage` cannot have
`HttpOnly`, so **XSS reads it directly**. Cookies move the risk; they do not remove it.

| | |
|---|---|
| **Residual risk score, before this audit's fixes** | **4.5 / 10** |
| **After the fixes applied here** | **≈ 2.0 / 10** |

The posture was already strong — bounded sliding window, `tv` revocation, DB-liveness on
every request, a live-socket revocation sweep, `iss`/`aud` enforcement. The findings below
are the seams between those mechanisms, not holes in any one of them.

---

## Findings

### SC-01 — MEDIUM — The absolute session cap had no effect on an open Socket.IO connection

**CWE-613** (Insufficient Session Expiration), **CWE-384** (Session Fixation — adjacent)

**Evidence (before the fix).**

- `backend/middleware/auth.js:110-133` — `maybeRenewToken` enforces `SESSION_MAX_HOURS`
  (default 12) by **declining to mint a new token**. It deliberately does not 401.
- `backend/services/socketSessions.js:96-118` — the revocation sweep checked
  `sessionRevocationReason(row, socket.user.tv)` only: account status and `token_version`.
- `backend/src/server.js:372-388` — the handshake authenticated once and never re-checked.

**Why it matters.** The cap works by starving the session of new tokens. **A socket does not
need new tokens.** It authenticates once at the handshake and Socket.IO never asks again, so
the ceiling was enforced against HTTP and against nothing else.

That inverts the control's own rationale. `CLAUDE.md` justifies `SESSION_MAX_HOURS` because
"a stolen token could be kept alive indefinitely by simply using it" — but a non-browser
client holding a stolen token does not have to keep using it. It opens **one** socket and
reads the live feed forever, issuing no HTTP request that could be refused. `handleConnection`
streams `sensorData`, `serverMetrics`, `networkMetrics`, `upsMetrics`, `deviceLog` and
`notification` to that socket for as long as it stays open.

The only remaining kill switches were account disable or a `token_version` bump — and the
latter requires the *legitimate* user to notice and press Sign out.

**Exploitability.** Requires a token first (XSS, a shared machine, a captured
`X-Renewed-Token`). Given one, it is a `socket.io-client` one-liner and survives indefinitely.

**Reproduction.**
```js
// with any valid dashboard JWT, from anywhere that can reach :3000
const s = io("http://<backend>:3000", { auth: { token: STOLEN } });
s.onAny((ev, ...a) => console.log(ev, a));
// before the fix: still streaming days later, long past SESSION_MAX_HOURS
```

**Remediation — applied.** A shared predicate in `backend/middleware/auth.js:70-108`:

```js
const TOKEN_TTL_SEC = 3600;   // must track RENEW_TTL / issueSession's expiresIn

export function sessionHardExpirySec(claims) {
  const start = claims?.ist ?? claims?.iat;
  if (typeof start !== "number") return null;
  return start + SESSION_MAX_SEC + TOKEN_TTL_SEC;
}
export function sessionPastHardLimit(claims, nowSec = Math.floor(Date.now() / 1000)) {
  const hardExp = sessionHardExpirySec(claims);
  return hardExp !== null && nowSec >= hardExp;
}
```

Wired into both socket paths:

| Site | Change |
|---|---|
| `backend/services/socketSessions.js:110-113` | sweep kicks a past-cap socket (`reason: "session_expired"`) |
| `backend/src/server.js:389-391` | handshake refuses a past-cap session outright |

Three decisions worth keeping:

1. **The bound is cap + one token lifetime, not the cap.** Past the cap the middleware stops
   renewing rather than 401-ing, so the last token minted just under the wire is valid for one
   more TTL — the documented "worst case a session lives this + 1h". Enforcing the bare cap
   would disconnect sockets belonging to sessions HTTP is still happily serving.
2. **`exp` is still not checked**, and the existing comment explaining why is preserved and
   extended. Ignoring `exp` was correct — sliding sessions legitimately outlive any single
   token. Ignoring the *cap* was not, and the two were being conflated.
3. **The cap is kept out of `sessionRevocationReason`.** That predicate answers "is this
   account entitled to a session", which HTTP answers with a 401. The cap answers "has this
   session run too long", which HTTP deliberately answers by declining to renew. Folding them
   would silently turn the HTTP path into a hard mid-session logout.

Checked at the handshake **as well as** in the sweep so a past-cap connection is never
established, rather than established and dropped up to `SOCKET_REVOKE_SWEEP_MS` (30 s) later.

**Tests.** `backend/tests/sessionCap.test.js` — 10 cases pinning the boundary (`>=` not `>`),
the `iat` fallback, `ist` winning over `iat`, non-numeric anchors, and fail-open on absent claims.

---

### SC-02 — MEDIUM — The idle timeout keys on tab visibility, not on user activity

**CWE-613** (Insufficient Session Expiration)

**Evidence.** `frontend/src/context/AuthContext.tsx:330-372`:

```js
const HEARTBEAT_MS   = 10 * 60 * 1000;  // keep-alive cadence
const AWAY_LOGOUT_MS = 15 * 60 * 1000;  // "idle timeout … (PCI-DSS standard)"
const watching = () => document.visibilityState === "visible" || pipOpen();
const ping = () => { if (watching()) void api.me(); };
```

**Why it matters.** `watching()` asks *"is this tab on screen"*, never *"is a person here"*.
So on a **visible but unattended** dashboard:

- `ping()` fires every 10 min → `/auth/me` → past the 30-min half-life the backend renews →
  `X-Renewed-Token` → the session slides forward.
- `AWAY_LOGOUT_MS` never arms, because `visibilitychange` never fires.

The session therefore lives to the 12 h cap with nobody in front of it. There is no
`mousemove` / `keydown` / `pointerdown` listener anywhere in the file.

The comment calls this a "15-min idle timeout (PCI-DSS standard)". That is accurate for the
tab-switching case and **not** accurate for the case an idle timeout is written for: an
unlocked workstation with the dashboard in the foreground.

**This is a genuine design tension, not simply a bug.** `CLAUDE.md` states the dashboard "can
sit on a wall display", and a wall display is unattended by definition — strict activity
detection would log it out every 15 minutes. That is why **this one is reported and not
unilaterally changed**: the correct answer depends on whether ICTU wants wall displays.

**Remediation — APPLIED 2026-08-26: option 1.** `backend/.env` now carries:

```
SESSION_MAX_HOURS=4
```

Verified in force: `sessionHardExpirySec` now cuts a session off **5 h** after sign-in
(4 h cap + one 1 h token lifetime); a 4 h-old session is still allowed, a 5 h-old one is not.

⚠️ **Operational consequence, stated plainly: a wall display now needs signing in again roughly
every 5 hours instead of every 13.** Lowering the cap does not exempt unattended screens — it
applies to every session equally, and nobody is standing at a wall display to complete a Google
sign-in. This option was chosen because it does not *break* the wall-display use case the way
option 2 would (a 15-min activity logout), but it does make it more manual. If that proves
unworkable in practice, option 3 is the answer, not raising the cap back.

The remaining options, if the trade needs revisiting:

1. **Real activity detection**, if wall displays are not required — drop-in for
   `AuthContext.tsx:352-356`:
   ```js
   const lastActivity = useRef(Date.now());
   useEffect(() => {
     const bump = () => { lastActivity.current = Date.now(); };
     const evs = ["mousemove", "keydown", "pointerdown", "wheel", "touchstart"];
     evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
     return () => evs.forEach((e) => window.removeEventListener(e, bump));
   }, []);

   // A visible tab is only "watching" if someone has actually touched it recently.
   const ping = () => {
     if (watching() && Date.now() - lastActivity.current < AWAY_LOGOUT_MS) void api.me();
   };
   ```

2. **A wall-display exemption**: a dedicated read-only kiosk account whose session is
   allowed to slide, with every interactive role on strict activity detection. Most work,
   cleanest security story — and the right answer if 5-hourly manual sign-ins become a nuisance.

**Defence in depth.** SC-03 (applied) means whichever timeout does fire now revokes
server-side, so the two findings compound favourably.

---

### SC-03 — LOW — The idle timeout cleared the browser but never revoked the token

**CWE-613**

**Evidence (before the fix).** `frontend/src/context/AuthContext.tsx:146-153` — `beginIdleLogout`
called `socket.disconnect()` and three `sessionStorage.removeItem(...)`. It never called
`api.logout()`. Compare the explicit Sign out at `:428-433`, which always has.

**Why it matters.** This is the one teardown where the token is **still alive**. Token expiry
and revocation-driven logouts end with a credential that is already dead; the idle timeout
fires on a perfectly valid token with up to an hour of life left and nothing bumps
`users.token_version`. Clearing `sessionStorage` secures *that browser* — which is most of the
point — but any copy taken from the machine keeps working for up to an hour after the screen
was supposedly secured. And an idle timeout is precisely the moment nobody is present to press
the button that would have revoked it.

**Remediation — applied.** `frontend/src/context/AuthContext.tsx:146-172`:

```js
// Fire-and-forget, and the local teardown does not wait on it: an offline or slow
// backend must never delay securing an unattended screen. api.logout() reads the
// token from storage, so it is issued BEFORE the keys are removed.
void api.logout().catch(() => {});
socket.disconnect();
sessionStorage.removeItem("cspc_user");
// …
```

Ordering matters and is deliberate: `api.logout()` is issued *before* the storage keys are
removed (it reads the token from there), and is not awaited, so a dead backend cannot delay
the local teardown. `authService.logout` bumps `token_version`, so the credential dies
immediately and everywhere.

---

### SC-04 — LOW — No cache directives on responses carrying a live bearer token

**CWE-525** (Use of Web Browser Cache Containing Sensitive Information), **CWE-524**

**Evidence (before the fix).** `git grep -nI "Cache-Control|no-store|Pragma" -- backend/` → no
matches. `backend/middleware/securityHeaders.js` set `nosniff`, `X-Frame-Options`, CSP,
`Referrer-Policy`, `Permissions-Policy` and HSTS — and nothing about caching.

**Why it matters.** No cache directives does not mean "not cached"; it means "cached
heuristically", by whatever rule the browser or an intermediary applies. Two things ride on
these responses:

- **`X-Renewed-Token`** (`backend/middleware/auth.js:133`) — the sliding renewal puts a **live
  bearer token in a response header**, on every request made past the current token's half-life.
- **The bodies** — `/auth/me`, the user list, and `system_logs` rows carrying `ip_address` and
  `user_agent`, which the previous audit identified as the most personal data in the schema. On
  a campus where browsers are shared between staff, a disk cache is a real place for that to sit.

RFC 9111 §3.5 already forbids a *shared* cache from storing a response to a request carrying
`Authorization`, so the exposure was bounded — but that rests on every intermediary honouring
the rule, and it says nothing about the local browser cache.

**Remediation — applied.** `backend/middleware/securityHeaders.js:79-80`:

```js
res.setHeader("Cache-Control", "no-store");
res.setHeader("Pragma", "no-cache"); // HTTP/1.0 spelling, still emitted by some proxies
```

**Verified live:**
```
$ curl -sD - http://127.0.0.1:3000/api/policy/version | grep -i cache
Cache-Control: no-store
Pragma: no-cache
```
`backend/tests/securityHeaders.test.js` — 5/5 still pass.

---

### SC-05 — LOW — The JSONP polling transport was reachable, bypassing CORS entirely

**CWE-1385** (Missing Origin Validation in WebSockets / cross-origin resource behaviour)

**Evidence (before the fix).** `backend/src/server.js:176` sets `allowEIO3: true` for the ESP32.
engine.io 6.6.9 still ships JSONP and selects it purely from a query parameter —
`backend/node_modules/engine.io/build/transports/index.js:15-21`:

```js
function polling(req) {
  if ("string" === typeof req._query.j) return new polling_jsonp_1.JSONP(req);
  else return new polling_1.Polling(req);
}
```

Confirmed reachable before the fix: `GET /socket.io/?EIO=3&transport=polling&j=0` → `200`.

**Why it matters.** A JSONP reply is loaded by the browser as a `<script>`, so it is the one
response on this server **not subject to CORS** — `cors.origin` cannot constrain it, because a
script tag never asks. `allowEIO3` is about the ESP32's *protocol version*; the *transport* is
a separate axis, and leaving JSONP reachable was an unintended consequence of it.

**Be precise about the actual exposure, which is small.** Because this API carries no ambient
credentials, a cross-origin script tag reaches only an **unauthenticated** handshake and is
rejected. It cannot ride a victim's session. What it could still do is spend that victim's
failed-handshake budget (`services/handshakeLimiter.js`, 50 failures / 15 min per address)
from any page they happen to visit — costing them live dashboard updates for 15 minutes while
HTTP keeps working. Modest, and worth closing since the transport has no legitimate consumer
here: the dashboard is a modern `socket.io-client` and the ESP32 connects with an explicit
`?EIO=3&transport=websocket`.

**Remediation — applied.** `backend/src/server.js:199-206`:

```js
allowRequest: (req, done) => {
  // Parsed off the raw URL: engine.io has not populated `_query` yet at this point.
  if (/[?&]j=/.test(req.url ?? "")) return done(3, false); // 3 = FORBIDDEN
  return done(null, true);
},
```

`allowRequest` runs *before* `io.use`, so a blocked JSONP probe no longer burns handshake
budget either.

**Verified live, including that nothing else broke:**

| Request | Result |
|---|---|
| `/socket.io/?EIO=3&transport=polling&j=0` | **403** `{"code":4,"message":3}` — refused |
| `/socket.io/?EIO=4&transport=polling` | 200 + sid — normal handshake intact |
| `/socket.io/?EIO=3&transport=polling` | 200 — **ESP32 protocol still works** |
| `socket.io-client`, no credential | `connect_error: Unauthorized` — auth still enforced |

---

### SC-06 — INFO (architectural) — The JWT lives in `sessionStorage`, so XSS reads it

**CWE-539** (Use of Persistent Cookies Containing Sensitive Information — analogue),
**CWE-1004** (Sensitive Cookie Without HttpOnly — analogue)

**Evidence.** `frontend/src/api/client.ts:22`, `frontend/src/context/AuthContext.tsx:415-418`:
`cspc_token`, `cspc_token_at`, `cspc_user`. The stored user object
(`AuthContext.tsx:405-413`) holds name, email, role, permissions and policy state — no
credential, but personal data readable by any script on the origin.

**Why it matters, stated fairly.** No `HttpOnly` equivalent exists for `sessionStorage`; any
XSS on the dashboard origin reads the token and the user record directly. The honest framing
is that **cookies would not remove this risk, only move it**: an `HttpOnly` cookie is
unreadable by XSS but is *automatically attached*, which reintroduces CSRF and forces
`SameSite` + token machinery. This codebase chose the trade that deletes CSRF and accepts
XSS-readability — a defensible choice, provided the XSS defence is real.

**So the control that matters is the page CSP** — and it is not in this repository. Express
here serves JSON only (`securityHeaders.js:29`, `default-src 'none'`); the dashboard's HTML/JS
is served by nginx. The page CSP is specified at `deployment-guide.md:571-583` and is a good
one — `script-src 'self' https://accounts.google.com`, `object-src 'none'`, `base-uri 'self'`,
`frame-ancestors 'none'`, and notably **no `unsafe-eval`**.

⚠️ **Unable to verify in production.** That CSP is a documented nginx block, not enforced code,
and this deployment has not happened yet (Google OAuth requires an HTTPS hostname —
`CLAUDE.md`, `google-oauth.md` §3/§10). The current dev setup runs the Vite dev server with
**no CSP at all**. *What would prove it:* `curl -sD - https://monitoring.cspc.edu.ph/ | grep -i
content-security-policy` returning the `$csp` value from §5.3.1.

**Two things worth choosing deliberately at deploy time:**

- `style-src 'unsafe-inline'` is required by the pervasive React `style={{…}}` attributes and
  is documented as such. It weakens the CSP against style-based exfiltration but not against
  script execution — acceptable, and correctly explained in the guide.
- `sessionStorage` (not `localStorage`) is the right pick and is already used: it dies with the
  tab. `CLAUDE.md` already documents the "Continue where you left off" restore hazard and the
  three guards that answer it.

---

### SC-07 — INFO — Rate-limit and handshake state is per-process, in memory

**CWE-613** (adjacent), **CWE-770** (Allocation Without Limits)

**Evidence.** All six limiters use `express-rate-limit`'s default `MemoryStore` — no `store:`
option is passed at `backend/src/server.js:125`, `routes/auth.js:12`, `routes/agents.js:19,39`,
`routes/servers.js:37,49`. `services/handshakeLimiter.js` is likewise an in-process `Map`.

**Why it matters.** The checklist item ("not using default in-memory storage in production")
does not apply to *sessions* here — there is no session store to get wrong — but it does apply
to this state. Two consequences:

- **A restart clears every budget.** The sign-in limiter (30/15 min), the enrollment limiter and
  the handshake budget all reset, so `nodemon` in development or a service restart in production
  hands an attacker a fresh allowance.
- **It assumes a single process.** Any move to `cluster`, PM2 in cluster mode, or a second
  instance behind nginx silently multiplies every limit by the instance count.

**Assessment: acceptable today, and worth writing down.** The documented deployment is one Node
process on one campus server (`deployment-guide.md` §5), where a memory store is the right call
— a Redis dependency on an on-prem box is a real operational cost for no benefit at n=1. This is
a **constraint to record, not a defect to fix**: if a second instance is ever added, these
limiters must move to a shared store on the same change.

---

### SC-08 — INFO — Logout is global; there is no session inventory

**Evidence.** `backend/services/authService.js:117-121` — `logout` runs
`UPDATE users SET token_version = token_version + 1`. `issueSession` (`:158-196`) does **not**
bump it.

**Behaviour this produces, all of it intentional:**

- Signing out on one device **invalidates every other device** — one counter, all tokens.
  Strong revocation, mildly surprising UX.
- Signing in **does not** invalidate other devices, so concurrent sessions are supported.
- There is no `sessions` table, so there is no "your active sessions" view, no per-device
  revocation, and no way for an admin to see who currently holds a live token. The only
  admin-side lever is disabling the account.

**On session fixation (checklist item "session regeneration after login") — PASS by
construction.** There is no server-side session identifier to fixate, and the token is minted
fresh at every sign-in with a fresh `ist` (`authService.js:184`). An attacker cannot plant a
token in a victim's `sessionStorage` without already having XSS on the origin, at which point
fixation is redundant. The classic `req.session.regenerate()` requirement has no analogue here.

**Recommendation.** None required. If per-device revocation is ever wanted, the minimal shape is
a `jti` claim plus a small revoked-token table checked in `fetchSessionRow` — but note that
trades away the statelessness that makes the current design cheap.

---

### SC-09 — LOW — `WEB_ORIGIN=*` collapses CORS to reflect-any-origin

**CWE-942** (Permissive Cross-domain Policy)

**Evidence.** `backend/src/server.js:166-169`:
```js
const CORS_ORIGIN = WEB_ORIGIN === "*" ? true : WEB_ORIGIN.split(",")...;
```
`CLAUDE.md` documents `WEB_ORIGIN=*` as a supported setting "for a roaming LAN".

**Current state: not in use.** The live `backend/.env` sets three explicit origins
(`localhost:5173`, `192.168.100.9:5173`, `https://monitoring.cspc.edu.ph`).

**Why it matters — and why it is only Low *here*.** With `origin: true` any site can read API
responses, and `exposedHeaders: ["X-Renewed-Token"]` (`:240`) would expose the renewal token to
them. But it can only read what it can successfully request, and **without ambient credentials
it can authenticate nothing**. The practical reach is the five deliberately-unauthenticated
routes, all rate-limited.

⚠️ **This becomes High the day anyone introduces a cookie.** `origin: true` plus
`credentials: true` is the classic account-takeover CORS misconfiguration, and half of it is
already configured. Whoever adds the first cookie must revisit this line.

**Remediation.** Leave `WEB_ORIGIN` as an explicit list — as it currently is. If the roaming-LAN
case is genuinely needed, prefer a regex over `*`:
```js
// e.g. any host on the campus /24, http only
const CORS_ORIGIN = /^http:\/\/192\.168\.100\.\d{1,3}:5173$/;
```

---

## Checklist diff

### 1. Session configuration

| Item | Verdict | Notes |
|---|---|---|
| Secure flag (HTTPS only) | **N/A** | No cookies. Equivalent control present: HSTS at `securityHeaders.js:83-85`, sent **only** over real TLS (`req.secure`) so a plain-HTTP LAN host is not pinned. |
| HttpOnly flag (no JS access) | **N/A** — see SC-06 | No cookies; the token is in `sessionStorage` and is JS-readable by necessity. Mitigation is the page CSP, which lives in nginx and is *unverified in production*. |
| SameSite attribute | **N/A** | No cookies. Cross-site request forgery is prevented structurally, not by an attribute. |
| Session timeout | **PARTIAL** | Token TTL 1 h; sliding renewal past half-life; effective server-side idle expiry 30–60 min; absolute cap 12 h via `ist`. **But** the 10-min client heartbeat defeats idle expiry on a visible tab — SC-02. |
| Session regeneration after login | **PASS** (by construction) | Fresh token + fresh `ist` per sign-in; no server-side session id exists to fixate — SC-08. |

### 2. Cookie security

| Item | Verdict | Notes |
|---|---|---|
| All cookies have appropriate flags | **N/A** | Zero cookies set, backend or frontend. |
| No sensitive data in cookies | **N/A** | Substitute check performed on `sessionStorage`: `cspc_token` (bearer), `cspc_user` (name/email/role/permissions). No password or long-lived secret — passwords were removed from this system entirely on 2026-08-25. |
| Proper domain/path scoping | **N/A** | `sessionStorage` is origin-scoped and tab-scoped by the platform — strictly narrower than any cookie scope. |
| Encryption for sensitive cookies | **N/A** | Nothing to encrypt. The JWT is signed (HS256) not encrypted, which is correct — it carries no secret, and `iss`/`aud` are enforced on every verify from one frozen definition (`auth.js:36-46`). |

### 3. CSRF Protection

| Item | Verdict | Notes |
|---|---|---|
| Token implementation | **N/A** | No ambient credentials ⇒ no forgeable authenticated request. A CSRF token here would guard nothing. |
| Double submit cookie pattern | **N/A** | Requires cookies. |
| Origin header validation | **PARTIAL** | No explicit `Origin` check. CORS (`server.js:240`) constrains who may *read* responses, and bearer auth constrains who may *make* them. Adequate for this architecture; the residual gaps were the CORS-exempt JSONP channel (**SC-05, fixed**) and the `WEB_ORIGIN=*` option (**SC-09**). |

### 4. Session storage

| Item | Verdict | Notes |
|---|---|---|
| Not using default in-memory storage in production | **PASS** for sessions / **NOTED** for limiters | No server-side session store exists at all — sessions are stateless JWTs validated per request against `users` (`fetchSessionRow`, `auth.js`). Rate-limit and handshake state *is* in-process memory — SC-07. |
| Redis/database backed sessions | **N/A by design** | The DB-liveness check is the equivalent: every request re-reads `status`, `token_version`, `role` and `policy_version`, so revocation is immediate without a session store. Authorization even reads the **DB role**, not the token's. |
| Session cleanup/expiration | **PASS** | Nothing accumulates: no session rows to purge, tokens expire intrinsically, `socketSessions` sweeps live sockets every 30 s, and `SYSTEM_LOG_RETENTION_DAYS` (365) purges the audit trail. |

---

## Top 5 prioritized fixes

1. ~~**Enforce the session cap on open sockets**~~ (SC-01) — **DONE.** The largest gap: it made
   the 12 h ceiling unenforceable against exactly the client that most benefits from evading it.
2. ~~**Decide the idle-timeout question**~~ (SC-02) — **DONE.** `SESSION_MAX_HOURS=4` applied,
   cutting an unattended visible dashboard from 13 h to 5 h. Watch whether 5-hourly re-sign-in
   is workable for wall displays; if not, move to a kiosk account rather than raising the cap.
3. ~~**Revoke server-side on idle logout**~~ (SC-03) — **DONE.** Makes whichever timeout fires an
   actual session termination rather than a local clear.
4. ~~**`Cache-Control: no-store`**~~ (SC-04) — **DONE.** One header; stops a live bearer token
   being written to a shared machine's disk cache.
5. **Confirm the nginx CSP at go-live** (SC-06). *~5 min, once.* It is the entire XSS defence for
   a token that cannot be `HttpOnly`. Verify with DevTools *and* `curl -sD -`, and re-test Google
   sign-in immediately after — `script-src` is the directive most likely to lock everyone out.

---

## Changes made by this audit

| File | Change |
|---|---|
| `backend/middleware/auth.js` | **New:** `sessionHardExpirySec()` / `sessionPastHardLimit()` + `TOKEN_TTL_SEC`; exported `SESSION_MAX_HOURS` (SC-01) |
| `backend/services/socketSessions.js` | Sweep now kicks past-cap sockets; rationale extended to separate "revoked" from "too old" (SC-01) |
| `backend/src/server.js` | Handshake refuses a past-cap session (SC-01); `allowRequest` blocks the JSONP transport (SC-05) |
| `backend/middleware/securityHeaders.js` | `Cache-Control: no-store` + `Pragma: no-cache` (SC-04) |
| `frontend/src/context/AuthContext.tsx` | `beginIdleLogout` now calls `api.logout()` before clearing storage (SC-03) |
| `backend/tests/sessionCap.test.js` | **New** — 10 cases for the session ceiling (SC-01) |

**Verification.** `npm test` — **342 pass, 0 fail** (10 new). `tsc --noEmit` clean. Live server
checks for SC-04 and SC-05 recorded in those findings, including confirmation that the EIO3
handshake the ESP32 depends on, normal polling, and auth rejection all still behave correctly.

**Config applied:** `SESSION_MAX_HOURS=4` in `backend/.env` (SC-02, operator-approved).

**Not changed, deliberately:** SC-06 (nginx config, not in this repo), SC-07 (correct at n=1),
SC-08 (intentional design), SC-09 (not currently in use; the explicit origin list is already
correct).
