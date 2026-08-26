# Authentication Flow Security Review — CSPC-ICTU Monitoring System

**Date:** 2026-08-25
**Scope:** `backend/middleware/auth.js`, `services/authService.js`, `services/googleAuthService.js`,
`services/googleDomain.js`, `services/userService.js`, `services/permissionService.js`,
`services/socketSessions.js`, `routes/auth.js`, `routes/users.js`, `config/env.js`,
`frontend/src/api/client.ts`, `frontend/src/context/AuthContext.tsx`
**Companions:** `audits/api-infra-security-2026-08-25.md` (same day — CORS, headers, rate limits, agent tokens)
**Method:** static read of every auth file, plus **live verification against the running backend**.

---

## 0. Verdict — Authentication: 7.5 / 10 → **9 / 10 after fixes**

**Most of the checklist does not apply to this system, and that is the single most important
thing to understand about it.** There are no passwords, no refresh tokens, no cookies, no
password reset, and no email verification of our own — sign-in is **Google OAuth 2.0
authorization-code + OIDC only**, and the password login was deleted. Roughly a third of the
requested checks are Not Applicable *by design*, and that design removes whole vulnerability
classes rather than mitigating them: no password to brute-force, no reset token to leak, no
cookie to forge a request with.

What is actually built is better than average. The authorization-code flow is the correct
choice (the implicit flow is deprecated under OAuth 2.1 / RFC 9700), `verifyIdToken` enforces
the audience, `email_verified` is checked as a real boolean, the CSPC domain gate is a pure
tested module, account matching prefers the immutable `google_sub` over the mutable email,
`jwt.verify` pins `algorithms: ["HS256"]` everywhere, and **session liveness is re-checked
against the database on every single request** — a stateful check most JWT deployments skip,
and the reason several classic JWT problems simply do not arise here.

The real findings were three, and all three were about **things left behind**: a sliding session
with no ceiling, a token that never said who issued it, and dead password code that was not
merely unused but actively broken.

| ID | Finding | Sev | CWE | Status |
|----|---------|-----|-----|--------|
| **AF-01** | **Sliding session had no maximum age** — a token renewed itself forever | **Medium** | CWE-613 | ✅ **Fixed** |
| **AF-03** | **Dead password code still mounted** — `bcrypt` endpoints with no login path, returning 500 | **Medium** | CWE-561, CWE-1164 | ✅ **Fixed** |
| **AF-02** | JWT carried no `iss` / `aud` — any token signed with the secret was accepted as a session | **Low** | CWE-345 | ✅ **Fixed** |
| **AF-04** | `requireRole` trusted the **token's** role claim, not the database | **Low** | CWE-807 | ✅ **Fixed** |
| **AF-05** | No `jti`; revocation is per-user (`token_version`), not per-session | **Low** | CWE-613 | ⏳ Recommend (§6) |
| **AF-06** | Access-token TTL is 1 h vs the 5–15 min guideline | **Low** | — | ✅ No action — see §7 |
| **AF-07** | `DEVICE_SECRET` is a single static secret with no rotation path | **Low** | CWE-798 | ⏳ Cross-ref: api-infra A-08 |

**Result: 299/299 backend tests pass (7 new). 0 TypeScript errors. Every fix verified against a
live request.**

---

## 1. AF-01 — Sliding session had no maximum age · **Medium** · CWE-613

**Evidence (before):** `backend/middleware/auth.js:16-30`

```js
function maybeRenewToken(res, decoded) {
  const now = Math.floor(Date.now() / 1000);
  const iat = decoded.iat ?? now;
  const exp = decoded.exp ?? iat + FALLBACK_TTL_SEC;
  if (now < iat + (exp - iat) / 2) return;      // past half-life → renew
  const { iat: _iat, exp: _exp, nbf: _nbf, ...claims } = decoded;
  const renewed = jwt.sign(claims, JWT_SECRET, { algorithm: "HS256", expiresIn: RENEW_TTL });
  res.setHeader("X-Renewed-Token", renewed);    // ← no ceiling, ever
}
```

**Why it matters.** A sliding window with no ceiling is not a session — it is a permanent
credential that rewrites itself. The renewal fires on *any* authenticated request, and this
dashboard makes requests constantly (six panels, a notification poll, a socket that re-seeds on
reconnect); one of its stated jobs is to sit on a wall display. So a token, once issued, lived
as long as somebody kept using it. Nothing expired it but the user thinking to press **Log out**.

That matters most for a *stolen* token. `sessionStorage` is not as short-lived as it sounds —
this codebase already documents that Chrome's "Continue where you left off" restores it along
with the tab, across a reboot. An attacker who obtains a token needs only to keep using it.

**Exploitability.** Requires an already-issued token (XSS, a shared machine, a restored tab).
Not remotely triggerable — hence Medium, not High. Reproduce by calling any authenticated
endpoint every ~31 minutes and swapping in each `X-Renewed-Token`: the session never ends.

**Fix — shipped.** `authService.issueSession` now stamps **`ist`** ("issued session time") once,
and it is preserved across every renewal, so it measures the age of the **session** rather than
of the current token:

```js
ist: Math.floor(Date.now() / 1000),
```

```js
const sessionStart = decoded.ist ?? iat;          // `iat` for tokens predating this
if (now - sessionStart >= SESSION_MAX_SEC) {      // SESSION_MAX_HOURS, default 12
  console.log(`[AUTH] not renewing user=${decoded.id} — session is …h old (cap …h)`);
  return;                                          // stop renewing; do NOT hard-kill
}
```

**Why it stops renewing rather than rejecting.** A hard 401 at the cap logs someone out
mid-action. Declining to renew lets the current token die at its own `exp`, which the client
already handles gracefully (`api/client.ts` → `notifySessionExpired`). Worst case the session
lives `cap + 1h`, and re-authenticating is one click because Google SSO is already warm.

⚠️ **A bug this fix nearly introduced, and the test that pins it.** The renewal re-signs the
decoded payload. `jwt.sign` **throws** when an option duplicates a claim already present —
verified:

```
strip only the time claims → THREW: Bad "options.audience" option. The payload already has an "aud" property
strip time claims + iss/aud → OK
```

So AF-02's `iss`/`aud` had to be stripped alongside `iat`/`exp`/`nbf`, or **every** renewal
would 500 — and only for users past a token's half-life, i.e. not at deploy time and not in any
quick manual test. `tests/jwtClaims.test.js` asserts both halves.

---

## 2. AF-03 — Dead password code still mounted · **Medium** · CWE-561, CWE-1164

**Evidence (before):**

| Location | What |
|---|---|
| `routes/users.js:39-56` | `PATCH /users/me/password` |
| `routes/users.js:83-96` | `POST /users` (admin create, **required** a password) |
| `services/userService.js:240` | `bcrypt.hash(password, 10)` |
| `services/userService.js:528` | `bcrypt.compare(currentPassword, user.hash_password)` |
| `backend/package.json` | `"bcryptjs": "^2.4.3"` |
| `frontend/src/api/api.ts:156, 224` | `createUser`, `changePassword` |

**Why it matters.** **No login path reads `users.hash_password`.** `/auth/login` was deleted;
`googleAuthService` is the only way to a session. So every password these endpoints hashed and
compared was write-only — it could never authenticate anyone.

It was not merely unused, it was **broken**. Every account is a Google account, so
`hash_password` is `NULL`, and `bcryptjs` rejects that outright — verified:

```
$ node -e "require('bcryptjs').compare('x', null).catch(e=>console.log(e.message))"
Illegal arguments: string, object
```

`changeOwnPassword` therefore **threw, and the endpoint answered 500** for every user who could
reach it. A live authentication endpoint that nobody calls, nobody tests, nobody reads and that
crashes on contact is precisely where a real vulnerability survives a review — and this one also
kept a password-hashing dependency in the tree at cost factor **10** (below the ≥12 the checklist
asks for), which would have been a genuine finding the day anyone re-enabled password login.

**Confirmed dead before removing anything:**

```
$ grep -rn "\.createUser(\|\.changePassword(" frontend/src | grep -v "api/api.ts"
(nothing)
$ grep -c "password" frontend/src/components/layout/ProfileModal.tsx frontend/src/pages/UserManagement.tsx
0
0
```

**Fix — shipped.** Both routes, both service methods, the `bcryptjs` dependency and the two dead
frontend functions are removed, each site leaving a comment explaining what was there and why it
went. `users.hash_password` stays as a nullable, all-`NULL` column — dropping it is a migration
with no security value, since there is nothing in it.

**Verified live:**

```
PATCH /users/me/password -> 404
POST  /users             -> 404
```

Accounts now arrive by exactly one route: Google self-registration → admin approval. The first
admin is promoted by hand (`deployment-guide.md` §4.3).

---

## 3. AF-02 — JWT carried no issuer or audience · **Low** · CWE-345

**Evidence (before):** `services/authService.js:26` signed with
`{ algorithm: "HS256", expiresIn: "1h" }`, and all three verify sites passed only
`{ algorithms: ["HS256"] }` — `middleware/auth.js:41`, `src/server.js:108` (the rate limiter's
user key) and `src/server.js:303` (the Socket.IO handshake).

**Why it matters.** Verification answered "is this signature valid?" but not "was this credential
issued **by** this app **for** this app?" HS256 rests on one shared secret, and secrets get
reused — copied into a sibling service, a migration script, a staging box. Any token signed with
that secret was accepted here as a live session. Low because there is only one issuer today; the
claims are cheap and turn a property of *current deployment hygiene* into an enforced one.

**Fix — shipped.** One frozen definition, exported from `middleware/auth.js`, consumed by all
five sign/verify sites — five hand-written copies would have been four chances to drift, and a
drift here fails as a mass logout:

```js
export const JWT_ISSUER = "cspc-ictu-monitoring";
export const JWT_AUDIENCE = "cspc-ictu-dashboard";
export const JWT_VERIFY_OPTS = Object.freeze({
  algorithms: ["HS256"], issuer: JWT_ISSUER, audience: JWT_AUDIENCE,
});
export const JWT_SIGN_OPTS = Object.freeze({
  algorithm: "HS256", issuer: JWT_ISSUER, audience: JWT_AUDIENCE,
});
```

**Verified live** — a token signed with the **real** `JWT_SECRET` but without the claims:

```
$ curl -H "Authorization: Bearer <valid-signature, no iss/aud>" .../api/auth/me
{"error":"Invalid or expired token."}   → 401
```

> ⚠️ **One-time effect:** tokens issued before this change lack `iss`/`aud` and are rejected, so
> anyone signed in when you deploy is logged out once. Signing in again is a single click.

---

## 4. AF-04 — `requireRole` trusted the token's role claim · **Low** · CWE-807

**Evidence (before):** `middleware/auth.js` `requireRole()` gates on `req.user.role`, which came
from the JWT payload, while `fetchSessionRow` read only `status, token_version`.

**Why it matters.** In the normal path this was safe: `userService.updateUser` bumps
`token_version` on any role change (`mustRevoke`), so an old token is rejected outright. But that
safety is a property of *one code path remembering to bump a counter* — and this codebase has
already been bitten by that exact shape. `services/socketSessions.js` exists as a sweep rather
than a push for the stated reason that *"there are four such sites and a sweep cannot miss a
fifth (or a hand-edited row)."*

A role edited directly in SQL bumps nothing — and that is the **documented** way the first admin
is created (`deployment-guide.md` §4.3). Until this fix, such a token kept asserting its old role
until it expired.

**Fix — shipped.** The row is already being read for the liveness check, so making the database
authoritative costs no extra query:

```js
sessionRow = await fetchSessionRow(decoded.id);        // now also SELECTs `role`
if (!sessionIsLive(sessionRow, decoded.tv)) return res.status(401).json({ … });

if (sessionRow.role && sessionRow.role !== decoded.role) {
  console.warn(`[AUTH] role for user=${decoded.id} is "${sessionRow.role}" in the database ` +
               `but "${decoded.role}" in the token — using the database.`);
  decoded.role = sessionRow.role;
}
```

Deliberately an **override, not a rejection** — a legitimate SQL promotion should take effect,
not log the user out. `permissions` in the payload is untouched: it decides which nav links the
dashboard draws, never a server-side decision.

---

## 5. What is already right — and worth defending in a review

These are not filler; several are the reason findings elsewhere are Low.

- **`jwt.decode` is never used for an authorization decision.** It appears once
  (`middleware/auth.js:52`), to read claims out of a token `jwt.verify` has *already rejected*,
  purely so the log can distinguish `TokenExpiredError` from `invalid signature` from
  `jwt malformed`. The rate limiter (`src/server.js` `userOrIpKey`) deliberately **verifies**
  rather than decodes, with the reasoning written down: decoding would let anyone claim any `id`
  and mint themselves a fresh budget or exhaust someone else's.
- **`algorithms` is pinned**, so the classic `alg: none` forgery fails. Pinned by a test.
- **Session state is checked on every request**, not just at issue: `sessionIsLive` is one shared
  predicate used by the HTTP middleware, the Socket.IO handshake, *and* a 30-second sweep over
  already-connected sockets. Most JWT deployments have no revocation at all.
- **Mass assignment is whitelisted at every write.** `updateOwnProfile` takes `username` only;
  `updateUser` destructures `username`/`role`/`status` with `ROLES`/`USER_STATUSES` validation;
  the route passes `{ username: req.body?.username }` explicitly. `role`, `status`, `google_sub`
  and `token_version` cannot be set from a request body.
- **Every query is parameterized.** The only template-literal SQL is a constant `SELECT` prefix
  with a parameterized `WHERE`.
- **`JWT_SECRET` is 96 characters** and `config/env.js` refuses to boot below 32.
- **Denied sign-ins are audited**, not just successes — `recordSignInDenied` records bad domain,
  unverified email, pending/rejected/disabled and failed token exchange, with the email preserved
  even when no user row exists.
- **Google is treated as fallible**: transport errors are separated from rejections
  (`isTransportError`) so an outage answers 503 rather than blaming the user's account.
- **No secrets are logged.** The auth log records `len=${token.length}`, never the token; no
  password, reset link or credential is written anywhere.

---

## 6. AF-05 — No `jti`; revocation is per-user · **Low** · ⏳ recommend

`token_version` is an excellent, restart-proof revocation mechanism, but it is **per user**:
bumping it kills *every* session that user has, on every device. There is no `jti`, so there is
no way to revoke one device and leave the others alone, and no way to show someone their active
sessions.

Not a vulnerability — a missing capability, and the right size of gap for this system (a handful
of ICTU staff on campus). Worth building only if a "signed-in devices" screen is ever wanted:

```js
// issueSession
jti: crypto.randomUUID(), ua: userAgent?.slice(0, 120) ?? null,
// + a `user_sessions` table keyed by jti, and a jti check in sessionIsLive
```

---

## 7. AF-06 — 1-hour access token · **Low** · ✅ no action

The checklist asks for 5–15 minutes, which assumes the usual stateless design where a token
cannot be withdrawn before it expires and TTL *is* the revocation window. That assumption does
not hold here: **every request re-reads `users.status` + `token_version`** (and now `role`), and
a sweep re-validates open sockets every 30 seconds. Revocation is effectively immediate, so
shortening the TTL would buy nothing and cost a signature + a renewal round-trip on a far larger
share of requests.

With AF-01 fixed, the exposure of a leaked token is now bounded at `SESSION_MAX_HOURS + 1h`
(13 h by default) even if the attacker keeps it warm — and zero the moment anyone logs out,
disables the account, or changes its role. Lower `SESSION_MAX_HOURS` if ICTU wants a tighter
bound; that is the dial that matters, not the TTL.

---

## 8. Checklist diff

| # | Item | Verdict | Note |
|---|------|---------|------|
| 1 | Password hashing (bcrypt ≥10/12, async, `compare`) | ➖ **N/A** *(now truly)* | No passwords exist. The vestigial cost-10 code is **removed** → AF-03 |
| 2 | JWT secret strength & storage | ✅ **Pass** | 96 chars, from `.env`, boot-checked ≥32 (`config/env.js`). Not hardcoded |
| 2 | Separate access/refresh keys | ➖ **N/A** | No refresh token |
| 3 | Access TTL 5–15 min | ⚠️ **Deviates, justified** | 1 h + per-request DB revocation → §7 |
| 3 | Sliding session bounded by max age | ✅ **Pass** *(was Fail)* | `ist` claim + `SESSION_MAX_HOURS` (12) → AF-01 |
| 3 | `algorithms` enforced | ✅ **Pass** | `["HS256"]` at all 3 verify sites; `alg:none` test |
| 3 | `iss` / `aud` enforced | ✅ **Pass** *(was Fail)* | → AF-02 |
| 3 | `sub` / `jti` | ⚠️ **Partial** | `id` serves as subject; no `jti` → AF-05 |
| 3 | `iat` / `exp` enforced | ✅ **Pass** | `expiresIn: "1h"`; `exp` enforced by `jwt.verify` |
| 4 | Refresh token rotation / reuse detection | ➖ **N/A** | No refresh tokens. Google re-auth replaces them |
| 4 | RT in HttpOnly cookie, hashed at rest | ➖ **N/A** | No RTs, no cookies |
| 5 | Invalidate tokens on credential change | ✅ **Pass** | `token_version` bumped on logout / role change / disable, checked every request + a 30 s socket sweep |
| 6 | Brute-force protection on login | ✅ **Pass** | 30/15 min per IP, `skipSuccessfulRequests` (`routes/auth.js:12`). ⚠️ depends on `TRUST_PROXY` — api-infra A-03 |
| 6 | Progressive backoff / CAPTCHA | ➖ **N/A** | Nothing to guess: auth is delegated to Google |
| 7 | Account enumeration defenses | ➖ **N/A** | Distinct pending/rejected/disabled replies exist, but reaching them requires controlling that CSPC Google account — you learn only your **own** status |
| 8 | Password reset flow | ➖ **N/A** | No reset flow exists |
| 9 | Email verification | ✅ **Pass** *(delegated)* | `payload.email_verified !== true` rejects; a real boolean from the ID token, not the legacy string |
| 10 | SQL/NoSQL injection in auth paths | ✅ **Pass** | Every query parameterized; no interpolated user input |
| 11 | AuthZ integrity / deny-by-default | ✅ **Pass** *(strengthened)* | Roles from `permissionService` server-side; `requireRole` denies unless listed; **role now read from the DB** → AF-04 |
| 12 | Cookie & CSRF config | ➖ **N/A** | No cookies anywhere — Bearer header from `sessionStorage`. Nothing to forge |
| 13 | Input validation & normalization | ✅ **Pass** | Email lowercased/trimmed in `findByEmail` + `registerGoogleUser`; username sanitized + de-duplicated; `ROLES`/`USER_STATUSES` frozen allow-lists |
| 14 | Mass assignment | ✅ **Pass** | Whitelisted at all three write paths — §5 |
| 15 | JWT misuse (`decode` for authz) | ✅ **Pass** | Never; `decode` used once for post-rejection logging — §5 |
| 16 | Logging & telemetry hygiene | ✅ **Pass** | No passwords/tokens/links logged. `system_logs` holds IP + UA **by design**, disclosed in the Privacy Notice, purged at 365 d |
| 17 | Dependency & crypto hygiene | ✅ **Pass** *(improved)* | `jsonwebtoken@^9`, `google-auth-library@^10`; no custom JWT parser; **`bcryptjs` removed** |
| 18 | Transport & CORS | ⚠️ **Partial** | CORS allow-listed, no wildcard credentials. HTTPS is ICTU's edge; HSTS ships but needs the cert — api-infra A-01/A-06 |
| 19 | Open redirect / `next` param | ➖ **N/A** | No redirect parameter; post-login routing is client-side to fixed paths |
| 20 | Operational controls | ⚠️ **Partial** | Rotation documented for `MIKROTIK_ENC_KEY`/install keys; **`DEVICE_SECRET` has no rotation path** → AF-07 / api-infra A-08 |

---

## 9. Risk score and priority

**Before: 7.5 / 10. After: 9 / 10.**

The remaining gap is deliberate and small: no per-session revocation (AF-05), and `DEVICE_SECRET`
rotation still requires reflashing every ESP32 (AF-07). Neither is worth building today.

### What reduced risk fastest

| # | Action | Status |
|---|--------|--------|
| 1 | **Bound the sliding session** (`ist` + 12 h cap) — turned a permanent credential back into a session | ✅ shipped |
| 2 | **Delete the dead password code** — removed a broken, untested auth surface and a password-hashing dep | ✅ shipped |
| 3 | **Enforce `iss`/`aud`** at all five sign/verify sites, from one frozen definition | ✅ shipped |
| 4 | **Read the role from the database**, closing the hand-edited-row window | ✅ shipped |
| 5 | 🔲 Lower `SESSION_MAX_HOURS` if ICTU wants tighter than 13 h worst-case | your call |

### Quick tests to validate the fixes

```bash
cd backend && npm test          # 299/299, incl. tests/jwtClaims.test.js

# AF-02 — a token with the RIGHT secret but no iss/aud must be refused
TOKEN=$(node -e "const j=require('jsonwebtoken');require('dotenv').config({quiet:true});\
console.log(j.sign({id:1,role:'admin',tv:0},process.env.JWT_SECRET,{algorithm:'HS256',expiresIn:'1h'}))")
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" localhost:3000/api/auth/me   # 401

# AF-03 — the password endpoints are gone
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH localhost:3000/api/users/me/password   # 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST  localhost:3000/api/users               # 404

# AF-01 — set SESSION_MAX_HOURS=0.01 (36s), sign in, wait, then call any endpoint past the
# token's half-life: the response carries NO X-Renewed-Token and the server logs
# "[AUTH] not renewing user=…".

# AF-04 — change a user's role directly in SQL WITHOUT bumping token_version, then call an
# admin-only endpoint with their existing token: it must now be refused, and the server logs
# the token/database role mismatch.
```

---

## 10. Hardening worth considering later

- **RS256 with a managed key pair.** Would let a verifier check tokens without holding a signing
  key. Real benefit only once something *other* than this backend verifies them — no second
  verifier exists, so HS256 with a 96-char secret is the right call today.
- **A `user_sessions` table keyed by `jti`** (AF-05) — buys per-device revocation and a
  "signed-in devices" screen.
- **ESP32 firmware version on connect** — turns "delete the deprecated `?deviceKey=` query
  channel once every box is reflashed" into a checkable condition, and makes `DEVICE_SECRET`
  rotation plannable (AF-07).
- **Lower `SESSION_MAX_HOURS` for a public deployment.** 12 h suits campus staff working a
  shift; 2–4 h would suit an internet-facing dashboard.

---

## 11. What was verified, and what was not

**Verified against the running backend:** the removed password endpoints return 404; a token
signed with the real `JWT_SECRET` but lacking `iss`/`aud` is rejected 401; `bcrypt.compare(x,
null)` throws (confirming the removed endpoint's 500); no frontend caller exists for either
removed function. 299/299 backend tests pass, `tsc --noEmit` clean.

**Unable to verify — stated rather than assumed:**

- **The full Google sign-in round trip was not exercised.** It needs a real CSPC Google account
  and a browser; a live auth code is one-time and cannot be replayed from a script. The
  code-exchange, `verifyIdToken`, domain-gate and status-branch logic were read, not run —
  though `tests/googleDomain.test.js` covers the domain gate as a pure unit.
- **The one-time logout from AF-02 was not observed**, because no browser session was open
  during the change. Expect to sign in once more after deploying.
- **`SESSION_MAX_HOURS` was not observed expiring** — proving it takes 12 hours, or the
  `SESSION_MAX_HOURS=0.01` recipe in §9.
- **`DEVICE_SECRET` entropy** was checked only for length (27 characters); whether it is random
  or a memorable phrase is not readable from the codebase.
