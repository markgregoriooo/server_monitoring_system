-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: preserve alert history when an alert rule is deleted
-- Date: 2026-06-14   Branch: email-popup-notifications
--
-- Run in phpMyAdmin (select your DB → SQL → paste → Go). Run ONCE.
--
-- WHY:
--  Alerts now record which rule fired them (alerts.alert_rule_id, set in
--  notificationService.raiseAlert). The original FK was ON DELETE CASCADE, so
--  deleting a rule from the Alert Rules page would CASCADE-delete every alert that
--  rule ever raised — and, via alert_notifications (ON DELETE CASCADE on alert_id),
--  every matching bell-feed row too. That silently destroys alert history.
--
--  Switch to ON DELETE SET NULL: deleting a rule keeps the historical alerts and
--  just nulls their alert_rule_id (the column is already NULLABLE). The audit trail
--  survives; only the "which rule" link is lost for that deleted rule.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE `alerts` DROP FOREIGN KEY `fk_alerts_alert_rules1`;

ALTER TABLE `alerts`
  ADD CONSTRAINT `fk_alerts_alert_rules1`
  FOREIGN KEY (`alert_rule_id`)
  REFERENCES `alert_rules` (`alert_rule_id`)
  ON DELETE SET NULL
  ON UPDATE CASCADE;
