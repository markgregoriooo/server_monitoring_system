-- Add the two ICMP link-quality rules: router_latency and router_loss.
--
-- Also included in v13_cspc-ictu-monitoring-system.sql. Only run this on a database
-- created before 2026-08-22.
--
-- Without a rule a metric never alerts. These two are what SNMP cannot report (a walk
-- answers or times out, so packet loss goes unseen), and they are the only numeric
-- metrics a ping-only router has. Collected for every router, including MikroTiks, so
-- these global defaults apply to all of them.

-- ── Packet loss ──────────────────────────────────────────────────────────────
-- Added active: a healthy link loses 0%, anywhere. 5% warning, 20% critical.
--
-- With PING_COUNT at its default of 3, loss can only be 0 / 33.3 / 66.7 / 100, so both
-- bands trip on the first lost packet. Raise PING_COUNT to 10 for 10% steps if that is
-- too noisy.
INSERT INTO `alert_rules`
  (`device_id`, `interface_name`, `metric_name`, `threshold_value`, `comparison`, `severity`, `is_active`)
VALUES
  (NULL, NULL, 'router_loss', 5,  '>=', 'warning',  1),
  (NULL, NULL, 'router_loss', 20, '>=', 'critical', 1);

-- ── Latency ──────────────────────────────────────────────────────────────────
-- Added inactive (is_active = 0): the right value depends on the link. A switch in the
-- same rack answers in under 1 ms; an ISP router over PLDT in 20-40 ms. 100/300 ms are
-- starting values: watch the device's real latency for a few days, then set a per-device
-- rule at about 2-3x its normal value and turn it on (a per-device rule overrides these;
-- see alertRulesService.getEffectiveRules).
INSERT INTO `alert_rules`
  (`device_id`, `interface_name`, `metric_name`, `threshold_value`, `comparison`, `severity`, `is_active`)
VALUES
  (NULL, NULL, 'router_latency', 100, '>=', 'warning',  0),
  (NULL, NULL, 'router_latency', 300, '>=', 'critical', 0);
