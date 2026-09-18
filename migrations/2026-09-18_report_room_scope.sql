-- Report scope: "the server room" as a target, alongside "one device".
--
-- Alert History already COVERS environment alerts when unscoped — they are ordinary
-- `alerts` rows with `device_id IS NULL`, because the ESP32 is not a `devices` row
-- (handlers/sensorHandler.js: "ESP32 isn't a devices row — this is a room-level alert").
-- What was impossible was asking for ONLY those. `reports.device_id` is the sole scope
-- column and it carries a foreign key to `devices`, so there is no id that means "the
-- room" and no sentinel value that would survive the constraint.
--
-- Hence a second, orthogonal column. NULL keeps its existing meaning — the whole campus —
-- so every report ever generated reads exactly as it did before this ran.
--
--   scope_kind NULL    → campus-wide (unchanged default)
--   scope_kind 'room'  → room-level only, i.e. alerts with device_id IS NULL
--
-- `device_id` and `scope_kind` are never both set: a device scope leaves this NULL.
--
-- Safe to re-run: the ADD COLUMN is guarded, since MariaDB has no ADD COLUMN IF NOT EXISTS
-- in every version ICTU might be on.
--
-- No semicolon appears inside any string literal here, deliberately: plenty of clients
-- (phpMyAdmin, GUI runners, a naive script) split a file on ';' without parsing quotes,
-- and one inside the COMMENT text chops the ALTER in half.

SET @col := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'reports'
     AND COLUMN_NAME  = 'scope_kind'
);
SET @sql := IF(@col = 0,
  "ALTER TABLE `reports`
     ADD COLUMN `scope_kind` VARCHAR(16) NULL DEFAULT NULL
     COMMENT 'NULL = campus-wide, ''room'' = room-level alerts only (device_id IS NULL)'
     AFTER `device_id`",
  "SELECT 'reports.scope_kind already present' AS note"
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
