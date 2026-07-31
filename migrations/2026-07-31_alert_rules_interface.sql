-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: per-INTERFACE alert rules (`alert_rules.interface_name`)
-- Date: 2026-07-31   Branch: mikrotik-monitoring
--
-- Run in phpMyAdmin (select your DB → SQL → paste → Go). Run ONCE.
-- Non-destructive: the column is NULLABLE and every existing row keeps NULL, which
-- means "applies to the whole device" — exactly today's behaviour. Nothing changes
-- until someone creates a rule that names a port.
--
-- WHY:
--  `link_util` and `link_errors` are measured PER PORT, but a rule could only be
--  scoped to a whole device — so one threshold had to cover every port on a router.
--  That doesn't survive contact with reality:
--
--    ether1  ISP uplink, 1 Gb/s   → 60-70% is normal, alert at 90
--    ether3  one laptop           → should never exceed ~5%, alert at 20
--
--  A single number either lets a misbehaving access port run unnoticed, or makes the
--  uplink cry wolf all day. This lets each port carry its own threshold.
--
-- RESOLUTION ORDER (services/alertRulesService.getEffectiveRules):
--    1. device_id = <id>  AND interface_name = '<port>'   ← most specific wins
--    2. device_id = <id>  AND interface_name IS NULL      ← whole-device override
--    3. device_id IS NULL AND interface_name IS NULL      ← global default
--  The first level that matches is used; the others are NOT merged into it. That
--  mirrors how the existing per-device vs global fallback already behaves.
--
-- SCOPE:
--  Only per-interface metrics (`link_util`, `link_errors`) read this column. It is
--  ignored for device-level metrics (cpu / mem / router_cpu / ups_* …), and the
--  service rejects an interface_name without a device_id.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE `alert_rules`
  ADD COLUMN `interface_name` VARCHAR(50) NULL DEFAULT NULL AFTER `device_id`;

-- The resolver looks rules up by (device, interface, metric) on every poll, so give
-- that lookup an index. `is_active` is included because the cache only loads active rows.
ALTER TABLE `alert_rules`
  ADD INDEX `idx_rules_dev_iface_metric` (`device_id` ASC, `interface_name` ASC, `metric_name` ASC, `is_active` ASC);
