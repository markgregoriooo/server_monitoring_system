-- Seed the two ICMP link-quality metrics: router_latency + router_loss.
--
-- ⚠️ Also folded into v13_cspc-ictu-monitoring-system.sql. Run this ONLY on a database
-- created before 2026-08-22.
--
-- Alerting is RULES-ONLY: with no matching row, getEffectiveRules returns nothing,
-- nextBand reports "normal", and the metric is silent forever. deviceAlerts.checkRouter
-- now evaluates both of these, so without this seed they would be exactly the dead-code-
-- that-looks-live that 2026-08-16_missing_alert_rules.sql was written to fix.
--
-- WHY THESE TWO EXIST AT ALL. They are the only things SNMP structurally cannot report:
-- an SNMP walk either answers or times out, so a link that is UP and dropping a third of
-- its packets reads as perfectly healthy right up until it crosses into a flat Offline.
-- They are also the ONLY numeric metrics a PING-ONLY router has (one registered with no
-- community string — an ISP-owned CPE), which without them could raise nothing but
-- "unreachable": working or dead, with no degraded state in between.
--
-- Both are collected on SNMP and ping devices alike (icmpPing runs alongside every
-- router poll), so these global defaults apply to the MikroTiks too.

-- ── Packet loss ──────────────────────────────────────────────────────────────
-- Seeded ACTIVE. Unlike a client count, loss is not site-dependent: a healthy LAN link
-- loses 0%, and any sustained loss is a fault anywhere in the world.
--
-- 5% warning: below this, a single dropped echo in a small sample is ordinary noise
-- rather than a signal. 20% critical: past that, TCP throughput has collapsed and
-- users are already complaining — VoIP and video are unusable well before 20%.
--
-- ⚠️ Read these against PING_COUNT (default 3): with 3 echoes the only possible values
-- are 0 / 33.3 / 66.7 / 100, so 5% and 20% both trip on the FIRST lost packet. That is
-- deliberate — one lost echo on a server-room link is worth a warning — but it means
-- the two bands are indistinguishable at the default count. Raise PING_COUNT to 10 for
-- a finer scale (10% steps) if this proves noisy.
INSERT INTO `alert_rules`
  (`device_id`, `interface_name`, `metric_name`, `threshold_value`, `comparison`, `severity`, `is_active`)
VALUES
  (NULL, NULL, 'router_loss', 5,  '>=', 'warning',  1),
  (NULL, NULL, 'router_loss', 20, '>=', 'critical', 1);

-- ── Latency ──────────────────────────────────────────────────────────────────
-- Seeded INACTIVE (is_active = 0), like router_clients before it, and for the same
-- reason: the right number is a property of the link, not of networking in general.
--
-- A switch in the same rack answers in under 1 ms. A campus gateway answers in a few.
-- An ISP CPE over PLDT's network is routinely 20-40 ms and perfectly healthy. One
-- global default would either page constantly about the WAN link or never notice the
-- LAN one degrading tenfold.
--
-- 100/300 ms are starting figures to edit, not recommendations. The intended workflow:
-- watch the device's real latency on its detail page for a few days, then set a
-- per-device rule at roughly 2-3x its normal figure and switch it on. A per-device rule
-- (device_id set) overrides these globals — see alertRulesService.getEffectiveRules.
INSERT INTO `alert_rules`
  (`device_id`, `interface_name`, `metric_name`, `threshold_value`, `comparison`, `severity`, `is_active`)
VALUES
  (NULL, NULL, 'router_latency', 100, '>=', 'warning',  0),
  (NULL, NULL, 'router_latency', 300, '>=', 'critical', 0);
