-- Interface-down alerting: stop empty and disabled ports from raising alerts.
--
-- Which ports alerted used to depend on an in-memory list built at backend startup,
-- so it changed with restart timing. Two stored columns replace it:
--
--   ever_up      the port has had a link at least once. A port that never has is an
--                empty socket, not a fault. Set by the pollers.
--   monitor_link per-port opt-out for ports that flap on purpose (lab bench, spare
--                drop). On by default.
--
-- A port without a row counts as ever_up = 0 (silent) and monitor_link = 1.

ALTER TABLE network_interfaces
  ADD COLUMN ever_up TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'Port has carried a link at least once — gates interface-down alerting'
    AFTER is_active,
  ADD COLUMN monitor_link TINYINT(1) NOT NULL DEFAULT 1
    COMMENT 'Admin opt-out: 0 silences interface-down alerts for this port'
    AFTER ever_up;

-- Ports that already have a row were labelled by hand, so they matter: mark them
-- ever_up = 1 so this migration does not silence them.
UPDATE network_interfaces
   SET ever_up = 1
 WHERE location_label IS NOT NULL AND location_label <> '';
