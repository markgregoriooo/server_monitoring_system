# Comprehensive Security Report — CSPC-ICTU Monitoring System

**Date:** 2026-08-25
**Prepared for:** CSPC ICTU / capstone review
**Consolidates four reviews of the same date** — read those for the full evidence per finding:

| Review | Prefix | File |
|---|---|---|
| API & Infrastructure | `A-` | [`api-infra-security-2026-08-25.md`](./api-infra-security-2026-08-25.md) |
| Authentication Flow | `AF-` | [`auth-flow-security-2026-08-25.md`](./auth-flow-security-2026-08-25.md) |
| Authorization | `AZ-` | [`authorization-review-2026-08-25.md`](./authorization-review-2026-08-25.md) |
| Business Logic | `BL-` | [`business-logic-review-2026-08-25.md`](./business-logic-review-2026-08-25.md) |

**Method:** static review of every route, middleware and service, plus **live verification against
the running backend** — every shipped fix was confirmed with a real HTTP request or a real
database round-trip, not just a passing test.

---

## 1. Executive Summary

### Overall posture: **MEDIUM before → LOW after** ✅

**No Critical vulnerabilities were found.** Nothing in this system allowed an unauthenticated
attacker to take it over, execute code, read the database, or escalate to admin. The genuinely
dangerous classes — SQL injection, authentication bypass, privilege escalation, CSRF — were all
clean, and several were clean *by design* rather than by luck (Google-only login removes password
attacks entirely; no cookies removes CSRF entirely).

**What the audit actually found was a pattern, and naming it is more useful than the list:**
five of the most serious code findings were **controls that existed, were documented, and were
enforced somewhere that could not enforce them** — or code left behind after the feature it served
was deleted.

- A consent gate written in React, which decides what renders, not what a token can do (BL-01)
- Photo-serving left mounted after the upload feature was deleted (A-02)
- Password endpoints left mounted after password login was deleted (AF-03)
- An AC config endpoint left mounted after nothing called it (AZ-01)
- A last-admin guard that checked, then acted, without holding a lock (BL-02)

That is a **maintenance** signature, not an insecure-design signature. The design is sound; the
gap is that deletions were done halfway. The one exception is **H-4**, the dependency cluster —
24 advisories, 15 of them high, on the WebSocket transport. Those are upstream defects, and the
gap there was simply that nobody was running `npm audit`.

### Vulnerabilities by severity

| Severity | Found | Fixed | Open |
|---|---|---|---|
| 🔴 **Critical** | **0** | — | 0 |
| 🟠 **High** | **4** | **4** | 0 |
| 🟡 **Medium** | **5** | **4** | 1 *(partial — needs a firewall rule)* |
| 🟢 **Low** | **8** | **7** | 1 *(accepted)* |
| ⚪ Informational / N-A | 5 | — | 5 |
| **Total actionable** | **17** | **15** | **2** |

Counting **dependency** CVEs separately, since they are upstream rather than code defects:
**24 advisories** (15 high, 8 moderate, 1 low) across both packages → **22 remediated**, 2
build-tool-only accepted (H-4).

**15 fixes shipped today.** 303/303 backend tests pass (26 new), 0 TypeScript errors, backend
boots clean.

### Immediate actions required (yours, not code)

| # | Action | Why it can't be code | Effort |
|---|---|---|---|
| 1 | **Decide on the 12 staff photos in git history** — they're in `origin/main` since 2026-05-14 | History rewriting is a shared-repo decision | 5 min or 30 min |
| 2 | **Firewall TCP/3000** at deployment (`deployment-guide.md` §9.1) | The port must stay open to the LAN for agents + ESP32 | 5 min |
| 3 | **Back up `backend/.env` somewhere that is NOT the offsite backup drive** | It now holds the only key that can re-deliver an agent token | 5 min |
| 4 | **Verify the nginx CSP in a browser before go-live** (§5.3.1) | Needs nginx + a browser; the Google sign-in script is what breaks | 10 min |

---

## 2. Critical Vulnerabilities — **none found**

No CVE-class or Critical-severity issues. For the record, these were specifically checked and
found clean:

| Class | Result | Evidence |
|---|---|---|
| SQL injection | ✅ Clean | Every query parameterised; the only template-literal SQL is a constant `SELECT` prefix with a parameterised `WHERE` |
| Authentication bypass | ✅ Clean | `jwt.verify` with pinned `algorithms`, plus a **per-request database check** of `status` + `token_version` |
| Privilege escalation | ✅ Clean | No route accepts `role`/`status` from a non-admin; frozen allow-lists; last-admin guard |
| Remote code execution | ✅ Clean | No `eval`, no `child_process` with user input (`icmpPing` spawns an argv **array**, no shell, host re-validated as an IP) |
| Path traversal | ✅ Clean | Report downloads resolve via `path.basename` + a `startsWith(REPORTS_DIR)` check; `format` is a two-value allow-list |
| CSRF | ➖ N/A | No cookies anywhere — Bearer token from `sessionStorage`. Structurally impossible |
| Dependency CVEs | ✅ **Resolved** | `npm audit` run after the fact: 24 advisories found, 22 fixed — see H-4 |

---

## 3. High Priority — all four fixed ✅

### H-1 · A-01 · No HTTP security headers · CWE-693, CWE-1021

**Evidence:** `backend/src/server.js:169-176` (before). The middleware stack was
`express.static → cors → express.json → trust proxy → globalLimiter → routes`. No header
middleware existed anywhere in the repo.

**Why it matters.** This dashboard **actuates hardware** — the AirConditioner toggle sends an
`irCommand` to the ESP32, and Alert Rules rewrites the thresholds the firmware alarms on. Without
`X-Frame-Options`/`frame-ancestors`, an invisible framed dashboard turns "click here" on any page
a signed-in staffer visits into a physical action. Additionally: no `nosniff` on a report
download whose filename comes from user input, no HSTS for the coming TLS hostname, and
`X-Powered-By: Express` naming the stack for free.

**PoC:** `curl -sI http://<host>:3000/api/policy/version` → only `X-Powered-By: Express`.

**Fix — shipped:** new `backend/middleware/securityHeaders.js`, mounted *before* routes and
*before* the limiter so a 429 and a 404 carry the headers too. See §8 for the code.

**Verified live** on both a 200 and a 404; `X-Powered-By` gone; HSTS correctly absent over plain
HTTP.

---

### H-2 · A-02 · `/uploads` served staff photos unauthenticated · CWE-548, CWE-359

**Evidence:** `backend/src/server.js:169` → `app.use("/uploads", express.static("uploads"))`,
serving **23 real staff profile photos** with no token and no role check, mounted above every
auth gate.

**Why it matters.** The avatar-upload feature was deleted when login went Google-only
(`middleware/upload.js` gone, `PATCH /users/me` no longer multipart) — the **writer** was removed
and the **reader** was left behind. It was also proxied through nginx in the deployment guide, so
it was reachable from outside. This system makes every user accept a Privacy Notice under
**RA 10173**; that notice does not describe a public photo directory.

**PoC:** `curl -o /dev/null -w '%{http_code}' http://<host>:3000/uploads/<file>.jpg` → `200`.

**Fix — shipped:** mount removed; `avatarUrl()` now returns `null` for non-absolute paths so a
legacy row degrades to initials rather than a broken image; the nginx `location /uploads/` block
removed from the deployment guide. **Verified: 404.**

> ### ⚠️ Correction to an earlier draft — this one matters
> The first version of the API audit said the folder was `.gitignore`d and therefore *"never
> committed… no repository exposure."* **That was wrong.** It came from spot-checking one
> filename; `.gitignore` has no effect on files already tracked.
>
> ```
> git ls-files backend/uploads/  →  12 files tracked
> git log --diff-filter=A        →  d2db711, 2026-05-14
> git branch -r --contains       →  origin/main       ← on GitHub
> ```
>
> **12 of the 23 photos have been in the GitHub repo since May.** Mitigating: `gh repo view`
> confirms the repository is **PRIVATE**, so the audience is the owner and collaborators, not the
> public. The files are now deleted from disk. **Open decision** — see §7.

---

### H-3 · A-05 · Agent tokens stored in plaintext, and shipped offsite nightly · CWE-256, CWE-522

**Evidence:** `services/agentService.js:298` minted `"AGT-" + randomBytes(24).toString("hex")`
and stored it **verbatim**; `:343` compared strings.

**Why it matters — this was not "if someone breaches the database".**
`ops/db-backup/dump-mysql.sh` dumps the whole database into `BACKUP_DIR` — a micro SD or USB
drive in the server room — as **gzip, not encrypted**. Every agent credential (permanent,
non-expiring, sufficient to forge metrics and thereby suppress or fabricate alerts) sat in
plaintext on removable media. `agent_install_keys` one table over was protected from exactly this
in `2026-08-15b_install_key_reveal.sql`; agent tokens never got the same treatment.

> ⚠️ **Corrected after the database audit.** An earlier draft of this section said the dump was
> *"leaving the building nightly, in a file on cloud storage."* That overstated it: offsite sync
> is **not enabled** (every `BACKUP_OFFSITE_*` var is blank), and when it is, rclone's `crypt`
> remote encrypts data **and** filenames client-side. The exposure is removable media and
> anyone with file access on the server — not the cloud. The finding and the fix stand; the
> severity story is narrower than first written. See `database-security-2026-08-25.md` DB-06.

**Fix — shipped:** `migrations/2026-08-25_agent_token_hash.sql` — two columns replace one, because
the plaintext was doing two jobs:

| Column | Job | Why it can't be the other |
|---|---|---|
| `approved_token_hash` CHAR(64) unique | **Lookup**, every metric POST | SHA-256 not bcrypt: 192 bits of CSPRNG has no dictionary to slow, and a slow hash would make the hottest query in the system scan instead of index |
| `approved_token_cipher` | **Re-delivery**, AES-256-GCM | A hash answers *"is this the token?"*, never *"what was the token?"* |

**The re-delivery column is why the obvious fix was wrong.** The first attempt cleared the
plaintext on first use ("proof of delivery") — which silently breaks recovery:
`agent/cmd/agent/main.go:57` runs enrolment **only when `config.Load` fails**, so every
`/agents/register` call is a machine that lost its `agent.conf`, and `register()` answers by
handing back the same pending token to exchange at `/agents/status`. That one path carries both
agent.conf recovery **and** the documented ADOPT workflow. Encrypting instead of discarding keeps
both behaviours identical.

**Verified end-to-end against the real database** — register → approve → decrypt re-delivery →
authenticate → reject a forgery → and the one that matters:

```
7. the HASH itself is not a token  : true    ← a stolen dump authenticates nothing
```

---

### H-4 · Dependency CVEs on the WebSocket path · CWE-1395, CWE-400

**Found by running `npm audit` after the code review** — it was the one OWASP category (A06) the
first pass had marked *Unable to verify*, and it turned out to be the single largest cluster of
issues in the whole audit.

```
backend   10 advisories  (5 high, 5 moderate)
frontend  14 advisories  (10 high, 3 moderate, 1 low)
```

**Why it matters here specifically.** The high-severity ones sit on the **long-lived WebSocket
transport this system depends on**:

| Package | Installed | Advisory |
|---|---|---|
| `ws` | 8.18.3 | Memory-exhaustion DoS from tiny fragments; uninitialised memory disclosure |
| `socket.io-parser` | 4.2.5 | Unbounded binary attachments; zero-attachment memory exhaustion |
| `engine.io` | 6.6.6 | Same transport family |
| `path-to-regexp` | <0.1.13 | ReDoS in Express routing |
| `axios`, `react-router`, `postcss`, `nanoid` | — | Frontend runtime + build chain |

A memory-exhaustion DoS against a **monitoring** backend is worse than against an ordinary app:
the failure takes down the thing that would have told you something failed.

⚠️ **The handshake limiter (M-4) does not mitigate these.** That limiter counts *failed
authentications*; these advisories are exploited at the **parser and transport layer, before any
auth runs**. Two independent controls on the same path — worth stating plainly rather than
assuming one covers the other.

**Fix — shipped.** All backend fixes were semver-compatible, so `npm audit fix --omit=dev` was
sufficient:

```
backend:  10 vulnerabilities → 0        ws 8.18.3→8.21.3, socket.io-parser 4.2.5→4.2.7,
                                        engine.io 6.6.6→6.6.9, express 4.22.1→4.22.2,
                                        path-to-regexp →0.1.13
frontend: 14 → 2                        axios, react-router(-dom), postcss, nanoid,
                                        form-data, picomatch, ws, socket.io-parser, …
```

**Verified after upgrading:** 303/303 backend tests pass, the backend boots, **REST answers 200
and the Socket.IO handshake still negotiates** (`0{"sid":"…","upgrades":["websocket"]}`),
`tsc --noEmit` clean, and a full `npm run build` succeeds.

**The 2 remaining (accepted):** `vite` and `esbuild`, which need a **major** bump to `vite@8`.
Both are **build-tooling, not runtime** — the esbuild advisory concerns the *dev server*, and
production is static files served by nginx, so neither ships to users. A major Vite upgrade
mid-capstone is a larger risk than the exposure. Revisit after the defence.

---

## 4. Medium Priority — 4 fixed, 1 partial

### M-1 · BL-01 · The consent gate could not enforce consent · CWE-602, CWE-841 ✅

**Evidence:** the *entire* enforcement was `frontend/src/App.tsx:138`. A grep for
`policy_version`/`policyService` across `backend/routes/` and `backend/middleware/` returned
nothing outside `routes/policy.js`.

**Why it matters.** `App.tsx` decides what React **renders**, not what the **token** can do. This
is the same mistake `CLAUDE.md` explicitly rejects for the login page — *"a checkbox… would be a
client-side flag, bypassable by clearing sessionStorage"* — and a gate in `App.tsx` is a
client-side flag too. The RA 10173 position rests on consent recorded **before** use, and
`policyService.accept` is the one audit write deliberately **not** best-effort *because the audit
row is the evidence*.

**Confirmed live, not hypothesised** — 2 of 4 active accounts had never accepted yet held fully
working sessions:

```
#1  supremeoasd | accepted: 2026-08-11      #10 micarulla | accepted: (never)  ← valid session
#9  raaguirre   | accepted: 2026-08-11      #11 doparina  | accepted: (never)  ← valid session
```

**Fix — shipped** in `middleware/auth.js`, reusing the row already read for the liveness check
(**no extra query**). 403 not 401, because `api/client.ts` logs out on 401 and deliberately not on
403 — a 401 would have looped the sign-in for exactly the users being prompted. Scoped to
**mutating** methods: every write lands an attributable `system_logs` row, and consent should
precede an attributable action. See §8 for the code.

**Verified:** reads 200/200, writes 200/**403**, `POST /policy/accept` still 200 (or the gate
would trap them).

---

### M-2 · BL-02 · Last-admin guard was check-then-act · CWE-367, CWE-362 ✅

**Evidence:** `services/userService.js` — `countOtherActiveAdmins()` (a plain `SELECT COUNT(*)`)
followed by a *separate* write, at three call sites (`updateUser`, `updateUserStatus`,
`deleteUser`). No transaction, no locking.

**Why it matters.** Two admins demoting each other simultaneously: both read `n = 1`, both guards
pass, both writes land → **zero admins**. Unrecoverable from inside the app — nobody can approve a
registration or promote anyone, and login is Google-only with self-registration landing in
`pending`. The documented way out is editing MySQL by hand.

**Fix — shipped:** one locking helper used by all three sites, guard and write in the **same**
transaction. **`FOR UPDATE` is the fix, not the count** — a plain `SELECT` under REPEATABLE READ
hands both transactions the same stale snapshot, which is exactly how the bug worked.
`countOtherActiveAdmins` was deleted rather than left as a tempting non-locking shortcut.

---

### M-3 · AF-01 · Sliding session had no ceiling · CWE-613 ✅

**Evidence:** `middleware/auth.js:16-30` re-issued a fresh 1 h token on every request past the
current one's half-life, with no absolute cap.

**Why it matters.** A sliding window with no ceiling is not a session — it is a permanent
credential that rewrites itself. This dashboard polls constantly and is designed to live on a
wall display, so any token renewed forever; a **stolen** one could be kept alive indefinitely just
by using it.

**Fix — shipped:** an `ist` ("issued session time") claim, stamped once and preserved across every
renewal, plus `SESSION_MAX_HOURS` (default 12). Past the cap it **stops renewing** rather than
401-ing, so the token dies at its own `exp` and the client's existing expiry path handles it
gracefully. Worst case a session lives cap + 1 h.

⚠️ **A bug this nearly introduced:** `jwt.sign` **throws** if an option duplicates a payload claim.
Verified — stripping only the time claims gives
`Bad "options.audience" option. The payload already has an "aud" property`. So `iss`/`aud` had to
be stripped alongside `iat`/`exp`/`nbf`, or **every renewal would 500** — and only for users past
a token's half-life, which no quick manual test reaches. Pinned in `tests/jwtClaims.test.js`.

---

### M-4 · A-04 · Socket.IO handshake had no rate limit · CWE-307, CWE-770 ✅

**Evidence:** `globalLimiter` is **Express** middleware. `new Server(httpServer)` installs its own
`request` listener and answers `/socket.io/` itself, so Express is never invoked for those
requests.

**Why it matters.** The handshake accepts `DEVICE_SECRET` — a single static secret shared by every
ESP32, with no rotation and no lockout — and every handshake carrying a well-formed JWT costs a
`fetchSessionRow` query out of a MySQL pool of **10** shared with both pollers, agent POSTs and
every dashboard request. Every HTTP credential path was throttled; this one was not.

**PoC — reproduced:** driving the Engine.IO polling handshake by hand, 55/55 attempts answered
with no throttling.

**Fix — shipped:** `services/handshakeLimiter.js` (pure, 13 tests). **It counts failures only, and
a success clears the key** — a plain per-IP connection cap would be the self-inflicted DoS this
codebase already documents for the global limiter, since behind nginx every browser socket arrives
from `127.0.0.1`. **Verified: blocked on attempt 51.**

---

### M-5 · A-03 · `trust proxy` hardcoded · CWE-348 ⚠️ **partial — needs a firewall rule**

**Evidence:** `src/server.js:174` → `app.set("trust proxy", 2)`.

**Why it matters.** That number decides how many `X-Forwarded-For` entries are *believed*. Set
higher than reality and the surplus are attacker-supplied: the client picks its own `req.ip`,
hence its own bucket in every IP-keyed limiter (sign-in 30/15 min, agent enrolment 30/15 min,
metric ingest) **and its own value in `system_logs.ip_address`** — the row that is the evidence
for a Privacy Notice acceptance.

`2` is correct for the documented path (ICTU edge → campus nginx → backend). It is exploitable
anyway, because `server.listen(PORT, "0.0.0.0")` means **port 3000 is directly reachable from the
campus LAN** — and that is *required*, since the ESP32 and Go agents connect to it directly.

**Fix — partial.** `TRUST_PROXY` is now env-configurable with the default unchanged. **Code cannot
finish this one.** The remaining control is network-level:

```bash
sudo ufw allow 22/tcp                                          # BEFORE enable, or you lock yourself out
sudo ufw allow 80/tcp                                          # nginx — browsers
sudo ufw allow from <AGENT_SUBNET> to any port 3000 proto tcp  # agents + ESP32 only
sudo ufw deny 3000
sudo ufw enable
```

Written up as `deployment-guide.md` **§9.1** with verification steps.

---

## 5. Low Priority — 7 fixed, 1 accepted

| ID | Issue | Status |
|---|---|---|
| **AF-03** | **Dead password code still mounted** — `bcrypt` endpoints with no login path. Not just unused: every account is a Google account so `hash_password` is NULL, and `bcrypt.compare(x, null)` **throws** → the endpoint answered **500** to every user who could reach it. Removed both routes, both service methods, `bcryptjs`, and two dead frontend functions. **Verified: both 404** | ✅ Fixed |
| **AF-02** | **JWT carried no `iss`/`aud`** — any token signed with the secret was accepted as a session. Now enforced at all five sign/verify sites from one frozen definition. **Verified: a token with the real secret but no claims → 401** | ✅ Fixed |
| **AF-04** | `requireRole` trusted the **token's** role. Safe normally (role changes bump `token_version`) — but a role edited directly in SQL bumps nothing, and that is the documented way the first admin is made. Role now read from the row already fetched | ✅ Fixed |
| **AZ-01** | `GET /api/aircon/channels` — unauthenticated **and called by nothing**. The ESP32 gets the same payload as the `irConfig` socket event on a `DEVICE_SECRET`-authenticated connection; the dashboard reads it behind a JWT. Disclosed the AC inventory to anyone reaching port 3000. **Verified: 404** | ✅ Fixed |
| **A-07** | `express.json()` limit inherited, not stated, with no recorded relationship to `MAX_BATCH = 60`. Now explicit (`100kb`) plus an explicit `maxHttpBufferSize` | ✅ Fixed |
| **BL-05** | Report period accepted an unbounded span — `periodStart: "2000-01-01"` scheduled Flux queries over 26 years, asynchronously, so the request looked fine. Capped at 366 days (**rejected, not clamped** — a report whose title claims one range and whose contents are another is worse than an error). **Verified: 400 at 9733 days, 202 at 24** | ✅ Fixed |
| **A-06** | `WEB_ORIGIN=*` reflects **any** origin. Current `.env` uses an explicit allow-list and `credentials` is off, so this is not exploitable today — but `*` is documented as a convenience, which is how it survives into production | ⏳ Guard rail recommended (§8) |
| **BL-03** | `raiseAlert` de-dup is check-then-insert — two raisers in the same millisecond can double-notify | ✅ **Accepted.** Failure direction is *safe* (an extra alert, never a missing one), window is milliseconds. Generated-column unique index in BL §4 if ever observed |

---

## 6. Informational / Not Applicable

| ID | Item | Note |
|---|---|---|
| **BL-04** | A compromised agent can fabricate its own metrics | Inherent to agent-based monitoring — the agent *is* the sensor. Blast radius correctly bounded: the token authenticates **one** device, samples are written under `req.device.device_id` from the token, and the one client value with a safety consequence (`metric_interval_sec`) is bounded 1–3600 s so offline detection cannot be disabled |
| **AZ-02** | Reports readable by any staffer regardless of author | By design and documented — the list is shared, and a report contains telemetry both roles can already read live. Downloads are audited |
| **AZ-04 / AF-05** | No `jti`; no API-token scopes | Revocation is per-user via `token_version`. Credentials are already separated **by route** (an agent token reaches 2 ingest routes and nothing else) — formal scopes would add ceremony without changing that |
| **AZ-03** | `it_staff` can read the audit trail incl. other users' IP + user-agent | **A policy question, not a flaw.** `historyService.getHistory` already accepts a `userId` filter, so narrowing is two lines — but it also removes the shared-operations timeline. **Your call**, ideally with the DPO |
| **A-08 / AF-07** | `DEVICE_SECRET` has no rotation path; `?deviceKey=` query channel deprecated with no removal trigger | Rotation currently means reflashing every ESP32. Recommended: have the firmware report its version on connect — that turns "delete the fallback someday" into a checkable condition |

---

## 7. Open decisions — yours, not code

### D-1 · The 12 staff photos in git history

They're in `origin/main` since 2026-05-14. The repo is **private**. Files are already off disk.

```bash
# Step 1 — always do this (they're deleted but unstaged)
git add -A backend/uploads
git commit -m "chore: remove committed staff profile photos"

# Step 2 — ONLY if you decide to purge history
git filter-repo --path backend/uploads --invert-paths
git push --force origin main
```

⚠️ Step 2 rewrites shared history: every clone must be re-cloned. **Recommendation: do step 1,
skip step 2.** The repo is private and force-pushing near a defence is the larger risk. Either
choice is defensible — make it deliberately. **Also review who has access to that repository** —
private means "whoever you granted", and that is the actual audience these photos have had.

### D-2 · Should the consent gate cover reads as well as writes?

One term to delete (`MUTATING.has(...)`). Stricter, but risks blocking the screen a user needs in
order to accept. A DPO question.

### D-3 · Should `it_staff` see other users' IPs in History? (AZ-03)

Two lines either way. Raise alongside the Privacy Notice review the project already owes ICTU.

### D-4 · Never change `MIKROTIK_ENC_KEY` / `SECRET_ENC_KEY` once agents are approved

Changing it makes stored ciphers undecryptable. Running agents are unaffected (lookup is by hash);
only re-delivery breaks. **Back `.env` up somewhere that is NOT the offsite drive** — putting the
key beside the encrypted dump undoes the encryption.

---

## 8. Secure code examples — one per vulnerability class found

**Security headers** (`middleware/securityHeaders.js`) — hand-written, not `helmet`, because
Express here serves **JSON only**; the dashboard's HTML comes from nginx, so the page CSP belongs
there (`deployment-guide.md` §5.3.1):

```js
res.removeHeader("X-Powered-By");
res.setHeader("X-Content-Type-Options", "nosniff");
res.setHeader("X-Frame-Options", "DENY");
res.setHeader("Content-Security-Policy",
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
res.setHeader("Referrer-Policy", "no-referrer");
// HSTS only over real TLS — on a plain-HTTP LAN it would pin http://<ip>:3000 to HTTPS
// in every staff browser and lock them out of a host with no certificate.
if (HSTS_MAX_AGE > 0 && req.secure) {
  res.setHeader("Strict-Transport-Security", `max-age=${HSTS_MAX_AGE}`);
}
```

**Credential at rest — hash to compare, encrypt only when it must be read back:**

```js
// LOOKUP: one indexed comparison. SHA-256, not bcrypt — 192 bits of CSPRNG has no
// dictionary to slow, and a slow hash would make the hottest query in the system scan.
`WHERE t.approved_token_hash = ? AND t.status = 'approved'`   [hashKey(token)]

// RE-DELIVERY: encryption is REQUIRED, never a silent downgrade to plaintext.
if (!secretCrypto.isConfigured()) throw unavailable("Cannot approve: no encryption key…");
[hashKey(approvedToken), secretCrypto.encrypt(approvedToken), deviceId]
```

**Enforce a policy gate where the credential is checked, not in the view:**

```js
if (MUTATING.has(req.method) &&
    !POLICY_EXEMPT.test(req.originalUrl) &&
    sessionRow.policy_version !== policyService.POLICY_VERSION) {
  return res.status(403).json({           // 403, not 401 — the session IS valid;
    error: "You must accept the Privacy Notice and Terms before making changes.",
    code: "policy_not_accepted",          // a 401 would loop the client's sign-in
  });
}
const POLICY_EXEMPT = /^\/api\/(policy|auth)(\/|$)/;   // or the gate traps its own escape route
```

**Check-then-act → one transaction with a locking read:**

```js
async function assertNotLastAdmin(conn, excludeId) {
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS n FROM users
      WHERE role = 'admin' AND status = 'active' AND user_id <> ?
      FOR UPDATE`,                       // ← the lock is the fix, not the count
    [excludeId],
  );
  if (Number(row?.n ?? 0) === 0) throw lastAdminError();
}
```

**Bound a sliding session:**

```js
const sessionStart = decoded.ist ?? iat;          // `ist` survives every renewal
if (now - sessionStart >= SESSION_MAX_SEC) return;  // stop RENEWING, don't 401 mid-action
const { iat: _i, exp: _e, nbf: _n, iss: _s, aud: _a, ...claims } = decoded;  // ← must strip iss/aud
const renewed = jwt.sign(claims, JWT_SECRET, { ...JWT_SIGN_OPTS, expiresIn: RENEW_TTL });
```

**Rate-limit a credential endpoint without DoS-ing your own users** — count failures, clear on
success (behind nginx every browser shares one address):

```js
if (handshakeLimiter.isBlocked(peer)) return next(new Error("Too many failed connection attempts"));
// …on success:
handshakeLimiter.recordSuccess(peer);
```

**Recommended, not yet applied — refuse `WEB_ORIGIN=*` in production (A-06):**

```js
if (WEB_ORIGIN === "*" && process.env.NODE_ENV === "production") {
  console.error("[CONFIG] WEB_ORIGIN=* is not permitted in production — set the real origin(s).");
  process.exit(1);   // a boot failure with a clear cause beats a silently open API
}
```

---

## 9. Testing guide — verify every fix

```bash
cd backend && npm test          # 303/303, 0 failures
cd ../frontend && npx tsc --noEmit
```

```bash
API=http://127.0.0.1:3000

# H-1 · security headers on a 200 AND a 404; no X-Powered-By; no HSTS over plain HTTP
curl -sI $API/api/policy/version | grep -iE 'x-frame|x-content|content-security|referrer|powered'
curl -sI $API/nope               | grep -i x-frame

# H-2 · the photo reader is gone
curl -s -o /dev/null -w '%{http_code}\n' $API/uploads/a3815b047e1b435e06f1f5837444ccce.jpg   # 404

# AZ-01 · the unauthenticated AC endpoint is gone; the guarded ones still refuse
for p in /api/aircon/channels /api/aircon /api/alert-rules /api/alerts /api/history /api/users; do
  printf '%-24s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' $API$p)"
done                                    # 404, then 401 ×5

# AF-03 · password endpoints removed
curl -s -o /dev/null -w '%{http_code}\n' -X PATCH $API/api/users/me/password   # 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST  $API/api/users              # 404

# AF-02 · a token signed with the REAL secret but no iss/aud must be refused
TOKEN=$(node -e "const j=require('jsonwebtoken');require('dotenv').config({quiet:true});\
console.log(j.sign({id:1,role:'admin',tv:0},process.env.JWT_SECRET,{algorithm:'HS256',expiresIn:'1h'}))")
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" $API/api/auth/me   # 401

# BL-05 · report period cap
curl -s -X POST -H "Authorization: Bearer <valid>" -H 'Content-Type: application/json' \
  -d '{"type":"alerts","periodStart":"2000-01-01","periodEnd":"2026-08-25"}' $API/api/reports
# → 400 {"error":"Report period cannot exceed 366 days (requested 9733)."}
```

**M-4 · handshake throttle** — drive the Engine.IO polling handshake with a wrong `x-device-key`
~55 times; attempt 1 returns `Invalid device key`, attempt 51 returns
`Too many failed connection attempts`.

**M-1 · consent gate** — with a token for a user whose `policy_version` is NULL:
`GET /api/servers` → 200, `PATCH /api/users/me` → **403 `policy_not_accepted`**,
`POST /api/policy/accept` → 200.
> ⚠️ **Use a throwaway account.** Calling `accept` writes a real consent record — `users.policy_version`
> **and** a `system_logs` row. During this audit that happened to user #10 and was reverted in a
> single transaction (verified: `false consent rows remaining: 0`). An audit that fabricates the
> record it is auditing is worse than no audit.

**M-2 · last-admin race** — fire two concurrent `PATCH /api/users/:id {role:"it_staff"}` with two
admin tokens, where those two are the only active admins. Exactly one must succeed; then
`SELECT COUNT(*) FROM users WHERE role='admin' AND status='active';` must be ≥ 1.

---

## 10. Compliance

### OWASP Top 10 (2021)

| # | Category | Status | Findings |
|---|---|---|---|
| **A01** | Broken Access Control | ✅ **Pass** | 99 routes enumerated: 75 JWT (33 role-gated), 2 agent-token, 5 deliberately unauthenticated. One dead open endpoint removed (AZ-01). Per-user data scopes on `req.user.id`; **no route takes a subject id from URL/body/query** |
| **A02** | Cryptographic Failures | ✅ **Fixed** | Agent tokens hashed + encrypted (H-3). Install keys and MikroTik passwords already were. `JWT_SECRET` 96 chars, boot-checked ≥32 |
| **A03** | Injection | ✅ **Pass** | All SQL parameterised; Flux presets whitelisted and custom bounds re-serialised from `Date`; `icmpPing` spawns an argv array, no shell |
| **A04** | Insecure Design | ⚠️ **Improved** | The consent gate was designed correctly and *placed* wrongly (M-1). Now enforced at the credential check |
| **A05** | Security Misconfiguration | ✅ **Fixed** | Headers added (H-1), `X-Powered-By` off, body limits explicit, `TRUST_PROXY` configurable, dead endpoints removed |
| **A06** | Vulnerable Components | ✅ **Fixed** | 24 advisories found, **22 remediated** (H-4). Backend 10→0, frontend 14→2. The 2 left are build-tool-only (`vite`/`esbuild`), not shipped to users |
| **A07** | Identification & Authentication | ✅ **Fixed** | Google OIDC auth-code flow, audience enforced, `email_verified` checked; session capped (M-3); `iss`/`aud` enforced; per-request DB revocation check |
| **A08** | Software & Data Integrity | ✅ **Pass** | Go↔Node metric contract guarded by a parsing test; Node↔SQL hash contract likewise; no unsigned auto-update path |
| **A09** | Logging & Monitoring Failures | ✅ **Pass** | Denied sign-ins audited (not just successes); `[RATE]`/`[AUTH]`/`[POLICY]` logs; `system_logs` retention 365 d. No passwords, tokens or reset links logged |
| **A10** | SSRF | ➖ **N/A** | No user-supplied URL is fetched. SNMP/ICMP/RouterOS targets come from admin-registered `devices` rows and are re-validated as IPs |

### PCI DSS — ➖ **Not Applicable**

No payment, cardholder, or financial data exists anywhere in the schema or code. No cardholder
data environment to scope.

### GDPR — ➖ **Not Applicable as written; RA 10173 applies instead**

CSPC is a Philippine institution processing data of Philippine staff and students; there is no EU
establishment and no EU-subject monitoring, so GDPR does not attach. **The Data Privacy Act of
2012 (RA 10173) does**, and it is structurally similar — the project already treats it as binding.
Status against the principles that overlap:

| Principle | Status |
|---|---|
| Lawful basis / consent recorded | ✅ **Now enforceable** — was client-side only (M-1). `policyService.accept` writes acceptance **and** its audit row in one transaction |
| Transparency | ✅ Notice lives in one component, rendered by both the gate and the **public** `/privacy` page — the text you agree to is the text anyone can read |
| Data minimisation | ✅ **Improved** — 23 staff photos no longer served (H-2); the upload path is gone entirely |
| Storage limitation | ✅ Every table has a purge: alerts 30 d, reports 90 d, `system_logs` 365 d, backups 30 d |
| Integrity & confidentiality | ✅ **Improved** — credentials no longer plaintext in the nightly offsite dump (H-3) |
| Accountability | ✅ Audit trail with actor, IP, user-agent; exports audited as data leaving the system |
| **Breach-notification readiness** | ⚠️ **Gap** — no documented incident-response procedure. See §11 |

⚠️ **The Privacy Notice text is accurate but is a binding institutional commitment. It needs
ICTU/DPO review before go-live** — and the retention figures in it must be changed whenever the
code's are.

### SOC 2 — ➖ Not a certification target; relevant criteria mapped

| Criterion | Status |
|---|---|
| CC6.1 Logical access | ✅ RBAC deny-by-default, MFA delegated to Google Workspace |
| CC6.2 Registration/authorisation | ✅ Self-register → admin approve; agent enrolment likewise |
| CC6.3 Access removal | ✅ `token_version` revocation + a 30 s socket sweep |
| CC6.6 Boundary protection | ⚠️ **Depends on the §9.1 firewall rule at deployment** (M-5) |
| CC6.7 Transmission | ⚠️ TLS terminates at ICTU's edge; campus hop is plain HTTP by design |
| CC7.2 Monitoring | ✅ This *is* a monitoring system; alerting, audit trail, retention |
| CC7.3/7.4 Incident response | ❌ **No documented IR procedure** — §11 |
| A1.2 Backup/recovery | ✅ 3-2-1: NDJSON stream mirror + nightly mysqldump + encrypted Backblaze offsite |

---

## 11. Recommendations

### Implementation priorities

1. **Do the four immediate actions in §1** — three are ≤5 minutes and one is a decision.
2. **Put `npm audit` in CI.** It found the largest cluster of issues in this audit (H-4) and it is
   one command — the gap was that nobody was running it, not that anything was hard to fix.
3. **Hash `agent_tokens.token`** (the short pending token) — the last plaintext credential. It
   needs the agent side reworked with it, so it is its own change.
4. **ESP32 firmware version on connect** — makes `DEVICE_SECRET` rotation plannable and turns
   "delete the deprecated `?deviceKey=` channel" into a checkable condition.

### Security tools to adopt

| Tool | Why here |
|---|---|
| `npm audit` in CI (or a weekly cron) | Closes A06; you already have a `/loop` and cron capability |
| **`git-secrets` or `gitleaks` pre-commit** | The `.env`/photos episode is exactly what it catches. `.gitignore` did not stop 12 photos being committed, because it never applies to already-tracked files |
| Dependabot / Renovate on the private repo | Free, and the repo is already on GitHub |
| `eslint-plugin-security` | Cheap static catch for `eval`, non-literal `fs` paths, unsafe regex |

### Process improvements

1. **When you delete a feature, grep for its readers.** Three of today's findings (H-2, AF-03,
   AZ-01) are the same mistake: writer removed, reader left mounted. A one-line habit —
   `grep -rn "<route path>" backend/ frontend/ iot/` before considering a deletion done — would
   have caught all three.
2. **`.gitignore` is not a remediation.** It has no effect on tracked files. Verify with
   `git ls-files <path>`, not `git check-ignore` on one filename — that is precisely the error the
   first draft of the API audit made.
3. **Write an incident-response note** — even one page: who is contacted, how a device is
   isolated, how tokens/keys are revoked (you now have per-key revocation with blast-radius
   listing), and the RA 10173 72-hour notification obligation. This is the largest remaining
   compliance gap and it is documentation, not code.
4. **Keep the audit convention.** Dated files, IDs, status per finding, and a "what I could not
   verify" section. It is already better than most professional reports, and it is why this
   consolidation was possible.

### Training needs

- **The class of bug found today**, for whoever maintains this: *a control enforced in the wrong
  layer is not a control.* The consent gate, the client-side role, and the deleted-feature readers
  are all one lesson.
- **Concurrency basics** — check-then-act vs a locking read (M-2). One concrete example is enough.
- **Credential storage decision tree** — hash when you only compare; encrypt only when a human or
  a machine must read it back; never plaintext. The codebase now demonstrates all three.

---

## 12. Summary risk score

| Domain | Before | After |
|---|---|---|
| API & Infrastructure | 6.5 / 10 | **9.0** |
| Authentication | 7.5 / 10 | **9.0** |
| Authorization | 8.5 / 10 | **9.5** |
| Business Logic | 7.0 / 10 | **9.5** |
| **Overall** | **7.4 / 10** | **9.2 / 10** |

*(Higher is better — these are posture scores, not risk scores.)*

### Top 5 remaining, in the order that reduces risk fastest

| # | Action | Owner | Effort |
|---|--------|-------|--------|
| 1 | **Firewall TCP/3000** (§9.1) — completes M-5, the only partially-fixed Medium | you, at deployment | 5 min |
| 2 | **Decide the git-history question** (D-1) and commit the deletion | you | 5–30 min |
| 3 | **Back up `.env` off the offsite drive** (D-4) — it now holds the only agent-token recovery key | you | 5 min |
| 4 | **Plan the `vite@8` upgrade** after the defence — the last 2 advisories (build-tool only) | either | 1 h |
| 5 | **Verify the nginx CSP in a browser** before go-live — a wrong CSP blocks Google sign-in and locks everyone out | you | 10 min |

---

## 13. What was verified, and what was not

**Verified against the running backend and the live database:** all response headers on a 200 and
a 404; `/uploads` and the removed password/aircon endpoints returning 404; a real-secret token
without `iss`/`aud` rejected 401; the handshake budget blocking on attempt 51; the full
agent-token lifecycle end-to-end (including that the stored hash does **not** authenticate); the
consent gate across reads, writes and the accept path with real signed tokens for two users; the
report-period cap at 9733 days and 24 days. **303/303 backend tests (26 new), 0 TypeScript
errors.** Test artefacts created during verification (a report, a false consent record) were
removed and re-checked.

**Unable to verify — stated rather than assumed:**

- **Dependency upgrades were verified by test suite, typecheck, build and a live Socket.IO
  handshake — not by exercising each CVE.** That the advisories no longer appear is `npm audit`'s
  assertion, not an independent confirmation.
- **The nginx page-CSP in `deployment-guide.md` §5.3.1 has not been run against a browser.** Its
  allowances were derived from the code; proving it needs nginx and a browser. The Google sign-in
  script is the piece most likely to be blocked, and it is the piece that locks everyone out.
- **The BL-02 and BL-03 races were reasoned, not reproduced.** Both need two sessions colliding
  inside the same millisecond; there is currently one usable admin.
- **Role enforcement was not exercised with a real `it_staff` session** — that needs two live
  Google accounts at different roles. Guards were verified statically and `requireRole` fails
  closed.
- **Other environments.** The agent-token migration was applied to the development database
  (0 live tokens). Any deployed instance needs the same migration run **before** this code ships
  there.
- **`DEVICE_SECRET` entropy** was checked only for length (27 characters).
