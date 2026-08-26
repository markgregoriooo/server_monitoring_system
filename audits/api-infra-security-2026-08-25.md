# API & Infrastructure Security Review — CSPC-ICTU Monitoring System

**Date:** 2026-08-25
**Scope:** `backend/src/server.js`, `backend/middleware/`, `backend/routes/`, `backend/config/`,
`frontend/src/utils/format.ts`, `deployment-guide.md` §5 — CORS, rate limiting, request-size
limits, HTTP security headers, credential/token management, error handling, API versioning
**Companions:** the twelve other audits in this folder
**Method:** static read of every route/middleware file, plus **live verification against the
running backend** — headers, `/uploads`, and the socket handshake budget were each confirmed
with a real request (see the PoC blocks).

---

## 0. Verdict — API & Infrastructure Security: 6.5 / 10 → **9 / 10 after fixes**

The parts of this layer that someone clearly sat down and thought about are genuinely good, and
better than most codebases this size: the rate limiting is **user-keyed off a verified JWT**
with a correct `ipKeyGenerator` IPv6 fallback, agent ingest has a two-tier IP+device limiter
with the arithmetic written down, the central error handler gates 5xx text behind an explicit
`expose` flag, session liveness is one shared predicate enforced in three places, and report
downloads resolve through `path.basename` plus a `startsWith` prefix check.

The failures were all of one kind: **things that were never added at all**, rather than things
added wrongly. There were *no* HTTP security headers of any kind. There was no attempt limit on
the one endpoint that accepts the ESP32's shared secret. And a deleted feature had left its
reader behind, serving 23 real staff photographs to anyone who asked.

| ID | Finding | Sev | CWE | Status |
|----|---------|-----|-----|--------|
| **A-01** | **No HTTP security headers at all** — no CSP, no `nosniff`, no frame protection, no HSTS; `X-Powered-By: Express` on every response | **High** | CWE-693, CWE-1021 | ✅ **Fixed** |
| **A-02** | **`/uploads` served 23 staff photos with no authentication** — the reader of a deleted feature | **High** | CWE-548, CWE-359 | ✅ **Fixed** |
| **A-03** | `trust proxy` hardcoded to `2` — mis-set on any other topology, making `req.ip` attacker-chosen | **Medium** | CWE-348 | ⚠️ **Partly fixed** (code shipped; the network control is yours) |
| **A-04** | **Socket.IO handshake had no rate limit** — the Express limiter structurally cannot see `/socket.io/` | **Medium** | CWE-307, CWE-770 | ✅ **Fixed** |
| **A-05** | Agent bearer tokens stored **in plaintext** in `agent_tokens.approved_token` — and shipped offsite nightly by the mysqldump + rclone jobs | **High** ⬆ | CWE-256, CWE-522 | ✅ **Fixed** |
| **A-06** | `WEB_ORIGIN=*` is a supported, documented setting that reflects **any** origin | **Low** | CWE-942 | ⏳ **Recommend** (guard rail, §7) |
| **A-07** | `express.json()` limit inherited rather than stated; no recorded relationship to `MAX_BATCH` | **Low** | CWE-770 | ✅ **Fixed** |
| **A-08** | No API versioning, and one deprecated credential channel (`?deviceKey=`) with no removal trigger | **Low** | — | ⏳ **Recommend** (§8) |

**Result: 292/292 backend tests pass (26 new). 0 TypeScript errors. Backend boots clean, and
every shipped fix was verified against a live request — the token change end-to-end against
the real database.**

---

## 1. A-01 — No HTTP security headers · **High** · CWE-693, CWE-1021

**Evidence:** `backend/src/server.js:169-176` (before the fix). The middleware stack was, in
order: `express.static` → `cors` → `express.json` → `trust proxy` → `globalLimiter` → routes.
No header middleware existed anywhere in the repository:

```
$ grep -rn "helmet\|Content-Security-Policy\|X-Frame-Options\|Strict-Transport\|X-Content-Type" \
    --include=*.js --include=*.json backend/ | grep -v node_modules
(no matches)
```

Neither did the nginx config in `deployment-guide.md` §5.3 set any.

**Why it matters.** Four separate gaps, each with a concrete consequence here:

- **Clickjacking (CWE-1021).** This dashboard drives real hardware. The AirConditioner page's
  toggle sends an `irCommand` to the ESP32, and the Alert Rules page rewrites the thresholds the
  firmware alarms on. A framed, invisible dashboard turns "click here" on any page a signed-in
  staffer visits into a hardware action.
- **MIME sniffing (CWE-430).** `GET /api/reports/:id/download` streams a file whose name is
  built from a user-supplied title. `nosniff` is the header that stops a browser deciding for
  itself what a response is.
- **No HSTS.** ICTU is publishing `monitoring.cspc.edu.ph` over TLS (deployment guide §6).
  Without HSTS, the first request of every session is plain HTTP and strippable.
- **Version disclosure.** `X-Powered-By: Express` is free reconnaissance — it names the stack to
  anyone deciding which CVE list to work through.

**Exploitability.** Trivial and unauthenticated to *observe*; the clickjacking path needs a
signed-in victim to visit an attacker-controlled page.

```
$ curl -sI http://127.0.0.1:3000/api/policy/version | grep -iE 'x-frame|x-content|csp|powered'
X-Powered-By: Express          ← and nothing else
```

**Fix — shipped.** New `backend/middleware/securityHeaders.js`, mounted before the routes *and
before the limiter*, so a 429 and a 404 carry the headers too:

```js
app.disable("x-powered-by");
app.use(securityHeaders());
```

```js
res.removeHeader("X-Powered-By");
res.setHeader("X-Content-Type-Options", "nosniff");
res.setHeader("X-Frame-Options", "DENY");
res.setHeader("Content-Security-Policy",
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
res.setHeader("Referrer-Policy", "no-referrer");
res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
if (HSTS_MAX_AGE > 0 && req.secure) {
  res.setHeader("Strict-Transport-Security", `max-age=${HSTS_MAX_AGE}`);
}
```

**Two decisions worth recording, because both could look like mistakes later.**

**Why not `helmet`.** Not to avoid a dependency — because **Express here serves JSON and nothing
else.** The dashboard's HTML, JS and CSS are served by nginx from `frontend/dist` and never pass
through this process. Helmet's CSP defaults are shaped for a page, so applying them here would
be dressing the wrong artifact: the CSP that governs the *dashboard* has to live in the nginx
config. That is why this audit also added **§5.3.1 to `deployment-guide.md`**, with a page CSP
derived from the code (Google Identity Services for the sign-in button, Google Fonts for
JetBrains Mono / Share Tech Mono, `*.googleusercontent.com` for avatars, and a warning that
`connect-src 'self'` is only correct when `VITE_API_URL` points at the same origin). What
belongs *here* is the far stricter `default-src 'none'` a JSON API can afford and helmet does
not ship.

**Why HSTS is gated on `req.secure`.** Sending it unconditionally would pin
`http://<lan-ip>:3000` to HTTPS in every staff browser and lock them out of a host that has no
certificate — an outage that is not quickly undoable. It is also deliberately sent **without
`preload` and without `includeSubDomains`**: preload is effectively irreversible, and neither is
ours to commit `cspc.edu.ph` to.

**Verified live** (against the running backend, on a 200 *and* a 404):

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
```

`X-Powered-By` absent; `Strict-Transport-Security` correctly absent over plain HTTP.

---

## 2. A-02 — `/uploads` served staff photographs unauthenticated · **High** · CWE-548, CWE-359

**Evidence:** `backend/src/server.js:169` (before the fix):

```js
app.use("/uploads", express.static("uploads"));
```

`backend/uploads/` holds **23 real image files** (`.jpg`/`.png`, 66 KB–1.6 MB, dated May–June
2026). No `authMiddleware`, no `requireRole`, no referrer check — mounted above every auth gate
in the file.

**Why it matters, and why it is worse than a stray route.** The feature this served *no longer
exists*. Per `CLAUDE.md`, login went Google-only, `middleware/upload.js` was deleted, and
`PATCH /users/me` no longer accepts multipart. The **writer** was removed and the **reader** was
left behind — a dead feature still handing out personal data, which is exactly the kind of thing
that survives a security review because nobody is looking at the feature it belongs to.

And the data is personal. This system makes every user accept a Privacy Notice under **RA 10173
(Data Privacy Act of 2012)** before it will show them a dashboard (`PolicyGate`,
`services/policyService.js`). That notice does not describe a public directory of staff
photographs. This is a compliance finding, not only a technical one.

**Exploitability.** Direct object read, unauthenticated:

```
$ curl -s -o /dev/null -w '%{http_code} %{size_download}\n' \
    http://<host>:3000/uploads/a3815b047e1b435e06f1f5837444ccce.jpg
200 38712
```

Filenames are not secret. The older half are `<unix-ms>-<9 digits>.jpg`, whose timestamp
component is guessable to the day, and any name is disclosed to any signed-in user through
`users.profile_image` — which includes `it_staff` accounts and any **rejected or pending**
registrant who ever reached a page. It was also reachable **from the internet**, because §5.3 of
the deployment guide proxied `/uploads/` through nginx.

**Fix — shipped.** The mount is removed. Gating it behind `authMiddleware` was considered and
rejected: an `<img src>` cannot send an `Authorization` header, so gating would have broken the
avatars while leaving the feature alive. Instead:

1. `backend/src/server.js` — mount deleted, with the reasoning recorded in place.
2. `frontend/src/utils/format.ts` — `avatarUrl()` no longer constructs `/uploads/…` URLs:

```ts
export function avatarUrl(profileImage?: string | null): string | null {
  if (!profileImage) return null;
  return /^https?:\/\//i.test(profileImage) ? profileImage : null;   // → fall back to initials
}
```

   Safe because every avatar that can appear is an **absolute** Google URL —
   `googleAuthService` re-syncs `profile_image` from the ID token on *every* sign-in, and
   password login is gone. Only a row that has never completed a Google sign-in (and therefore
   can never hold a session) can still carry a `/uploads/…` value; those now render as initials
   rather than as a broken image.
3. `deployment-guide.md` §5.3 — the `location /uploads/` proxy block removed, with a warning for
   anyone copying an older revision of the config.

**Verified live:** `GET /uploads/a3815b047e1b435e06f1f5837444ccce.jpg` → **404**.

> ### ⚠️ CORRECTION — these files WERE committed to git
>
> An earlier revision of this report said the folder was `.gitignore`d and therefore *"never
> committed… no repository exposure."* **That was wrong**, and it was wrong in the way that
> matters. It came from spot-checking a single filename with `git check-ignore` and generalising
> from it — `.gitignore` only stops *untracked* files being added; it has no effect on files
> already tracked.
>
> The actual state:
>
> ```
> $ git ls-files backend/uploads/ | wc -l
> 12                     ← tracked, i.e. in the repository
> $ git log --diff-filter=A -- backend/uploads/
> d2db711  2026-05-14  quite enhance UI and add CRUD for user management
> $ git branch -r --contains d2db711
> origin/main            ← pushed to GitHub
> ```
>
> So **12 of the 22 staff photos are in git history and have been on GitHub since 2026-05-14.**
> The other 10 (the newer md5-named files) really are untracked — `backend/uploads/` was added to
> `.gitignore` after that commit, which is exactly why a one-file check gave the wrong answer.
>
> **Mitigating: the repository is PRIVATE** (`gh repo view` → `"visibility":"PRIVATE"`), so
> exposure is limited to the owner and any collaborators — not the public. That is the difference
> between "tidy this up" and "an incident".
>
> **The files have since been deleted from disk** (the working tree is empty), which closes the
> live copy. What remains is history.
>
> ### What to do
>
> **1. Commit the deletion** so they leave `HEAD` (they are deleted but unstaged):
> ```bash
> git add -A backend/uploads && git commit -m "chore: remove committed staff profile photos"
> ```
> This stops them appearing in fresh clones' working trees. It does **not** remove them from
> history — an old commit still contains them.
>
> **2. Decide about history.** Purging needs a rewrite:
> ```bash
> git filter-repo --path backend/uploads --invert-paths     # or the BFG
> git push --force origin main
> ```
> ⚠️ This **rewrites shared history**. Every existing clone must be re-cloned, and force-pushing
> a capstone repo mid-defence carries its own risk. Given the repo is private and this is
> personal data of a handful of staff, the defensible options are both reasonable:
> *rewrite now* (cleanest), or *commit the deletion and note it* (lower risk). **That is your
> call, not mine** — but make it deliberately rather than by default.
>
> **3. Either way, check the collaborator list** on that repository. Private means "whoever you
> granted access to", and that set is the actual audience these photos have had since May.

---

## 3. A-03 — `trust proxy` hardcoded · **Medium** · CWE-348

**Evidence:** `backend/src/server.js:174` (before the fix): `app.set("trust proxy", 2);`

**Why it matters.** That number decides how many `X-Forwarded-For` entries are *believed*. Set
higher than the real hop count and the surplus entries are attacker-supplied — the client picks
its own `req.ip`, and `req.ip` is the key for:

| Control | Location | What a spoofed IP buys |
|---|---|---|
| Sign-in limiter (30/15 min) | `routes/auth.js:12` | unlimited Google auth-code attempts |
| Agent enrollment limiter (30/15 min) | `routes/agents.js:18` | unlimited `AIK-` install-key guesses |
| Agent ingest IP limiter (5000/15 min) | `routes/servers.js:37` | unmetered pre-auth ingest flood |
| Global limiter's IP fallback | `src/server.js` → `userOrIpKey` | a fresh unauthenticated budget on demand |
| **`system_logs.ip_address`** | `services/auditService.js` | **poisons the audit trail** |

That last row is the sharp one. `policyService.accept` writes the acceptance **and** its
`system_logs` row in one transaction, and `CLAUDE.md` says of it: *"unlike every other audit
write in this codebase it is NOT best-effort, because the audit row **is** the evidence."* An
attacker-chosen IP in that row degrades the evidence the RA 10173 compliance story rests on.

**Exploitability.** `2` is correct for the documented production path (ICTU edge → campus nginx
→ backend), so this is not currently a production misconfiguration. It is exploitable in two
real situations: **(a)** any developer or alternate deployment running without a proxy, where
`X-Forwarded-For: a, b, c` fully controls `req.ip`; and **(b)** production anyway, because
`server.listen(PORT, "0.0.0.0")` means **port 3000 stays directly reachable from the campus
LAN** regardless of what nginx does. That is required — the ESP32 and the Go agents connect to
it directly — so it cannot be fixed by binding to loopback.

```
# with no proxy in front, or by talking to :3000 directly:
$ curl -H 'X-Forwarded-For: 1.2.3.4, 5.6.7.8, 9.9.9.9' http://<host>:3000/api/auth/me
# → req.ip is now 5.6.7.8, and so are the rate-limit bucket and the audit row
```

**Fix — partly shipped.** The value is now explicit and configurable, with the default unchanged
so the documented deployment behaves exactly as before:

```js
const TRUST_PROXY = process.env.TRUST_PROXY ?? "2";
app.set("trust proxy", /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);
const TRUST_PROXY_HOPS = /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : 0;
```

Documented in `CLAUDE.md` as a security control rather than a tuning knob, with `TRUST_PROXY=0`
called out for a proxy-less run.

> **⚠️ Marked "partly fixed" deliberately.** Code can make the hop count *correct*; it cannot
> stop someone on the campus LAN bypassing nginx and talking to `:3000` directly. The remaining
> control is network-level and is yours to apply at deployment: **firewall TCP/3000 to the
> subnets that actually host agents and the ESP32**, e.g.
> ```bash
> sudo ufw allow from 10.0.0.0/8 to any port 3000 proto tcp   # agent/ESP32 VLANs only
> sudo ufw deny 3000
> ```
> Browsers do not need it — they reach the API through nginx on 80/443.

---

## 4. A-04 — Socket.IO handshake had no rate limit · **Medium** · CWE-307, CWE-770

**Evidence:** `backend/src/server.js` — `io.use(...)` authenticates every handshake, and
`globalLimiter` is an **Express** middleware. `new Server(httpServer)` installs its own
`request` listener on the Node HTTP server and answers everything under `/socket.io/` itself, so
the Express app is never invoked for those requests. Every HTTP credential path in this codebase
has an attempt limit; the handshake had none.

**Why it matters.** The handshake accepts `DEVICE_SECRET` — a **single static shared secret,
identical across every ESP32, with no rotation and no lockout** — via three channels
(`auth.deviceKey`, the `x-device-key` header, and the deprecated `?deviceKey=` query). It also
accepts browser JWTs, and each handshake carrying a well-formed one costs a `fetchSessionRow`
query out of a MySQL pool of **10** shared with the SNMP poller, the MikroTik poller, the agent
POSTs and every dashboard request (`config/mysql.js`, `queueLimit: 0` — so exhaustion *queues*
and reads as "the dashboard is slow", never as an error).

**Exploitability — reproduced live.** Driving the Engine.IO polling handshake by hand, before
the fix, 55/55 attempts were answered with no throttling:

```js
// 1) GET  /socket.io/?EIO=4&transport=polling            -> engine sid
// 2) POST /socket.io/?EIO=4&transport=polling&sid=<sid>  body "40"  -> runs io.use
// 3) GET  the same url                                   -> the middleware's verdict
```

**Fix — shipped.** New `backend/services/handshakeLimiter.js` (pure, import-free, 13 tests),
wired into the `io.use` gate.

**The design decision that matters here is what it counts.** A plain per-IP *connection* cap
would have been the self-inflicted DoS this codebase already documents for the global limiter:
behind nginx every browser socket arrives from `127.0.0.1`, and behind the campus NAT every
agent shares one address, so one shared bucket means the first person to reload locks out
everyone else. So it counts **failures only**, and **a success clears the key**. A working
dashboard, a working agent and a correctly-flashed ESP32 never fail a handshake; a brute-forcer
only fails.

It also resolves the client address with `clientIpFrom(headers, address, TRUST_PROXY_HOPS)`,
which reproduces Express's numeric `trust proxy` semantics exactly (`[peer, ...XFF reversed]`,
index = hops, clamped to the chain) — so the socket buckets by the same address `req.ip` yields,
rather than lumping the whole campus into nginx's loopback. Key tracking is bounded (`maxKeys`,
expired-first eviction) because with `trust proxy` on, the key is attacker-chosen and an
unbounded map would turn the defence into a memory leak.

**Verified live** — 50 failures allowed, blocked on the 51st:

```
attempt  1 -> {"message":"Invalid device key"}
attempt 51 -> {"message":"Too many failed connection attempts"}
```

**Known trade-off, accepted:** once an address is blocked, a *valid* credential from that same
address also waits out the window. That is correct for a brute-force defence and is bounded by
the per-real-client keying above. Tune with `SOCKET_HANDSHAKE_MAX_FAILURES` if a flapping ESP32
ever trips it.

---

## 5. A-07 — Request-size limits were inherited, not stated · **Low** · CWE-770

**Evidence:** `backend/src/server.js:173` (before the fix): `app.use(express.json());`

Not unbounded — Express applies a 100 kb default — so this is Low, not a DoS. But an **inherited
default is not a decision**, and there are two limits here that have to stay consistent with
each other: `MAX_BATCH = 60` in `handlers/serverMetricsHandler.js:218`, and the byte cap the
batch has to fit inside. Nothing recorded the relationship, so raising one in a future release
would silently 413 every post-outage agent backfill — a failure that looks like servers randomly
not reporting.

**Fix — shipped.**

```js
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "100kb" }));
```

plus an explicit Socket.IO frame cap (`maxHttpBufferSize`, at the library's 1 MB default) for
the ingest path Express never sees — both documented in `CLAUDE.md` with the `MAX_BATCH`
dependency spelled out. **No `express.urlencoded` is mounted** — every client speaks JSON, so a
form parser would be attack surface with no consumer. Verified correct as-is.

---

## 6. A-05 — Agent tokens stored in plaintext · **High** · CWE-256, CWE-522

> **⚠️ Severity raised from Medium, and a correction to an earlier draft of this report.**
> That draft said, under defence-in-depth, that "the on-site backup drive is not an additional
> copy of it." That was wrong in the way that matters. It was true only of the NDJSON metric
> streams. `ops/db-backup/dump-mysql.sh` dumps the **whole database** into the same
> `BACKUP_DIR`, and `ops/offsite-backup/sync-offsite.sh` rclone-copies that entire folder to
> Backblaze, excluding only `.last_offsite_sync`, `*.log` and `*.tmp`. So this was never
> "someone would have to breach the database" — **every agent credential was already leaving
> the building nightly, in a file on cloud storage.** That is High, not Medium.

> ### ⚠️ Correction (added by the database audit, same day)
> The claim that these credentials were *"leaving the building nightly, in a file on cloud
> storage"* **overstated the cloud exposure.** Two things were checked afterwards and both cut
> the other way: every `BACKUP_OFFSITE_*` variable in `backend/.env` is **blank**, so
> `sync-offsite.sh` is not running at all; and when it is enabled it uploads through an rclone
> **`crypt`** remote (`filename_encryption = standard`), so data *and* filenames are encrypted
> client-side before they leave.
>
> **What remains true:** `ops/db-backup/dump-mysql.sh` writes `mysql-YYYY-MM-DD.sql.gz` — gzip,
> **not** encrypted — into `BACKUP_DIR`, a micro SD or USB drive in the server room. Permanent,
> non-expiring credentials in plaintext on removable media is still a real finding, and hashing
> them was still the right fix. The accurate framing is *"removable media, and anyone with file
> access on the server"* — not *"readable on the cloud"*.
> See `database-security-2026-08-25.md` §0 and DB-06.

**Evidence (before the fix):** `backend/services/agentService.js:298` and `:337-346`

```js
const approvedToken = "AGT-" + crypto.randomBytes(24).toString("hex");   // :298
// ...
WHERE t.approved_token = ? AND t.status = 'approved'                      // :343
```

The token was stored and compared **verbatim**. `services/installKeyUtils.js` does the
opposite for the `AIK-` install keys one table over, and
`migrations/2026-08-15b_install_key_reveal.sql` gives the reason in as many words — *"`ops/db-backup`
writes a nightly mysqldump onto the same drive… so a plaintext column would put every install
key into a file that leaves the building."* Install keys were protected from exactly this.
Agent tokens never got the same treatment, despite being the higher-value credential: permanent,
never expiring, and sufficient to forge metrics — which on a monitoring system means suppressing
or fabricating alerts.

### What was built

**`migrations/2026-08-25_agent_token_hash.sql`** — two columns replace one, because the
plaintext was doing two different jobs:

| Column | Job | Why it cannot be the other one |
|---|---|---|
| `approved_token_hash` `char(64)`, unique | **Lookup**, on every metric POST | SHA-256, not bcrypt — the token is 192 bits of CSPRNG output, so there is no dictionary to slow anyone down with, while a slow hash would make the hottest query in the system (every agent, every 10 s) scan the table instead of hitting one index. `hashKey` is **reused** from installKeyUtils, not re-implemented |
| `approved_token_cipher` `varchar(255)` | **Re-delivery**, via AES-256-GCM | A hash answers *"is this the token?"* and can never answer *"what was the token?"* |

**The re-delivery column is the part that took the longest to get right, and the first attempt
was wrong.** That attempt cleared the plaintext on the agent's first successful metric POST —
"proof of delivery", which reads well until you follow the recovery path.
`agent/cmd/agent/main.go:57` runs enrollment **only when `config.Load` fails**, so every call to
`/api/agents/register` is a machine with no usable `agent.conf`; `register()` answers it by
handing back the *same* pending token, which the agent exchanges at `/api/agents/status`. That
one path carries both the "restore wiped agent.conf" recovery **and** the documented ADOPT
workflow (moving a server onto another branch's install key). Clearing the plaintext would have
broken both — and broken them silently, because the agent's `approved but token missing;
retrying` branch loops forever rather than failing. Encrypting instead of discarding keeps every
one of those behaviours identical.

**Code — `services/agentService.js`:**

```js
// approve() — encryption is REQUIRED, deliberately not a fallback
if (!secretCrypto.isConfigured()) throw unavailable("Cannot approve: no encryption key…");
`SET approved_token_hash = ?, approved_token_cipher = ?, status = 'approved'`
  [hashKey(approvedToken), secretCrypto.encrypt(approvedToken), deviceId]

// validateToken() — one unique-indexed comparison, same shape the plaintext compare had
`WHERE t.approved_token_hash = ? AND t.status = 'approved'`   [hashKey(token)]
```

There is **no** "store it readable if no key is configured" branch. That branch is how the
plaintext column existed in the first place; failing loudly at approval — one admin action, with
a message naming the fix — is far cheaper than a credential quietly landing in the offsite dump.

### Why the plaintext column could simply be dropped

The precondition query returned **0**: this database held a single `revoked` row and no live
credentials, so nothing was lost. The migration is safe even where that count is *not* zero,
because of statement order — it backfills `approved_token_hash = SHA2(approved_token, 256)`
**before** the `DROP COLUMN`, so already-approved agents keep authenticating untouched (each one
already holds its own token in `agent.conf`). What such agents lose is only re-delivery: they
predate the cipher column, so a machine that later loses `agent.conf` must be re-enrolled — and
`register()` re-arms the same row, so it keeps its device id, its logs and its InfluxDB history.
`tests/agentTokenHash.test.js` asserts that ordering, because reversing it would 403 an entire
fleet at once.

Folded into `v13_cspc-ictu-monitoring-system.sql` as well — otherwise a fresh install would
recreate the old column and the new code would not start.

### Verified end-to-end against the real database

```
1. registered  device_id=68
2. approved    token=AGT-cf67fbb2…
3. stored hash matches Node sha256 : true
   stored cipher is not the token  : true
4. re-delivery returns the original: true      ← agent.conf recovery + ADOPT still work
5. validateToken accepts it        : true
6. rejects a wrong token           : true
7. the HASH itself is not a token  : true      ← the whole security property
8. cleaned up test device
```

Line 7 is the one that matters: what the database now stores does **not** authenticate. A
stolen dump yields a hash and a ciphertext, and the key (`SECRET_ENC_KEY`, falling back to
`MIKROTIK_ENC_KEY`) lives in `backend/.env` — neither in the database nor in the backup.

### The pending token — ⚠️ CORRECTED, then fixed

An earlier revision of this section called `agent_tokens.token` *"lower-value and pre-approval"*,
a risk that applied only *"while an enrollment sits pending"*. **That was wrong on three counts**,
each verified against the running system:

```
row status                : approved       <- not just pending. ANY approved row.
approved_token returned?  : YES - 52 chars <- repeatable forever, not a one-time race
does it authenticate?     : true           <- it IS the live credential
```

`getStatusByPendingToken` decrypts `approved_token_cipher` on **every** call, and
`POST /api/agents/status` had **no authentication and no rate limiter**. So the pending token was
not lower-value than the permanent one — it was the permanent one, one unauthenticated HTTP call
away. **That largely defeated the fix above**: the unencrypted `mysqldump` still contained, for
every server, a string convertible into that server's live credential.

**Fixed** — `migrations/2026-08-25b_agent_pending_token_hash.sql`. The blocker had been that
`register()` handed the *same* pending token back to a returning machine, and you cannot hand back
a hash. That dissolved by minting a **fresh** token on every registration: nothing depended on it
being stable (the agent holds it in memory only, never in `agent.conf`), and recovery stays gated
by the `AIK-` install key `/register` already demands. A `statusLimiter` (600/15 min, sized for
10-second polling) was added to the endpoint.

**Verified end-to-end:**

```
2. DB stores only the hash            : true
3. poll before approval               : pending | token: none
4. poll after approval collects it    : true
5. the STORED HASH cannot be exchanged: true   <- the dump path is closed
6. re-register issues a FRESH ticket  : true
7. old ticket is now dead             : true
8. new ticket recovers the same token : true   <- lost-agent.conf recovery intact
```

`agent_tokens` now holds no readable credential at all.

⚠️ **One operational consequence of encrypting:** `MIKROTIK_ENC_KEY` / `SECRET_ENC_KEY` must
never change once agents are approved, or their ciphers become undecryptable. Running agents are
unaffected (lookup is by hash) — only re-delivery breaks, and the log says so by name. This is
the same warning CLAUDE.md already carries for MikroTik passwords.

---


## 7. A-06 — `WEB_ORIGIN=*` reflects any origin · **Low** · CWE-942 · ⏳ recommend

**Evidence:** `backend/src/server.js` — `WEB_ORIGIN === "*" ? true : [...]`, passed to both
`cors()` and the Socket.IO server. With the `cors` package, `origin: true` **reflects the
request's `Origin`**, i.e. allows every site.

**Current state is correct.** `backend/.env` reads
`WEB_ORIGIN=http://localhost:5173,http://192.168.100.9:5173,https://monitoring.cspc.edu.ph` — an
explicit allow-list. `credentials` is **not** enabled and the JWT travels in an `Authorization`
header from `sessionStorage`, so even under `*` this is not a CSRF or ambient-credential path: a
third-party page can send requests but cannot attach a session.

**Why it is still worth a line.** `*` is documented in `CLAUDE.md` as a supported convenience
("handy on a LAN whose IP changes"), which is exactly how it ends up in a `.env` during a demo
and stays there. Under `*`, any page on the internet can read this API's unauthenticated
responses and freely probe it from a victim's browser — and it removes the backstop if
`credentials` is ever switched on.

**Recommended (small, no behaviour change today):** treat `*` as a dev-only setting and refuse it
when running in production, so it cannot survive into deployment silently:

```js
if (WEB_ORIGIN === "*" && process.env.NODE_ENV === "production") {
  console.error("[CONFIG] WEB_ORIGIN=* is not permitted in production — set the real origin(s).");
  process.exit(1);   // a boot failure with a clear cause beats a silently open API
}
```

---

## 8. A-08 — API versioning & deprecated channels · **Low** · ⏳ recommend

Routes are mounted at `/api/<resource>` with no version segment. For the **dashboard** this is
genuinely Not Applicable — it is built and deployed from the same repository in the same step,
so no client can be older than the server.

It is *not* N/A for the two independently-deployed clients, which is where the real version risk
lives:

- **The Go agent** — versioned only by `backend/tests/contract.test.js`, which parses
  `agent/internal/collector/metrics.go` and fails if its json tags drift from `NUMERIC_FIELDS`.
  That is a good guard and better than nothing, but it catches drift *in this repo* — it cannot
  detect an old binary still running in the field.
- **The ESP32** — carries one genuinely deprecated credential channel: `?deviceKey=` in the
  handshake query, kept because removing it would strand un-reflashed boxes. A query string is
  written verbatim into proxy and access logs, so every log line the handshake touched used to
  contain the shared secret. It has **no removal trigger** — nothing records which boxes have
  been reflashed, so "delete it once every ESP32 is updated" has no way to become true.

**Recommended:** have the ESP32 report its firmware version on connect, and log it. That single
change turns "delete the fallback someday" into a checkable condition, and it is also what makes
`DEVICE_SECRET` rotation (see A-04) plannable. Until then, at minimum log a one-line warning
whenever the query channel is used, naming the peer, so the stragglers identify themselves.

---

## 9. Checklist diff

| # | Item | Verdict | Note |
|---|------|---------|------|
| 1 | **CORS** — no wildcard in production | ⚠️ **Pass (guard rail recommended)** | `.env` uses an explicit allow-list; `*` is a supported setting → A-06 |
| 1 | **CORS** — proper origin validation | ✅ **Pass** | comma-split allow-list, applied to both `cors()` and Socket.IO |
| 1 | **CORS** — credentials handling | ✅ **Pass** | `credentials` off; Bearer token in a header, not a cookie — no ambient auth |
| 2 | **Rate limiting** — on all endpoints | ✅ **Pass** *(was Fail)* | global + sign-in + enrollment + two-tier agent ingest; **the handshake gap is closed** → A-04 |
| 2 | **Rate limiting** — different limits per operation | ✅ **Pass** | credential paths 30/15 min vs 3000/15 min for the dashboard, with the arithmetic documented |
| 2 | **Rate limiting** — distributed | ➖ **N/A** | single on-prem process by design; in-memory stores are correct here |
| 3 | **API versioning** — deprecated version handling | ⚠️ **Partial** | `?deviceKey=` deprecated with no removal trigger → A-08 |
| 3 | **API versioning** — breaking-change management | ⚠️ **Partial** | `contract.test.js` guards the Go↔Node metric contract; nothing covers field binaries |
| 4 | **Request size** — body parser limits | ✅ **Pass** *(now explicit)* | `express.json({ limit: "100kb" })` + `maxHttpBufferSize` → A-07 |
| 4 | **Request size** — file upload restrictions | ➖ **N/A** | no upload path exists; the last reader was removed → A-02 |
| 4 | **Request size** — JSON depth limits | ➖ **N/A** | V8's `JSON.parse` is not depth-recursive; the 100 kb cap bounds the payload |
| 5 | **Headers** — Helmet / equivalent | ✅ **Pass** *(was Fail)* | `middleware/securityHeaders.js`, deliberately not helmet → A-01 |
| 5 | **Headers** — CSP | ✅ **Pass** | `default-src 'none'` on the API; page CSP added to `deployment-guide.md` §5.3.1 |
| 5 | **Headers** — X-Frame-Options | ✅ **Pass** | `DENY` + `frame-ancestors 'none'` |
| 5 | **Headers** — X-Content-Type-Options | ✅ **Pass** | `nosniff` |
| 5 | **Headers** — HSTS | ✅ **Pass** | sent only over real TLS; the nginx line is staged, commented until §6's certificate exists |
| 6 | **Tokens** — secure storage | ✅ **Pass** *(was Fail)* | install keys hashed, MikroTik passwords AES-256-GCM, and **agent tokens now hashed + encrypted** → A-05. Only the short pending token remains readable, and is documented |
| 6 | **Tokens** — rotation policy | ⚠️ **Partial** | JWT 1 h + `token_version` revocation + a 30 s socket sweep is good, and an `AGT-` token can now be re-minted by re-enrolling. `DEVICE_SECRET` still has **no rotation path** → A-08 |
| 6 | **Tokens** — scope limitations | ✅ **Pass** | three separate credential classes; install keys own what they enrolled, revocable per key |
| 7 | **Errors** — no stack traces in production | ✅ **Pass** | central handler; 5xx text gated behind `expose` |
| 7 | **Errors** — generic messages | ✅ **Pass** | client gets one string, the server log gets the real cause (auth, install keys, sign-in) |
| 7 | **Errors** — proper status codes | ✅ **Pass** | the 401-vs-403 distinction is correct and deliberately documented |

---

## 10. Risk score and priority

**Before: 6.5 / 10. After the shipped fixes: 9 / 10.**

Not 10, and the gap is honest: `DEVICE_SECRET` is still a single static secret shared by every
ESP32 with no rotation path (A-08), the short pending enrollment token is still readable (§6),
and port 3000 is still reachable directly on the LAN (A-03, which needs a firewall rule rather
than code).

### Top 5, in the order that reduces risk fastest

| # | Action | Effort | Owner |
|---|--------|--------|-------|
| 1 | ✅ **Security headers** — done, verified live | — | shipped |
| 2 | ✅ **Remove the `/uploads` reader** — done, `404` verified | — | shipped |
| 3 | ✅ **Hash + encrypt the agent tokens** — migration applied, verified end-to-end | — | shipped |
| 4 | ⚠️ **Commit the `backend/uploads/` deletion, then decide about git history** — 12 of those photos are in `origin/main` since 2026-05-14 (private repo). Files are already off disk | 5 min / 30 min | **you** — see the correction in §2 |
| 5 | 🔲 **Firewall TCP/3000** to the agent/ESP32 subnets at deployment | 5 min | **you** — completes A-03 |
| 6 | 🔲 **Back up `backend/.env`** somewhere the offsite drive is not | 5 min | **you** — it now holds the only key that can re-deliver an agent token |

Then, before go-live: apply §5.3.1's nginx block and **verify it in DevTools** — the Google
sign-in script is the piece most likely to be blocked by a CSP, and it is the piece that locks
everyone out.

---

## 11. What was verified, and what was not

**Verified against a running backend:** the response headers on both a 200 and a 404; the absence
of `X-Powered-By`; the absence of HSTS over plain HTTP; `/uploads/<file>` → 404; the handshake
budget blocking on attempt 51; and the full agent-token lifecycle — register → approve → decrypt
re-delivery → authenticate → reject a forgery → **confirm the stored hash does not itself
authenticate** — run against the real MariaDB after applying the migration. 292/292 backend tests
pass (26 new across `tests/handshakeLimiter.test.js`, `tests/securityHeaders.test.js` and
`tests/agentTokenHash.test.js`); `tsc --noEmit` clean.

**Unable to verify — stated rather than assumed:**

- **The nginx page CSP in §5.3.1 has not been run against a browser.** Its allowances were
  derived from the code (`@react-oauth/google` → `accounts.google.com/gsi/client`; `index.html`
  + `src/index.css` → Google Fonts; `avatarUrl` → `*.googleusercontent.com`), and the React
  `style={{…}}` usage throughout the pages is what forces `style-src 'unsafe-inline'`. Proving it
  needs nginx and a browser. The guide says so in place, with the exact check.
- **Git history was initially mis-read.** The first revision of this report checked one filename
  with `git check-ignore` and concluded the photos were never committed. `git ls-files` shows 12
  of them are tracked and pushed. Corrected in §2 — the lesson is that `.gitignore` says nothing
  about files already in the index.
- **Whether any `users.profile_image` row still holds a `/uploads/…` value.** MySQL was not
  queried. It does not change the fix — such a row now renders initials — but if you want the
  count: `SELECT COUNT(*) FROM users WHERE profile_image LIKE '/uploads/%';`
- **Other environments.** The migration was applied to the development database, where the live
  approved-token count was 0. Any other instance (a deployed campus server, a restored dump)
  needs the same migration run before this code is deployed there, and §6 explains what happens
  if that instance *does* have live tokens (they keep working; only re-delivery is lost).
- **`DEVICE_SECRET` strength** was checked only for length (27 characters). Whether it is
  high-entropy or a memorable phrase is not readable from the codebase, and it matters more now
  that A-04 has shown the handshake was previously unlimited. If it is a phrase, rotate it — and
  note that rotation currently means reflashing every ESP32, which is A-08's point.
