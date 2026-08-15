-- Seed the two metrics that are evaluated but have no rule to evaluate against.
--
-- ⚠️ Also folded into v13_cspc-ictu-monitoring-system.sql. Run this ONLY on a database
-- created before 2026-08-16.
--
-- Alerting is RULES-ONLY: `alertRulesService.getEffectiveRules` returns an empty array
-- when nothing matches, `nextBand` then reports "normal", and the metric is silent
-- forever. `deviceAlerts.checkUps` and `checkRouter` have always evaluated `ups_load` and
-- `router_clients`, and CLAUDE.md has always listed them as supported — but neither was
-- ever seeded, so both were dead code that looked live. That is the failure mode this
-- model is most prone to: silence is indistinguishable from health.

-- UPS load. 80% is the conventional vendor warning point: above it the runtime figure
-- the battery advertises no longer holds, which matters precisely when mains is lost.
INSERT INTO `alert_rules`
  (`device_id`, `interface_name`, `metric_name`, `threshold_value`, `comparison`, `severity`, `is_active`)
VALUES
  (NULL, NULL, 'ups_load', 80, '>=', 'warning',  1),
  (NULL, NULL, 'ups_load', 90, '>=', 'critical', 1);

-- Connected clients. Seeded INACTIVE (is_active = 0) on purpose.
--
-- Unlike a percentage, the right number here is a property of the site — a router serving
-- one office and one serving a campus differ by an order of magnitude, and a guessed
-- default would either page constantly or never. Seeding it paused puts the metric in
-- front of an admin on the Alert Rules page, with a starting figure to edit, instead of
-- leaving it invisible. Set a real threshold and switch it on.
INSERT INTO `alert_rules`
  (`device_id`, `interface_name`, `metric_name`, `threshold_value`, `comparison`, `severity`, `is_active`)
VALUES
  (NULL, NULL, 'router_clients', 200, '>=', 'warning',  0),
  (NULL, NULL, 'router_clients', 300, '>=', 'critical', 0);
