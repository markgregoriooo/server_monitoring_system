-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: make (device_id, interface_name) unique on `network_interfaces`
-- Date: 2026-08-04   Branch: router-ups-monitoring
--
-- Run in phpMyAdmin (select your DB → SQL → paste → Go).
--
-- WHY:
--  `network_interfaces` holds the friendly per-port labels the Network pages show
--  ("ether1" → "Uplink to admin building"). Until now NOTHING in the application
--  ever wrote to it — the only INSERTs were the dev-snmpsim seed and a commented-out
--  line in the 2026-06-12 device template — so `location_label` was permanently
--  blank for any router registered from the dashboard, even though the label
--  plumbing runs end-to-end (loadInterfaceLabels → sample → Influx tag → the UI).
--
--  The SNMP poller now UPSERTS each interface it discovers, and an admin can name
--  them from the router's detail page (PATCH /api/network/:id/interfaces). Both
--  need one row per (device, interface) — this key is what makes the upsert atomic
--  via ON DUPLICATE KEY UPDATE, and what stops a re-poll from appending a new row
--  every cycle.
--
-- SAFETY:
--  Additive only. Verify there is nothing to collide with first:
--      SELECT device_id, interface_name, COUNT(*) c FROM network_interfaces
--       GROUP BY device_id, interface_name HAVING c > 1;
--  That must return zero rows (it did on the dev DB). If it does not, keep the
--  lowest id per group and delete the rest before running this.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE `network_interfaces`
  ADD UNIQUE KEY `uq_network_interfaces_device_iface` (`device_id`, `interface_name`);
