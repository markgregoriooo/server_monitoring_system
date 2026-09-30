-- Report template: paper size, reference number, and an uploadable letterhead logo.
--
-- Also included in v13_cspc-ictu-monitoring-system.sql. Only run this on a database
-- created before 2026-08-28.
--
-- Paper size and reference number are columns on each report (not only settings) because
-- they are fixed when the report is generated: changing the default later must not change
-- what past reports say, and a filed number must never change.
-- See reports-client-questionnaire.md for ICTU's answers.

-- ── Paper size ───────────────────────────────────────────────────────────────
-- ICTU: "Dynamic (long - default)". Chosen per report; the default is long bond / Folio
-- (8.5x13in), what CSPC prints on. Existing rows get the default (their stored PDFs are
-- still A4).
ALTER TABLE `reports`
  ADD COLUMN `paper_size` ENUM('a4','letter','folio') NOT NULL DEFAULT 'folio'
    COMMENT 'Page size the PDF was rendered at; folio = long bond, 8.5x13in'
    AFTER `type`;

-- ── Reference / control number ───────────────────────────────────────────────
-- ICTU: "Advisable to have." Format from their sample: ICTU-ENV-2026-001. Nullable because
-- it is assigned during build(), and a failed build should not use up a number. UNIQUE so
-- a number can never repeat.
ALTER TABLE `reports`
  ADD COLUMN `reference_no` VARCHAR(40) DEFAULT NULL
    COMMENT 'Assigned at build time, e.g. ICTU-SRV-2026-001. NULL until generated.'
    AFTER `paper_size`,
  ADD UNIQUE KEY `uq_reports_reference` (`reference_no`);

-- ── Template settings ────────────────────────────────────────────────────────
-- The first rows in the `settings` table (key/value). `report.logo_ictu` holds a file name
-- under backend/branding/, not the image, so images are not copied into every nightly
-- database dump.
INSERT INTO `settings` (`setting_key`, `setting_value`, `description`) VALUES
  ('report.paper_size', 'folio',
   'Default page size for generated PDF reports: a4 | letter | folio (long bond).'),
  ('report.logo_ictu', '',
   'Filename under backend/branding/ of the ICTU letterhead mark. Blank = use the bundled assets/branding/ictu-logo.jpg.'),
  ('report.logo_cspc', '',
   'Filename under backend/branding/ of the CSPC seal. Blank = use the bundled assets/branding/cspc-logo.png.')
ON DUPLICATE KEY UPDATE `setting_key` = `setting_key`;

-- ── Letterhead unit line ──────────────────────────
-- The large bold line (on CSPC stationery, "COLLEGE of COMPUTER STUDIES"). Blank = the
-- code default (INFORMATION AND COMMUNICATIONS TECHNOLOGY UNIT).
INSERT INTO `settings` (`setting_key`, `setting_value`, `description`) VALUES
  ('report.unit_name', '',
   'Large line on the report letterhead. Blank = INFORMATION AND COMMUNICATIONS TECHNOLOGY UNIT.')
ON DUPLICATE KEY UPDATE `setting_key` = `setting_key`;

-- ── Signature block ───────────────────────────────
-- ICTU confirmed Prepared by / Noted by / Approved by and asked for it to be
-- configurable. Stored as JSON in one settings row (a short list, edited as a whole).
-- `auto` means "fill with whoever generated the report".
INSERT INTO `settings` (`setting_key`, `setting_value`, `description`) VALUES
  ('report.signatories',
   '[{"role":"Prepared by:","name":"","auto":true},{"role":"Approved by:","name":"","auto":false}]',
   'Report signature block as JSON: [{role,name,auto}]. auto = fill with the report generator.')
ON DUPLICATE KEY UPDATE `setting_key` = `setting_key`;
