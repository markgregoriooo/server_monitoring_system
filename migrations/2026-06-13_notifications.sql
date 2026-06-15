-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Notifications (bell feed + in-app popup + Resend email)
-- Date: 2026-06-13   Branch: email-popup-notifications
--
-- Run this ONCE against your monitoring database (the one named in backend/.env
-- DB_NAME). In phpMyAdmin: select that database in the left tree → SQL tab →
-- paste → Go.  Safe to run on the existing (currently unused) alerts /
-- alert_notifications tables.
--
-- We REUSE the tables the schema already ships:
--   alerts             = the event (one row per event)
--   alert_notifications = the delivery (one row per recipient — the bell feed)
-- and add per-user channel preferences.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) `alerts` — relax + default for non-metric, state-transition alerts.
--    - metric_value becomes NULLABLE: "server offline" / "UPS on battery" are
--      state changes, not a numeric reading, so they have no metric_value.
--    - status defaults to 'active' (every new alert starts active).
--    - updated_at now auto-bumps on ack/resolve.
ALTER TABLE `alerts`
  MODIFY `metric_value` FLOAT NULL,
  MODIFY `status` ENUM('active','acknowledged','resolved') NOT NULL DEFAULT 'active',
  MODIFY `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- 2) `alert_notifications` — the per-user bell feed.
--    - is_read defaults to 0 (unread on creation).
--    - emailed: 1 once the Resend email for THIS recipient has been sent, so a
--      restart/retry never double-emails and the UI can show "emailed".
ALTER TABLE `alert_notifications`
  MODIFY `is_read` TINYINT NOT NULL DEFAULT 0,
  ADD COLUMN `emailed` TINYINT NOT NULL DEFAULT 0 AFTER `is_read`;

-- 3) `notification_prefs` — per-user channel control (one row per user; a missing
--    row means "use defaults", which the backend supplies, so this table is
--    optional to populate). min_email_severity gates which alerts get emailed.
CREATE TABLE IF NOT EXISTS `notification_prefs` (
  `user_id` INT NOT NULL,
  `email_enabled` TINYINT NOT NULL DEFAULT 1,
  `popup_enabled` TINYINT NOT NULL DEFAULT 1,
  `min_email_severity` ENUM('info','warning','critical') NOT NULL DEFAULT 'critical',
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_notification_prefs_users1`
    FOREIGN KEY (`user_id`)
    REFERENCES `users` (`user_id`)
    ON DELETE CASCADE
    ON UPDATE CASCADE)
ENGINE = InnoDB;
