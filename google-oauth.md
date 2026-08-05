# Google OAuth Login — CSPC-ICTU Monitoring

Sign in with Google (the **"CSPC Mail"** button) is the **only** way to log into the dashboard.
This document covers what it is, how it works, the one-time Google Cloud + database setup,
and how to test it. Branch: `google-oauth`.

> 📖 **Studying the code?** Read §1–§2 for the concept, then follow **§12 "Trace the code"**,
> which walks the files in the exact order a single login travels through them.

---

## 1. What it is (in one paragraph)

It's **OAuth 2.0 + OpenID Connect (OIDC)**. OAuth 2.0 is the authorization protocol; OIDC adds
the authentication layer that proves *who* the user is. The browser never sends a password to
our server — the password is entered only on Google's own page. After the user signs in, Google
hands the frontend a short-lived one-time **auth code**; our backend exchanges that code with
Google for an **ID token**, verifies it, and — for an approved CSPC user — issues the **same app
JWT** the rest of the system already uses. So Google is just a new way to *obtain* our session
token — everything downstream (`authMiddleware`, roles, socket auth, `token_version` revocation)
is unchanged.

> ⚠️ We must **never** collect a user's real Google password in our own form. That's why there
> is no email/password field — the password lives only on `accounts.google.com`.

### Why a custom button (and the authorization-code flow)

Google's *official* "Sign in with Google" button can only show Google's preset labels — it can't
say **"CSPC Mail"**. To get a custom label we use a **custom button** wired to the
`useGoogleLogin` hook with **`flow: "auth-code"`**. That returns a one-time **auth code**; the
backend exchanges it with Google (server-side, using the **client secret**) for an **ID token**
and verifies that locally with `verifyIdToken` — which also enforces the audience and hands back
`email`, `email_verified` (a real boolean), `name`, and `picture` in one shot, so there is **no
separate `tokeninfo` / `userinfo` call**.

> We used to use the **implicit** flow (returns an access token directly to the browser). It's now
> deprecated (OAuth 2.1 / RFC 9700), so we moved to auth-code — the current best practice. The cost
> is one extra config item: a **client secret** in `backend/.env`. No Google Console change is
> needed beyond copying that secret (the popup flow uses the magic `postmessage` redirect URI, so
> nothing goes in "Authorized redirect URIs").

---

## 2. The flow — one endpoint does register *and* login

The custom **CSPC Mail** button runs Google's authorization-code flow and gets a one-time
**auth code**. The frontend POSTs `{ code }` to `POST /api/auth/google`, which exchanges the code,
verifies the ID token, enforces the CSPC domain, then branches on the matched user's status:

| User (matched by email) | Result | HTTP |
|---|---|---|
| **doesn't exist** | create `users` row `status='pending'` (role placeholder `it_staff`, no password); emit `userPending` | `200 {status:"pending"}` — "Registration submitted, await approval" |
| **pending** | nothing | `403 {status:"pending"}` |
| **rejected** | nothing | `403 {status:"rejected"}` |
| **inactive** (disabled) | nothing | `403 {status:"disabled"}` |
| **active** | issue app JWT, update `last_login`, audit log | `200 {token, user}` — logged in |

`authMiddleware` requires `status='active'`, so pending/rejected/inactive accounts can never
hold a session even if they somehow obtained a token.

```
[ CSPC Mail ] button  → useGoogleLogin (auth-code) → Google AUTH CODE
        │  POST /api/auth/google  { code }
        ▼
googleAuthService.authenticate()
        │ 1. getToken(code)                            ← exchange w/ Google (client secret)
        │ 2. verifyIdToken(tokens.id_token, aud)       ← verify signature + audience locally
        │ 3. email_verified === true                   ← ID token gives a real boolean
        │ 4. domain ∈ {cspc.edu.ph, my.cspc.edu.ph}    ← exact match, not endsWith
        │ 5. name + photo come from the ID token       ← no extra /userinfo call
        │ 6. findByGoogleSub → else findByEmail        ← sub is stable, email is renameable
        │ 7. syncGoogleProfile()                       ← refresh name/photo every login
        │ 8. active? → issueSession() → app JWT
        │    none?   → registerGoogleUser() → pending
        │    else    → recordSignInDenied() + that status
        ▼
   admin approves (assign role) / rejects in User Management
```

---

## 3. One-time Google Cloud setup

1. **console.cloud.google.com** → create/select a project.
2. **Google Auth Platform** (under APIs & Services → OAuth consent screen):
   - **Branding** — app name + support email. (Note: a custom logo only appears on Google's
     consent screen **after** the app is published + verified; in Testing it's hidden.)
   - **Audience** — User type is **External** if the project isn't under the CSPC Google
     Workspace org (the dev case). Publishing status starts at **Testing**: only **Test users**
     you add can sign in. Add the CSPC accounts you'll log in with.
   - **Clients** → **Create client** → **Web application**. Authorized JavaScript origins =
     your dashboard URL(s). Copy **both** the **Client ID** (`…apps.googleusercontent.com`) and
     the **Client secret** (`GOCSPX-…`) immediately. (No "Authorized redirect URI" is needed —
     the popup auth-code flow uses the magic `postmessage` value.)

     > ⚠️ **Google accepts only `http://localhost` or an HTTPS origin here.** A raw
     > `http://192.168.x.x:5173` is **rejected** — you cannot simply "add the LAN origin".
     > So `http://localhost:5173` covers dev, but the on-prem deployment needs the dashboard
     > served over **HTTPS at a real hostname** before anyone on the LAN can sign in. This is a
     > deployment prerequisite, not a config step — see §10.
3. Put the Client ID in both env files (below), the Client secret in `backend/.env`, and restart
   the servers.

> ⚠️ **The Client secret is shown only once.** Google **no longer lets you view or download** an
> existing secret — the Clients page only shows the last 4 chars (e.g. `…X3N8`). If you didn't save
> it, click **"Add secret"** on the client to mint a **new** one (shown once); paste that into
> `backend/.env` and restart the backend. A Web client can hold multiple secrets, so the old one
> keeps working until you delete it — add first, swap `.env`, verify a login, then delete the old.
> Store the secret **only** in `backend/.env` (already git-ignored) — never commit it.

> **Internal vs External:** Internal (auto-restricts to the Workspace org, no user cap, no
> verification) is only available if the project is owned by the CSPC Workspace. Otherwise use
> External — our backend domain allow-list is the real gate anyway.

---

## 4. Environment variables

`backend/.env`:
```
GOOGLE_CLIENT_ID=<...>.apps.googleusercontent.com    # public; checked as the token audience
GOOGLE_CLIENT_SECRET=<...>                            # SECRET; used to exchange the auth code
GOOGLE_ALLOWED_DOMAINS=cspc.edu.ph,my.cspc.edu.ph    # unset OR blank = same default
```
Missing `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` is reported **at backend startup**
(`[CONFIG] Missing in backend/.env: …`) rather than only at the first sign-in; a missing
`VITE_GOOGLE_CLIENT_ID` logs the same way in the browser console.
`frontend/.env` (Vite reads `VITE_*` at startup — restart `npm run dev` after editing):
```
VITE_GOOGLE_CLIENT_ID=<...>.apps.googleusercontent.com   # SAME id as backend
```
The Client ID is **public** (it ships in the frontend bundle); the Client **secret** is not —
it lives only in `backend/.env` and never reaches the browser.

---

## 5. Database migration

Run **`migrations/2026-06-09_google_auth.sql`** once against the monitoring database. It:
- makes `users.hash_password` **NULLable** (Google users have no in-app password),
- expands `users.status` to `ENUM('pending','active','inactive','rejected')` default `pending`,
- adds `users.google_sub` (the Google account id) + `users.auth_provider`,
- **bootstraps the first admin** — an `UPDATE ... WHERE role='admin' LIMIT 1` that flips your
  existing admin `active` and sets its email. **Edit the email placeholder to your exact,
  lowercase CSPC Google address before running**, or the email won't match at sign-in.

Multiple admins are supported — the approval dialog can assign `admin`, and a promoted user
can approve others, so you are never locked into a single admin.

---

## 6. Backend files

| File | Role |
|---|---|
| `services/googleAuthService.js` | exchange the auth code (`getToken`), verify the ID token (`verifyIdToken` — audience enforced), enforce domain, read name/photo from the token, login-or-create-pending (`authenticate()`) |
| `services/googleDomain.js` | **pure, dependency-free** domain gate: `domainOf`, `parseAllowedDomains`, `isAllowedDomain`. The whole CSPC allow-list rule in one place |
| `services/authService.js` | `issueSession(user)` — builds/signs the JWT (shared); `recordSignInDenied()` — audits refused attempts; `getMe`, `logout` |
| `services/userService.js` | `findByGoogleSub`, `findByEmail`, `registerGoogleUser`, `linkGoogleSub`, `syncGoogleProfile`, `listPending`, `approveUser(role)`, `rejectUser` |
| `routes/auth.js` | `POST /api/auth/google` (only login route; body `{ code }`) + `googleLimiter`; `/me`, `/logout` |
| `routes/users.js` | `GET /users/pending`, `POST /users/:id/approve`, `POST /users/:id/reject` (admin) |
| `middleware/auth.js` | unchanged — already requires `status='active'` |

Dependency added: **`google-auth-library`**. The code exchange + ID-token verification need
`GOOGLE_CLIENT_SECRET` and the `redirectUri: "postmessage"` on the `OAuth2Client` (popup flow).

> **Note:** the ID token returns `email_verified` as a real boolean (`true`), so the check is a
> plain `=== true`. (The old implicit/`tokeninfo` path returned the **string** `"true"`, which
> needed a both-forms check — no longer relevant.)

## 7. Frontend files

| File | Role |
|---|---|
| `main.tsx` | wraps the app in `<GoogleOAuthProvider clientId={VITE_GOOGLE_CLIENT_ID}>` |
| `pages/auth/Login.tsx` | Grafana-styled page; custom **CSPC Mail** button via `useGoogleLogin` (`flow: "auth-code"`) → auth code; pending/rejected/disabled messaging |
| `context/AuthContext.tsx` | `loginWithGoogle(code)` (replaces `login(email,password)`) |
| `api/api.ts` | `loginWithGoogle` (posts `{ code }`), `getPendingUsers`, `approveUser`, `rejectUser` |
| `pages/UserManagement.tsx` | Grafana-styled; **Pending registrations** panel — approve (role dropdown) / reject, live via socket; "Invited" status for approved-but-never-logged-in |
| `utils/format.ts` | `avatarUrl()` — renders the Google photo (absolute URL) as-is, uploaded files (relative) prefixed with the backend URL |
| `api/client.ts` | response interceptor ignore-list uses `/auth/google` |

Dependency added: **`@react-oauth/google`**.

## 8. Socket events (server → admin browsers)

| Event | When |
|---|---|
| `userPending` | a user self-registered, or a pending user was rejected (refresh the pending list) |
| `userApproved` | an admin approved a registration |

---

## 9. Testing (dev)

1. Apply the migration (with your admin email filled in).
2. Restart **both** servers (nodemon does not reload `.env`; Vite reads `VITE_*` at startup).
3. Open `http://localhost:5173` → **CSPC Mail** → a Google **popup** opens → sign in with your
   **admin** CSPC account → you land in the dashboard as admin.
4. To exercise approval, sign in with a **second** CSPC account (must be added as a Google Test
   user while the app is in Testing) → it lands "awaiting approval" → approve it from
   **User Management → Pending registrations** → that account can now sign in.

Common errors:
- **`Error 400: origin_mismatch`** — the URL you opened isn't in **Authorized JavaScript
  origins**. Add the exact origin (`http://localhost:5173`). After changing origins, a normal
  browser may cache the old config → test in **Incognito** or clear site data.
- **"Access blocked / app is being tested"** — the Google account isn't in **Test users**.
- **"Could not verify your Google sign-in. Please try again." (popup succeeded, then fails)** —
  the backend's code exchange failed. Usual cause: a missing/wrong **`GOOGLE_CLIENT_SECRET`**, a
  secret that belongs to a **different** client than `GOOGLE_CLIENT_ID`, or the backend wasn't
  restarted after editing `.env`. (If the secret is *blank*, you instead get "Google sign-in is
  not configured on the server.") **The real cause is in the backend console** —
  `[GOOGLE_AUTH] code exchange / ID-token verification failed:` prints what Google actually
  rejected; the browser only ever sees the generic message.
- **"Your Google email is not verified."** — `payload.email_verified` from the ID token isn't
  `true`; check the signing-in Google account is actually verified.
- **"Only CSPC accounts… can sign in"** — the email's domain isn't in `GOOGLE_ALLOWED_DOMAINS`.
- **Signs in but never logs in (stuck pending)** — the account isn't `active`; approve it, or
  for the bootstrap admin confirm the migration `UPDATE` matched its email exactly (lowercase).
- **Mobile / LAN can't sign in** — Google only allows `localhost` or an **HTTPS** origin, never
  a raw `http://<IP>:5173`. The dashboard has to be served over its HTTPS hostname
  (`monitoring.cspc.edu.ph`, published by ICTU — `deployment-guide.md` §6.1) and that origin
  added to Authorized JavaScript origins.

---

## 10. Production notes

> 📖 **The step-by-step runbook lives in `deployment-guide.md` §6.4** ("Open the app to all
> CSPC accounts — Internal audience"), together with the HTTPS hostname setup it depends on
> (§6.1, provided by ICTU). Follow that at deployment time; the notes below are the rationale.

- **This project uses Internal**, and the Cloud project is owned by the `cspc.edu.ph`
  organization — no user cap, no verification review, no "unverified app" warning, and Google
  itself restricts sign-in to CSPC accounts. ✅ Confirmed 2026-08-05 that `cspc.edu.ph`
  (employees) and `my.cspc.edu.ph` (students) are a **single Workspace**, verified by a
  successful `@my.cspc.edu.ph` sign-in under Internal.
- **Do not "publish" the app.** Publishing status (Testing → In production) applies only to
  **External** apps, to lift the 100-test-user cap. Internal has no publishing step and is live
  for the org as soon as it's set; switching to External to "publish" would throw away the org
  restriction. Only relevant if the Internal path ever becomes unavailable.
- Trade-off to know: the consent-screen **logo** is gated behind app verification, which
  Internal apps never undergo — so the app *name* renders but the logo does not. Not worth
  switching to External over.
- Serve the dashboard over **HTTPS at a real hostname** and add it to **Authorized JavaScript
  origins** — this is what lets campus PCs and phones sign in at all. ICTU publishes that
  endpoint; see `deployment-guide.md` §6.1.
- Keep `GOOGLE_ALLOWED_DOMAINS` as the server-side gate regardless of Google's settings.

## 11. Status & known follow-ups

- **Done:** Google-only login via the CSPC Mail button; self-register → approve/reject; Grafana
  restyle of Login + User Management; Google profile photos; "Invited" status; **Add User
  removed** (made no sense under Google-only). Verified live on desktop.
- **Done (hardening pass):** `google_sub`-first account matching; profile re-sync on every
  login; denied sign-ins written to `system_logs` (`action='login_denied'`); the real
  token-exchange error logged server-side; domain gate extracted to `googleDomain.js`;
  startup warning for missing Google env; `prompt: "select_account"` so shared
  machines can switch account; rejected accounts re-enableable from the UI instead of only by
  deleting the row; blank `GOOGLE_ALLOWED_DOMAINS` now falls back to the CSPC default instead of
  denying everyone.
- **Open — blocks on-prem go-live:** Google permits only `localhost` or **HTTPS** origins, so
  the dashboard needs a real hostname + certificate before anyone on the campus LAN can sign in
  (§3, §10). Nothing in this repo solves that yet.
- **Open — fresh installs:** the schema seeds no admin row, so the first Google sign-in lands
  `pending` with nobody able to approve it. Bootstrap instructions currently live only in
  `migrations/2026-06-09_google_auth.sql`.
- **Open — session length:** the JWT is 1 h with a proactive client-side logout and no refresh,
  so an always-on wall dashboard drops to the login screen hourly and cannot self-recover.
- **Open — approval loop:** `userPending` is socket-only, so a registration submitted while no
  admin has the tab open is invisible; approved users are never told they can now sign in.
- **Done:** profile editing reduced to **username only**. Because `syncGoogleProfile` refreshes
  name/photo (and a renamed email) on every sign-in, editing them in the app was futile — the
  change appeared to work, then reverted at the next login. Both the My Profile modal and the
  admin Edit User modal now show name + email read-only, the avatar upload is removed, and the
  backend accepts `username` only (`updateOwnProfile`) / `username`+`role`+`status`
  (`updateUser`, via `COALESCE` so an omitted field can't blank a column).
- **Still vestigial:** User Management "Reset PW" and the Profile "Change Password" panel — no
  one logs in with an app password anymore. Candidates for removal. `middleware/upload.js` is
  now unused too, since the avatar upload was the only caller.
- See `CLAUDE.md` (auth section) and `SESSION_NOTES.md` (Sessions 7–8) for the broader log.

---

## 12. Trace the code (request order)

The one-sentence mental model: *Google proves the email is real → our backend checks it's a
CSPC account that's `active` → if so it mints our normal app JWT; if it's new, it parks the user
as `pending` for an admin to approve.* Everything else is plumbing around that.

Read the files in the order a single login actually flows through them. Start with **§2**'s
diagram open beside you.

### A. Frontend — get the Google auth code

1. **`frontend/src/pages/auth/Login.tsx`** — the **CSPC Mail** button. `useGoogleLogin({ flow:
   "auth-code" })` opens the Google popup; on success its callback gets a one-time **auth code**
   and calls `exchangeToken()`.
2. **`frontend/src/context/AuthContext.tsx`** → `loginWithGoogle(code)` — calls the API,
   and on a real session stores the JWT + user in `sessionStorage` and connects the socket. A
   non-active result (pending/rejected/disabled) carries a `status` back to the page instead.
3. **`frontend/src/api/api.ts`** → `loginWithGoogle` — the actual `POST /auth/google` with body
   `{ code }`. (`api/client.ts` attaches tokens + handles 401/403 auto-logout.)

### B. Backend — verify the token and decide

4. **`backend/routes/auth.js`** → `POST /api/auth/google` — calls the service, then maps its
   `outcome` to an HTTP response (200 `{token,user}` for `ok`; 200/403 with a `status` otherwise).
   Rate-limited by `googleLimiter`.
5. **`backend/services/googleAuthService.js`** → **`authenticate(code)`** — *the core.*
   Step through it top to bottom; it mirrors the §2 diagram:
   - `client.getToken(code)` — exchange the code with Google for tokens (client secret).
   - `client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID })` — verify the ID token's
     signature locally and confirm it was issued for *us* (anti-replay), then read its `payload`.
   - `payload.email_verified === true`; then the **domain** check (`googleDomain.js`).
   - `payload.name` / `payload.picture` come straight from the token (no extra fetch).
   - `userService.findByGoogleSub()` **first**, falling back to `findByEmail()`. `sub` is the
     immutable Google account id; matching on email alone would turn a CSPC address rename into
     a duplicate `pending` row, orphan the original `user_id`, and then collide on the unique
     `google_sub` index. The email fallback is what lets pre-Google accounts (the bootstrap
     admin) sign in the first time.
   - `syncGoogleProfile()` refreshes name/photo on every login — otherwise they freeze at
     registration and Google's rotating photo URLs eventually 404.
   - Branch: active → `issueSession`; none → `registerGoogleUser` (pending);
     pending/rejected/inactive → `recordSignInDenied()` + return that status.
6. **`backend/services/authService.js`** → `issueSession(user)` — builds the JWT payload
   (`id, role, tv, …`), signs it (1 h), writes `last_login` + an audit log. *Shared* — this is the
   single place a session is minted, whatever the login path.
7. **`backend/services/userService.js`** → `findByEmail`, `registerGoogleUser` (creates the
   `pending` row + derives username/avatar), `linkGoogleSub`, and the admin ops
   `listPending` / `approveUser(role)` / `rejectUser`.
8. **`backend/middleware/auth.js`** → `authMiddleware` — *unchanged*, but read it to see the
   other half: every later request requires a valid JWT **and** `status='active'` +
   matching `token_version`. This is why a `pending`/`rejected` account can never hold a session.

### C. The approval side (admin)

9. **`backend/routes/users.js`** → `GET /users/pending`, `POST /users/:id/approve` (body
   `{ role }`), `POST /users/:id/reject` — admin-only; they emit `userApproved` / `userPending`.
10. **`frontend/src/pages/UserManagement.tsx`** → the **Pending registrations** panel (approve
    with a role dropdown / reject), kept live via the `userPending` / `userApproved` socket events.

### D. Keep open as reference

- **`migrations/2026-06-09_google_auth.sql`** — the DB shape the code assumes (`status` enum,
  `google_sub`, `auth_provider`, nullable `hash_password`).
- The **§2 table** above — re-check it whenever the code branches on `status`.

> If you only open one file, make it **`googleAuthService.js`** — the whole feature's decision
> logic lives in `authenticate()`.
