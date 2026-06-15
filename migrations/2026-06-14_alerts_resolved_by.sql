-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: record WHO resolved an alert (separate from who acknowledged it)
-- Date: 2026-06-14   Branch: email-popup-notifications
--
-- Run in phpMyAdmin (select your DB → SQL → paste → Go). Run ONCE.
--
-- WHY:
--  `alerts` already has `acknowledged_by` but no `resolved_by`, so the UI could only
--  show one name — making an admin's resolve of an it_staff-acknowledged alert look
--  like the it_staff member resolved it. Acknowledge and resolve are often different
--  people (one triages, another fixes), so track them separately.
--
--  resolved_by NULL + resolved_at set = AUTO-resolved (metric recovered, no human).
--  resolved_by set                      = manually resolved by that user.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE `alerts`
  ADD COLUMN `resolved_by` INT NULL AFTER `acknowledged_by`,
  ADD INDEX `fk_alerts_resolved_by_idx` (`resolved_by` ASC),
  ADD CONSTRAINT `fk_alerts_resolved_by`
    FOREIGN KEY (`resolved_by`)
    REFERENCES `users` (`user_id`)
    ON DELETE SET NULL
    ON UPDATE CASCADE;
