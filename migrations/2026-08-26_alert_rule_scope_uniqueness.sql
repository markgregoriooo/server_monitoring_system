-- One rule per (scope, metric, severity) — enforced by the database, not only by the API.
--
-- `alert_rules` had no uniqueness constraint of any kind, so a scope could hold two
-- `temperature` / `warning` rows. They are not additive: one of them is dead.
-- `alertRulesService.getRoomThresholds` resolves a severity with `.find()`, which returns
-- whichever row the in-memory cache happens to hold first, so the value pushed to the
-- ESP32 as `tempWarn` — and therefore the LED, the buzzer and the device's reported
-- status — was decided by row order rather than by anything an admin chose. Editing the
-- losing row changed nothing, and which row lost could shift on the next reload().
--
-- The application now refuses this (alertRuleValidation.duplicateSeverityError), and that
-- is where the readable error message belongs. This constraint exists because the
-- application is not the only writer: deployment-guide.md §4.3 documents editing rows
-- straight in SQL, and services/socketSessions.js already sets out the house position on
-- this shape — a guard that depends on every code path remembering to call it is a guard
-- that will eventually be missed, "or a hand-edited row".
--
-- ── WHY A PLAIN UNIQUE KEY WOULD NOT HAVE WORKED ──────────────────────────────────
--
-- In MySQL/MariaDB a UNIQUE index treats NULLs as DISTINCT, so
--   UNIQUE (device_id, interface_name, metric_name, severity)
-- permits unlimited duplicates whenever either nullable column is NULL. Verified on this
-- server (MariaDB 10.4.32) before writing this file: two identical rows with
-- device_id = NULL both inserted under exactly that key.
--
-- That is not an edge case here, it is the DEFAULT case. A GLOBAL rule is precisely one
-- with `device_id IS NULL`, and a non-port rule has `interface_name IS NULL` — so all six
-- seeded temperature/gas/humidity rules, the ones this was written for, would have been
-- the rows the index could not see. A naive unique key would have looked like protection
-- and provided none.
--
-- ── THE FIX: SENTINEL-FOLDED GENERATED COLUMNS ────────────────────────────────────
--
-- Two PERSISTENT generated columns fold NULL to a value the index CAN compare, and the
-- unique key is built on those instead. They are derived, never written by application
-- code, and recompute automatically on every INSERT/UPDATE.
--
--   scope_device  IFNULL(device_id, -1)        -1 is safe: device_id is an AUTO_INCREMENT
--                                              primary key, so it is never negative.
--   scope_iface   IFNULL(interface_name, '')   '' is safe: alertRuleValidation's
--                                              nullableStr() converts an empty string to
--                                              NULL before it is ever stored, so '' is not
--                                              a value a real port name can take.
--
-- PERSISTENT (MariaDB's spelling of STORED) rather than VIRTUAL: a stored column is the
-- conservative choice for a unique index, and this table has 28 rows — the space argument
-- for VIRTUAL does not apply.
--
-- ⚠️ This migration FAILS if duplicates already exist, which is the correct behaviour —
-- it is not this file's business to decide which of two conflicting rules an admin meant
-- to keep. Find them first with:
--
--     SELECT device_id, interface_name, metric_name, severity, COUNT(*) n,
--            GROUP_CONCAT(alert_rule_id) ids
--       FROM alert_rules
--      GROUP BY device_id, interface_name, metric_name, severity
--     HAVING n > 1;
--
-- (Verified empty on this database before applying.)
--
-- NOTE: the ladder rule — info < warning < critical, and no two severities sharing a
-- threshold — is deliberately NOT expressed here. It is a comparison BETWEEN rows, which
-- a UNIQUE index cannot state; enforcing it in SQL would need a trigger, and a trigger
-- that throws is a far worse debugging experience than a 400 with a sentence in it. That
-- one stays in alertRuleValidation.severityOrderError.

ALTER TABLE `alert_rules`
  ADD COLUMN `scope_device` INT AS (IFNULL(`device_id`, -1)) PERSISTENT
    COMMENT 'Derived. NULL device_id folded to -1 so the uniqueness index below can compare global rules.',
  ADD COLUMN `scope_iface` VARCHAR(50) AS (IFNULL(`interface_name`, '')) PERSISTENT
    COMMENT 'Derived. NULL interface_name folded to an empty string, same reason as scope_device.',
  ADD UNIQUE KEY `uq_alert_rules_scope_severity`
    (`scope_device`, `scope_iface`, `metric_name`, `severity`);
