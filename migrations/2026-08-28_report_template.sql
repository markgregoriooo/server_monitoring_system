-- Report template: paper size, reference number, and an ICTU-uploadable letterhead logo.
--
-- ⚠️ Also folded into v13_cspc-ictu-monitoring-system.sql. Run this ONLY on a database
-- created before 2026-08-28.
--
-- WHY THESE ARE COLUMNS AND NOT JUST SETTINGS.
--
-- `settings` holds the DEFAULTS an admin picks once. These two columns hold what a
-- SPECIFIC report was actually built with, and they are frozen at generate time for the
-- same reason reportService freezes the data itself: the CSV and PDF on disk are the
-- artifact. If paper size lived only in `settings`, changing the default would make every
-- past report's stored PDF disagree with what the Reports page claims it is — and a
-- reference number that recomputed on read would renumber documents ICTU had already
-- filed under the old number.
--
-- See reports-client-questionnaire.md for ICTU's answers driving this.

-- ── Paper size ───────────────────────────────────────────────────────────────
-- ICTU: "Dynamic (long - default)" — the admin picks per report, and the default is
-- Long/Folio (8.5x13in), which is what CSPC prints on. NOT A4, which is what the code
-- shipped with. Existing rows take the default so nothing is left NULL; their stored PDFs
-- are still the A4 files they were built as, and the column is honest about the intent
-- going forward rather than retro-claiming a size those files do not have.
ALTER TABLE `reports`
  ADD COLUMN `paper_size` ENUM('a4','letter','folio') NOT NULL DEFAULT 'folio'
    COMMENT 'Page size the PDF was rendered at; folio = long bond, 8.5x13in'
    AFTER `type`;

-- ── Reference / control number ───────────────────────────────────────────────
-- ICTU: "Advisable to have." Shape follows their own sample, ICTU-ENV-2026-001.
--
-- Nullable because it is assigned during build(), not at insert: a `pending` row has no
-- number yet, and a report that FAILS to build should not consume one — a gap in a filing
-- sequence is a question somebody has to answer.
--
-- UNIQUE, because a control number that can repeat is not a control number. The sequence
-- is derived per (type, year) in reportService, so a collision would mean a bug rather
-- than ordinary contention, and it should surface as one.
ALTER TABLE `reports`
  ADD COLUMN `reference_no` VARCHAR(40) DEFAULT NULL
    COMMENT 'Assigned at build time, e.g. ICTU-SRV-2026-001. NULL until generated.'
    AFTER `paper_size`,
  ADD UNIQUE KEY `uq_reports_reference` (`reference_no`);

-- ── Template settings ────────────────────────────────────────────────────────
-- The `settings` table has existed since v13 and has never held a row. These are its
-- first, and they are deliberately generic key/value rather than new columns somewhere:
-- report branding is admin-tunable presentation, not schema.
--
-- `report.logo_ictu` holds a FILENAME under backend/branding/, not the image. Storing an
-- image in a TEXT column would put it in every mysqldump — ops/db-backup/dump-mysql.sh
-- runs nightly and ops/offsite-backup/sync-offsite.sh copies that offsite — which is a
-- lot of bytes crossing a wire every night for a picture that changes once a year.
INSERT INTO `settings` (`setting_key`, `setting_value`, `description`) VALUES
  ('report.paper_size', 'folio',
   'Default page size for generated PDF reports: a4 | letter | folio (long bond).'),
  ('report.logo_ictu', '',
   'Filename under backend/branding/ of the ICTU letterhead mark. Blank = use the bundled assets/branding/ictu-logo.jpg.'),
  ('report.logo_cspc', '',
   'Filename under backend/branding/ of the CSPC seal. Blank = use the bundled assets/branding/cspc-logo.png.')
ON DUPLICATE KEY UPDATE `setting_key` = `setting_key`;

-- ── Letterhead unit line (added later the same day) ──────────────────────────
-- The large bold line where CSPC's own stationery reads "COLLEGE of COMPUTER STUDIES".
-- Configurable because the sample ICTU supplied names a different unit to the one
-- filing these reports, and whoever files them next may be a third. Blank = the code
-- default (INFORMATION AND COMMUNICATIONS TECHNOLOGY UNIT).
INSERT INTO `settings` (`setting_key`, `setting_value`, `description`) VALUES
  ('report.unit_name', '',
   'Large line on the report letterhead. Blank = INFORMATION AND COMMUNICATIONS TECHNOLOGY UNIT.')
ON DUPLICATE KEY UPDATE `setting_key` = `setting_key`;

-- ── Signature block (added later the same day) ───────────────────────────────
-- ICTU confirmed Prepared by / Noted by / Approved by, then asked for the block to be
-- CONFIGURABLE — how many lines and whose names. Stored as JSON in one settings row
-- rather than as a table: it is a short ordered list, edited whole, never queried by
-- part. `auto` means "fill with whoever generated the report".
INSERT INTO `settings` (`setting_key`, `setting_value`, `description`) VALUES
  ('report.signatories',
   '[{"role":"Prepared by:","name":"","auto":true},{"role":"Approved by:","name":"","auto":false}]',
   'Report signature block as JSON: [{role,name,auto}]. auto = fill with the report generator.')
ON DUPLICATE KEY UPDATE `setting_key` = `setting_key`;
