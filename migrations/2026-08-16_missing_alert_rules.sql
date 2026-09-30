-- Add rules for two metrics that are checked but had no rule.
--
-- Also included in v13_cspc-ictu-monitoring-system.sql. Only run this on a database
-- created before 2026-08-16.
--
-- Alerting only fires when a rule exists. deviceAlerts evaluates `ups_load` and
-- `router_clients`, but neither had a rule, so both were silent.

-- UPS load. 80% is the conventional vendor warning point: above it the runtime figure
-- the battery advertises no longer holds, which matters precisely when mains is lost.
INSERT INTO `alert_rules`
  (`device_id`, `interface_name`, `metric_name`, `threshold_value`, `comparison`, `severity`, `is_active`)
VALUES
  (NULL, NULL, 'ups_load', 80, '>=', 'warning',  1),
  (NULL, NULL, 'ups_load', 90, '>=', 'critical', 1);

-- Connected clients. Added inactive (is_active = 0): the right number depends on the site
-- (one office vs a whole campus), so an admin should set a real threshold and turn it on.
INSERT INTO `alert_rules`
  (`device_id`, `interface_name`, `metric_name`, `threshold_value`, `comparison`, `severity`, `is_active`)
VALUES
  (NULL, NULL, 'router_clients', 200, '>=', 'warning',  0),
  (NULL, NULL, 'router_clients', 300, '>=', 'critical', 0);
