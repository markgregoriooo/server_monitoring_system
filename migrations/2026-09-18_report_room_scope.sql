-- Report scope: "the server room" as well as "one device".
--
-- Environment alerts have device_id NULL (the ESP32 has no devices row), and
-- reports.device_id is a foreign key to devices, so no id can mean "the room". A
-- separate column does:
--
--   scope_kind NULL    → campus-wide (unchanged default)
--   scope_kind 'room'  → room-level only, i.e. alerts with device_id IS NULL
--
-- device_id and scope_kind are never both set.
--
-- Safe to re-run (the ADD COLUMN is guarded, since not every MariaDB version has ADD
-- COLUMN IF NOT EXISTS). No semicolons inside string literals: some clients split on ';'.

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
