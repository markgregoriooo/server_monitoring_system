# Logging & Monitoring Review — CSPC-ICTU Monitoring System

**Date:** 2026-08-25
**Scope:** both logging systems — the `system_logs` **audit trail** (`auditService`, read by the
History page) and the operational **`console.*`** stream — plus `device_logs`, retention across
every log table, and whether the application monitors *itself*
**Companions:** the seven other security reviews of the same date; see
[`SECURITY-REPORT`](./SECURITY-REPORT-2026-08-25.md)
**Method:** exhaustive sweep of every `console.*` call for secret exposure, a **real failed OAuth
exchange** to inspect what actually gets logged, and **raw-socket testing** of the log-injection
vectors rather than assuming they were reachable.

---

## 0. Verdict — Logging & Monitoring: 7 / 10 → **9 / 10 after fixes**

The audit trail is the strong half and was clearly designed rather than accreted: `system_logs`
records actor, module, action, IP and user-agent; **denied** sign-ins are recorded, not just
successes (`recordSignInDenied` — most systems log only who got in); report generate/download/
email/delete and install-key reveals are all audited because an export is data leaving the system;
and `policyService.accept` writes its acceptance and its audit row in **one transaction**, uniquely
in this codebase, because that row *is* the compliance evidence.

The operational half had the gaps. Four findings, and the two that matter are opposite failures —
one thing logged that shouldn't be, one thing not logged that should.

| ID | Finding | Sev | CWE | Status |
|----|---------|-----|-----|--------|
| **LM-01** | **Log injection** — a newline in an enrollment `hostname` forges log lines | **Medium** | CWE-117 | ✅ **Fixed** |
| **LM-02** | **403 authorization failures were silent** — the one auth outcome never written down | **Medium** | CWE-778 | ✅ **Fixed** |
| **LM-03** | Failed OAuth logged a 9.5 KB object containing the one-time auth code | **Low** | CWE-532 | ✅ **Fixed** |
| **LM-04** | `device_logs` was the only log table with no retention policy | **Low** | CWE-400 | ✅ **Fixed** |
| **LM-05** | **The monitoring system does not monitor itself** — no error-rate or auth-failure alerting | **Low** | — | ⏳ Recommend — §6 |

**Result: 317/317 backend tests pass (8 new). No secret is logged anywhere — verified, not assumed.**

---

## 1. LM-01 — Log injection · **Medium** · CWE-117 · ✅ fixed

**Evidence (before):** two sites interpolated attacker-controlled text into a log line with only a
length slice:

```js
// middleware/auth.js:124
const ua = (req.get("user-agent") ?? "?").slice(0, 60);
console.warn(`[AUTH] rejected ${req.method} … from=${req.ip} ua="${ua}")`);

// routes/agents.js:67
`host="${String(req.body?.hostname ?? "?").slice(0, 60)}"`
```

**Slicing does not help** — the newline is usually in the first few bytes. Demonstrated:

```
[AUTH] rejected GET /x — from=1.2.3.4 ua="Mozilla/5.0
[AUTH] rejected POST /api/admin — user=1 role=admin"     ← forged; reads as a genuine entry
```

**Why it matters.** It grants no access. It corrupts the record you would use to work out what
happened afterwards — on a system whose audit trail is RA 10173 compliance evidence, the wrong
thing to leave writable. An attacker can fabricate `[AUTH]` entries, or bury real activity in
noise.

### ⚠️ Severity split — one vector is real, the other is blocked upstream

Rather than assume both were exploitable, both were **tested**:

```
User-Agent with a bare LF (raw socket, bypassing curl's own validation)
  → HTTP/1.1 400 Bad Request          ← Node's HTTP parser rejects it before Express

hostname with \n inside the JSON body
  → 401 (install key refused)         ← reached the app; the log line WAS written
```

So the **body vector is genuinely exploitable** and the **header vector is not** — Node's
`llhttp` parser refuses a bare CR/LF in a header value. That is a real mitigation, but it is one
this project neither wrote nor controls, and it does not apply to JSON at all.

**Fix — shipped.** New `backend/utils/logSafe.js` (pure, import-free, 8 tests), applied at both
sites plus the new `[AUTHZ]` line:

```js
const ua = logSafe(req.get("user-agent") ?? "?", 60);
`host="${logSafe(req.body?.hostname ?? "?", 60)}"`
```

Three decisions in it worth recording:

- **Escaped, not stripped.** `ua="Mozilla\n5.0"` tells you the client sent something strange,
  which is itself worth knowing. Deleting it hides that.
- **All C0/C1 controls, not just CR/LF.** A terminal reading these logs interprets ANSI escapes —
  `ESC[2J` clears the screen, `ESC[1A` moves the cursor up to overwrite the line above. Same
  forgery, extra steps.
- **The cap is applied inside the loop.** Each control character expands to 4 characters, so
  "escape then slice" would build a 2000-character string from 500 NULs before truncating.

⚠️ It is written as an explicit code-point test rather than a regex character class. A class of
control characters has to be spelled with escape sequences that are easy to mangle into the raw
bytes they denote — which is exactly what happened on the first attempt here, putting invisible
control characters into the module whose job is removing them. The file is now asserted to contain
zero raw control bytes.

---

## 2. LM-02 — Authorization failures were never logged · **Medium** · CWE-778 · ✅ fixed

**Evidence (before):** `middleware/auth.js` `requireRole()`

```js
if (!roles.includes(req.user.role)) {
  return res.status(403).json({ error: "Insufficient permissions." });   // ← silent
}
```

**Why it matters.** Every other authorization outcome in this codebase is written down —
successful sign-ins, **denied** sign-ins with the reason, rate-limit 429s (`[RATE]`), the policy
gate (`[POLICY]`), socket handshake rejections (`[AUTH]`). The 403 was the single gap, and it is
the one that means *"an authenticated user reached for something above their role."*

"it_staff user 9 attempted `DELETE /api/users/1`" is precisely what an incident review needs, and
its absence is why insufficient logging appears on every OWASP list. Across **33 role-gated
routes**, nothing recorded a single refusal.

**Fix — shipped:**

```js
console.warn(
  `[AUTHZ] 403 ${req.method} ${logSafe(req.originalUrl, 100)} — user=${req.user.id} ` +
    `role="${logSafe(req.user.role, 20)}" needs one of [${roles.join(", ")}]`,
);
```

**Logged, not audited to `system_logs`** — deliberately. This fires whenever anyone mis-clicks a
nav link their role cannot use, so it belongs in the operational stream, not the compliance trail
that a DPO reads. If ICTU later wants 403s in the audit table, `audit({ module: "auth", action:
"authz_denied" })` is the one-line change — but it should be a decision, not a default.

> ### A verification that failed usefully
> The first attempt to trigger a 403 forged `role: "it_staff"` into an **admin's** token. It
> returned **200** — because today's AF-04 fix makes `authMiddleware` override the token's role
> with the database's. The test was wrong, not the code; re-running with a genuine `it_staff`
> account was needed. A pleasing way to find out that fix works.

---

## 3. LM-03 — A 9.5 KB error dump containing the auth code · **Low** · CWE-532 · ✅ fixed

**Evidence (before):** `services/googleAuthService.js:97`

```js
console.error("[GOOGLE_AUTH] code exchange / ID-token verification failed:", err);
```

**Measured, not guessed** — a real failed exchange was run against Google and the logged output
searched:

```
error type    : Error / invalid_grant
DOES THE LOGGED OUTPUT CONTAIN...
  client SECRET : false      ← the library does not include it. The important half is safe.
  the auth CODE : true       ← leaked
  the client ID : true       ← public, not a secret
  output size   : 9474 chars ← per failed sign-in
```

**Why it is Low, and why it is still worth fixing.** The client secret — the thing that would
matter — is **not** exposed. The leaked auth code is one-time and short-lived, and by the time
this catch runs it has usually already been spent. But it is still a credential; this path is
reachable 30 times per IP per window; and 9.5 KB per failure is a log-volume problem on its own.

The clincher is consistency: **the transport branch two lines above already does it correctly**
with `describeError(err)`. One branch of the same `catch` was disciplined and the other dumped raw.

**Fix — shipped:**

```js
console.error(
  `[GOOGLE_AUTH] code exchange / ID-token verification failed: ${describeError(err)}` +
    (err?.status ? ` (http ${err.status})` : ""),
);
```

`describeError` already handles the empty-`message` case (mysql2's connection errors carry
`message: ""`), and `err.status`/`err.code` carry what actually diagnoses this — `invalid_grant`,
`400`.

---

## 4. LM-04 — `device_logs` had no retention · **Low** · CWE-400 · ✅ fixed

Every other log table purges daily: `alerts` 30 d (feed rows cascade), `reports` 90 d (row **and**
both files), `system_logs` 365 d. `device_logs` had none — and `system_logs` got its purge for
exactly this reason, having *"had NO purge before, so it grew forever."*

**Measured before claiming urgency:**

```
device_logs rows: 53 | oldest: 2026-06-30 | newest: 2026-08-25
spanning 56 days -> ~1 row/day
```

So this is **consistency, not an emergency** — these are lifecycle events and threshold
*crossings*, not samples. But that rate is a property of things going well: a flapping port or a
metric oscillating around its threshold writes a row per transition, and the table that records an
incident should not be the one that fills the disk during it.

**Fix — shipped.** `deviceLogs.purgeOld(days)` plus a daily job on the existing purge cadence in
`src/server.js`, `DEVICE_LOG_RETENTION_DAYS` default **90** — longer than the alerts feed (a
device's own history is what you read when investigating a repeat offender), shorter than
`system_logs` (this is operational telemetry, not the compliance trail).

---

## 5. Sensitive data in logs — swept, and clean

Every `console.*` in `services/`, `routes/`, `middleware/`, `handlers/`, `src/`, `sockets/` and
`config/` was matched against password/secret/token/apikey/credential/community. **Three hits, all
benign:**

| Hit | Verdict |
|---|---|
| `googleAuthService.js:97` | The one real issue → LM-03, now fixed |
| `installKeyService.js:215` | *"no SECRET_ENC_KEY/MIKROTIK_ENC_KEY — key will not be re-viewable"* — reports the **absence** of a key |
| `secretCrypto.js:52` | A help string telling the operator how to *generate* a key |

**Nothing dumps a request body.** The only match is a commented-out `// console.log(req.body);` at
`routes/users.js:94` — now orphaned, since that route was removed today (auth-flow AF-03). Worth
deleting on the next pass; a live one would have logged admin user-creation bodies.

**Specific good practices found:**

- `middleware/auth.js` logs `len=${token.length}` — the token's **length**, never the token. That
  distinguishes "truncated/corrupt" from "expired" without writing a credential down.
- `MYSQL_PWD` is used in both backup scripts specifically to keep the DB password **off the
  process list**, with the reasoning commented.
- `GENERAL_LOG = OFF` on MariaDB (verified live) — the query log would otherwise contain every
  bound parameter.
- No `mysql2` `debug` flag is set.

**PII is logged deliberately and disclosed.** `system_logs` holds `ip_address` and `user_agent`
by design — that is what makes the audit trail an audit trail. It is covered by the Privacy Notice
and purged at 365 days. That is the correct handling; the finding would be logging it *without*
disclosure or retention.

---

## 6. LM-05 — The monitoring system does not monitor itself · **Low** · ⏳ recommend

Every `raiseAlert` call in the codebase is about **monitored infrastructure** — servers, routers,
UPS, the environment, forecasts. Nothing raises an alert about the **application's own** health.

There is no alerting on:

- a spike in failed sign-ins (`login_denied`) — the signal of a credential attack
- a spike in 403s (now that LM-02 makes them visible at all)
- a sustained 5xx rate
- rate-limit storms (`[RATE]` is logged but never aggregated)
- the handshake budget being exhausted repeatedly

That is a notable irony for this product specifically: it will page ICTU when a UPS battery
degrades over six months, and say nothing while someone grinds credentials against it.

The pieces already exist — `notificationService.raiseAlert` with severity-gated email and a
restart-proof cooldown, and `system_logs` already records the events. What is missing is a job
that reads its own trail:

```js
// services/selfMonitor.js — sketch, on the existing purge/analytics cadence
const [[r]] = await db.query(
  `SELECT COUNT(*) n FROM system_logs
    WHERE action = 'login_denied' AND created_at > NOW() - INTERVAL 15 MINUTE`,
);
if (r.n >= Number(process.env.SELF_ALERT_LOGIN_DENIED || 20)) {
  await notificationService.raiseAlert({
    deviceId: null, type: "auth_failure_spike", severity: "warning",
    title: "Unusual sign-in failures",
    message: `${r.n} denied sign-ins in the last 15 minutes.`,
  });
}
```

**Not built here** — it is a feature, not a fix, and it needs thresholds chosen against real ICTU
traffic rather than guessed. Flagged as the largest remaining gap in this area.

⚠️ **Unable to verify:** whether the deployed backend's stdout is captured, rotated or shipped
anywhere. On the dev machine it goes to the nodemon console. `deployment-guide.md` does not
specify a process supervisor, so whether `console.*` survives a restart — or fills a disk — is
undetermined. See §8.

---

## 7. Logging compliance checklist

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| 1 | **Passwords not logged** | ✅ **Pass** | No password path exists at all any more (AF-03). `MYSQL_PWD` keeps the DB password off the process list |
| 1 | **Tokens not logged** | ✅ **Pass** | `len=${token.length}` only. The one exception (an OAuth auth code) → LM-03, fixed |
| 1 | **PII not logged** | ⚠️ **By design, disclosed** | `system_logs` holds IP + user-agent deliberately — Privacy Notice, 365 d retention — §5 |
| 1 | **API keys not logged** | ✅ **Pass** | Install keys are hashed; the only key-related log reports a key's *absence* |
| 1 | Credit card numbers | ➖ **N/A** | No payment data anywhere in the system |
| 2 | **Failed login attempts** | ✅ **Pass** | `recordSignInDenied` records bad domain, unverified email, pending/rejected/disabled and failed exchange — with the email preserved even for an unknown account |
| 2 | **Authorization failures** | ✅ **Pass** *(was Fail)* | `[AUTHZ] 403 …` across 33 role-gated routes → LM-02 |
| 2 | **Input validation failures** | ✅ **Pass** | Central handler logs all 4xx at `warn` with method + URL; `[POLICY]`, `[RATE]` and install-key refusals name their reason |
| 2 | **System errors** | ✅ **Pass** | 5xx logged at `error` **with the stack**; `unhandledRejection`/`uncaughtException` log before exit |
| 3 | **Log injection prevention** | ✅ **Pass** *(was Fail)* | `utils/logSafe.js` at every attacker-controlled site → LM-01 |
| 3 | **Structured logging** | ⚠️ **Partial** | Consistent `[TAG]` prefixes with `key=value` fields, but plain text, not JSON — §8 |
| 4 | **Secure storage** | ⚠️ **Partial** | `system_logs` is in MariaDB (loopback-only). Console output goes to stdout — destination undetermined (§6). The mysqldump containing it is unencrypted on removable media (database DB-06) |
| 4 | **Rotation policy** | ✅ **Pass** *(DB)* / ⚠️ **Unverified** *(stdout)* | All four log tables now purge daily → LM-04. Stdout rotation depends on a supervisor that is not specified |
| 4 | **Backup strategy** | ✅ **Pass** | `system_logs` is in the nightly mysqldump; the NDJSON streams are checksummed (`checksums.sha256`) with 30 d retention. ⚠️ Restore never tested (database §8) |
| 5 | **Unusual activity detection** | ❌ **Fail** | Nothing alerts on auth-failure spikes → LM-05 |
| 5 | **Error rate monitoring** | ❌ **Fail** | 5xx are logged, never aggregated or alerted → LM-05 |
| 5 | **Performance anomalies** | ⚠️ **Partial** | Sophisticated anomaly detection exists — for **monitored devices** (`analyticsService.detectAnomalies`, per-hour-of-day z-score + IQR). None of it points at the application itself → LM-05 |

---

## 8. Recommendations beyond the fixes

**Decide where stdout goes, before go-live.** This is the largest unknown. `deployment-guide.md`
specifies nginx, MariaDB and InfluxDB but no process supervisor, so nothing states whether
`console.*` is captured, rotated, or discarded on restart. With `systemd`, `journald` handles both
for free:

```ini
# /etc/systemd/system/cspc-monitoring.service
[Service]
ExecStart=/usr/bin/node /opt/cspc/backend/src/server.js
Restart=always
StandardOutput=journal
StandardError=journal
```

`journalctl -u cspc-monitoring -f` then follows it and `journalctl --vacuum-time=30d` bounds it.
This also answers the restart question the audits keep deferring to "the process supervisor".

**Structured logging is not worth it yet.** The `[TAG] key=value` convention is consistent and
greppable, and for a single-process on-prem deployment with no log aggregator, JSON lines would
add ceremony without a consumer. Revisit only if logs are ever shipped somewhere that parses them.

**Delete the orphaned `// console.log(req.body)`** at `routes/users.js:94` — its route is gone.

---

## 9. Risk score and priority

**Before: 7 / 10. After: 9 / 10.**

The remaining point is LM-05 (self-monitoring) plus the undetermined stdout destination — both
deployment-shaped rather than code-shaped.

| # | Action | Owner | Effort |
|---|--------|-------|--------|
| 1 | ✅ **Sanitise attacker-controlled log fields** (`logSafe`, 8 tests) | shipped | — |
| 2 | ✅ **Log 403s** — the one silent authorization outcome | shipped | — |
| 3 | ✅ **Stop dumping the OAuth error object** / ✅ **purge `device_logs`** | shipped | — |
| 4 | 🔲 **Run the backend under `systemd`** so stdout is captured and rotated (§8) | you, at deployment | 15 min |
| 5 | 🔲 **Self-monitoring job** — alert on a sign-in-failure spike (§6) | future | ~2 h |

### Quick tests

```bash
cd backend && npm test          # 317/317, incl. tests/logSafe.test.js

# LM-01 · a newline in a body field must not forge a line
curl -s -o /dev/null -X POST -H 'Content-Type: application/json' \
  --data-binary '{"install_key":"AIK-bogus","hostname":"evil\n[install-keys] FORGED"}' \
  localhost:3000/api/agents/register
# server log must show:  host="evil\n[install-keys] FORGED"   ← one line, escape visible

# LM-02 · a 403 must now leave a trace
#   Call any admin-only route with a genuine it_staff token; the log must show
#   [AUTHZ] 403 GET /api/users — user=9 role="it_staff" needs one of [admin]
#   ⚠️ Forging role in the token will NOT work — authMiddleware reads it from the DB (AF-04).

# LM-03 · a failed sign-in must log one line, not 9.5 KB
curl -s -X POST -H 'Content-Type: application/json' -d '{"code":"bogus"}' \
  localhost:3000/api/auth/google
# server log:  [GOOGLE_AUTH] code exchange / ID-token verification failed: invalid_grant (http 400)
```

---

## 10. What was verified, and what was not

**Verified:** every `console.*` swept for secrets across seven directories; the OAuth error
contents measured by running a **real** failed exchange against Google and searching the output
for the client secret, the auth code and the client ID; the log-injection vectors tested
**separately** — a raw socket proved the header path is rejected by Node's HTTP parser (400) while
the JSON body path reaches the application; `device_logs` growth measured (53 rows / 56 days)
before calling it a risk; `logSafe` asserted to contain zero raw control bytes. 317/317 tests pass.

**Unable to verify — stated rather than assumed:**

- **Where the deployed backend's stdout goes.** No supervisor is specified, so capture, rotation
  and survival across restart are all undetermined. This is the single biggest gap in the logging
  story and it is a deployment decision — §8.
- **Whether the `[AUTHZ]` line renders as intended in production**, since the live 403 test was run
  against the nodemon console rather than a captured log.
- **Log volume under real load.** The 9.5 KB dump was measured once; how much the whole system
  writes per day under ICTU traffic is unknown, which is also why no rotation size is recommended.
- **`system_logs` reading on the History page** was audited for authorization (authorization AZ-03)
  but not for rendering — whether a stored control character displays safely in React was not
  tested. React escapes by default, so this is expected to be fine, but it was not exercised.
