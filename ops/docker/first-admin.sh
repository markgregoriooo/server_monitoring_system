#!/bin/bash
# ============================================================================
#  First admin — seeded ONCE, when the MariaDB volume is created.
# ----------------------------------------------------------------------------
#  Mounted into /docker-entrypoint-initdb.d/ as 02-first-admin.sh, so it runs
#  right after 01-schema.sql (v13) on the very first `docker compose up`, and
#  never again. An existing database is never touched.
#
#  Why it exists: sign-in is Google-only and self-register → admin-approve, and
#  v13 seeds no admin. On a fresh install the first sign-in lands `pending` with
#  nobody able to approve it (deployment-guide.md §4.3). This pre-creates that
#  admin from FIRST_ADMIN_EMAIL in the root .env instead.
#
#  There is NO PASSWORD, by design — there is no password login to use one with.
#  The row is an email that is allowed in as an active admin. On its first
#  Google sign-in, googleAuthService matches it by email (google_sub is still
#  NULL), links the Google account id, and syncs the real name and photo.
#
#  ⚠️ The entrypoint SOURCES a non-executable .sh file into its own shell, so
#  this script must never `exit` or `set -e` — either would take the database's
#  first-run setup down with it. Everything below is if/else.
# ============================================================================

first_admin_email="$(printf '%s' "${FIRST_ADMIN_EMAIL:-}" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"

if [ -z "$first_admin_email" ]; then
  echo "[first-admin] FIRST_ADMIN_EMAIL is blank — no admin seeded. Promote the first sign-in by hand (deployment-guide.md §4.3)."
# Strict shape check. The value is interpolated into SQL below, so this is also
# what keeps a quote or semicolon in .env from becoming part of a statement.
elif ! printf '%s' "$first_admin_email" | grep -Eq '^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$'; then
  echo "[first-admin] FIRST_ADMIN_EMAIL='$first_admin_email' is not a valid address — no admin seeded." >&2
else
  local_part="${first_admin_email%@*}"
  # Same rule as userService.registerGoogleUser. The table is empty, so no
  # de-duplication is needed.
  admin_username="$(printf '%s' "$local_part" | sed 's/[^a-z0-9._-]//g' | cut -c1-40)"
  [ -n "$admin_username" ] || admin_username="admin"

  mariadb --protocol=socket -uroot -p"${MARIADB_ROOT_PASSWORD}" "${MARIADB_DATABASE}" <<SQL
INSERT INTO users (name, username, email, auth_provider, role, status, avatar, created_at)
VALUES ('${local_part}', '${admin_username}', '${first_admin_email}', 'google', 'admin', 'active', 'AD', NOW());

SET @admin_id = LAST_INSERT_ID();

-- Same as every self-registered account: alert email is opt-in, so it starts
-- OFF and the admin turns it on in Settings once they have signed in.
INSERT INTO notification_prefs (user_id, email_enabled, popup_enabled)
VALUES (@admin_id, 0, 1);

-- The History page should be able to say where this account came from, since
-- no admin approved it.
INSERT INTO system_logs (user_id, module, action, description, log_level, created_at)
VALUES (@admin_id, 'users', 'bootstrap_admin',
        'First admin ${first_admin_email} created by the Docker first-run seed (FIRST_ADMIN_EMAIL)',
        'info', NOW());
SQL

  if [ $? -eq 0 ]; then
    echo "[first-admin] Seeded ${first_admin_email} as an active admin. Sign in with that Google account."
  else
    echo "[first-admin] FAILED to seed ${first_admin_email} — promote the first sign-in by hand (deployment-guide.md §4.3)." >&2
  fi
fi
