-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: allow system / room-level alerts (no specific device)
-- Date: 2026-06-13   Branch: email-popup-notifications
--
-- Run in phpMyAdmin (select your DB → SQL → paste → Go). Safe + idempotent.
--
-- Environment alerts (server-room temperature / humidity / gas / smoke) come from
-- the ESP32, which is NOT a row in `devices` — so the alert isn't tied to a
-- device. Make alerts.device_id NULLABLE so these system-level alerts can be
-- stored. The existing FK still applies to non-NULL values (MySQL skips the FK
-- check when the column is NULL).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE `alerts`
  MODIFY `device_id` INT NULL;
