-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: configurable alert thresholds (alert_rules) + seed defaults
-- Date: 2026-06-14   Branch: email-popup-notifications
--
-- Run in phpMyAdmin (select your DB → SQL → paste → Go). Safe + idempotent —
-- re-running it will NOT duplicate the seeded rules.
--
-- WHY:
--  The `alert_rules` table already ships in the schema but was unused — thresholds
--  lived hardcoded in code (agentService.checkThresholds = 80/90 for cpu/mem/disk;
--  the ESP32 firmware for temp/gas/humidity). The client wants admins to configure
--  thresholds per metric, with a fleet-wide default that a specific server can
--  override. This migration makes that possible and seeds the current behavior so
--  alerting is identical on day one (no monitoring blackout).
--
-- MODEL (decided with the team):
--   * Scope     = GLOBAL default (device_id = NULL) + optional PER-SERVER override
--                 (a row with a real device_id). Resolver picks the device-specific
--                 rule if one exists, else the global one.
--   * Fallback  = RULES-ONLY: a metric with NO matching active rule raises NO alert.
--                 → so we MUST seed the global defaults below, or alerting goes dark.
--   * metric_name convention (Phase 2 code must use these exact strings):
--                 server:      'cpu', 'mem', 'disk'
--                 environment: 'temperature', 'gas', 'humidity'  (device_id = NULL,
--                              room-level — the ESP32 isn't a `devices` row)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Allow GLOBAL (fleet-wide) rules.
--    device_id becomes NULLABLE → NULL = "applies to every server / the room".
--    The existing FK (fk_alert_rules_devices2 → devices) still enforces non-NULL
--    values; MySQL skips the FK check when the column is NULL. Idempotent.
ALTER TABLE `alert_rules`
  MODIFY `device_id` INT NULL;

-- 2) Seed the GLOBAL default rules from the current hardcoded thresholds, so the
--    system behaves exactly like today until an admin tunes it. Idempotent: each
--    row is inserted only if no global rule for that (metric_name, severity)
--    already exists, so re-running this file is safe.
--
--    Severity mapping for environment matches sensorHandler ENV_SEVERITY:
--    firmware WARNING → warning, firmware DANGER/CRITICAL → critical.
INSERT INTO `alert_rules`
  (`device_id`, `metric_name`, `threshold_value`, `comparison`, `severity`, `is_active`)
SELECT s.device_id, s.metric_name, s.threshold_value, s.comparison, s.severity, 1
FROM (
  -- Server metrics (agentService.checkThresholds: ≥80 warning, ≥90 critical)
  SELECT NULL AS device_id, 'cpu'         AS metric_name,  80 AS threshold_value, '>=' AS comparison, 'warning'  AS severity
  UNION ALL SELECT NULL, 'cpu',          90, '>=', 'critical'
  UNION ALL SELECT NULL, 'mem',          80, '>=', 'warning'
  UNION ALL SELECT NULL, 'mem',          90, '>=', 'critical'
  UNION ALL SELECT NULL, 'disk',         80, '>=', 'warning'
  UNION ALL SELECT NULL, 'disk',         90, '>=', 'critical'
  -- Environment (ESP32 firmware thresholds; DANGER maps to critical)
  UNION ALL SELECT NULL, 'temperature',  29, '>=', 'warning'    -- TEMP_WARNING
  UNION ALL SELECT NULL, 'temperature',  32, '>=', 'critical'   -- TEMP_DANGER
  UNION ALL SELECT NULL, 'gas',         150, '>=', 'warning'    -- WARNING_PPM
  UNION ALL SELECT NULL, 'gas',         300, '>=', 'critical'   -- DANGER_PPM
  UNION ALL SELECT NULL, 'humidity',     85, '>=', 'warning'    -- HUM_WARNING
  UNION ALL SELECT NULL, 'humidity',     95, '>=', 'critical'   -- HUM_DANGER
) AS s
WHERE NOT EXISTS (
  SELECT 1 FROM `alert_rules` r
   WHERE r.`device_id` IS NULL
     AND r.`metric_name` = s.metric_name
     AND r.`severity`    = s.severity
);

-- 3) (Already in place — no action) `alerts.alert_rule_id` exists with its FK to
--    alert_rules, ready for Phase 2 to stamp which rule fired each alert.
-- ─────────────────────────────────────────────────────────────────────────────
