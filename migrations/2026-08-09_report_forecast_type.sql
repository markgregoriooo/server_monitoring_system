-- ─────────────────────────────────────────────────────────────────────────────
-- Adds the 'forecast' report type (Capacity Forecast).
--
-- REQUIRED before generating a forecast report. `reports.type` is an ENUM, so a
-- value outside the list is rejected under strict mode (or silently stored as ''
-- without it) — the earlier `network` and `ups` types needed no migration only
-- because they were already in the ENUM.
--
-- Safe to re-run: adding a value that is already present is a no-op rewrite of the
-- same definition. Existing rows are untouched; the column stays nullable with its
-- current default.
--
-- Apply:  mysql -u root -p server_monitoring_system < migrations/2026-08-09_report_forecast_type.sql
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE `reports`
  MODIFY COLUMN `type`
  ENUM('environment','server','alerts','aircon','network','ups','forecast')
  DEFAULT NULL;
