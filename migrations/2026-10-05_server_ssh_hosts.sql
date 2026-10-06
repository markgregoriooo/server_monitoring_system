-- ─────────────────────────────────────────────────────────────────────────────
--  Server Console: pinned SSH host keys.
--
--  The Server Console (Quick Actions + Web Terminal) logs in to a monitored server over
--  SSH with a password an admin types. Without checking the server's host key, anything
--  able to answer on that IP could pose as the server and collect that password. So the
--  key seen on the FIRST successful login is saved here (trust on first use, the same
--  model as OpenSSH's known_hosts) and every later login must present the same one.
--  A changed key is refused; an admin clears the row from the console when the change
--  is expected (OS reinstall). Passwords are never stored — this table holds no secret.
--
--  Cascades with the server: removing a server forgets its key.
--  Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `server_ssh_hosts` (
  `device_id` int(11) NOT NULL,
  -- OpenSSH-style "SHA256:<base64>", the same string `ssh-keygen -lf` prints, so an admin
  -- can compare it against the server by hand.
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
