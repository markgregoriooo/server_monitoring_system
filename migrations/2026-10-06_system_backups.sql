-- Backups module: one row per weekly/manual system backup (encrypted archive).
-- The row is kept after the file is purged. Safe to re-run.

CREATE TABLE IF NOT EXISTS `system_backups` (
  `backup_id` int(11) NOT NULL AUTO_INCREMENT,
  `kind` enum('weekly','manual') NOT NULL,
  `status` enum('running','ok','failed') NOT NULL DEFAULT 'running',
  `file_name` varchar(120) DEFAULT NULL,
  `week_label` varchar(10) DEFAULT NULL,
  `scheduled_for` datetime DEFAULT NULL,
  `coverage_from` date DEFAULT NULL,
  `coverage_to` date DEFAULT NULL,
  `size_bytes` bigint(20) UNSIGNED DEFAULT NULL,
  `sha256` char(64) DEFAULT NULL,
  `key_id` char(12) DEFAULT NULL,
  `db_bytes` bigint(20) UNSIGNED DEFAULT NULL,
  `data_files` int(11) DEFAULT NULL,
  `data_bytes` bigint(20) UNSIGNED DEFAULT NULL,
  `error` text DEFAULT NULL,
  `started_at` datetime NOT NULL,
  `finished_at` datetime DEFAULT NULL,
  `verified_at` datetime DEFAULT NULL,
  `verify_status` enum('ok','mismatch','missing','undecryptable') DEFAULT NULL,
  `purged_at` datetime DEFAULT NULL,
  `created_by` int(11) DEFAULT NULL,
  PRIMARY KEY (`backup_id`),
  KEY `idx_system_backups_started` (`started_at`),
  KEY `idx_system_backups_slot` (`kind`, `scheduled_for`),
  KEY `fk_system_backups_user` (`created_by`),
  CONSTRAINT `fk_system_backups_user` FOREIGN KEY (`created_by`) REFERENCES `users` (`user_id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

ALTER TABLE `system_logs`
  MODIFY COLUMN `module`
  ENUM('auth','aircon','users','alerts','reports','devices','network','backups')
  DEFAULT NULL;

ALTER TABLE `reports`
  MODIFY COLUMN `type`
  ENUM('environment','server','alerts','aircon','network','ups','forecast','backup')
  DEFAULT NULL;
