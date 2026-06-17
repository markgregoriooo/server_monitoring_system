-- Per-user customizable PiP (pop-out) live-widget layout.
--
-- The dashboard's floating Picture-in-Picture widget shows a set of "tiles" the user
-- picks and orders in the Settings → Customize Widget builder. The layout is just an
-- ordered list of tile ids (e.g. ["env.temp","alerts.count",...]) stored as JSON.
--
-- One row per user; a missing row means "use the default layout", which the backend
-- supplies (widgetPrefsService.DEFAULT_LAYOUT). Mirrors notification_prefs. The server
-- validates ids against its allow-list on write, so unknown/edited ids never persist.

CREATE TABLE IF NOT EXISTS `widget_prefs` (
  `user_id`     INT NOT NULL,
  `layout_json` JSON NOT NULL,
  `updated_at`  TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `fk_widget_prefs_users1`
    FOREIGN KEY (`user_id`)
    REFERENCES `users` (`user_id`)
    ON DELETE CASCADE
    ON UPDATE CASCADE)
ENGINE = InnoDB;
