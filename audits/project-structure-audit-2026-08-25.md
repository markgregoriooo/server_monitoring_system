# Project Structure Audit — CSPC-ICTU Monitoring System

**Date:** 2026-08-25
**Scope:** the eight structural questions — entry points, routes, middleware chain, external
integrations, database connections, auth flow, upload handling, rate limiting — across the
**whole repository**, not just `backend/`
**Companions:** this is the structural map. The depth reviews of the same date are
[`SECURITY-REPORT`](./SECURITY-REPORT-2026-08-25.md) (consolidated),
[`api-infra`](./api-infra-security-2026-08-25.md), [`auth-flow`](./auth-flow-security-2026-08-25.md),
[`authorization`](./authorization-review-2026-08-25.md),
[`business-logic`](./business-logic-review-2026-08-25.md),
[`database`](./database-security-2026-08-25.md) and
[`file-handling`](./file-handling-security-2026-08-25.md).

> **What this audit adds.** Seven reviews today already covered routes, auth, rate limiting,
> database and uploads in depth, and this report links to them rather than restating them. The
> **new** work is the parts a per-file review misses: the full repository-wide entry-point map
> (five runtimes, not one), the outbound integration boundaries, the operator scripts nobody had
> looked at, and the exact middleware ORDER — which is where the one new finding came from.

---

## 0. Verdict — Structure: 8.5 / 10 → **9 / 10 after fixes**

The structure is genuinely clean: one entry point per runtime, one router per resource mounted at
a predictable prefix, a single pool per datastore, and no circular dependency between the
composition root and the services. `src/server.js` reads as a composition root should — imports,
config validation, middleware, routes, error handler, shutdown, timers.

The audit surfaced one ordering defect and two dormant-artifact observations. Nothing structural
is broken.

| ID | Finding | Sev | CWE | Status |
|----|---------|-----|-----|--------|
| **PS-01** | **Rate limiter ran *after* the body parser** — a request about to be 429'd had already had 100 kB parsed | **Low** | CWE-405 | ✅ **Fixed** |
| **PS-02** | `scripts/seed-analytics-history.js` writes synthetic history to InfluxDB with no environment guard | **Low** | CWE-489 | ⏳ Recommend — §7 |
| **PS-03** | Two entry points reachable only by convention (`sd_card_test.ino`, the seed script) | **Info** | — | ➖ Noted — §1 |

**Result: 309/309 backend tests pass. Middleware reorder verified live.**

---

## 1. Entry points — five runtimes, not one

A `package.json`-only reading of this project finds one entry point. There are **five separately
deployable runtimes**, and each is a trust boundary:

| # | Runtime | Entry point | Deployed to | Talks to |
|---|---|---|---|---|
| 1 | **Backend API** | `backend/src/server.js` | campus server | everything |
| 2 | **Dashboard** | `frontend/src/main.tsx` → `vite build` → static files | nginx | backend only |
| 3 | **Go agent** | `agent/cmd/agent/main.go` | each monitored server | backend `:3000` |
| 4 | **ESP32 firmware** | `iot/esp32/env_monitor_v2/env_monitor_v2.ino` | the server room | backend `:3000` (Socket.IO) |
| 5 | **Ops scripts** | `ops/db-backup/*`, `ops/offsite-backup/*` (`.sh` + `.ps1`) | campus server cron | MariaDB, Backblaze |

Plus four **operator CLI tools** under `backend/scripts/`, wired into `package.json`:

```
npm run mail:check       scripts/mailCheck.js       SMTP reachability          argv[2] = recipient
npm run analytics:check   scripts/analyticsCheck.js  DRY RUN of predictive alerting — raises nothing
npm run link:check        scripts/linkCheck.js       per-port interface-down verdict (read-only)
npm run probe -- <ip>     scripts/probeDevice.js     "can this device be monitored, and HOW?"
```

**These are the right tools to have.** `analytics:check` and `link:check` exist because "alerting is
broken" and "nothing to alert about" look identical on a healthy system — a diagnostic that tells
those apart is exactly what a monitoring system needs. All four are read-only except the SMTP one,
which sends a test mail.

### PS-03 · Two entry points not reachable through any documented command

- `iot/esp32/sd_card_test/sd_card_test.ino` — a hardware bring-up sketch. Harmless; it is flashed
  deliberately, never deployed.
- `backend/scripts/seed-analytics-history.js` — **not** in `package.json` scripts, so there is no
  `npm run` for it. See PS-02.

---

## 2. Routes and endpoints — 99, mapped

Full per-route inventory with guards is in
[`authorization-review-2026-08-25.md`](./authorization-review-2026-08-25.md) §1. Summary:

```
99 routes across 17 routers, all mounted at /api/<resource>
 ├─ 75  JWT required        (33 of them additionally role-gated)
 ├─  2  agent bearer token  (POST /servers/metrics, /metrics/batch)
 └─  5  deliberately unauthenticated
```

The five unauthenticated ones — `POST /auth/google` (issues the session),
`GET /policy/version` (public so `/privacy` can stamp itself without an account),
`POST /agents/register` + `POST /agents/status` (install-key / pending-token auth) — are each
structurally necessary. A sixth, `GET /aircon/channels`, was unauthenticated **and called by
nothing**; it was removed today (authorization AZ-01).

⚠️ **A structural trap worth recording for anyone auditing this repo:** four routers
(`alertRules`, `alerts`, `analytics`, `history`) are gated at the **top of the file** with
`router.use(authMiddleware, requireRole(...))` rather than per route. A per-route grep reports
those 19 routes as unguarded. They are not — and the file-level pattern is *safer*, because a
route added to one of those files inherits the gate automatically.

---

## 3. Middleware chain — and PS-01

**The order after today's fix**, which is now the order a security review would want:

```
 1  app.disable("x-powered-by")                    no stack disclosure
 2  securityHeaders()                              nosniff, DENY, CSP, Referrer-Policy, HSTS-if-TLS
 3  cors({ origin: CORS_ORIGIN, … })               allow-list
 4  app.set("trust proxy", TRUST_PROXY)            startup config — makes req.ip trustworthy
 5  globalLimiter                                  ← moved ahead of the parser (PS-01)
 6  express.json({ limit: "100kb" })               body parse
 7  …17 routers…                                   per-route authMiddleware / requireRole
 8  404 handler
 9  central error handler                          5xx text gated behind `expose`
10  graceful shutdown + process safety net
```

### PS-01 — the limiter ran after the body parser · **Low** · CWE-405 · ✅ fixed

**Evidence (before):** `express.json()` at `src/server.js:214`, `globalLimiter` at `:238`.

**Why it matters.** A request that was about to be refused with 429 had already had up to 100 kB
of JSON read off the socket and parsed. That is work done on behalf of a client you have just
decided to reject — and a flood is precisely when you least want to be doing it. Small per
request; the point of a rate limiter is that it is not one request.

**Fix — shipped:** `globalLimiter` moved ahead of `express.json`.

**Safe because the limiter never touches the body** — `userOrIpKey` reads the `Authorization`
header and `skip` reads `req.path`. And `app.set("trust proxy", …)` is app-level configuration
applied at **startup**, not middleware, so `req.ip` is already correct at position 5 regardless of
where the `app.set` line sits.

**Verified live** after the move — body parsing still works and the limiter still counts:

```
POST /api/auth/google {"code":"x"}  -> 401        ← body was parsed
RateLimit: "3000-in-15min"; r=2998; t=899          ← limiter still counting
```

> **A related non-issue, checked because it looks like one.** `securityHeaders()` at position 2
> reads `req.secure` for HSTS, and `req.secure` depends on `trust proxy` set at position 4. That
> is fine: `app.use` *registers* a function that runs per request, while `app.set` executes once
> at startup — long before any request arrives. Order between them is irrelevant.

---

## 4. External service integrations — the outbound trust boundaries

Seven, each a place where this process trusts something it does not control:

| Integration | Library | Transport | Credential | Notes |
|---|---|---|---|---|
| **Google OAuth / OIDC** | `google-auth-library` | HTTPS → accounts.google.com | `GOOGLE_CLIENT_SECRET` | Auth-code flow; ID token verified locally with audience enforced. Transport failure is separated from rejection (`isTransportError`) so an outage answers 503 rather than blaming the user's account |
| **SMTP** | `nodemailer` | STARTTLS :587 → smtp.gmail.com | `SMTP_PASS` (App Password) | Pooled. No-op if unset, so email is an optional channel — bell + toast still work |
| **MariaDB** | `mysql2` | TCP :3306, **loopback** | `DB_PASSWORD` | Pool of 10. ⚠️ Currently connects as `root` — database DB-01 |
| **InfluxDB** | `@influxdata/influxdb-client` | HTTP :8086, **loopback** | `INFLUX_TOKEN` | 10 s transport timeout, explicit |
| **SNMP** (routers, UPS) | `net-snmp` | UDP :161 → campus devices | per-device community | v2c. Community strings stored per device, not global |
| **MikroTik RouterOS** | `node-routeros` | TCP :8728/:8729 | `api_password`, **AES-256-GCM at rest** | TLS optional (`MIKROTIK_TLS_VERIFY`); RouterOS ships a self-signed cert, so strict verification fails on a stock router |
| **ICMP** | OS `ping` via `spawn` | raw ICMP | none | ⚠️ The only OS process spawn. Uses an **argv array, no shell**, and the host is re-validated as an IP first — see below |

**The `spawn` deserves a note because it is the one place this process executes something.**
`services/icmpPing.js` shells out to the OS `ping` rather than opening a raw socket, and the
reasoning is recorded: `net-ping` needs Administrator on Windows and root on Linux, and *"running
the backend elevated is a far worse trade than parsing text on a box holding JWT_SECRET."* That is
the right call, and it is implemented safely — argv array (never a shell string), host
re-validated as an IP, killed on a deadline.

**Inbound boundaries** are Socket.IO (browsers with a JWT; the ESP32 with `DEVICE_SECRET`) and the
agent metric POSTs (`AGT-` bearer). Each has its own middleware and its own limiter.

---

## 5. Database connection points

**Two stores, one connection module each — no ad-hoc connections anywhere.**

```
config/mysql.js   → mysql.createPool(...).promise()   exported as `db`   216 call sites
config/influx.js  → getWriteApi(org, bucket, "ms") + getQueryApi(org)
```

A grep for `createPool`/`createConnection`/`new InfluxDB` outside `config/` finds nothing — every
service imports the shared instance. That is what makes a single change (today's statement
timeout) apply everywhere at once.

**Pool:** `connectionLimit: 10`, `waitForConnections: true`, `queueLimit: 0` (unbounded queue, a
documented choice). **New today:** a 30 s `max_statement_time` set on every pooled connection, so a
runaway query can no longer hold a connection forever — database DB-02, verified by killing a real
`SELECT SLEEP(60)`.

Full analysis — including that all 216 call sites are parameterised and the app currently runs as
MySQL `root` — is in [`database-security-2026-08-25.md`](./database-security-2026-08-25.md).

---

## 6. Authentication & authorization flow

```
Browser ──"CSPC Mail" button (auth-code, popup)──► Google
   │  one-time code
   ▼
POST /api/auth/google  ── googleAuthService ──►  exchange code (client secret, server-side)
                                                 verifyIdToken (audience enforced)
                                                 email_verified === true
                                                 CSPC domain allow-list (googleDomain.js, pure+tested)
                                                 match google_sub → fall back to email
   │
   ├─ no row      → users row status='pending'   → admin approves → active
   ├─ pending/rejected/inactive → 403, audited as login_denied
   └─ active      → authService.issueSession → JWT (1h, HS256, iss/aud, tv, ist)
                                                 │
   every request ──► authMiddleware ─────────────┤ jwt.verify (algorithms+iss+aud)
                                                 │ fetchSessionRow → status + token_version + role
                                                 │ POLICY GATE (mutating methods)
                                                 │ role taken from the DB, not the token
                                                 │ sliding renewal, capped at SESSION_MAX_HOURS
                                                 ▼
                                            requireRole(...) → handler
```

Three credential classes, separated **by route** so none can reach another's endpoints:

| Credential | Middleware | Reaches |
|---|---|---|
| User JWT | `middleware/auth.js` | 75 dashboard routes |
| Agent `AGT-` | `middleware/agentAuth.js` | 2 ingest routes **only** |
| Install key `AIK-` | inline in `routes/agents.js` | `POST /agents/register` only |
| `DEVICE_SECRET` | `io.use` handshake | Socket.IO only |

Five auth defects were found and fixed today (session cap, `iss`/`aud`, dead password code, DB
role, server-side policy gate) — see [`auth-flow`](./auth-flow-security-2026-08-25.md) and
[`business-logic`](./business-logic-review-2026-08-25.md) BL-01.

---

## 7. File upload handling — **none exists**

Verified four independent ways (dependencies, code sweep, `middleware/` listing, static-serving
sweep). No `multer`/`formidable`/`busboy`, no multipart handler, `middleware/upload.js` deleted,
no `express.static` remaining. Profile photos are absolute Google URLs.

The file-handling surface that *does* exist — report CSV/PDF generation and the NDJSON backup
writer — is audited in [`file-handling-security-2026-08-25.md`](./file-handling-security-2026-08-25.md),
which found and fixed CSV formula injection (FU-01).

### PS-02 · The seed script has no environment guard · **Low** · CWE-489 · ⏳ recommend

`backend/scripts/seed-analytics-history.js` writes ~30 days of **synthetic** `ups_metrics`,
`network_traffic` and `router_metrics` points into InfluxDB, so the forecasting pipeline can be
validated without real hardware.

**What is already right about it** — and this is more than most seed scripts get:

- It is **not** in `package.json` scripts, so there is no convenient `npm run` for it.
- It uses **device_ids 9001/9002/9101** deliberately *"so it never collides with real devices"*.
- Its header carries an honesty note: *"this is TEST data to validate the forecasting pipeline —
  NOT a real prediction"*, cross-referencing `predictive-analytics.md` §9.

**What is missing.** It reads whatever `.env` is present. Run in the deployed backend directory it
writes fabricated history into the **production** time-series store. Real devices stay clean, but
the Analytics page would then forecast for three devices that do not exist — and on a monitoring
system, history that looks real and is not is the specific thing that destroys trust in the tool.

```js
// scripts/seed-analytics-history.js — refuse to run against a real deployment
if (process.env.NODE_ENV === "production" && !process.argv.includes("--i-know")) {
  console.error(
    "[seed] Refusing to run with NODE_ENV=production — this writes SYNTHETIC history into\n" +
    "       InfluxDB and the Analytics page cannot tell it from real data.\n" +
    "       Re-run with --i-know only if you are certain this is a scratch environment.",
  );
  process.exit(1);
}
```

⚠️ **Unable to verify:** `NODE_ENV` is not set in `backend/.env` today, so the guard above would
not fire until it is. Setting `NODE_ENV=production` on the deployed box is worth doing anyway —
it also switches Express to its production error handling.

---

## 8. Rate limiting — four limiters, deliberately different

| Limiter | Location | Budget | Keyed by |
|---|---|---|---|
| `globalLimiter` | `src/server.js` | 3000 / 15 min | **user** (verified JWT) else IP |
| `googleLimiter` | `routes/auth.js:12` | 30 / 15 min, **failures only** | IP |
| `enrollLimiter` | `routes/agents.js:18` | 30 / 15 min | IP |
| `metricsIpLimiter` → `metricsAgentLimiter` | `routes/servers.js:37,49` | 5000 / 15 min IP, then 300 / 15 min per device | IP, then **device** |
| `handshakeLimiter` | `services/handshakeLimiter.js` **(new today)** | 50 failed handshakes / 15 min | client IP |

Three design decisions here are worth preserving, because each one is a trap avoided:

1. **The global limiter keys on the verified user**, not the IP — every ICTU staffer is behind the
   same campus NAT, so IP-only keying would hand them one shared budget. The token is `jwt.verify`d,
   not `jwt.decode`d, or anyone could mint an id and claim a fresh budget.
2. **Agent ingest is two-tier** — an outer IP limiter sized for the whole fleet (it runs *before*
   auth, so it is the only thing between an unauthenticated flood and the token lookup) and an
   inner per-device limiter so one misconfigured agent cannot consume the fleet's budget.
3. **The handshake limiter counts failures only, and a success clears the key** — behind nginx
   every browser socket arrives from `127.0.0.1`, so a plain connection cap would have locked out
   the campus.

⚠️ **All IP-keyed budgets depend on `TRUST_PROXY` being correct and on the port-3000 firewall rule**
(api-infra A-03 / `deployment-guide.md` §9.1). Without the firewall, a client can bypass nginx,
write its own `X-Forwarded-For`, and choose its own bucket.

---

## 9. package.json — dependency posture

`npm audit` was run today as part of the consolidated report (H-4) — it was the largest single
cluster of issues found:

```
backend   10 advisories (5 high)   →  0
frontend  14 advisories (10 high)  →  2
```

The high-severity ones were on the **WebSocket transport** (`ws` memory-exhaustion DoS,
`socket.io-parser` unbounded attachments) — which matters more on a monitoring backend, because the
DoS takes down the thing that would have reported the outage.

The 2 remaining are `vite`/`esbuild`, needing a **major** bump to `vite@8`. Both are build tooling:
the advisory concerns the dev server, and production is static files on nginx, so neither ships to
users. Deferred until after the defence.

**Also removed today:** `bcryptjs`, which backed password endpoints that no login path could reach
(auth-flow AF-03).

---

## 10. Checklist diff

| # | Item | Verdict | Note |
|---|------|---------|------|
| 1 | All entry points identified | ✅ **Pass** | **Five runtimes** + 4 CLI tools + 4 ops scripts — §1. Two reachable only by convention → PS-03 |
| 2 | All routes and endpoints | ✅ **Pass** | 99 routes / 17 routers enumerated with guards — §2 |
| 3 | Middleware chain and order | ✅ **Pass** *(was Fail)* | Limiter moved ahead of the body parser → PS-01. Full order in §3 |
| 4 | External service integrations | ✅ **Pass** | 7 outbound boundaries mapped, incl. the single `spawn` — §4 |
| 5 | Database connection points | ✅ **Pass** | One pool per store in `config/`; no ad-hoc connections anywhere — §5 |
| 6 | Authentication/authorization flow | ✅ **Pass** | Full flow diagrammed; 3 credential classes separated by route — §6 |
| 7 | File upload handling locations | ➖ **N/A** | None exists — verified four ways — §7 |
| 8 | API rate limiting implementation | ✅ **Pass** | 5 limiters, each keyed deliberately — §8 |
| — | package.json vulnerable dependencies | ✅ **Pass** *(fixed today)* | 24 advisories → 22 fixed; 2 build-tool-only remain — §9 |
| — | `routes/` reviewed | ✅ **Pass** | All 17 — authorization review §1 |
| — | `middleware/` reviewed | ✅ **Pass** | All 3 (`auth.js`, `agentAuth.js`, `securityHeaders.js`) |
| — | Seed/debug artifacts | ⚠️ **Partial** | No debug *endpoints*; one unguarded seed *script* → PS-02 |

---

## 11. Risk score and priority

**Before: 8.5 / 10. After: 9 / 10.**

Structure was never the weak area — the two open items are a script guard and an
environment variable.

| # | Action | Owner | Effort |
|---|--------|-------|--------|
| 1 | ✅ **Move the rate limiter ahead of the body parser** — verified live | shipped | — |
| 2 | 🔲 **Guard the seed script** (§7) — five lines, and set `NODE_ENV=production` on the deployed box | you | 10 min |
| 3 | 🔲 **Plan the `vite@8` upgrade** after the defence — the last 2 advisories | either | 1 h |
| 4 | 🔲 Carried from other audits and unchanged: firewall :3000, create `cspc_app`, test a restore | you | see SECURITY-REPORT |

### Quick tests

```bash
cd backend && npm test          # 309/309

# PS-01 · the limiter must run first, and the body must still parse
grep -n "^app\.\(use\|set\|disable\)(" src/server.js | head -6
# expect: disable → securityHeaders → cors → trust proxy → globalLimiter → express.json

curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' \
  -d '{"code":"x"}' localhost:3000/api/auth/google        # 401 = body parsed
curl -sI localhost:3000/api/policy/version | grep -i ratelimit   # limiter still counting
```

---

## 12. What was verified, and what was not

**Verified:** all five runtimes' entry points located by file; the four npm-wired CLI tools read
and confirmed read-only except `mail:check`; the ops backup scripts confirmed to pass the DB
password via **`MYSQL_PWD`** rather than `-p` on the command line (keeping it off the process
list — correct, in both the `.sh` and `.ps1` versions); the middleware order re-read from source
after the change and exercised with live requests; single-pool-per-store confirmed by grepping for
connection creation outside `config/`.

**Unable to verify — stated rather than assumed:**

- **The Go agent and the ESP32 firmware were read for their backend interactions only**, not
  audited as programs. `main.go`'s enrolment path and the `.ino`'s socket handshake were traced
  where they touched findings; neither codebase was reviewed end to end.
- **The `.ps1` ops scripts were checked for credential handling only.** Their overall correctness
  on Windows was not exercised — the deployment target is Linux.
- **`NODE_ENV` is unset**, so the PS-02 guard as written would not fire until it is set on the
  deployed box.
- **No load testing.** The limiter budgets are sized from a documented count of requests per
  dashboard load (~50-70 in dev with StrictMode); they have not been validated against real
  concurrent ICTU usage.
