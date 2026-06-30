-- ─────────────────────────────────────────────────────────────────────────────
-- DEV-ONLY seed: register a fake router + fake UPS that the snmpsim simulator
-- answers for, so the SNMP poller has something to poll without real hardware.
--
-- Both point at 127.0.0.1 (the simulator on this PC). The simulator serves a
-- different data file per COMMUNITY string:
--     community 'dev-router' -> dev-snmpsim/data/dev-router.snmprec
--     community 'dev-ups'    -> dev-snmpsim/data/dev-ups.snmprec
-- Port 1161 (not 161) so it needs no admin rights.
--
-- Run once against your dev DB (the DB_NAME in backend/.env):
--     mysql -u <user> -p <db_name> < dev-snmpsim/seed-dev-devices.sql
--
-- To remove later:  DELETE FROM devices WHERE location = 'DEV - snmpsim';
-- (cascades to device_network / ups_details / network_interfaces via FKs)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Fake router ──────────────────────────────────────────────────────────────
INSERT INTO `devices` (ip_address, device_name, device_type, status, location)
  VALUES ('127.0.0.1', 'DEV Router (sim)', 'router', 'offline', 'DEV - snmpsim');
SET @router_id := LAST_INSERT_ID();

INSERT INTO `device_network`
    (device_id, gateway, dns, network_segment, mac_address, snmp_port, snmp_community)
  VALUES (@router_id, '', '', '', NULL, 1161, 'dev-router');

INSERT INTO `network_interfaces` (device_id, interface_name, location_label, is_active) VALUES
  (@router_id, 'ether1', 'Uplink (sim)',      1),
  (@router_id, 'ether2', 'Rack switch (sim)', 1);

-- ── Fake UPS ─────────────────────────────────────────────────────────────────
INSERT INTO `devices` (ip_address, device_name, device_type, status, location)
  VALUES ('127.0.0.1', 'DEV UPS (sim)', 'ups', 'offline', 'DEV - snmpsim');
SET @ups_id := LAST_INSERT_ID();

INSERT INTO `device_network`
    (device_id, gateway, dns, network_segment, mac_address, snmp_port, snmp_community)
  VALUES (@ups_id, '', '', '', NULL, 1161, 'dev-ups');

INSERT INTO `ups_details`
    (device_id, brand, model, battery_capacity, communication_type, serial_number)
  VALUES (@ups_id, 'SimVendor', 'SIM-1500', '1500', 'snmp', NULL);
