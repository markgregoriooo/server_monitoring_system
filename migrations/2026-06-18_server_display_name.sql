-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: admin-settable server DISPLAY NAME (friendly label / rename)
-- Date: 2026-06-18   Branch: pip-widget
--
-- Run ONCE in phpMyAdmin (select your DB → SQL → paste → Go).
--
-- WHY:
--   A server's name is taken from its hostname at agent enrollment
--   (devices.device_name). Several boxes in one rack can share a hostname
--   (e.g. "unknown-server" / "localhost"), making them hard to tell apart on the
--   dashboard. This adds an OPTIONAL admin-set label, separate from the hostname.
--
-- MODEL:
--   device_name  = the real hostname reported by the agent (kept intact, never
--                  overwritten — still shown for technical reference).
--   display_name = the admin's friendly label (NULL = none → fall back to hostname).
--   Effective name everywhere = COALESCE(NULLIF(display_name,''), device_name).
--   Survives re-registration (refreshHostInfo never touches it). Admin-only.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE `devices`
  ADD COLUMN `display_name` VARCHAR(100) NULL DEFAULT NULL AFTER `device_name`;
