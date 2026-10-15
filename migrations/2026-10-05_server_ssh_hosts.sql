-- Server Console: SSH host key pinned on first login; a changed key is refused.
-- No passwords stored. Safe to re-run.

CREATE TABLE IF NOT EXISTS `server_ssh_hosts` (
  `device_id` int(11) NOT NULL,
  `fingerprint` varchar(100) NOT NULL,
  `key_type` varchar(40) DEFAULT NULL,
  `pinned_by` int(11) DEFAULT NULL,
  `first_seen` timestamp NOT NULL DEFAULT current_timestamp(),
  `last_seen` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`device_id`),
  KEY `fk_server_ssh_hosts_user` (`pinned_by`),
  CONSTRAINT `fk_server_ssh_hosts_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_server_ssh_hosts_user` FOREIGN KEY (`pinned_by`) REFERENCES `users` (`user_id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
