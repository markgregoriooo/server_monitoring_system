-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: seed GLOBAL alert_rules for router / UPS metrics
-- Date: 2026-06-30   Branch: mikrotik-monitoring
--
-- Run in phpMyAdmin (select your DB → SQL → paste → Go). Idempotent — re-running
-- this file will NOT duplicate the seeded rules.
--
-- WHY:
--  MikroTik routers, generic SNMP routers and UPS devices now raise REAL alerts
--  (bell + toast + email + the Alerts page) through the same configurable
--  `alert_rules` pipeline as servers and the environment (services/deviceAlerts.js,
--  replacing the old device-log-only poller checks). Alerting is RULES-ONLY: a
--  metric with no matching active rule raises nothing — so without these seeded
--  global defaults the new metrics would stay silent. The values below are sensible
--  NOC starting points an admin can retune from the Alert Rules page.
--
-- metric_name vocabulary (MUST match services/deviceAlerts.js + the Alert Rules UI):
--   router_cpu, router_mem   router CPU / memory %        (higher-is-worse, '>=')
--   link_util                interface utilization %      (higher-is-worse, per-iface)
--   ups_charge, ups_runtime  battery % / runtime minutes  (LOWER-is-worse, '<=')
-- Not seeded (capability only — no universal sensible default): router_clients,
-- ups_load. Boolean events (interface down, UPS on-battery) are not rule-based.
-- ─────────────────────────────────────────────────────────────────────────────

-- Seed the GLOBAL (device_id = NULL) defaults. Idempotent: each (metric, severity)
-- row is inserted only if no global rule for it already exists, so re-running is safe.
-- `<=>` is MySQL's null-safe equals (device_id is NULL for global rules).
INSERT INTO `alert_rules`
  (`device_id`, `metric_name`, `threshold_value`, `comparison`, `severity`, `is_active`)
SELECT s.device_id, s.metric_name, s.threshold_value, s.comparison, s.severity, 1
FROM (
  -- Router device-level (higher-is-worse)
  SELECT NULL AS device_id, 'router_cpu'  AS metric_name, 85 AS threshold_value, '>=' AS comparison, 'warning'  AS severity
  UNION ALL SELECT NULL, 'router_cpu',   95, '>=', 'critical'
  UNION ALL SELECT NULL, 'router_mem',   85, '>=', 'warning'
  UNION ALL SELECT NULL, 'router_mem',   95, '>=', 'critical'
  -- Link saturation (higher-is-worse; one global rule covers every interface)
  UNION ALL SELECT NULL, 'link_util',    80, '>=', 'warning'
  UNION ALL SELECT NULL, 'link_util',    95, '>=', 'critical'
  -- UPS (LOWER-is-worse)
  UNION ALL SELECT NULL, 'ups_charge',   50, '<=', 'warning'
  UNION ALL SELECT NULL, 'ups_charge',   20, '<=', 'critical'
  UNION ALL SELECT NULL, 'ups_runtime',  10, '<=', 'warning'
  UNION ALL SELECT NULL, 'ups_runtime',   5, '<=', 'critical'
) AS s
WHERE NOT EXISTS (
  SELECT 1 FROM `alert_rules` ar
   WHERE ar.device_id <=> s.device_id
     AND ar.metric_name = s.metric_name
     AND ar.severity = s.severity
);
