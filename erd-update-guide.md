# ERD Update Guide — bringing `cspc-ictu-monitoring-system.mwb` up to date

**Target:** make the Workbench EER model match `v13_cspc-ictu-monitoring-system.sql`.
**Date written:** 2026-08-16

---

## Why this file exists

The model was last brought level with the schema on 2026-08-10 (the previous edition of
this guide, deleted once its checklist was worked through) and re-tracked in commit
`663253d` — *"chore(repo): track the Workbench model again, now that it is current"*.

Four schema changes have landed since, all in Session 21:

| Migration | What it did |
|---|---|
| `2026-08-15_agent_install_keys.sql` | new `agent_install_keys` table; `agent_tokens` gains `install_key_id` and a `revoked` status |
| `2026-08-15b_install_key_reveal.sql` | `agent_install_keys.key_cipher` |
| `2026-08-16_missing_alert_rules.sql` | seed rows only — **no ERD impact** |
| `2026-08-16_preserve_history_on_user_delete.sql` | two FK delete rules changed CASCADE → SET NULL |

All four are already folded into `v13_cspc-ictu-monitoring-system.sql`, which was verified
on 2026-08-16 by importing it into a clean database and diffing all 235 columns and every
FK delete rule against the live one: **no differences**. The SQL is correct; only the model
is behind.

This matters more than usual because **the manuscript's ER diagram is generated from this
model**. A stale model means a stale figure in the paper.

---

## Ignore this false alarm first

The same one as last time. A naive column-type diff flags dozens of columns as
`timestamp_f` / `datetime_f` where the SQL says `timestamp` / `datetime`. **These are not
differences** — they are Workbench's internal ids for the fractional-second variants, all
with `precision = -1`, and they forward-engineer as plain `TIMESTAMP` / `DATETIME`.

Do not "fix" them.

---

## The changes

5 items.

### 1. Add the new table: `agent_install_keys`

- [ ] Create the table

Dashboard-managed agent enrollment keys, replacing the single `AGENT_INSTALL_KEY` that
used to live in `backend/.env`. One row per issued key.

| Column | Type | Flags | Default | Note |
|---|---|---|---|---|
| `install_key_id` | INT | **PK**, NN, AI | — | |
| `key_hash` | CHAR(64) | NN, **UQ** | — | SHA-256 hex of the plaintext key — the key itself is never stored |
| `key_cipher` | VARCHAR(255) | — | NULL | AES-256-GCM of the plaintext key, for re-displaying the install command; NULL = not recoverable |
| `key_prefix` | VARCHAR(16) | NN | — | Leading chars, shown in the UI to identify a key that can no longer be read |
| `label` | VARCHAR(100) | NN | — | |
| `created_by` | INT | — | NULL | FK → users |
| `revoked_by` | INT | — | NULL | FK → users |
| `expires_at` | TIMESTAMP | — | NULL | NULL = never expires |
| `revoked_at` | TIMESTAMP | — | NULL | NULL = still valid |
| `last_used_at` | TIMESTAMP | — | NULL | |
| `use_count` | INT | NN | `0` | How many agents enrolled with this key |
| `created_at` | TIMESTAMP | NN | `CURRENT_TIMESTAMP` | |

Indexes beyond the PK:

- [ ] `uq_install_key_hash` — **UNIQUE** on (`key_hash`)
- [ ] `idx_install_key_created_by` on (`created_by`)
- [ ] `idx_install_key_revoked_by` on (`revoked_by`)

Foreign keys — **both non-identifying, and both SET NULL**:

- [ ] `fk_install_keys_created_by` → `users.user_id`, **ON DELETE SET NULL / ON UPDATE CASCADE**
- [ ] `fk_install_keys_revoked_by` → `users.user_id`, **ON DELETE SET NULL / ON UPDATE CASCADE**

> **Why SET NULL and not CASCADE:** deleting the admin who issued a key must not delete the
> key. That would revoke enrolment for a whole branch as a side effect of an HR change, and
> would erase the record that the key ever existed.

**Cardinality — both are one-to-many (`users` 1 ──< `agent_install_keys` N):**

| Relationship | Reads as | Workbench notation |
|---|---|---|
| `users` → `agent_install_keys` (`created_by`) | one admin issues **many** keys; a key has **at most one** issuer | 1:n, non-identifying, **optional** |
| `users` → `agent_install_keys` (`revoked_by`) | one admin revokes **many** keys; a key has **at most one** revoker | 1:n, non-identifying, **optional** |

Optional on both sides of the "one": the FK columns are nullable, and SET NULL can empty
them later, so the minimum is 0 — a key with no issuer on record is a valid row, not a
broken one. Non-identifying because a key is identified by its own `install_key_id` and
exists perfectly well with neither user set; Workbench draws that as a **dashed** line.

**Two FKs to the same table = two separate connection lines.** Draw it twice — this is
normal, and it is why the totals below go from 30 to 33 rather than 32. The lines will
land on top of each other; drag either one's midpoint to separate them so the figure is
readable in the manuscript.

> ⚠️ **Do not use the relationship *tool* in the toolbar to draw these.** The 1:n tool
> CREATES a new FK column, so you would end up with `users_user_id` alongside the
> `created_by` you already defined — twice over. `created_by` and `revoked_by` already
> exist, so add the constraints in the table editor's **Foreign Keys** tab instead
> (referenced table `users`, then tick the existing column). Workbench draws both lines
> onto the canvas by itself. Same applies to `agent_tokens.install_key_id` in item 2.

- [ ] Drag the new table onto the EER canvas (new tables do **not** auto-place)

Place it near `agent_tokens` and `devices` — it belongs to the agent-enrollment cluster,
not the user-admin cluster, even though both its FKs point at `users`.

### 2. Add the column `agent_tokens.install_key_id`

- [ ] Add the column

| Column | Type | Flags | Default | Note |
|---|---|---|---|---|
| `install_key_id` | INT | — | NULL | Which install key enrolled this agent; NULL = legacy/.env enrollment |

- [ ] Position it **third**, immediately after `device_id` (matches `AFTER device_id` in the migration)
- [ ] Add index `idx_agent_tokens_install_key` on (`install_key_id`)
- [ ] Add FK `fk_agent_tokens_install_key` → `agent_install_keys.install_key_id`,
      **ON DELETE SET NULL / ON UPDATE CASCADE**, **non-identifying**

**Cardinality — one-to-many (`agent_install_keys` 1 ──< `agent_tokens` N), optional:** one
key enrols **many** agents; each agent was let in by **at most one** key. Optional because
`install_key_id` is nullable — see the NULL case below.

This is the relationship that makes a key *own* the servers it enrolled, so revoking a key
can optionally cut that fleet off. NULL means the agent predates install keys or came in on
the legacy `.env` key — those are unaffected by any revoke.

### 3. Extend the `agent_tokens.status` ENUM

- [ ] `enum('pending','approved','rejected')` → **`enum('pending','approved','rejected','revoked')`**

`revoked` = authorisation withdrawn wholesale by revoking the install key. Distinct from
`rejected`, which means an admin declined a NEW enrollment (and which `agentService.reject`
implements by deleting the device outright, so no such row survives). A `revoked` row is
KEPT so the device, its logs and its history survive and the same machine can re-enrol onto
the same `device_id`.

### 4. Change `alerts.acknowledged_by` FK to SET NULL

- [ ] `fk_alerts_users1` — ON DELETE **CASCADE → SET NULL** (ON UPDATE stays CASCADE)

> Deleting a user used to delete every alert they had ever acknowledged — not their name on
> it, the incident row itself, and via its own cascade the whole per-user feed for it.

### 5. Change `system_logs.user_id` FK to SET NULL

- [ ] `fk_system_logs_users` — ON DELETE **CASCADE → SET NULL** (ON UPDATE stays CASCADE)

> Same problem: it took the whole audit trail with them, including the policy-acceptance
> evidence rows. The Privacy Notice commits to a 365-day retention for that table.

---

## Expected totals afterwards

| | Before | After |
|---|---|---|
| Tables | 24 | **25** |
| Table figures on the EER canvas | 24 | **25** |
| Relationship connections | 30 | **33** |

Three new relationships: two from `agent_install_keys` → `users`, one from `agent_tokens`
→ `agent_install_keys`. Items 3–5 change existing objects and add no connections.

---

## Working notes

- **Open it as a second model.** Workbench holds a per-model lock — open
  `cspc-ictu-monitoring-system.mwb` alongside any other session rather than over it.
- **The model IS tracked now** (re-added in `663253d`), unlike last time. Commit it when the
  edits are done.
- **Update the README count** when finished — it currently reads *"current as of v13
  (24 tables, 24 figures, 30 relationships)"*.

## Verifying afterwards

Model → **Forward Engineer** to a `.sql` file, then diff the generated `CREATE TABLE`
statements against `v13_cspc-ictu-monitoring-system.sql`. Expect these harmless differences
even when the model is correct:

- integer **display widths** (`int` vs `int(11)`) — Workbench omits them, MariaDB dumps them
- `AUTO_INCREMENT` / `PRIMARY KEY` inline in the model vs trailing `ALTER TABLE` statements
  in the mysqldump-style v13 file
- `JSON` vs `longtext … CHECK (json_valid(…))` on `widget_prefs.layout_json`

Anything beyond those three categories is real drift worth a second look.

**Faster check for these five items specifically** — run against a database that has the
migrations applied and confirm it matches the model:

```sql
-- expect 12 rows
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_install_keys'
 ORDER BY ORDINAL_POSITION;

-- expect install_key_id present, and status carrying 'revoked'
SELECT COLUMN_NAME, COLUMN_TYPE
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_tokens'
   AND COLUMN_NAME IN ('install_key_id', 'status');

-- expect SET NULL on all five
SELECT CONSTRAINT_NAME, TABLE_NAME, DELETE_RULE
  FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
 WHERE CONSTRAINT_SCHEMA = DATABASE()
   AND CONSTRAINT_NAME IN ('fk_install_keys_created_by', 'fk_install_keys_revoked_by',
                           'fk_agent_tokens_install_key', 'fk_alerts_users1',
                           'fk_system_logs_users');
```

---

## Delete this file when the checklist is done

The previous edition was deleted once worked through, which is the right habit: a
half-applied guide left in the repo reads as outstanding work when it is not. Session 21's
notes record that the model needed updating; that record is enough history.
