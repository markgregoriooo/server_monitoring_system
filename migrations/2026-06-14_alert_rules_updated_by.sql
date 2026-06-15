-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: alert_rules accountability — track WHO last created/edited a rule
-- Date: 2026-06-14   Branch: email-popup-notifications
--
-- Run ONCE in phpMyAdmin (select your DB → SQL → paste → Go).
--
-- WHY:
--   Alert thresholds drive what alarms the whole team (and the server-room device).
--   For accountability, every create/edit now stamps the acting admin's id in
--   `updated_by`; the Alert Rules page shows "edited by <name> · <when>". Seeded
--   global defaults keep updated_by = NULL → shown as "system default".
--
-- NOTE:
--   `updated_at` already exists; the service sets it to NOW() on every update.
--   FK is ON DELETE SET NULL so removing a user never deletes their rules — the
--   attribution just falls back to "system default".
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE `alert_rules`
  ADD COLUMN `updated_by` INT NULL DEFAULT NULL AFTER `updated_at`;

ALTER TABLE `alert_rules`
  ADD INDEX `idx_rules_updated_by` (`updated_by` ASC),
  ADD CONSTRAINT `fk_alert_rules_updated_by`
    FOREIGN KEY (`updated_by`)
    REFERENCES `users` (`user_id`)
    ON DELETE SET NULL
    ON UPDATE CASCADE;
