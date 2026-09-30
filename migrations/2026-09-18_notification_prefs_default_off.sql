-- Alert email is off by default for new accounts, and for accounts nobody has signed in to.
--
-- ── The problem ─────────────────────────────────────────────────────────────────────
-- raiseAlert picks recipients with COALESCE(p.email_enabled, 1) ... LEFT JOIN
-- notification_prefs p, and a new account has no notification_prefs row until someone
-- saves the Settings page. So a newly approved account got critical alert emails before
-- its owner had signed in or seen the Privacy Notice (RA 10173, see privacy-policy.md).
--
-- ── The backfill ─────────────────────────────────────
-- Every existing user gets an explicit row, so nobody's current setup changes:
--   * signed in at least once  -> email_enabled = 1 (what they have been getting)
--   * never signed in          -> email_enabled = 0
-- last_login is only written by authService.issueSession, so NULL means never used.
-- Pending accounts get a row too (email off). New accounts get their row from
-- userService.registerGoogleUser.
--
-- Safe to re-run. No semicolons inside string literals: some clients (phpMyAdmin, GUI
-- runners) split on ';' without parsing quotes.

-- 1) Record what every EXISTING user has been getting, before the default changes.
INSERT INTO `notification_prefs` (`user_id`, `email_enabled`, `popup_enabled`, `min_email_severity`)
SELECT u.`user_id`,
       IF(u.`last_login` IS NULL, 0, 1),
       1,
       'critical'
  FROM `users` u
  LEFT JOIN `notification_prefs` p ON p.`user_id` = u.`user_id`
 WHERE p.`user_id` IS NULL;

-- 2) New rows default to off, matching notificationService.PREF_DEFAULTS. Only matters
--    for rows inserted by hand.
ALTER TABLE `notification_prefs`
  MODIFY `email_enabled` tinyint(4) NOT NULL DEFAULT 0
  COMMENT 'Alert email opt-IN. Off by default: a new account must not be mailed before its owner has signed in and accepted the Privacy Notice.';

-- `popup_enabled` stays 1: it only fires in a browser the user has already signed in to.
