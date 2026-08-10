# ERD Update Guide — bringing `cspc-ictu-monitoring-system.mwb` up to date

**Target:** make the Workbench EER model match `v13_cspc-ictu-monitoring-system.sql`.
**Date written:** 2026-08-10

---

## Why this file exists

The Workbench model `cspc-ictu-monitoring-system.mwb` was untracked from the repo on
2026-08-04 (commit `dbc0177`, *"chore(repo): stop tracking the MySQL Workbench model"*) and
went missing from disk with it. It was recovered from git's object database (blob
`1ed2ca82`) and restored to the repo root.

The recovered model is **byte-identical to the last version ever committed**, but that
version's content dates from **2026-06-15** (commit `8e558dd`, *"Email + Popup Notifications
+ configurable alerting"*). Roughly two months of schema work landed after it, so the model
is behind `v13_cspc-ictu-monitoring-system.sql`.

The model is worth repairing rather than regenerating: it carries a real EER diagram —
**23 table figures and 28 relationship connections**. Reverse-engineering the SQL into a
fresh model would produce a correct catalog but throw the layout away.

---

## Ignore this false alarm first

A naive column-type diff flags **48 columns** as `timestamp_f` / `datetime_f` where the SQL
says `timestamp` / `datetime`. **These are not differences.** `timestamp_f` and `datetime_f`
are Workbench's internal ids for the fractional-second variants of those types. Every one of
the 48 has `precision = -1`, so they forward-engineer as plain `TIMESTAMP` / `DATETIME`.

Do not "fix" them. Changing them by hand risks introducing a real difference where none exists.

---

## The changes

14 items. Tick them off as you go.

### 1. Add the missing table: `widget_prefs`

- [ ] Create the table

The only table absent from the ERD entirely (added by `migrations/2026-06-17_widget_prefs.sql`).
It stores the per-user PiP live-widget layout; one row per user, a missing row meaning
"use the default layout".

| Column | Type | Flags | Default |
|---|---|---|---|
| `user_id` | INT | **PK**, NN | — |
| `layout_json` | JSON | NN | — |
| `updated_at` | TIMESTAMP | — | `CURRENT_TIMESTAMP` ON UPDATE `CURRENT_TIMESTAMP` |

- [ ] Add FK `fk_widget_prefs_users1` → `users.user_id`, **ON DELETE CASCADE / ON UPDATE CASCADE**
- [ ] Drag the new table onto the EER canvas (new tables do **not** auto-place)

Because `user_id` is both the PK and the FK, draw it as a **1:1 identifying** relationship —
the same shape `notification_prefs` already uses.

> **On the type:** v13 renders this column as `longtext CHARACTER SET utf8mb4 COLLATE
> utf8mb4_bin NOT NULL CHECK (json_valid(...))`. That is MariaDB's way of *dumping* a `JSON`
> column, not a different type. The migration file declares it `JSON`. Model it as **JSON**.

### 2. Add these columns

- [ ] `devices.display_name`
- [ ] `alert_rules.interface_name`
- [ ] `mikrotik_devices.use_tls`
- [ ] `server_specs.metric_interval_sec`
- [ ] `reports.device_id`

| Table | Column | Type | Place after |
|---|---|---|---|
| `devices` | `display_name` | VARCHAR(100) NULL | `device_name` |
| `alert_rules` | `interface_name` | VARCHAR(50) NULL | `device_id` |
| `mikrotik_devices` | `use_tls` | TINYINT NOT NULL **DEFAULT 0** | `api_port` |
| `server_specs` | `metric_interval_sec` | SMALLINT UNSIGNED NULL | `agent_version` |
| `reports` | `device_id` | INT NULL | `type` |

Exact DDL from v13, for reference while typing:

```sql
`display_name`        varchar(100) DEFAULT NULL,
`interface_name`      varchar(50)  DEFAULT NULL,
`use_tls`             tinyint(4)   NOT NULL DEFAULT 0,
`metric_interval_sec` smallint(5) UNSIGNED DEFAULT NULL
  COMMENT 'Agent posting cadence in seconds; NULL = unknown, readers assume 10',
`device_id`           int(11)      DEFAULT NULL,
```

**`reports.device_id` needs more than the column** — it is the per-device report scope, so it
also carries an index and a foreign key, and is the one item in this section with a visible
effect on the diagram (a new relationship line):

- [ ] Index `idx_reports_device` on `device_id`
- [ ] FK `fk_reports_devices1` → `devices.device_id`, **ON DELETE SET NULL / ON UPDATE CASCADE**

### 3. Drop one column

- [ ] `mikrotik_devices.firmware_version` (VARCHAR(50)) — no longer in the schema

### 4. Extend two ENUMs

- [ ] `devices.device_type` — add `mikrotik`

  ```sql
  enum('aircon','server','ups','router','esp32','mikrotik')
  ```

- [ ] `reports.type` — add `forecast`

  ```sql
  enum('environment','server','alerts','aircon','network','ups','forecast')
  ```

`reports.type` is why `migrations/2026-08-09_report_forecast_type.sql` exists — the column is
an ENUM, so generating a Capacity Forecast report without this value is rejected under strict
mode (or silently stored as `''`).

### 5. Fix two column types

- [ ] `aircon_ir_config.id` — INT UNSIGNED → **TINYINT(3) UNSIGNED**
- [ ] `aircon_state.ir_channel` — TINYINT → **TINYINT(3) UNSIGNED NOT NULL DEFAULT 1**

`ir_channel` also carries a comment in v13: *"ESP32 IR transmitter slot (1-based). Must match
IR_CHANNEL_PINS[] index in firmware."*

### 6. Fix a real bug in the model

- [ ] Rename `users." google_sub"` → `users.google_sub`

The model's `users` table has a column whose name **begins with a space** — confirmed, the
first character is code 32, and the name is 11 characters long instead of 10.

This one is not cosmetic. Forward-engineering the model as it stands emits `` ` google_sub` ``,
which would not match the column `userService.findByGoogleSub` queries — and `google_sub` is
the immutable Google account id the whole login path matches on before falling back to email.

### 7. Add the link-alert gate columns

- [ ] `network_interfaces.ever_up` — `TINYINT(1) NOT NULL DEFAULT 0`, after `is_active`
      *Comment: "Port has carried a link at least once — gates interface-down alerting"*
- [ ] `network_interfaces.monitor_link` — `TINYINT(1) NOT NULL DEFAULT 1`, after `ever_up`
      *Comment: "Admin opt-out: 0 silences interface-down alerts for this port"*

These back `services/linkAlertPolicy.js` — the gate that stops empty and disabled ports
raising interface-down alerts.

They arrived via `migrations/2026-08-09_link_alert_gate.sql`, which was the one migration
**not** folded into v12. It is now included in v13, so all four files in `migrations/` are
part of the shipped schema and the ERD has a single source of truth again:

| Migration | In v13 |
|---|---|
| `2026-06-17_widget_prefs.sql` | yes — table present |
| `2026-06-18_server_display_name.sql` | yes — `devices.display_name` present |
| `2026-08-09_report_forecast_type.sql` | yes — `forecast` in the ENUM |
| `2026-08-09_link_alert_gate.sql` | yes — `ever_up` + `monitor_link` present |

---

## Working notes

- **Open it as a second model.** Workbench holds a per-model lock. If
  `Server_monitoring_system(MySQL-Schema)` is already open, open
  `cspc-ictu-monitoring-system.mwb` alongside it rather than over that session.
- **`cspc-ictu-monitoring-system.mwb.bak`** in the repo root is Workbench's own auto-backup,
  recovered alongside the model. Keep it until the edits are done and verified.
- **The file is untracked** (`??` in `git status`). `.gitignore` has no `mwb` rule — it was
  deliberately untracked in 2026-08-04, and restoring it did not re-stage it. Commit it
  again only if you want the model back under version control.

## Verifying afterwards

Model → **Forward Engineer** to a `.sql` file, then diff the generated `CREATE TABLE`
statements against `v13_cspc-ictu-monitoring-system.sql`. Expect these harmless differences
even when the model is correct:

- integer **display widths** (`int` vs `int(11)`) — Workbench omits them, MariaDB dumps them
- `AUTO_INCREMENT` / `PRIMARY KEY` expressed inline in the model vs as trailing
  `ALTER TABLE` statements in the mysqldump-style v12 file
- `JSON` vs `longtext … CHECK (json_valid(…))` on `widget_prefs.layout_json`

Anything beyond those three categories is real drift worth a second look.
