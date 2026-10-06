-- ─────────────────────────────────────────────────────────────────────────────
--  Backups module (pre-oral panel RSC #2: "Integrate a backup server module to
--  manage and secure system backups. FOD: present the system weekly backup").
--
--  One row per backup RUN of the monitoring system itself — the weekly job
--  (Sunday 02:00 Philippine time by default) and the admin's "Back up now". Each
--  successful run is ONE encrypted archive in <BACKUP_DIR>/weekly/: the full MySQL
--  dump + that week's NDJSON data files + a manifest of their SHA-256 sums.
--  See services/systemBackupService.js.
--
--  The row OUTLIVES its file: retention deletes archives older than the configured
--  number of weeks (default 12) and stamps `purged_at` rather than deleting the row,
--  so the Backups page and the backup report can still say "W30 was taken, verified,
--  and aged out" — that history is what the panel asked to see.
--
--  Also widens reports.type for the new "backup" report.
--
--  Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `system_backups` (
  `backup_id` int(11) NOT NULL AUTO_INCREMENT,
  `kind` enum('weekly','manual') NOT NULL,
  `status` enum('running','ok','failed') NOT NULL DEFAULT 'running',
  -- The archive's name inside <BACKUP_DIR>/weekly/. Never a path: downloads re-check it
  -- against backupSchedule.ARCHIVE_NAME_RE before touching the disk.
  `file_name` varchar(120) DEFAULT NULL,
  -- ISO week of the run, read in Manila: "2026-W41".
  `week_label` varchar(10) DEFAULT NULL,
  -- The schedule slot a weekly run was FOR (NULL for manual). What lets a run missed
  -- while the backend was down be caught up exactly once on the next start.
  `scheduled_for` datetime DEFAULT NULL,
  -- The seven whole days of data files inside the archive (inclusive, Manila dates).
  `coverage_from` date DEFAULT NULL,
  `coverage_to` date DEFAULT NULL,
  `size_bytes` bigint(20) UNSIGNED DEFAULT NULL,
  -- SHA-256 of the encrypted archive as written. "Verify" recomputes it.
  `sha256` char(64) DEFAULT NULL,
  -- Which key encrypted it (first 6 bytes of SHA-256(key), hex). Not secret.
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
  -- NULL for the scheduled job.
  `created_by` int(11) DEFAULT NULL,
  PRIMARY KEY (`backup_id`),
  KEY `idx_system_backups_started` (`started_at`),
  KEY `idx_system_backups_slot` (`kind`, `scheduled_for`),
  KEY `fk_system_backups_user` (`created_by`),
  CONSTRAINT `fk_system_backups_user` FOREIGN KEY (`created_by`) REFERENCES `users` (`user_id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- History (system_logs) gets its own "Backups" category: running, verifying and
-- especially DOWNLOADING a backup (the whole database leaving the server) is audited.
ALTER TABLE `system_logs`
  MODIFY COLUMN `module`
  ENUM('auth','aircon','users','alerts','reports','devices','network','backups')
  DEFAULT NULL;

ALTER TABLE `reports`
  MODIFY COLUMN `type`
  ENUM('environment','server','alerts','aircon','network','ups','forecast','backup')
  DEFAULT NULL;
