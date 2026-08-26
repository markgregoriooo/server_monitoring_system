# Database Security Audit — CSPC-ICTU Monitoring System

**Date:** 2026-08-25
**Scope:** every database interaction in the codebase — **216 MySQL/MariaDB call sites** across
`backend/services/`, `routes/`, `handlers/`, `middleware/`, plus the **InfluxDB/Flux** query
surface, the connection/pool configuration, the live server settings, and the backup pipeline
(`ops/db-backup/`, `ops/offsite-backup/`)
**Stores:** MariaDB (relational) + InfluxDB 2.x (time-series) + flat-file NDJSON backups
**Companions:** the api-infra, auth-flow, authorization and business-logic reviews of the same date
**Method:** exhaustive static sweep for dynamic SQL, then **live interrogation of the running
database** — `information_schema`, `SHOW GRANTS`, `CURRENT_USER()`, server variables, and a real
runaway-query test.

---

## 0. Verdict — Database Security: 7 / 10 → **9 / 10 after fixes**

**No SQL injection exists in this codebase.** That is the headline, and it is not a
spot-check: all 216 query call sites were swept, and the three places that build SQL
dynamically were each traced to their source. Every one is derived from a code-owned whitelist
or a clamped integer — never from a request body.

The same is true of the second, less obvious injection surface. InfluxDB's Flux is a query
*language*, and this system builds Flux strings — but range presets are whitelisted, custom time
bounds are re-serialised from `Date` objects (`historyRange.js`), measurement/field names come
from an internal `METRICS` map, and the single user-supplied value that reaches a Flux string
(`deviceId`) is integer-validated at two independent gates.

What the audit did find sits almost entirely at the **operational** layer rather than the code
layer: the application connects to MariaDB as **root with `GRANT ALL … WITH GRANT OPTION`**, and
until today there was **no query timeout at either the driver or the server**.

| ID | Finding | Sev | CWE | Status |
|----|---------|-----|-----|--------|
| **DB-01** | **App connects as MySQL `root` with ALL PRIVILEGES + GRANT OPTION** | **High** | CWE-250, CWE-269 | ⏳ **Deployment step** — §2 |
| **DB-02** | **No query timeout at driver *or* server** — one runaway query holds a pooled connection forever | **Medium** | CWE-400 | ✅ **Fixed** |
| **DB-03** | LIKE metacharacters unescaped and unbounded in the History search | **Low** | CWE-20 | ✅ **Fixed** |
| **DB-04** | `SELECT *` on `users` at four sites — field minimisation | **Low** | CWE-213 | ⏳ Recommend — §5 |
| **DB-05** | No database-level encryption at rest (`INNODB_ENCRYPT_TABLES = OFF`) | **Low** | CWE-311 | ⏳ Accept / §6 |
| **DB-06** | The **local** `mysqldump` is plaintext gzip on removable media | **Low** | CWE-311 | ⏳ Recommend — §6 |

**Result: 303/303 backend tests pass. Both fixes verified against the live database — including
killing a real runaway query.**

> ### ⚠️ Correction to the api-infra audit (A-05) and the consolidated report (H-3)
> Both said the plaintext agent tokens were *"already leaving the building nightly, in a file on
> cloud storage."* **That overstated the cloud exposure**, in two ways:
>
> 1. **Offsite sync is not enabled.** Every `BACKUP_OFFSITE_*` variable in `backend/.env` is
>    blank, so `sync-offsite.sh` is not running (it was deliberately deferred to deployment).
> 2. **When it is enabled, the upload is client-side encrypted.** `ops/offsite-backup/` uses an
>    rclone **`crypt`** remote (`b2crypt`) with `filename_encryption = standard` and
>    `directory_name_encryption = true` — data *and* filenames are encrypted before they leave
>    the building, so Backblaze never holds a readable dump.
>
> **What was accurate, and still is:** `ops/db-backup/dump-mysql.sh` writes
> `mysql-YYYY-MM-DD.sql.gz` — **gzip, not encrypted** — into `BACKUP_DIR`, which is a micro SD
> or USB drive in the server room. Permanent, non-expiring agent credentials sitting in plaintext
> on removable media is a genuine finding, and hashing them was the right fix. But the correct
> severity story is *"removable media and anyone with file access on the server"*, not
> *"readable on the cloud"*. Both source reports have been corrected.

---

## 1. No SQL injection — the sweep, and the three dynamic sites

```
216 db.query() / conn.query() call sites
  0 built by string concatenation
  3 containing an interpolated SQL fragment  ← each traced below
```

**The critical flag the brief asks for — direct string concatenation in a query — does not occur
anywhere in this codebase.** Every value is bound with `?` placeholders.

The three interpolated fragments are the ones worth explaining, because "an interpolated SQL
string" is exactly what a scanner flags and what a reviewer must then judge:

### 1a · `services/alertRulesService.js:235` — a dynamic `SET` clause ✅ safe

```js
const sets = Object.keys(f).map((k) => `${k} = ?`).join(", ");
await db.query(`UPDATE alert_rules SET ${sets}, updated_by = ?, … WHERE alert_rule_id = ?`,
               [...Object.values(f), userId, Number(id)]);
```

Column *names* are interpolated. That is only safe if those names cannot come from the request —
and they cannot. `f = cleanRule(data)` (`services/alertRuleValidation.js:124`) iterates a fixed
`RULE_FIELDS` array and writes `out[f.out]`, where `f.out` is a **literal column name in the
source**:

```js
for (const f of RULE_FIELDS) {
  if (data[f.in] !== undefined) { … out[f.out] = parsed; }   // key from CODE, not from data
}
```

A body of `{"threshold_value = 1, severity='critical' --": 1}` produces nothing at all, because
the loop only ever reads `data[f.in]` for names it already knows. **Values remain bound.** This
is the correct pattern for a dynamic `SET`, and the whitelist is shared with validation so the
two cannot drift.

### 1b · `services/analyticsService.js:250, 269` — a dynamic `WHERE` ✅ safe

```js
const d = clampInt(days, 1, 365, 30);
const since = `created_at >= NOW() - INTERVAL ${d} DAY`;
```

`d` is `parseInt` → clamped to 1–365 → a bare integer. It cannot carry syntax. The code says so
in a comment, and the comment is true.

### 1c · `${SERVER_SELECT}` / `${BASE_SELECT}` (5 sites) ✅ safe

`agentService.js:633`, `alertsService.js:74`, `installKeyService.js:226/320`,
`reportService.js:832` — all interpolate a **module-level constant SELECT prefix**, then append a
parameterised `WHERE … = ?`. No user data touches the string.

### 1d · Flux / InfluxDB — the second injection surface ✅ safe

Flux is a query language and this codebase builds Flux strings, so it deserves the same scrutiny:

| Input | Protection |
|---|---|
| Range presets (`-1h`, `-24h`, …) | Whitelisted in `historyRange.PRESET_WINDOW`; an unknown preset falls back to the default |
| Custom `?start=&stop=` | Parsed to `Date`, then **re-serialised** with `toISOString()` — *"the user's original text never reaches the query"* (`historyRange.js:101`). A malformed custom window is a 400 |
| `deviceId` | `reportService.fluxDeviceFilter` validates `Number.isInteger(id) && id > 0` and throws otherwise — *"the second of two gates"*, the first being the INT column at `create()` |
| `measurement` / `_field` | From the internal `METRICS` map via `metricMeta()`, which returns `null` for an unknown key — never from the URL |
| `aggregateWindow(every:)` | Built internally from clamped numbers |

**NoSQL injection (item 10) is N/A** — there is no MongoDB, no `$where`/`$ne`/`$gt` operator
surface, and no user JSON is passed to a filter. Flux is the analogue and it is covered above.

---

## 2. DB-01 — The application runs as MySQL root · **High** · CWE-250, CWE-269

**Evidence — read from the live database, not inferred:**

```sql
SELECT CURRENT_USER();   →  root@localhost
SHOW GRANTS;             →  GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost` WITH GRANT OPTION
```

`backend/.env` has `DB_USER = root`.

**Why it matters.** The application needs `SELECT/INSERT/UPDATE/DELETE` on **one** schema. It has
every privilege MariaDB offers, on **every** schema, plus the right to grant those privileges to
others. `DROP`, `ALTER`, `CREATE USER`, `GRANT`, `FILE` — all available to the process that also
terminates HTTP requests from the campus LAN.

This is defence in depth, and it is worth being precise about that: **there is no SQL injection
to escalate through** (§1), so this is not currently exploitable. Its value is in the *next* bug —
the one nobody has found yet. With a least-privilege account, an injection is a data-read
incident; as root, the same injection is `DROP DATABASE`, or `SELECT … INTO OUTFILE` writing a
web shell, or a new admin MySQL user.

**The project already knows the right answer** — `deployment-guide.md` §2.1 says *"don't run the
app as root"* and provides the `GRANT`. The gap is that nothing enforces it, and a `.env` gets
copied to the server with everything else.

**Remediation** (deployment step — deliberately not applied here, because changing the DB user on
a working development machine risks locking you out of your own database):

```sql
-- 'localhost', NOT '%' — the backend runs on the same host, so the account never needs
-- to accept a connection from anywhere else.
CREATE USER 'cspc_app'@'localhost' IDENTIFIED BY 'a-strong-password';
GRANT SELECT, INSERT, UPDATE, DELETE ON cspc_ictu_monitoring.* TO 'cspc_app'@'localhost';
FLUSH PRIVILEGES;
```

```ini
# backend/.env
DB_USER=cspc_app
DB_PASSWORD=…
```

Then verify on the deployed box — `SELECT CURRENT_USER();` must return `cspc_app@localhost`.

⚠️ **A second issue in the guide, now fixed:** it created the account as `'cspc_app'@'%'`, which
permits connection from **any** host. Corrected to `'localhost'`, with the explicit no-DDL
reasoning and a pre-go-live verification block (`deployment-guide.md` §2.1).

**Separate accounts (item 3, second half):** there is no split between application, migration and
admin accounts. With migrations run by hand from `migrations/*.sql`, the natural split is the app
account above (no DDL) plus a human DBA login for migrations — which is what `root` should be
reserved for.

---

## 3. DB-02 — No query timeout at any layer · **Medium** · CWE-400 · ✅ fixed

**Evidence (before):**

```sql
SELECT @@max_statement_time;   →  0.000000     -- unlimited, server-side
```

and `config/mysql.js` said in its own comment: *"connectTimeout covers CONNECTING only — it is
not a query timeout. mysql2 has no per-query timeout option, so a slow query holds its pool
connection until the server answers."*

So there was **no bound at either end**.

**Why it matters here specifically.** The pool is `connectionLimit: 10` with `queueLimit: 0`
(unbounded queue). One query that never finishes — a lock wait, a missing index after a schema
change, a report over a huge period — permanently consumes 1/10th of the pool. Because the queue
is unbounded, the pool does not error; it **queues**. The symptom is *"the dashboard is slow"*,
never a message anyone can search for. Enough of them and the SNMP poller, the MikroTik poller and
agent ingest all stall behind a `SELECT` — a monitoring system that stops monitoring.

**Fix — shipped.** `config/mysql.js` now sets a session statement timeout on every new pooled
connection:

```js
const STATEMENT_TIMEOUT_SEC = Number(process.env.DB_STATEMENT_TIMEOUT_SEC) || 30;

pool.on("connection", (conn) => {
  // Fire-and-forget: a server that rejects the variable must not stop the connection
  // being used. MariaDB = max_statement_time (SECONDS); MySQL 5.7+ = max_execution_time
  // (MILLISECONDS, SELECT only). Both attempted, failures ignored, so it works on either.
  conn.query(`SET SESSION max_statement_time = ${Number(STATEMENT_TIMEOUT_SEC)}`, () => {});
  conn.query(`SET SESSION max_execution_time = ${Number(STATEMENT_TIMEOUT_SEC) * 1000}`, () => {});
});
```

Applied per connection because the pool creates them lazily and mysql2 has no "run this on
connect" option. Deliberately generous — a backstop against a query that will *never* finish, not
a performance budget.

**Verified live — a real runaway query, not a passing test:**

```
session max_statement_time : 30 seconds   (was 0 = unlimited)
SELECT SLEEP(60)           : killed after 30.0s
SELECT COUNT(*) FROM users : 4            ← normal queries unaffected
```

---

## 4. DB-03 — LIKE metacharacters unescaped · **Low** · CWE-20 · ✅ fixed

**Evidence (before):** `services/historyService.js:130-136`

```js
const term = String(search ?? "").trim();
const like = `%${term}%`;
clauses.push("(h.message LIKE ? OR h.action LIKE ? OR h.device_name LIKE ? OR h.actor_name LIKE ?)");
```

**Why it matters.** Binding the parameter prevents *injection* — but it does not stop the term
being **interpreted**. In SQL `LIKE`, `_` matches any single character and `%` matches anything:

- Searching `server_01` also matched `server-01`, `serverX01` — quietly wrong results in an
  **audit log**, which is the one place results need to be exact.
- Searching `%` matched every row.
- There was no length cap, and each term is compared against **four** columns with a leading
  wildcard — which cannot use an index, so a long string is pure scan cost.

**Fix — shipped:**

```js
const term = String(search ?? "").trim().slice(0, 120);
if (term) {
  const like = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
```

Backslash is escaped **first** (it is in the character class), or it would escape the escapes.

**Verified against the expression as it exists on disk** (extracted from the file rather than
retyped, so shell quoting could not make the test lie):

```
"server_01"       -> "%server\_01%"
"%"               -> "%\%%"
"100%"            -> "%100\%%"
"a\b"             -> "%a\\b%"
"normal"          -> "%normal%"      ← plain text untouched
```

---

## 5. DB-04 — `SELECT *` on `users` · **Low** · CWE-213 · ⏳ recommend

Four sites: `userService.js:102, 117, 127, 447` (`getUserById`, `findByEmail`,
`findByGoogleSub`, `updateOwnProfile`), plus `SELECT r.*` / `SELECT k.*` in `alertRulesService`
and `installKeyService`.

**Why it is only Low.** The columns pulled are `hash_password` (now vestigial and **all-NULL** —
see auth-flow AF-03), `google_sub` and `token_version`. Nothing reaches a response: the list
paths destructure it away (`rows.map(({ hash_password, ...user }) => user)`), `issueSession`
builds an explicit payload, and `installKeyService.toClient()` re-projects `k.*` to a whitelist
exposing only `canReveal: Boolean(r.key_cipher)`.

**Why it is worth recording at all.** `SELECT k.*` on `agent_install_keys` pulls `key_hash` **and**
`key_cipher` into memory, and nothing leaks them only because `toClient()` is disciplined. Naming
the columns turns "no route leaks the cipher" from a discipline into a guarantee:

```js
// installKeyService.BASE_SELECT — replace `k.*` with the columns actually used
SELECT k.install_key_id, k.label, k.key_prefix, k.status, k.expires_at,
       k.use_count, k.created_at, k.revoked_at, (k.key_cipher IS NOT NULL) AS can_reveal,
       …
```

**Not applied** — `findByEmail`/`findByGoogleSub` feed the Google login path, and narrowing the
column list there risks dropping a field the sign-in flow reads. That is the highest-consequence
path in the system to break for a Low finding.

---

## 6. Encryption at rest — what is and is not protected

**Live server state:** `INNODB_ENCRYPT_TABLES = OFF`, `HAVE_SSL = DISABLED`.

So there is **no database-level or disk-level encryption**, and no TLS on the MySQL connection.
Both are mitigated rather than absent:

| Concern | Reality |
|---|---|
| **TLS in transit (item 13)** | `DB_HOST = localhost`, `INFLUX_URL = http://localhost:8086` — both loopback. Traffic never touches a network, so TLS would protect nothing. ⚠️ **If the database is ever moved to another host, this becomes a real finding** and `mysql2`'s `ssl` option must be set |
| **Column-level encryption (item 4)** | ✅ The three credentials that matter are individually protected: `agent_tokens.approved_token_hash` (SHA-256) + `approved_token_cipher` (AES-256-GCM), `agent_install_keys.key_hash` + `key_cipher`, `mikrotik_devices.api_password` (AES-256-GCM). Keys live in `backend/.env`, not in the database |
| **Full-disk / tablespace** | ❌ Off. Meaningful only against physical theft of the server, and it is an ICTU infrastructure decision rather than an application one |

### DB-06 · The local dump is plaintext gzip

`ops/db-backup/dump-mysql.sh:78` → `mysqldump … | gzip -c > "$BACKUP_DIR/mysql-YYYY-MM-DD.sql.gz"`.

That file contains **every** table — users, `system_logs` (IP + user-agent), and the credential
tables — and `BACKUP_DIR` is a micro SD or USB drive. `gzip` is compression, not encryption.

**The offsite leg is fine** (§0 correction): rclone `crypt` encrypts data *and* filenames
client-side. It is the **local** copy on removable media that is readable by anyone who picks up
the drive.

```bash
# ops/db-backup/dump-mysql.sh — encrypt the dump at rest, same key material as rclone
mysqldump … "$DB_NAME" | gzip -c | \
  gpg --batch --yes --symmetric --cipher-algo AES256 \
      --passphrase-file /etc/cspc/backup.pass -o "$OUT.gpg"
```

⚠️ **Unable to verify:** whether `gpg` is available on the target Linux server — it is not
installed on this Windows development machine, so the snippet is untested here. An alternative
that needs no new dependency is full-disk encryption on the backup drive itself (LUKS), which is
arguably the better answer since it also covers the NDJSON streams.

---

## 7. What passed — with evidence

**Schema integrity (item 15) — read from `information_schema` on the live database:**

```
tables: 25   foreign keys: 34   unique constraints: 15   non-InnoDB tables: 0
```

34 foreign keys across 25 tables is genuinely good coverage — this is why deleting a device
cascades its `server_specs`, `device_network`, `agent_tokens` and logs cleanly instead of leaving
orphans, and why `alert_rules.device_id` cannot point at a device that does not exist (the code
catches `ER_NO_REFERENCED_ROW_2` and returns a 400).

| Item | Verdict |
|---|---|
| **Connection strings (2)** | ✅ All credentials from `process.env`; nothing hardcoded. No `\|\| "root"`-style fallback defaults. `.env` and `.env.*` are gitignored and **verified absent** from `git ls-files` |
| **Connection pool (7)** | ✅ Explicit `connectionLimit: 10`, `waitForConnections: true`, documented. ⚠️ `queueLimit: 0` is unbounded by choice — with DB-02 fixed, a stuck query now releases after 30 s instead of queueing forever |
| **Transactions (8)** | ✅ Multi-step writes are wrapped: `policyService.accept` (acceptance + audit row in one transaction, *because the audit row is the evidence*), `agentService.register` (device + specs + network + token), and — new today — the last-admin guard (`inTransaction` + `SELECT … FOR UPDATE`, business-logic BL-02). Rollback paths present |
| **Audit logging (9)** | ✅ `system_logs` records actor, module, action, IP, user-agent. Denied sign-ins are logged, not just successes. Report generate/download/email/delete and install-key reveal all audited. ⚠️ **DDL and privilege changes are not logged** — see §8 |
| **Row/tenant isolation (11)** | ➖ N/A — single tenant, no `tenantId` column exists. Per-user rows (`alert_notifications`, `widget_prefs`) always scope on `req.user.id` server-side |
| **Least-privilege networking (12)** | ✅ MariaDB and InfluxDB both bound to `localhost`; neither is network-exposed. Complements the port-3000 firewall rule (api-infra A-03) |
| **Pagination & limits (17)** | ✅ Every list path is capped: history `pageSize` 1–200 and `page` 1–100000, alerts `limit` 1–500, notifications `limit` 1–100 — all via `clampInt`/`Math.min`. `LIMIT ${pageSize} OFFSET ${offset}` interpolates only clamped integers |
| **Retention & deletion (19)** | ✅ Every growing table has an enforced daily purge: alerts 30 d (feed rows cascade), reports 90 d (**row *and* both files**), `system_logs` 365 d, backups 30 d. Run at startup and every 24 h |
| **Migrations safety (20)** | ✅ Versioned files in `migrations/`, run by hand, each documenting *why*. Today's `2026-08-25_agent_token_hash.sql` backfills the hash **before** dropping the source column — a test asserts that ordering, since reversing it would 403 an entire fleet |
| **Raw-query escape hatch (21)** | ➖ N/A — no ORM. `mysql2` is used directly with placeholders, so there is no `queryRaw`/`knex.raw` bypass to audit |
| **PII in logs/metrics (25)** | ✅ `GENERAL_LOG = OFF` (verified live) — the query log would otherwise contain every parameter. No mysql2 `debug` flag set. The auth log records `len=${token.length}`, never the token |
| **Indexing sensitive data (26)** | ✅ **Improved today.** `agent_tokens.approved_token` was `UNIQUE`-indexed **in plaintext**; the index is now on `approved_token_hash`. `agent_install_keys` already indexed the hash |
| **Caching layers (28)** | ➖ N/A — no Redis/Memcached. Caches are in-process (`alertRulesService` rule cache, `latestMetrics`) and die with the process |
| **Analytics/ETL exports (29)** | ⚠️ Partial — reports (CSV/PDF) contain device telemetry, not personal data, and downloads are audited. NDJSON backups carry no PII. The `mysqldump` **does** (see DB-06) |

---

## 8. Gaps that are not code defects

- **No DDL / privilege-change auditing (item 24).** MariaDB's general log is off (correctly — it
  would log PII), and there is no `server_audit` plugin. So a `DROP TABLE` or a `GRANT` leaves no
  trace. Enabling `server_audit` filtered to DDL + privilege events would close this without
  logging query parameters — worth doing at deployment, where DB-01's least-privilege account also
  lands.
- **No credential rotation schedule (item 14).** `.env` holds static passwords with no rotation
  procedure. For an on-prem single-server capstone a secrets manager is over-engineering; a
  documented "rotate at handover and annually" line in the deployment guide is proportionate.
  ⚠️ Note the constraint discovered today: `MIKROTIK_ENC_KEY`/`SECRET_ENC_KEY` **cannot** be
  rotated casually — every stored cipher becomes undecryptable.
- **No restore test (item 18).** Backups are written, checksummed (`checksums.sha256`) and
  retained, but nothing has ever been restored from them. **A backup that has never been restored
  is a hypothesis.** One `mysql < dump.sql` into a scratch schema would convert it into a fact.

---

## 9. Checklist diff

| # | Item | Verdict | Note |
|---|------|---------|------|
| 1 | Parameterized queries / ORM | ✅ **Pass** | 216 call sites, **0** concatenation. 3 interpolated fragments all whitelist- or integer-derived — §1 |
| 2 | Connection string security | ✅ **Pass** | All from `process.env`; no hardcoded fallback; `.env*` gitignored and untracked |
| 3 | DB user least privilege | ❌ **Fail** | `root` + `ALL PRIVILEGES … WITH GRANT OPTION` → DB-01. No app/migration/admin split |
| 4 | Encryption at rest | ⚠️ **Partial** | No DB/disk encryption; the 3 credential columns **are** individually hashed/encrypted — §6 |
| 5 | PII handling compliance | ✅ **Pass** | Minimised (the 23 photos are gone), redacted from logs, retention enforced. RA 10173, not GDPR — see the consolidated report |
| 6 | Query timeouts | ✅ **Pass** *(was Fail)* | `max_statement_time = 30 s` per connection; verified by killing a real `SLEEP(60)` → DB-02 |
| 7 | Connection pool settings | ✅ **Pass** | Explicit limit 10, documented; unbounded queue is a stated choice, now bounded in effect by DB-02 |
| 8 | Transaction handling | ✅ **Pass** | Multi-step writes wrapped; rollback paths present — §7 |
| 9 | Audit logging | ⚠️ **Partial** | Application actions fully audited; **DDL/privilege changes are not** — §8 |
| 10 | NoSQL injection hardening | ➖ **N/A** | No document store. Flux is the analogue and is whitelisted — §1d |
| 11 | Row/tenant isolation | ➖ **N/A** | Single tenant; per-user rows scope on `req.user.id` |
| 12 | Least-privilege networking | ✅ **Pass** | MariaDB + InfluxDB both loopback-bound |
| 13 | TLS in transit | ⚠️ **N/A today** | Both connections are loopback (`HAVE_SSL = DISABLED`). Becomes a real finding if either store moves off-host — §6 |
| 14 | Secret management & rotation | ⚠️ **Partial** | Env vars, gitignored, not in a manager; no rotation schedule — §8 |
| 15 | Schema & integrity controls | ✅ **Pass** | 25 tables, **34 FKs**, 15 unique constraints, all InnoDB — §7 |
| 16 | Field-level minimization | ⚠️ **Partial** | `SELECT *` at 4 user sites + 2 `t.*` — nothing leaks, but by discipline → DB-04 |
| 17 | Pagination & query limits | ✅ **Pass** | Every list path clamped — §7 |
| 18 | Backup/restore security | ⚠️ **Partial** | Offsite **is** client-side encrypted (rclone `crypt`); the local dump is plaintext gzip → DB-06. **Restore never tested** — §8 |
| 19 | Data retention & deletion | ✅ **Pass** | Enforced daily purges on every growing table — §7 |
| 20 | Migrations safety | ✅ **Pass** | Versioned, hand-run, ordering asserted by test — §7 |
| 21 | ORM raw-query escape hatch | ➖ **N/A** | No ORM |
| 22 | LIKE / regex input handling | ✅ **Pass** *(was Fail)* | Metacharacters escaped + 120-char cap → DB-03 |
| 23 | Query timeouts & resource guards | ⚠️ **Partial** | Statement timeout now set (item 6); no `work_mem`/CPU caps — a MariaDB tuning task, not application code |
| 24 | Audit & monitoring depth | ❌ **Fail** | No DDL/GRANT auditing — §8 |
| 25 | PII in logs/metrics | ✅ **Pass** | `GENERAL_LOG = OFF`; no driver debug; no token/password logging |
| 26 | Indexing of sensitive data | ✅ **Pass** *(fixed today)* | Plaintext-token unique index replaced by a hash index |
| 27 | Service/account lifecycle | ❌ **Fail** | One shared `root` account, not time-bound, never reviewed → DB-01 |
| 28 | Caching layers | ➖ **N/A** | No external cache |
| 29 | Analytics/ETL exports | ⚠️ **Partial** | Reports carry telemetry (audited); the mysqldump carries PII → DB-06 |

---

## 10. Risk score and priority

**Before: 7 / 10. After the shipped fixes: 9 / 10.**

The remaining point is almost entirely **DB-01** — an operational decision that belongs at
deployment, not a code change to make on a working development machine.

| # | Action | Owner | Effort |
|---|--------|-------|--------|
| 1 | ✅ **Statement timeout** — verified by killing a real runaway query | shipped | — |
| 2 | ✅ **LIKE escaping + length cap** in the audit-log search | shipped | — |
| 3 | 🔲 **Create `cspc_app@localhost` and stop running as root** (§2) — the single highest-value remaining change | **you, at deployment** | 5 min |
| 4 | 🔲 **Test a restore** — a backup that has never been restored is a hypothesis (§8) | you | 20 min |
| 5 | 🔲 **Encrypt the local dump, or the backup drive** (§6) — it holds `system_logs` PII on removable media | you | 30 min |
| 6 | 🔲 Name the columns in `installKeyService.BASE_SELECT` instead of `k.*` (§5) | either | 5 min |

### Quick tests

```bash
cd backend && npm test          # 303/303

# DB-02 · the statement timeout is real
node --input-type=module -e "import('./config/env.js').then(async()=>{
  const db=(await import('./config/mysql.js')).default;
  const [[r]]=await db.query('SELECT @@max_statement_time AS s'); console.log('timeout:', r.s);
  const t=Date.now();
  try { await db.query('SELECT SLEEP(60)'); console.log('NOT enforced'); }
  catch { console.log('killed after', ((Date.now()-t)/1000).toFixed(1)+'s'); }
  await db.end(); });"
# → timeout: 30   /   killed after 30.0s

# DB-01 · what are you actually connecting as?
node --input-type=module -e "import('./config/env.js').then(async()=>{
  const db=(await import('./config/mysql.js')).default;
  console.log((await db.query('SELECT CURRENT_USER() u'))[0]);
  console.log((await db.query('SHOW GRANTS'))[0]);
  await db.end(); });"
# → must be cspc_app@localhost in production, NOT root@localhost

# DB-03 · a literal underscore must not act as a wildcard
#   Search the History page for `server_01`. It must not match `server-01`.
```

---

## 11. What was verified, and what was not

**Verified against the live database:** `CURRENT_USER()` and `SHOW GRANTS`; `information_schema`
counts for tables, foreign keys, unique constraints and storage engines; the server variables
`max_statement_time`, `general_log`, `innodb_encrypt_tables`, `have_ssl`; the statement timeout
killing a real `SELECT SLEEP(60)` at exactly 30 s while normal queries continued; the LIKE
escaping tested against the expression **as it exists on disk** (extracted from the file, not
retyped). All 216 query call sites swept for concatenation. 303/303 tests pass.

**Unable to verify — stated rather than assumed:**

- **`gpg` availability on the deployment host** for the DB-06 dump-encryption snippet — not
  installed on this Windows machine, so that snippet is untested. LUKS on the backup drive is the
  dependency-free alternative.
- **Restore has never been exercised.** Backups are written and checksummed; nothing has been
  restored from them. This is the single largest untested assumption in the data-protection story.
- **InfluxDB token scope.** `INFLUX_TOKEN` was not inspected for whether it is an all-access
  operator token or bucket-scoped. `influx auth list` on the server would settle it — if it is an
  operator token, that is the InfluxDB equivalent of DB-01.
- **Production server settings.** Everything above was read from the **development** MariaDB. The
  deployed instance may differ, and DB-01/DB-02 must be re-checked there.
- **DDL auditing** was confirmed absent by the lack of a `server_audit` plugin in the variables
  read; the plugin list itself was not enumerated.
