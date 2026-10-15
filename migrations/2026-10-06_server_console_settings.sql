-- Server Console: admin-set SSH address when the agent's IP is unreachable (e.g. a NAT VM).
-- No row = use devices.ip_address. Safe to re-run.

CREATE TABLE IF NOT EXISTS `server_console_settings` (
  `device_id` int(11) NOT NULL,
  `ssh_host` varchar(255) DEFAULT NULL,
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
