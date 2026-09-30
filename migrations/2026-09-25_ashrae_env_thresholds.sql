-- Room temperature and humidity defaults set to ASHRAE's guidelines.
--
-- Also included in v13_cspc-ictu-monitoring-system.sql. Only run this on a database
-- created before 2026-09-25, then restart the backend (rules are cached at startup, and
-- the ESP32 gets the new `envConfig` when it reconnects).
--
-- ── Why ─────────────────────────────────────────────────────────────────────────────────
-- The old values (30 / 34 °C, 60 / 70 %RH) had no stated basis. ASHRAE TC 9.9, Thermal
-- Guidelines for Data Processing Environments (5th ed., 2021, reference [3] in the
-- manuscript):
--
--   WARNING  = leaving the recommended envelope   → 27 °C   (recommended 18–27 °C)
--   CRITICAL = leaving the Class A1 allowable one → 32 °C, 80 %RH
--
-- Humidity warning stays at 60 %RH: the recommended ceiling is 70 % only where gaseous
-- contamination has been measured low (50 % otherwise), and this room has not been measured.
--
-- ── What it does not change ──────────────────────────────────────────────────────────────
-- Only global rules, and only if they still have the old default value; a threshold an
-- admin already changed is left alone. The auto-cooling zones are unchanged (cooling
-- starts at 25 °C, before the 27 °C warning).

UPDATE `alert_rules` SET `threshold_value` = 27, `updated_at` = CURRENT_TIMESTAMP
 WHERE `device_id` IS NULL AND `interface_name` IS NULL
   AND `metric_name` = 'temperature' AND `severity` = 'warning'  AND `threshold_value` = 30;

UPDATE `alert_rules` SET `threshold_value` = 32, `updated_at` = CURRENT_TIMESTAMP
 WHERE `device_id` IS NULL AND `interface_name` IS NULL
   AND `metric_name` = 'temperature' AND `severity` = 'critical' AND `threshold_value` = 34;

UPDATE `alert_rules` SET `threshold_value` = 80, `updated_at` = CURRENT_TIMESTAMP
 WHERE `device_id` IS NULL AND `interface_name` IS NULL
   AND `metric_name` = 'humidity'    AND `severity` = 'critical' AND `threshold_value` = 70;
