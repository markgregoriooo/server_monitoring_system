-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: register Router & UPS devices for SNMP monitoring  (TEMPLATE)
-- Date: 2026-06-12   Branch: router-ups-monitoring
--
-- This registers the real routers/switches and UPS units so the SNMP poller
-- (backend/services/snmpPollerService.js) starts polling them every ~60s. The
-- poller is data-driven: every row you add here is picked up automatically on the
-- next cycle — no code change, any number of devices.
--
-- ⚠️ THIS IS A TEMPLATE. The executable INSERTs are COMMENTED OUT. Fill in the
--    real values (ip, snmp_community, model, …) and UNCOMMENT each block you need,
--    then run ONCE against the DB named in backend/.env (DB_NAME).
--
-- It depends on three facts to be confirmed first (see router-ups-monitoring.md §10):
--   Q1  Does each UPS have a network / SNMP card?  → only those get a row here
--       (a usb/serial-only UPS CANNOT be monitored over SNMP — leave it out).
--   Q6  Are the routers MANAGED (SNMP-capable)?    → managed → add with a community
--       string; basic/unmanaged → leave out for now (ICMP-ping fallback is a
--       separate module not yet built).
--   Q9  Does the firewall let the backend host reach UDP 161 on each device?
--       → confirm with: snmpwalk -v2c -c <community> <device-ip>
--
-- SNMP version is v2c (the schema stores only a community string + port; there are
-- no v3 credential columns yet). Use a READ-ONLY community on each device.
-- ─────────────────────────────────────────────────────────────────────────────


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 1) ROUTER / SWITCH  (one block per managed device)                          ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- device_network requires gateway/dns/network_segment (NOT NULL) — '' is fine if
-- unknown; the poller only needs ip_address + snmp_community + snmp_port.

-- INSERT INTO `devices` (ip_address, device_name, device_type, status, location)
--   VALUES ('REPLACE_ROUTER_IP', 'REPLACE_ROUTER_NAME', 'router', 'offline', 'CSPC-ICTU Server Room');
-- SET @router_id := LAST_INSERT_ID();
--
-- INSERT INTO `device_network`
--     (device_id, gateway, dns, network_segment, mac_address, snmp_port, snmp_community)
--   VALUES (@router_id, '', '', '', NULL, 161, 'REPLACE_READONLY_COMMUNITY');
--
-- (Optional) label individual ports — shown as the per-interface "location_label"
-- on the Network page. interface_name MUST match the device's SNMP ifName exactly
-- (check with: snmpwalk -v2c -c <community> <ip> 1.3.6.1.2.1.31.1.1.1.1).
-- INSERT INTO `network_interfaces` (device_id, interface_name, location_label, is_active) VALUES
--   (@router_id, 'REPLACE_IFNAME_1', 'Uplink to ISP',   1),
--   (@router_id, 'REPLACE_IFNAME_2', 'Rack A switch',    1);


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 2) UPS  (one block per UPS that HAS an SNMP / network card)                  ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- communication_type MUST be 'snmp' or 'network' for the poller to read it. A
-- 'usb'/'serial' UPS is intentionally left out — it can't be polled over SNMP.

-- INSERT INTO `devices` (ip_address, device_name, device_type, status, location)
--   VALUES ('REPLACE_UPS_IP', 'REPLACE_UPS_NAME', 'ups', 'offline', 'CSPC-ICTU Server Room');
-- SET @ups_id := LAST_INSERT_ID();
--
-- INSERT INTO `device_network`
--     (device_id, gateway, dns, network_segment, mac_address, snmp_port, snmp_community)
--   VALUES (@ups_id, '', '', '', NULL, 161, 'REPLACE_READONLY_COMMUNITY');
--
-- INSERT INTO `ups_details`
--     (device_id, brand, model, battery_capacity, communication_type, serial_number)
--   VALUES (@ups_id, 'REPLACE_BRAND', 'REPLACE_MODEL', 'REPLACE_VA_OR_AH', 'snmp', NULL);


-- ─────────────────────────────────────────────────────────────────────────────
-- To DECOMMISSION a device later (cascades to device_network / ups_details /
-- network_interfaces via their FKs):
--   DELETE FROM `devices` WHERE device_id = <id>;
-- ─────────────────────────────────────────────────────────────────────────────
