-- Environment node maintenance windows: room alerts and auto-cooling paused while open.
-- Every window closes itself at ends_at. Safe to re-run.

CREATE TABLE IF NOT EXISTS `environment_maintenance` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `started_at` datetime NOT NULL,
  `ends_at` datetime NOT NULL,
  `ended_at` datetime DEFAULT NULL,
  `end_reason` enum('resumed','expired') DEFAULT NULL,
  `note` varchar(200) DEFAULT NULL,
  `started_by` int(11) DEFAULT NULL,
  `ended_by` int(11) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_environment_maintenance_open` (`ended_at`),
  KEY `fk_environment_maintenance_started_by` (`started_by`),
  KEY `fk_environment_maintenance_ended_by` (`ended_by`),
  CONSTRAINT `fk_environment_maintenance_started_by` FOREIGN KEY (`started_by`) REFERENCES `users` (`user_id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_environment_maintenance_ended_by` FOREIGN KEY (`ended_by`) REFERENCES `users` (`user_id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;
