-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: MikroTik network monitoring — device_type value + API-SSL flag
-- Date: 2026-06-20   Branch: mikrotik-monitoring
--
-- Run ONCE in phpMyAdmin (select your DB → SQL → paste → Go).
--
-- WHY:
--   The MikroTik is monitored by PULLING metrics over the RouterOS API (no agent).
--   It is ONE row in `devices`, with its API connection details in the EXISTING 1:1
--   detail table `mikrotik_devices` (already in the V10 schema — same pattern as
--   server_specs / ups_details). Each building = one PORT, labeled in the EXISTING
--   `network_interfaces` table (interface_name → location_label). Full design in
--   mikrotik-monitoring.md.
--
--   The V10 schema already ships `mikrotik_devices` and `network_interfaces`, so we do
--   NOT create them. This migration only fills the two gaps V10 left:
--     1) `devices.device_type` ENUM has no 'mikrotik' value yet.
--     2) `mikrotik_devices` has no TLS (API-SSL / port 8729) flag.
-- ─────────────────────────────────────────────────────────────────────────────


-- 1) Allow MikroTik as a first-class device type.
--    Appended to the ENUM → non-destructive (existing rows keep their value).
ALTER TABLE `devices`
  MODIFY `device_type` ENUM('aircon','server','ups','router','esp32','mikrotik') NOT NULL;


-- 2) Explicit API-SSL flag on the existing mikrotik_devices table.
--    api_port already defaults to 8728; 8729 = API-SSL. use_tls makes the intent explicit
--    instead of inferring TLS from the port number.
ALTER TABLE `mikrotik_devices`
  ADD COLUMN `use_tls` TINYINT NOT NULL DEFAULT 0 AFTER `api_port`;


-- 3) Drop the unused column. RouterBOOT firmware isn't used by monitoring and overlaps
--    with routeros_version. (`updated_at` is intentionally kept — every table has it, and
--    the admin form stamps it when the connection config is edited.)
--    ⚠️ Also remove `firmware_version` from the .mwb Workbench model so a future schema
--       re-export doesn't re-add it.
ALTER TABLE `mikrotik_devices`
  DROP COLUMN `firmware_version`;


-- NOTE — credentials: `mikrotik_devices.api_password` (VARCHAR(255)) holds the RouterOS API
-- password ENCRYPTED at rest (AES-256-GCM, stored base64) — written by the dashboard admin
-- form, never plaintext. The backend decrypts it only inside the poller. No column change
-- needed for this; it's an application-layer concern.


-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ SEED  (TEMPLATE — fill in after the questionnaire, then UNCOMMENT)           ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- Registers the ONE MikroTik and maps each port to a building. Recommended path is to
-- add the device + API credentials from the dashboard admin form (it encrypts the
-- password). The block below is for a manual bring-up; leave `api_password` to be set
-- via the app so it is stored encrypted.
--
-- INSERT INTO `devices` (ip_address, device_name, device_type, status, location)
--   VALUES ('REPLACE_MIKROTIK_IP', 'Campus MikroTik', 'mikrotik', 'offline', 'CSPC-ICTU Server Room');
-- SET @mikrotik_id := LAST_INSERT_ID();
--
-- INSERT INTO `mikrotik_devices` (device_id, api_port, use_tls, api_username, api_enabled)
--   VALUES (@mikrotik_id, 8728, 0, 'monitor-ro', 1);   -- read-only RouterOS user; set api_password via the dashboard
--
-- -- Each building = one port. interface_name MUST match the RouterOS name exactly
-- -- (e.g. ether1, ether2, sfp1). location_label = the building that port serves.
-- INSERT INTO `network_interfaces` (device_id, interface_name, location_label, is_active) VALUES
--   (@mikrotik_id, 'ether1', 'Uplink to ISP',       1),
--   (@mikrotik_id, 'ether2', 'REPLACE_BUILDING_1',  1),
--   (@mikrotik_id, 'ether3', 'REPLACE_BUILDING_2',  1),
--   (@mikrotik_id, 'ether4', 'REPLACE_BUILDING_3',  1),
--   (@mikrotik_id, 'ether5', 'REPLACE_BUILDING_4',  1);
--
-- To DECOMMISSION later (cascades to mikrotik_devices + network_interfaces):
--   DELETE FROM `devices` WHERE device_id = <id>;
