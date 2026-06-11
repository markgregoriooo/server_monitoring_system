-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: Google OAuth (Sign in with Google) + self-register / admin approval
-- Date: 2026-06-09   Branch: google-oauth
--
-- Run this ONCE against your monitoring database (the one named in backend/.env
-- DB_NAME). In MySQL Workbench: open this file → set the schema as the default
-- (USE ...) → Execute. It is safe to run on the existing `users` table.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Schema changes on `users`
--    - hash_password becomes NULLABLE  (Google users have no in-app password)
--    - status gains 'pending' + 'rejected' (registration workflow), default 'pending'
--    - google_sub: the stable Google account id (sub claim)
--    - auth_provider: how the account authenticates
ALTER TABLE `users`
  MODIFY `hash_password` VARCHAR(255) NULL,
  MODIFY `status` ENUM('pending','active','inactive','rejected') NULL DEFAULT 'pending',
  ADD COLUMN `google_sub`    VARCHAR(64) NULL AFTER `email`,
  ADD COLUMN `auth_provider` ENUM('local','google') NOT NULL DEFAULT 'google' AFTER `google_sub`,
  ADD UNIQUE INDEX `idx_users_google_sub` (`google_sub` ASC);

-- 2) Bootstrap the FIRST admin so it can sign in with Google immediately.
--    Google matches accounts by EMAIL, so this row's email MUST equal the exact
--    CSPC Google address you sign in with. EDIT the email below to yours, then run.
--
--    If your existing admin row already uses your CSPC email, this just flips it
--    active. If it uses some other email, this also corrects it to your CSPC one.
UPDATE `users`
   SET `email`         = 'REPLACE_WITH_YOUR_ADMIN@my.cspc.edu.ph',
       `status`        = 'active',
       `role`          = 'admin',
       `auth_provider` = 'google'
 WHERE `role` = 'admin'
 LIMIT 1;

-- (If you have NO admin row yet, insert one instead — uncomment & edit:)
-- INSERT INTO `users` (name, username, email, role, status, auth_provider, avatar, created_at)
-- VALUES ('System Admin', 'admin', 'REPLACE_WITH_YOUR_ADMIN@my.cspc.edu.ph',
--         'admin', 'active', 'google', 'SA', NOW());
