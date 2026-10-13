-- ─────────────────────────────────────────────────────────────────────────────
--  Environment node maintenance windows.
--
--  An admin puts the ESP32 environment node "in maintenance" from the Environment page
--  before unplugging it, opening the box or cleaning a sensor. While a window is open
--  the room-level alerts (environment sensor offline, temperature, humidity, smoke) are
--  not raised and auto-cooling is paused, because the readings are known to be wrong.
--  Live readings still show.
--
--  Every window has a fixed end (`ends_at`): the room has no smoke or heat alarm while
--  one is open, so it must close on its own if nobody presses Resume. `ended_at` is
--  when it actually closed — early (`resumed`) or at `ends_at` (`expired`).
--
--  A table and not a `settings` row because the windows are history: the Environment
--  report lists those that overlap its period, and History shows who opened them.
--
--  Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `environment_maintenance` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `started_at` datetime NOT NULL,
  -- Scheduled end. Extending a window moves this; it never stays open past it.
  `ends_at` datetime NOT NULL,
  -- NULL while the window is open.
  `ended_at` datetime DEFAULT NULL,
  `end_reason` enum('resumed','expired') DEFAULT NULL,
  -- What is being done, e.g. "replacing MQ-2 #2". Shown on the banner and in the report.
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
