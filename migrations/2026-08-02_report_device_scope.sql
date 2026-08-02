-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: scope a report to ONE device
-- Date: 2026-08-02   Branch: reports-page
--
-- Run in phpMyAdmin (select your DB → SQL → paste → Go). Run ONCE.
--
-- WHY:
--  Reports were always campus-wide: a "Network Traffic" report covered every router
--  and the MikroTik together, with no way to ask "just the MikroTik, last 7 days".
--  The scope has to be PERSISTED, not just a query parameter — the report list shows
--  what each row covers, and the saved CSV/PDF must stay explainable months later.
--
--  NULL = all devices (the previous behaviour, and still the default). Only the
--  types that are per-device honour it — `environment` is room-level (one sensor
--  cluster in the server room), so it ignores this column.
--
--  ON DELETE SET NULL, not CASCADE: decommissioning a router must not silently
--  delete the historical reports that describe it. The row survives with a NULL
--  scope and the UI falls back to showing the type alone.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE `reports`
  ADD COLUMN `device_id` INT NULL AFTER `type`,
  ADD INDEX `idx_reports_device` (`device_id` ASC),
  ADD CONSTRAINT `fk_reports_devices1`
    FOREIGN KEY (`device_id`)
    REFERENCES `devices` (`device_id`)
    ON DELETE SET NULL
    ON UPDATE CASCADE;
