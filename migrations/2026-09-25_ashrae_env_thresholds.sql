-- Room temperature + humidity defaults moved onto ASHRAE's published envelopes.
--
-- Also folded into v13_cspc-ictu-monitoring-system.sql. Run this ONLY on a database
-- created before 2026-09-25, then RESTART the backend — alertRulesService caches the
-- rules at startup, and the ESP32 only receives the new `envConfig` when it reconnects.
--
-- ── Why ─────────────────────────────────────────────────────────────────────────────────
-- The old values (temperature 30 / 34 °C, humidity 60 / 70 %RH) had no stated basis.
-- ASHRAE TC 9.9, *Thermal Guidelines for Data Processing Environments* (5th ed., 2021 —
-- reference [3] in the manuscript) gives two envelopes, and each maps onto one severity:
--
--   WARNING  = leaving the RECOMMENDED envelope   → 27 °C   (recommended 18–27 °C)
--   CRITICAL = leaving the Class A1 ALLOWABLE one → 32 °C, 80 %RH
--
-- Humidity WARNING stays at 60 %RH: the 2021 recommended ceiling is 70 % only where
-- gaseous contamination has been measured low, and 50 % otherwise. Nobody has measured
-- this room, so 60 is the conservative middle.
--
-- ── What it does NOT touch ──────────────────────────────────────────────────────────────
-- Only the GLOBAL rules (device_id / interface_name NULL), and only while each still holds
-- the old shipped value. A threshold an admin has already retuned on the Alert Rules page
-- is a decision, not a default, and is left exactly as it is.
--
-- The auto-cooling zones (aircon_ir_config) are separate and unchanged: cooling already
-- ramps from 25 °C (ACCEPTABLE → set 24 °C), ahead of the new 27 °C warning.

UPDATE `alert_rules` SET `threshold_value` = 27, `updated_at` = CURRENT_TIMESTAMP
 WHERE `device_id` IS NULL AND `interface_name` IS NULL
   AND `metric_name` = 'temperature' AND `severity` = 'warning'  AND `threshold_value` = 30;

UPDATE `alert_rules` SET `threshold_value` = 32, `updated_at` = CURRENT_TIMESTAMP
 WHERE `device_id` IS NULL AND `interface_name` IS NULL
   AND `metric_name` = 'temperature' AND `severity` = 'critical' AND `threshold_value` = 34;

UPDATE `alert_rules` SET `threshold_value` = 80, `updated_at` = CURRENT_TIMESTAMP
 WHERE `device_id` IS NULL AND `interface_name` IS NULL
   AND `metric_name` = 'humidity'    AND `severity` = 'critical' AND `threshold_value` = 70;
