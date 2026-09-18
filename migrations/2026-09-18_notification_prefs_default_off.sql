-- Alert EMAIL is off by default for a new account, and an account nobody has ever
-- signed in to goes quiet.
--
-- ── What went wrong ─────────────────────────────────────────────────────────────────────
-- `notificationService.raiseAlert` picks its recipients with
--
--     COALESCE(p.email_enabled, 1) ... LEFT JOIN notification_prefs p
--
-- and a freshly approved account has NO `notification_prefs` row, because nothing has
-- ever written one — `savePrefs` is the only writer and it runs when somebody presses
-- Save on the Settings page. So the fallback decided the email channel, and the fallback
-- was ON.
--
-- Registration itself was never the trigger: the fan-out is `WHERE u.status = 'active'`
-- and a self-registration lands `pending`. APPROVAL is what starts the mail. The effect
-- is that the first thing a newly approved staff member receives from this system is a
-- critical alert email about a server room they have not yet seen a dashboard for — and
-- they cannot turn it off without signing in, because the toggle is behind the login.
--
-- It is also a consent problem. Somebody who has never signed in has never been shown
-- the Privacy Notice (`users.policy_version IS NULL`), so their address was being used
-- for a purpose they were never asked about. RA 10173. See privacy-policy.md.
--
-- ── Why a backfill, and why it splits on last_login ─────────────────────────────────────
-- Flipping the fallback to 0 on its own would silently mute every existing user, since
-- none of them has a row either. A monitoring system getting quieter with nobody asking
-- is the worse bug. So every existing user gets an EXPLICIT row that records what they
-- have been getting until now, and the split is `last_login`:
--
--   * signed in at least once  -> email_enabled = 1. They have been receiving these
--     alerts, they have seen the toggle, and this migration must not change their setup.
--   * never signed in          -> email_enabled = 0. This is the reported bug. Nobody
--     has ever used the account, so nothing is being taken away from anyone.
--
-- `last_login` is written by `authService.issueSession` on every successful sign-in and
-- by nothing else, so NULL is a reliable "never used this account".
--
-- Status is deliberately NOT part of the rule. A pending account gets a row too, with
-- email off, so the day an admin approves it the decision is already recorded rather
-- than being taken by whatever the fallback happens to be.
--
-- After this runs, the fallback applies only to accounts created later, and
-- `userService.registerGoogleUser` seeds those a row of their own.
--
-- Safe to re-run: the INSERT skips users who already have a row, and re-declaring the
-- column default is a no-op.
--
-- No semicolon appears inside any string literal here, deliberately: plenty of clients
-- (phpMyAdmin, GUI runners, a naive script) split a file on ';' without parsing quotes,
-- and one inside a COMMENT chops the statement in half.

-- 1) Record what every EXISTING user has been getting, before the default changes.
INSERT INTO `notification_prefs` (`user_id`, `email_enabled`, `popup_enabled`, `min_email_severity`)
SELECT u.`user_id`,
       IF(u.`last_login` IS NULL, 0, 1),
       1,
       'critical'
  FROM `users` u
  LEFT JOIN `notification_prefs` p ON p.`user_id` = u.`user_id`
 WHERE p.`user_id` IS NULL;

-- 2) New rows default to silent. Belt and braces with the code default in
--    notificationService.PREF_DEFAULTS — the seed INSERT names the value explicitly, so
--    this matters only for a row somebody inserts by hand.
ALTER TABLE `notification_prefs`
  MODIFY `email_enabled` tinyint(4) NOT NULL DEFAULT 0
  COMMENT 'Alert email opt-IN. Off by default: a new account must not be mailed before its owner has signed in and accepted the Privacy Notice.';

-- `popup_enabled` keeps its default of 1. It is an in-app control with no consent
-- question attached, and it only ever fires in a browser somebody has already signed in
-- to and left open.
