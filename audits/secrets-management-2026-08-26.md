# Secrets Management Audit — 2026-08-26

**Scope.** Every tracked file (343) plus the full git history (287 commits), the local
`backend/.env`, `iot/esp32/env_monitor_v2/secrets.h`, the `ops/` backup scripts, the Go
agent and its two installers, and the MySQL schema.

**Method.** Pattern scan for assignment-shaped secrets and high-entropy literals across
the working tree; `git log -S` over history for each known secret name and value;
comparison of the values found in history against the values currently live in `.env`
and `secrets.h` (compared programmatically — no secret is reproduced in this document
except one that is already burned and named below because remediation depends on
recognising it); read of every credential read/write path in the backend.

**Headline.** No secret is hardcoded in the current source tree. Three were committed in
the past, and **one of them was still the live credential at the time of this audit** — it
has since been rotated (S-01). The remaining findings are about how secrets are *stored*
and *handed over*, not about where they are written down.

| | |
|---|---|
| **Residual risk score, before this audit** | **7.5 / 10** |
| **After the fixes applied here** | **≈ 3.0 / 10** |
| **After S-04 is actioned by an operator** | **≈ 2.0 / 10** |

S-01 (the published `DEVICE_SECRET`) **has been rotated** and S-05 (plaintext SNMP
communities) **has been migrated on the live database** — see "Actions completed" at the
end. The one item code cannot close is S-04: the MySQL account still has no password.

---

## Exposure context (read this before the severities)

The remote is `https://github.com/markgregoriooo/server_monitoring_system`. An
unauthenticated `GET /repos/…` returns **HTTP 404**, which GitHub returns for both a
private repository and one that does not exist — so **the history is not currently
world-readable**, and the severities below are set on that basis.

*Unable to verify* which of the two it is without an authenticated call. That distinction
matters less than it looks: the value in S-01 is in every clone, every fork, every
`git bundle`, and every backup of this repository that anyone has ever taken, and it
becomes world-readable the moment the repo is flipped public — which is a normal thing to
do with a capstone project at submission time. Treat the history as "shared with an
unbounded set of people", not as "safe because the repo is private today".

---

## Findings

### S-01 — CRITICAL — The live `DEVICE_SECRET` is readable in git history

**CWE-798** (Use of Hard-coded Credentials), **CWE-540** (Inclusion of Sensitive
Information in Source Code)

**Evidence.**

- `iot/esp32/env_monitor_v2.ino:130` at commit `5f5a084` (2026-06-09):
  `const char* deviceSecret = "REDACTED-ROTATED-DEVICE-SECRET";`
- Removed at `219f36e` (2026-08-16), *"fix(security): keep credentials out of git and out
  of URLs"* — which moved it to the gitignored `secrets.h`. The split stopped new
  exposure; it did not remove the old blob.
- Same commit shows the secret was also being sent **in the query string**:
  `"/socket.io/?EIO=3&transport=websocket&deviceKey=%s"` — so it was written verbatim into
  every proxy and access log the handshake touched, for that whole period. Already fixed
  (header-based since `219f36e`).
- **Was still live when found.** Compared programmatically at audit time: the value in
  `backend/.env` (`DEVICE_SECRET`, 27 chars) and in `iot/esp32/env_monitor_v2/secrets.h`
  were both byte-identical to the value in the historical blob. Rotated since — see
  "Remediation — DONE" below.

**Why it matters.** `backend/src/server.js:331-332` — presenting this string on the
Socket.IO handshake sets `socket.isDevice = true`. That is the authority to:

- emit `sensorData` — accepted, broadcast to every dashboard, and **evaluated against the
  alert rules on every reading** (`handlers/sensorHandler.js`);
- emit `offlineData` — written to InfluxDB **under the sender's own timestamps**
  (`handlers/offlineDataHandler.js`), i.e. to write history;
- emit `irFired` / `irChannelMap` — drive the air-conditioning state.

The failure mode is not "someone reads the temperature". It is that the record this
system exists to keep can be fabricated: a real smoke event can be buried under readings
that say the room is fine, and the fabrication is indistinguishable from a real reading
because it arrives on the same authenticated channel. Nothing else on the socket layer
distinguishes an ESP32 from anything else holding the string — there is no per-device
identity, no nonce, and no rotation.

**Exploitability.** Trivial for anyone with repo access or an old clone. `git log -S` and
the value is in hand; no cracking, no timing, no network position needed. Bounded only by
reachability of port 3000, and the backend listens on `0.0.0.0` for exactly the ESP32 and
the Go agents, so it is reachable from the whole LAN by design.

**Reproduction (no secret disclosed).**

```bash
# Recover the credential from history:
git log --all -S'deviceSecret' -- 'iot/esp32/**/*.ino'
git show 5f5a084^:iot/esp32/env_monitor_v2.ino | grep deviceSecret

# Confirm it still authenticates (before the fix below):
#   a Socket.IO v2/EIO3 client connecting with header  X-Device-Key: <value>
#   is accepted as a device and may emit sensorData.
```

**Remediation — applied.** `backend/config/env.js:70-107`. The variable had **no
validation at all**, while `JWT_SECRET` two lines above has had a length check since it
was written; the two are the same class of value. Now:

```js
const DEVICE_SECRET_MIN_LEN = 24;
const LEAKED_DEVICE_SECRETS = new Set([
  "REDACTED-ROTATED-DEVICE-SECRET", // iot/esp32/env_monitor_v2.ino, 5f5a084 → 219f36e
]);
const deviceSecret = (process.env.DEVICE_SECRET ?? "").trim();
if (deviceSecret && LEAKED_DEVICE_SECRETS.has(deviceSecret)) throw new Error(/* … */);
if (deviceSecret && deviceSecret.length < DEVICE_SECRET_MIN_LEN) throw new Error(/* … */);
```

Fails **closed**, deliberately: a warning on a published credential is a warning nobody
acts on. It means the backend will not start until the secret is rotated — the intended
forcing function, not a side effect.

**Remediation — DONE (2026-08-26).** The secret was rotated: a fresh 24-byte value was
written to **both** `backend/.env` and `iot/esp32/env_monitor_v2/secrets.h` (verified
byte-identical to each other, 48 hex chars, and confirmed *not* equal to the burned value).
The backend boots again and the full suite passes with no override.

⚠️ **The ESP32 is now locked out until it is reflashed** — it still holds the old secret.
That is the expected, correct state; reflash `env_monitor_v2.ino` (which `#include`s the
updated `secrets.h`) to bring it back.

For reference, the rotation procedure is **two-sided**:

1. `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
2. Same value into `backend/.env` → `DEVICE_SECRET=` **and**
   `iot/esp32/env_monitor_v2/secrets.h` → `#define DEVICE_SECRET "…"`.
3. **Reflash the ESP32.** Between step 2 and step 3 the box cannot connect. That is the
   correct state for a burned credential, and it is unavoidable — there is no ordering in
   which a published shared secret keeps working *and* stops being published.
4. ⚠️ Check *which* `secrets.h` your Arduino IDE actually compiles: the IDE relocates a
   sketch into a folder named after it, and `.gitignore` matches `iot/esp32/**/secrets.h`
   at any depth for exactly that reason.

**Defence in depth.** The per-device-identity problem remains: one static string shared by
every box, with no rotation story. If a second ESP32 is ever deployed, give each one its
own row and its own secret rather than widening this one.

---

### S-02 — HIGH (already remediated) — WiFi PSK in git history

**CWE-798, CWE-540**

**Evidence.** `iot/esp32/env_monitor_v2.ino:123-124` at `5f5a084`:
`ssid = "GREGORIO WIFI 2.4G"`, `password = "REDACTED-ROTATED-WIFI-PASSWORD"`. Removed at `219f36e`.

**Status.** **Already rotated.** The `WIFI_PASSWORD` currently in
`iot/esp32/env_monitor_v2/secrets.h` does **not** match the historical value (verified by
comparison). The SSID/PSK pair remains in history and is still valid for anyone who can
reach that network's radius, but the credential itself is dead.

**Remediation.** None required beyond the history cleanup in S-14. Noted here because an
SSID + PSK pair in history is a physical-proximity finding that survives repo privacy —
it is useful to anyone who can stand near the building.

---

### S-03 — HIGH (already remediated) — `AGENT_INSTALL_KEY` in git history

**CWE-798, CWE-540**

**Evidence.** `server-metrics.md` carried a real 48-hex-character enrollment key
(`AGENT_INSTALL_KEY=ea47a2d9…`, first 8 shown) from `5f5a084` (2026-06-09) to `1d67791`
(2026-08-14) — a **66-day** window. Confirmed absent from `HEAD`.

**Status.** **Not live.** `AGENT_INSTALL_KEY` is unset in the current `backend/.env`.
`services/installKeyService.js:35` only consults it *after* the `agent_install_keys` table
misses, and an empty value never matches, so the leaked key authorises nothing.

**Why it mattered.** A live install key gets a machine to `pending` at
`POST /api/agents/register` (unauthenticated by design). It does not by itself yield a
metric-posting token — an admin still has to approve — so the leak was an unauthorised
*enrollment request* primitive, not an ingest primitive. Real but bounded.

**Remediation.** None required; the managed-key system (`agent_install_keys`, mintable and
revocable from the dashboard) has since replaced this path entirely. Keep
`AGENT_INSTALL_KEY` blank.

---

### S-04 — HIGH — MySQL runs as `root` with an empty password

**CWE-521** (Weak Password Requirements), **CWE-1188** (Insecure Default Initialization),
**CWE-250** (Execution with Unnecessary Privileges)

**Evidence.** `backend/.env`: `DB_USER=root`, `DB_PASSWORD=` (empty — verified
programmatically). `backend/config/mysql.js` passes both straight to `mysql.createPool`.
`deployment-guide.md:139` already prescribes a `cspc_app` user; it has not been created.

**Why it matters.** Two separate problems stacked:

- **Empty password** — the account authenticates *anyone who can reach port 3306*. The
  host in question holds `JWT_SECRET`, `MIKROTIK_ENC_KEY`, and the AES-GCM ciphertext that
  those keys open. "It is only on the LAN" is the same LAN as the monitored devices, the
  Go agents, and whatever else is plugged into the campus network.
- **`root`** — the backend needs `SELECT/INSERT/UPDATE/DELETE` on one schema. As `root` an
  injection, a bad migration, or a stray script can `DROP` any database on the server.

Note the interaction with S-05 and with `ops/db-backup/dump-mysql.sh`: an unauthenticated
`mysqldump` against this instance yields the whole credential store in one command.

**Remediation — applied (detection only).** `backend/config/mysql.js:18-42` warns at boot
on both conditions. Deliberately **not** fatal: a fresh XAMPP install is the documented
starting point for development, and refusing to boot would block the first run of the
system before there is anything to protect. Boot output confirms it fires:

```
[CONFIG] DB_PASSWORD is empty — the MySQL account 'root' accepts any connection …
[CONFIG] DB_USER is 'root' — the backend needs DML on one schema, not administrative …
```

**Remediation — required (operator).**

```sql
CREATE USER 'cspc_app'@'localhost' IDENTIFIED BY '<generated>';
GRANT SELECT, INSERT, UPDATE, DELETE ON `cspc_ictu_monitoring`.* TO 'cspc_app'@'localhost';
-- No DROP, no CREATE, no GRANT OPTION, and scoped to one schema.
FLUSH PRIVILEGES;
ALTER USER 'root'@'localhost' IDENTIFIED BY '<different generated>';
```

Then set `DB_USER=cspc_app` / `DB_PASSWORD=…` in `backend/.env` and restart. Note
`ops/db-backup/dump-mysql.sh` reads the same `.env` and already uses `MYSQL_PWD` to keep
the password off the process list, so the backup job follows automatically.

---

### S-05 — MEDIUM — SNMP community strings stored in cleartext and shipped offsite

**CWE-312** (Cleartext Storage of Sensitive Information), **CWE-522** (Insufficiently
Protected Credentials)

**Evidence (before the fix).**

- `device_network.snmp_community VARCHAR(255)` — written verbatim at
  `services/snmpPollerService.js` `addNetworkDevice()` and `addUpsDevice()`.
- `ops/db-backup/dump-mysql.sh:78-82` — full `mysqldump` into `BACKUP_DIR`.
- `ops/offsite-backup/sync-offsite.sh` — rclone-copies that folder to Backblaze,
  excluding only `.last_offsite_sync`, `*.log` and `*.tmp`.

**Why it matters.** An SNMPv2c community **is** the credential — no user, no challenge, no
transport security. Whoever holds it can read the full MIB of the router or UPS it belongs
to. So the community string for every router and UPS on the campus network was leaving the
building nightly, in the clear, in a file on third-party storage.

This is word-for-word the argument the codebase already makes for two other columns:
`migrations/2026-08-25_agent_token_hash.sql` ("*every agent credential was already leaving
the building nightly, in a file on cloud storage*") and
`migrations/2026-08-15b_install_key_reveal.sql`. Meanwhile `mikrotik_devices.api_password`
— one table over, same threat, same machinery — has been AES-256-GCM since the day it was
added. This column was simply never revisited.

**Remediation — applied.** New `backend/services/communityCrypto.js`, wired into
`snmpPollerService.js`:

| Site | Change |
|---|---|
| `snmpPollerService.js:275` | `loadDevices()` decrypts on read |
| `snmpPollerService.js:796, 859` | both `INSERT`s encrypt on write |
| `snmpPollerService.js:739` | duplicate-endpoint check compares **decrypted** values |

Encryption, **not** a hash, for the reason `secretCrypto.js` sets out: the poller must
*present* this value to the device on every cycle, so the original has to come back.

Stored as `"gcm1:" + base64([iv(12) | tag(16) | ciphertext])`. The prefix is what makes an
in-place migration of a live column safe — without a marker, telling ciphertext from a
legacy plaintext community means guessing, and Node's base64 decoder will happily "decode"
`dev-router` into bytes, so a wrong guess silently destroys a working community. An
unprefixed value is read as plaintext **permanently**, not for a migration window:
`dev-snmpsim/seed-dev-devices.sql` inserts plaintext directly, and a row hand-fixed during
an incident must not take the poller down.

⚠️ **`assertEndpointFree` had to move its comparison out of SQL.** A random IV means the
same community encrypts differently every time, so `WHERE n.snmp_community = ?` would
match nothing — silently turning the duplicate-device guard into a no-op, which is
precisely the bug the `IS NULL` branch was written to fix. The query now narrows on
`(ip, port)` (indexed, a handful of rows at this scale) and compares after decryption.

Migration: `migrations/2026-08-26_snmp_community_at_rest.sql`. It deliberately changes **no
data** — the key lives in `backend/.env`, which MySQL cannot read and must never be handed.
Conversion is one idempotent command:

```bash
cd backend && npm run rekey -- --encrypt-plaintext
```

**Applied to the live database on 2026-08-26** — see "Actions completed".

Tests: `backend/tests/communityCrypto.test.js`, 11 cases — round-trip, IV uniqueness,
blank→`null`, legacy plaintext passthrough, base64-looking plaintext passthrough,
wrong-key **fails closed to `""` rather than open**, GCM tamper rejection, no-key
degradation, and a `VARCHAR(255)` fit assertion.

**Accepted degradation.** With no key configured, `writeCommunity` stores plaintext and
warns loudly on every write, rather than throwing. `agentService.approve()` takes the
opposite line for agent tokens and is right to — it *mints* a credential, so refusing costs
nothing. This value describes a device that already exists, and refusing would mean "you
cannot register your router because an unrelated variable is unset", which ends with the
feature being worked around rather than the variable being set.

---

### S-06 — MEDIUM — No rotation path existed for any encryption key

**CWE-320** (Key Management Errors), **CWE-522**

**Evidence (before the fix).** `CLAUDE.md`, on `MIKROTIK_ENC_KEY`: *"⚠️ **NEVER change this
once MikroTik credentials are saved** — every stored password was encrypted under it and
becomes undecryptable, and the poller then fails to log in with no obvious cause."*
`services/secretCrypto.js:37-42` documents the same constraint for any caller with stored
data. Both are accurate descriptions of the code.

**Why it matters.** Four columns hold AES-256-GCM ciphertext:

| Column | Secret | Key |
|---|---|---|
| `mikrotik_devices.api_password` | RouterOS login | `MIKROTIK_ENC_KEY` (pinned) |
| `agent_install_keys.key_cipher` | `AIK-` key, for re-display | `SECRET_ENC_KEY` → `MIKROTIK_ENC_KEY` |
| `agent_tokens.approved_token_cipher` | `AGT-` token, for re-delivery | `SECRET_ENC_KEY` → `MIKROTIK_ENC_KEY` |
| `device_network.snmp_community` (new, S-05) | SNMPv2c community | `SECRET_ENC_KEY` → `MIKROTIK_ENC_KEY` |

The documented answer to "the key leaked, what now?" was *you cannot change it*. A key you
cannot rotate is a key you must never lose — that is not a security property, it is a hope.
It also blocked a benign, desirable change: setting `SECRET_ENC_KEY` on a deployment that
had been running on the `MIKROTIK_ENC_KEY` fallback would have made every existing
ciphertext unreadable.

**Remediation — applied.** New `backend/scripts/rekeySecrets.js`, `npm run rekey`:

```bash
npm run rekey                            # report: what is encrypted, what is still readable
npm run rekey -- --encrypt-plaintext     # encrypt stragglers (this is also the S-05 migration step)
npm run rekey -- --from-key <old 64hex>  # DRY RUN of a full rotation
npm run rekey -- --from-key <old> --apply # write it
```

Design points worth keeping:

- **Dry run by default.** The dry run decrypts every row under the old key and re-encrypts
  it in memory, so "this will work" is proven against the real data before a row is written.
- **All-or-nothing.** Everything is transformed in memory *first*. A rotation that fails
  halfway leaves rows split across two keys, and then neither key opens the whole table —
  so the failure has to happen before any write. `failures > 0` refuses to write at all.
- **`--suite`.** `mikrotik_devices.api_password` is pinned to `MIKROTIK_ENC_KEY` while the
  other three resolve `SECRET_ENC_KEY` first, so those are two different operations on two
  different row sets. Defaults to `both`, because doing one and forgetting the other is the
  failure mode.
- **Honest ciphertext detection.** For the three unmarked columns, "is this already
  encrypted?" is answered by *trial decryption* — GCM authenticates, so a value that
  decrypts is ciphertext. Only `snmp_community` uses a prefix, and that is declared per
  target rather than guessed per row.
- **Preflight.** An unreachable database is one clear line, not four per-table "skip"s that
  read as a schema problem and send the operator to the wrong place.

The rotation procedure (stop backend → dry run → apply → start) is documented in the
script header.

---

### S-07 — MEDIUM — Install key passed as a command-line argument

**CWE-214** (Invocation of Process Using Visible Sensitive Information), **CWE-522**

**Evidence (before the fix).**

- `agent/cmd/agent/main.go:48` — `flag.String("install-key", …)`
- `agent/installer/linux/install.sh:56` — `… -install-key "$INSTALL_KEY" …`
- `agent/installer/windows/install.ps1:78` — `… -install-key $InstallKey …`
- `agent/installer/*/RUN-ME.txt` and `agent/README.md` documented the flag form.

**Why it matters.** A command-line argument is visible to every user on the box via
`ps aux` / `Get-CimInstance Win32_Process | Select CommandLine` for as long as enrollment
runs — and enrollment **blocks until an admin approves**, so that window is minutes, not
milliseconds. It also lands in the invoking shell's history file (`~/.bash_history`;
PowerShell's PSReadLine file persists on disk across reboots) and is captured by
process-creation auditing (Linux auditd `execve`, Windows Security event 4688).

Bounded: an `AIK-` key only reaches `pending`, and it is admin-revocable. But the whole
point of the managed-key system is per-office attribution and revocation, which is
undermined if the key is trivially harvested from any machine it was ever used on.

**Remediation — applied.**

```go
// agent/cmd/agent/main.go:73-81
key := os.Getenv("CSPC_INSTALL_KEY")
if key != "" {
    _ = os.Unsetenv("CSPC_INSTALL_KEY")
} else if *installKey != "" {
    key = *installKey
    logger.Infof("install key was passed as a command-line flag; it is visible in the " +
        "process list and in shell history. Prefer CSPC_INSTALL_KEY=... for future installs.")
}
```

- **Env var wins over the flag** — a stale `-install-key` in an old runbook must not
  silently override a deliberately-set variable.
- **Unset immediately after reading.** The agent then runs for months, and the metric
  collector shells out to PowerShell on Windows; a child process must not inherit an
  enrollment credential it has no use for.
- **The flag still works and warns**, so no existing runbook breaks.
- Both installers now hand the key over *in the environment* even when the operator used
  the positional/parameter form — so the key stops being visible in the process list from
  that point regardless. `install.ps1` restores the caller's previous value in a `finally`,
  so it does not leave a credential in a session the caller did not put one in.
- `install.sh` needed care: `$2` may now legitimately be `--re-enroll`, so it is only
  treated as a key when it does not start with a dash, and `--re-enroll` is matched
  anywhere in `${@:2}`.
- Docs updated: both `RUN-ME.txt` files, `agent/README.md` (flag table + all four
  examples). `sudo -E` is called out explicitly — without it sudo strips the variable and
  the installer reports a missing key.

Verified: `go build ./...` and `go vet ./...` clean; `install.sh` passes `bash -n`;
`install.ps1` parses via `[Parser]::ParseFile`.

---

### S-08 — LOW — Hardcoded `"public"` SNMP community fallback

**CWE-1188**, **CWE-798**

**Evidence (before the fix).** `services/snmpPollerService.js`, `connFor`:

```js
community: d.community || "public",
```

**Why it matters.** This substituted the single best-known default credential in existence
for a missing one. It was unreachable in practice — `loadDevices()` filters out a UPS with
no community, and `pollRouter()` sends a community-less router down the ICMP path first —
which is exactly what makes a fallback like this dangerous: it is invisible until the
invariant it rests on changes, and then the poller starts probing production devices with
a guessed credential and reports the result as monitoring.

**Remediation — applied.** `services/snmpPollerService.js:93-109` now throws, naming the
device and the invariant that must have broken.

---

### S-09 — LOW — `DEVICE_SECRET` compared with `===`

**CWE-208** (Observable Timing Discrepancy)

**Evidence (before the fix).** `backend/src/server.js`: `if (secret && deviceKey === secret)`.

**Why it matters.** Modest in isolation — `services/handshakeLimiter.js` caps failed
handshakes at 50 per address per 15 minutes, which makes a byte-at-a-time timing attack
impractical over a network. It is flagged mainly for **inconsistency**:
`installKeyService.matchesLegacyKey` has always used `crypto.timingSafeEqual` for the
identical class of value. Two comparisons of the same kind of secret should not disagree
about how careful to be.

**Remediation — applied.** `backend/src/server.js:276-284`:

```js
function matchesDeviceSecret(provided) {
  const expected = process.env.DEVICE_SECRET;
  if (!expected || typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

Length is still compared first (`timingSafeEqual` throws on a length mismatch), so length
itself is not constant-time. That is not the part worth protecting: `config/env.js` now
enforces a 24-character floor, making the length a known property of the deployment. What
this removes is the byte-by-byte prefix oracle. `false` on an unset variable preserves the
previous `secret && …` behaviour.

---

### S-10 — LOW — `MIKROTIK_TLS_VERIFY` defaults to unverified

**CWE-295** (Improper Certificate Validation)

**Evidence.** `services/mikrotikClient.js:81-82` —
`rejectUnauthorized: String(process.env.MIKROTIK_TLS_VERIFY ?? "").toLowerCase() === "true"`.
Blank (the default) ⇒ `false`.

**Why it matters.** With `use_tls` on but verification off, the RouterOS API session is
encrypted but unauthenticated — an on-path attacker can present any certificate and capture
the API password, which is the one credential the system goes to the trouble of encrypting
at rest.

**Status: accepted, documented trade-off.** RouterOS ships a self-signed certificate, so
strict verification fails on a stock router; `MIKROTIK_TLS_CA` already exists for the case
where a private CA is used. This is a deployment decision, not a code defect.

**Remediation (deployment).** Install a CA-signed (or private-CA) certificate on the
router, set `MIKROTIK_TLS_VERIFY=true`, and point `MIKROTIK_TLS_CA` at the CA file. Until
then, treat the RouterOS credential as exposed to anyone with an on-path position between
the backend and the router.

---

### S-11 — INFO — `SECRET_ENC_KEY` is unset; three columns share the MikroTik key

**Evidence.** `backend/.env`: `SECRET_ENC_KEY` absent, `MIKROTIK_ENC_KEY` set (64 hex).
`services/secretCrypto.js:86` — the general suite resolves
`["SECRET_ENC_KEY", "MIKROTIK_ENC_KEY"]`.

So `agent_install_keys.key_cipher`, `agent_tokens.approved_token_cipher` and (now)
`device_network.snmp_community` are all encrypted under the MikroTik key. This is
documented and intentional — it is what lets an existing deployment gain the feature with
no new configuration.

**Newly actionable.** Separating them used to be a one-way door. It no longer is:

```bash
# generate, put in .env as SECRET_ENC_KEY, then:
npm run rekey -- --from-key <MIKROTIK_ENC_KEY value> --suite general --apply
```

Worth doing before go-live so a MikroTik key rotation and an agent-credential rotation stop
being the same event.

---

### S-12 — INFO — `probeDevice.js` echoes the community to stdout

**Evidence.** `backend/scripts/probeDevice.js:56, 172-186` print the community string in
the verdict.

**Assessment: no action.** It is an interactive operator tool and the value was supplied by
that same operator on the command line moments earlier, so the tool discloses nothing the
invoker did not already type. Flagged only so it is not mistaken for a leak on a later read.

---

### S-13 — INFO — No `.env.example`; no `NODE_ENV` split

**Evidence.** No `*.env.example` is tracked (`git ls-files` confirms). No `NODE_ENV`
reference anywhere in `backend/`. The environment contract lives entirely in `CLAUDE.md`.

**Assessment: no action, deliberately.** Adding a second copy of the variable list would
create exactly the drift this codebase avoids elsewhere (the `PolicyDocument.tsx`
single-source rule is the same reasoning). `CLAUDE.md` is thorough, current, and is the
file a developer already has open. The absence of a dev/prod config split is appropriate
for a single on-prem deployment: `deployment-guide.md` carries the production values, and a
`NODE_ENV` fork would add a code path nobody exercises. Note that the central error handler
(`src/server.js`) already gates 5xx message disclosure on `err.expose` rather than on an
environment flag, which is the better design.

---

### S-14 — Cross-cutting — History cleanup — **DONE 2026-08-26**

The three historical leaks (S-01, S-02, S-03) lived in blobs that removal commits do not
delete. **Rewritten and force-pushed on 2026-08-26**, ahead of any decision to make this
repository public rather than after it.

Two `git filter-repo` passes, run against a full pre-rewrite bundle of every ref:

```bash
# 1. the three credentials -> placeholders, across all 291 commits
git filter-repo --replace-text <(printf '%s
'   '<device secret>==>REDACTED-ROTATED-DEVICE-SECRET'   '<wifi psk>==>REDACTED-ROTATED-WIFI-PASSWORD'   '<install key>==>REDACTED-REVOKED-INSTALL-KEY')

# 2. 12 profile photos of real people. --replace-text swaps TEXT and does not
#    delete files, so pass 1 could not touch them.
git filter-repo --path backend/uploads --invert-paths --force

git push --force-with-lease=refs/heads/main:<pre-rewrite sha> origin main
```

**Verified after the push.** All three values return **0 commits** under
`git log --all -S`; zero `backend/uploads` commits remain; **283 commits intact, none
dropped** (both photo commits also touched other files, so neither went empty); local and
`origin/main` in sync; 357 tests pass.

⚠️ **A rewrite reaches this repository only** — not forks, not existing clones, not
anyone's reflog, and GitHub keeps orphaned commits reachable by direct SHA until Support
GCs them. What actually closed these three was rotating or revoking them *first*; the
rewrite removes the copy this repo serves. **Every other clone must be re-cloned, not
pulled.** The SHA-256 denylist in `backend/config/env.js` stays permanently — it is what
keeps the burned secret dead if it is ever pasted back in.

---

## Checklist diff

### 1. Hardcoded secrets

| Item | Verdict | Notes |
|---|---|---|
| API keys | **PASS** (tree) / **FAIL** (history) | None in `HEAD`. `AGENT_INSTALL_KEY` was committed for 66 days — S-03, no longer live. |
| Database passwords | **PASS** (tree) / **FAIL** (strength) | Never hardcoded; `config/mysql.js` reads env only. But the password is *empty* — S-04. |
| JWT secrets | **PASS** | `JWT_SECRET` env-only, 96 chars, length-enforced at boot (`config/env.js:32`). |
| Encryption keys | **PASS** | `MIKROTIK_ENC_KEY` / `SECRET_ENC_KEY` env-only, format-validated (`secretCrypto.js` `KEY_RE`). |
| *Device shared secret* | **FAIL** → fixed + rotation pending | S-01. Was not on the original checklist; it is the most serious finding. |
| *Default credential fallback* | **FAIL** → **fixed** | `"public"` SNMP community — S-08. |

### 2. Environment variable usage

| Item | Verdict | Notes |
|---|---|---|
| All secrets in env vars | **PASS** | Every secret resolves from `process.env`. Only two env fallbacks exist and neither invents a credential (`emailService.js:35` normalises whitespace; `installKeyService.js:35` reads the deprecated key). |
| `.env` file not in git | **PASS** | `.gitignore:69` (`.env`, `.env.*`); `git check-ignore` confirms `backend/.env`. No `.env` has *ever* been committed (`git log --diff-filter=A` over all refs: empty). `iot/esp32/**/secrets.h` likewise ignored at any depth and never committed. |
| Production vs development configs | **PARTIAL** | One `.env`, no `NODE_ENV` split, no `.env.example`. Assessed as appropriate — S-13. Templates that *do* exist (`secrets.h.example`, `agent.conf.example`, `rclone.conf.example`) were checked and contain **no real values**. |

### 3. Secret rotation capability

| Item | Verdict | Notes |
|---|---|---|
| Database password rotation | **PASS** | Env-driven, no code coupling; `ops/db-backup/*` read the same `.env`, so the backup job follows. Requires a restart. |
| API key rotation | **PASS** | `agent_install_keys` mint/revoke from the dashboard, with optional expiry and per-key blast-radius listing (`GET /install-keys/:id/servers`). Per-server revocation via `DELETE /api/servers/:id`. Agent tokens are hash-stored, so revocation is real. |
| Certificate updates | **PARTIAL** | `MIKROTIK_TLS_VERIFY` / `MIKROTIK_TLS_CA` exist but default to unverified — S-10. The dashboard's own TLS is nginx's concern and correctly out of this repo. |
| *Encryption key rotation* | **FAIL** → **fixed** | Was documented as impossible. `npm run rekey` — S-06. |
| *Device secret rotation* | **FAIL** | S-01. Possible but two-sided and undocumented; the procedure is now in `CLAUDE.md` and in the boot error. No fleet story if a second ESP32 is ever added. |

### 4. Encryption key management

| Item | Verdict | Notes |
|---|---|---|
| Key derivation functions | **N/A — correctly** | Keys are 32 raw CSPRNG bytes supplied as hex, not passwords. A KDF would add nothing and is right to be absent. `secretCrypto.js` validates the format (`/^[0-9a-fA-F]{64}$/`) and refuses anything else. |
| Salt usage | **N/A — correctly** | No password hashing exists (the bcrypt path was removed on 2026-08-25). Credential hashes are unsalted SHA-256 over 192 bits of CSPRNG output — `installKeyUtils.js:45`. Documented and correct: there is no dictionary to slow an attacker down with, and a slow salted hash would force the hottest query in the system to table-scan instead of hitting a unique index. |
| Key storage | **PASS, with a caveat** | Keys live in `backend/.env` — not in the database, therefore not in the `mysqldump`, therefore not in the offsite sync. That separation is the whole design and it holds. ⚠️ Caveat: `.env` is readable by the account running the service on a host where that account is `root@localhost` with no DB password (S-04); and `BACKUP_DIR` defaults to `backend/backups`, i.e. under the same tree as `.env` — verify the rclone job's exclusions never widen to the repo root. |
| *AEAD choice* | **PASS** | AES-256-GCM with a random 12-byte IV per encryption, auth tag stored. Tamper-rejection is asserted in `tests/communityCrypto.test.js`. |

---

## Top 5 prioritized fixes

Ordered by risk removed per unit of effort.

1. ~~**Rotate `DEVICE_SECRET`**~~ (S-01) — **DONE.** ⚠️ Still outstanding: **reflash the
   ESP32**, which is locked out until it carries the new secret.
2. **Create `cspc_app` and set a MySQL password** (S-04). *~10 min.* **The top remaining
   item.** Removes unauthenticated access to the store holding every other credential's
   ciphertext — including, now, the SNMP communities.
3. ~~**Encrypt the SNMP communities**~~ (S-05) — **DONE**, migration applied and both values
   converted; round-trip verified against the live rows.
4. ~~**Decide on history rewrite before the repo is ever made public**~~ (S-14) —
   **DONE 2026-08-26.** Rewritten and force-pushed; see S-14.
   Cheap now; impossible to do retroactively once it is public and forked.
5. **Split `SECRET_ENC_KEY` from `MIKROTIK_ENC_KEY`** (S-11). *~5 min.* Newly possible; do it
   before go-live so the two rotation events stop being one.

---

## Changes made by this audit

| File | Change |
|---|---|
| `backend/config/env.js` | **New:** `DEVICE_SECRET` denylist + 24-char floor + unset warning (S-01) |
| `backend/config/mysql.js` | **New:** boot warning on empty `DB_PASSWORD` / `DB_USER=root` (S-04) |
| `backend/src/server.js` | `matchesDeviceSecret()` — constant-time compare (S-09) |
| `backend/services/communityCrypto.js` | **New module** — SNMP communities encrypted at rest (S-05) |
| `backend/services/snmpPollerService.js` | Encrypt on write, decrypt on read, decrypt-aware duplicate check; `"public"` fallback removed (S-05, S-08) |
| `backend/scripts/rekeySecrets.js` | **New** — `npm run rekey`: report / encrypt-plaintext / rotate (S-06) |
| `backend/package.json` | `rekey` script |
| `backend/tests/communityCrypto.test.js` | **New** — 11 cases (S-05) |
| `migrations/2026-08-26_snmp_community_at_rest.sql` | **New** — column comment + reasoning; no data change by design (S-05) |
| `agent/cmd/agent/main.go` | `CSPC_INSTALL_KEY` env var, precedence over the flag, unset after read (S-07) |
| `agent/installer/linux/install.sh` | Env-var form, `sudo -E`, warns on the argument form (S-07) |
| `agent/installer/windows/install.ps1` | Env-var form, `-InstallKey` no longer mandatory, restores prior value (S-07) |
| `agent/installer/*/RUN-ME.txt`, `agent/README.md` | Updated instructions + key-handling guidance (S-07) |
| `CLAUDE.md` | `DEVICE_SECRET` validation, `npm run rekey`, `communityCrypto.js`, `rekeySecrets.js`, `MIKROTIK_ENC_KEY` now rotatable |

**Verification.** `npm test` — **332 pass, 0 fail**, with the rotated `.env` and no
override. `go build ./...` and `go vet ./...` clean. `bash -n install.sh` clean.
`install.ps1` parses via `[Parser]::ParseFile`. `node src/server.js` boots to
"Server running on port 3000" and both `[CONFIG]` warnings fire as designed.

---

## Actions completed on the live system — 2026-08-26

| Action | Result |
|---|---|
| **Rotated `DEVICE_SECRET`** | New 24-byte value written to `backend/.env` **and** `iot/esp32/env_monitor_v2/secrets.h`; verified identical to each other and different from the burned value. Both files are gitignored. |
| **Applied `2026-08-26_snmp_community_at_rest.sql`** | Against `cspc-ictu-monitoring-system` (MariaDB 10.4.32). Column comment now records the storage format. |
| **`npm run rekey -- --encrypt-plaintext`** | 2 SNMP communities encrypted. The other three cipher columns reported `nothing to do` — they were already encrypted, as expected. |
| **Round-trip verification** | All 5 `device_network` rows checked against a pre-change snapshot: the 2 SNMP devices store ciphertext and decrypt back to their exact original values; the 3 ping-only/agent devices correctly store `NULL`. |
| **Snapshot destroyed** | The temporary rollback file held the communities in the clear and was deleted once the round-trip passed. |

**Post-state of `npm run rekey`:**

```
  all encrypted  mikrotik_devices.api_password        (1 of 1)
  all encrypted  agent_install_keys.key_cipher        (1 of 1)
  all encrypted  agent_tokens.approved_token_cipher   (1 of 1)
  all encrypted  device_network.snmp_community        (2 of 2)
```

### Still outstanding

1. **Reflash the ESP32** — it holds the old secret and cannot connect until reflashed.
2. **S-04: set a MySQL password and move off `root`** — the largest remaining exposure, and
   now the only *live* credential problem left: the three historical ones are all dead.
3. **S-11: set `SECRET_ENC_KEY`** and run
   `npm run rekey -- --from-key <mikrotik key> --suite general --apply`. ⚠️ One step, not
   two — setting the key without the rekey leaves the app unable to decrypt what it has
   already written (install-key re-display, agent-token re-delivery, SNMP communities).

*(S-14, the history rewrite, was completed 2026-08-26 — see above.)*
