-- ─────────────────────────────────────────────────────────────────────────────
--  Server Console: per-server SSH address (admin override).
--
--  The console connects to the IP the Go agent reports (devices.ip_address). That is
--  the IP of the interface holding the default route, which is not always where SSH
--  can be reached from the monitoring server:
--    - a VirtualBox VM on NAT reports 10.0.2.15, which nothing outside the VM can reach,
--      even when a second (host-only / bridged) adapter carries SSH;
--    - a server with a separate management network listens for SSH on that one.
--  devices.ip_address cannot simply be edited: the agent rewrites it on every host
--  refresh. So the override lives here, set by an admin from the Console tab, and is
--  used ONLY by the console. NULL row / no row = use the agent's IP.
--
--  Cascades with the server. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `server_console_settings` (
  `device_id` int(11) NOT NULL,
  -- IPv4, IPv6 or a hostname (validated by consoleCommands.isValidSshHost).
  `ssh_host` varchar(255) DEFAULT NULL,
  -- NULL = 22.
  `ssh_port` smallint(5) UNSIGNED DEFAULT NULL,
  `updated_by` int(11) DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`device_id`),
  KEY `fk_server_console_settings_user` (`updated_by`),
  CONSTRAINT `fk_server_console_settings_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_server_console_settings_user` FOREIGN KEY (`updated_by`) REFERENCES `users` (`user_id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
