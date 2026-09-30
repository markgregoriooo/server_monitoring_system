-- Per-user layout for the pop-out (PiP) live widget.
--
-- The widget shows tiles the user picks and orders in Settings → Customize Widget,
-- stored as an ordered JSON list of tile ids (e.g. ["env.temp","alerts.count",...]).
-- One row per user; no row means the default layout
-- (widgetPrefsService.DEFAULT_LAYOUT). The server checks ids against its allow-list
-- on write.

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
