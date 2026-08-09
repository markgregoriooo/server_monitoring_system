-- Interface-down alerting: stop empty and disabled ports raising alerts.
--
-- Before this, ANY port reporting no carrier alerted, and which ports alerted was
-- decided by an in-memory Set seeded on the first poll after a backend restart: a
-- port already down at boot was baselined silent forever, a port up at boot alerted
-- the moment its cable moved. On a 5-port router with 3 empty ports that reads as
-- "why does ether5 alert and ether2-4 don't" — the answer being restart timing, which
-- is not a property anyone can reason about.
--
-- Two persistent facts replace it, so the decision survives restarts and is inspectable
-- in SQL rather than living in process memory:
--
--   ever_up      the port has carried a link at least once. A port that has NEVER come
--                up is an empty socket, not a fault. Set by the pollers, never by hand.
--   monitor_link ICTU's explicit opt-out for a port that legitimately flaps (a lab
--                bench, a spare drop) — default ON, so this only ever silences on request.
--
-- Rows are otherwise optional (a port with no row just shows its raw RouterOS name),
-- so both columns are read with a default: a port with no row is treated as
-- ever_up = 0 (silent) and monitor_link = 1.

ALTER TABLE network_interfaces
  ADD COLUMN ever_up TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'Port has carried a link at least once — gates interface-down alerting'
    AFTER is_active,
  ADD COLUMN monitor_link TINYINT(1) NOT NULL DEFAULT 1
    COMMENT 'Admin opt-out: 0 silences interface-down alerts for this port'
    AFTER ever_up;

-- Ports that already exist here were labelled by hand, which is a deliberate statement
-- that the port matters. Seed them ever_up = 1 so labelling keeps its meaning and this
-- migration doesn't silence a link someone is already watching.
UPDATE network_interfaces
   SET ever_up = 1
 WHERE location_label IS NOT NULL AND location_label <> '';
