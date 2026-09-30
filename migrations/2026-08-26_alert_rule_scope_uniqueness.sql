-- One rule per (scope, metric, severity), enforced by the database as well as the API.
--
-- Two `temperature` / `warning` rows in one scope are not combined; getRoomThresholds takes
-- whichever it finds first, so which value reaches the ESP32 depended on row order. The
-- API rejects this (alertRuleValidation.duplicateSeverityError) with a readable message;
-- this constraint covers rows edited directly in SQL.
--
-- ── Why a plain unique key does not work ──────────────────────────────────
--
-- A UNIQUE index treats NULLs as distinct, so UNIQUE (device_id, interface_name,
-- metric_name, severity) allows unlimited duplicates when a column is NULL (tested on
-- MariaDB 10.4.32). Global rules have device_id NULL, so they would not be protected.
--
-- ── Generated columns ────────────────────────────────────
--
-- Two PERSISTENT generated columns turn NULL into a comparable value, and the unique key
-- uses those:
--
--   scope_device  IFNULL(device_id, -1)        device_id is an AUTO_INCREMENT key, never
--                                              negative.
--   scope_iface   IFNULL(interface_name, '')   nullableStr() stores '' as NULL, so '' is
--                                              never a real port name.
--
-- PERSISTENT (MariaDB's STORED) rather than VIRTUAL, the safer choice for a unique index
-- on a small table.
--
-- This migration fails if duplicates already exist; it will not pick which to keep. Find
-- them with:
--
--     SELECT device_id, interface_name, metric_name, severity, COUNT(*) n,
--            GROUP_CONCAT(alert_rule_id) ids
--       FROM alert_rules
--      GROUP BY device_id, interface_name, metric_name, severity
--     HAVING n > 1;
--
-- The severity order rule (info < warning < critical, no shared thresholds) compares rows,
-- which a unique index cannot express; it stays in alertRuleValidation.severityOrderError.

ALTER TABLE `alert_rules`
  ADD COLUMN `scope_device` INT AS (IFNULL(`device_id`, -1)) PERSISTENT
    COMMENT 'Derived. NULL device_id folded to -1 so the uniqueness index below can compare global rules.',
  ADD COLUMN `scope_iface` VARCHAR(50) AS (IFNULL(`interface_name`, '')) PERSISTENT
    COMMENT 'Derived. NULL interface_name folded to an empty string, same reason as scope_device.',
  ADD UNIQUE KEY `uq_alert_rules_scope_severity`
    (`scope_device`, `scope_iface`, `metric_name`, `severity`);
