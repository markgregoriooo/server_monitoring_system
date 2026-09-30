-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: admin-set server display name
-- Date: 2026-06-18
--
-- Run once in phpMyAdmin (select the DB → SQL → paste → Go).
--
-- A server's name comes from its hostname at enrollment (devices.device_name), and
-- several machines can share one (e.g. "localhost"). This adds an optional label.
--
--   device_name  = the hostname reported by the agent (never overwritten)
--   display_name = the admin's label (NULL = use the hostname)
--   Shown name   = COALESCE(NULLIF(display_name,''), device_name)
-- Kept across re-registration (refreshHostInfo does not touch it). Admin-only.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE `devices`
  ADD COLUMN `display_name` VARCHAR(100) NULL DEFAULT NULL AFTER `device_name`;
