-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: seed GLOBAL alert_rules for interface ERROR rate (`link_errors`)
-- Date: 2026-07-31   Branch: mikrotik-monitoring
--
-- Run in phpMyAdmin (select your DB → SQL → paste → Go). Idempotent — re-running
-- will NOT duplicate the seeded rules.
--
-- WHY:
--  Both pollers already collect per-interface rx/tx error counters and write them to
--  InfluxDB (`network_traffic.rx_errors` / `tx_errors`), and the dashboard now shows
--  them per port — but nothing ever alerted on them. Rising interface errors are the
--  classic signal of a failing cable, a dying SFP or a duplex mismatch, and nobody
--  catches that by watching a page. Alerting is RULES-ONLY, so without these rows the
--  new `link_errors` metric stays silent.
--
-- WHAT IS MEASURED:
--  services/deviceAlerts.js evaluates the number of errors added SINCE THE PREVIOUS
--  POLL (rx+tx), not the lifetime counter. A router up for a year carries a large
--  total that says nothing about current health; errors appearing *now* do.
--
--  ⚠️ Because it is a per-poll delta, the sensible threshold depends on the poll
--     cadence: MIKROTIK_POLL_INTERVAL_MS (default 30s) and SNMP_POLL_INTERVAL_MS
--     (default 60s). The values below assume roughly those defaults. If you shorten
--     the interval, lower these to match, or you will alert later than you expect.
--
--  The first observation of an interface establishes a baseline and never alerts —
--  there is no previous counter to compare against.
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO `alert_rules`
  (`device_id`, `metric_name`, `threshold_value`, `comparison`, `severity`, `is_active`)
SELECT s.device_id, s.metric_name, s.threshold_value, s.comparison, s.severity, 1
FROM (
  -- A handful of errors per poll is worth a look; hundreds means the link is failing.
  SELECT NULL AS device_id, 'link_errors' AS metric_name, 10 AS threshold_value, '>=' AS comparison, 'warning'  AS severity
  UNION ALL SELECT NULL, 'link_errors', 100, '>=', 'critical'
) AS s
WHERE NOT EXISTS (
  SELECT 1 FROM `alert_rules` ar
   WHERE ar.device_id <=> s.device_id
     AND ar.metric_name = s.metric_name
     AND ar.severity = s.severity
);
