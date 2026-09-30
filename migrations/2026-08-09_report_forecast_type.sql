-- ─────────────────────────────────────────────────────────────────────────────
-- Adds the 'forecast' report type (Capacity Forecast).
--
-- Needed before generating a forecast report: `reports.type` is an ENUM, and a value
-- outside it is rejected (strict mode) or stored as ''.
--
-- Safe to re-run. Existing rows are unchanged.
--
-- Apply:  mysql -u root -p server_monitoring_system < migrations/2026-08-09_report_forecast_type.sql
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE `reports`
  MODIFY COLUMN `type`
  ENUM('environment','server','alerts','aircon','network','ups','forecast')
  DEFAULT NULL;
