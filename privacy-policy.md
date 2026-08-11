# Privacy Notice & Terms Acceptance

Every user must read and accept the Privacy Notice & Terms of Use before the dashboard
opens. Required by the **Data Privacy Act of 2012 (RA 10173)**, which CSPC is covered by
as the personal information controller.

---

## Setup

Adds two columns to `users`: `policy_version`, `policy_accepted_at`.

**Fresh install** — nothing to do. Both are in `v13_cspc-ictu-monitoring-system.sql`.

**Database created before 2026-08-11** — run the migration once:

```bash
mysql -u root -p cspc-ictu-monitoring-system < migrations/2026-08-11_policy_acceptance.sql
```

⚠️ **Without the columns the app breaks** — `GET /api/auth/me` selects them and throws
`Unknown column 'policy_version'`. Running the migration on a fresh v13 import fails the
other way, with `Duplicate column name`.

---

## How it works

```
Sign in with Google → approved account → JWT issued
                                            ↓
                        policy_version ≠ policy_current ?
                          ↓ yes                      ↓ no
                    ┌─────────────┐             Dashboard
                    │ POLICY GATE │
                    └─────────────┘
                     agree → Dashboard
                     decline → sign out
```

The gate replaces the **whole** dashboard — no sidebar, no routes, no live pages behind it.
The only ways out are accepting or signing out.

Accepting writes two things in **one transaction**:

| Where | What |
|-------|------|
| `users` | `policy_version`, `policy_accepted_at` |
| `system_logs` | `action='policy_accepted'` + user, version, timestamp, IP, browser |

Unlike other audit writes in this codebase, this one is **not** best-effort — the log row
*is* the evidence. If it fails, the acceptance fails and the user is re-prompted.

---

## Why a gate and not a login checkbox

Before the Google round-trip nobody has identified themselves, so a checkbox on the login
page can't be attributed to a person. It would be a client-side flag proving nothing, and
clearing `sessionStorage` bypasses it. After sign-in the JWT exists, so acceptance writes a
real record naming who agreed to what, when, and from where.

---

## Files

| File | Role |
|------|------|
| `frontend/src/pages/legal/PolicyDocument.tsx` | **The text.** One component, shared. |
| `frontend/src/pages/legal/PrivacyTerms.tsx` | Public `/privacy` page |
| `frontend/src/components/legal/PolicyGate.tsx` | The blocking gate |
| `backend/services/policyService.js` | `POLICY_VERSION`, `getAcceptance`, `accept`, `resetAll` |
| `backend/routes/policy.js` | `GET /version` (public), `POST /accept` (auth) |
| `migrations/2026-08-11_policy_acceptance.sql` | The two columns |

**The document is one component** rendered by both the gate and the public page. The text
someone agrees to must be the text anyone can read without an account — two copies would
drift invisibly.

`/privacy` is public. It's checked in `App.tsx` **before** the unauthenticated redirect,
because a notice you can only read after agreeing to it is not a notice.

---

## Updating the notice

1. Edit `PolicyDocument.tsx`.
2. Bump `POLICY_VERSION` in `backend/services/policyService.js` (date-based, e.g. `"2026-11-04"`).
3. Restart the backend.

Everyone re-accepts at their next sign-in — at most an hour away, since that's the JWT
lifetime. The gate says "It has been updated since you last accepted it."

**Only bump for real changes** — new data collected, a new recipient, a different retention
period. A re-prompt that says nothing new teaches people to click through without reading.

---

## Retention

The notice commits to these periods, and the code enforces them daily:

| Data | Period | Env |
|------|--------|-----|
| Audit trail (`system_logs`) | 365 days | `SYSTEM_LOG_RETENTION_DAYS` |
| Alerts + notification feed | 30 days | `NOTIFY_RETENTION_DAYS` |
| Reports (row + CSV/PDF) | 90 days | `REPORT_RETENTION_DAYS` |
| On-site backup files | 30 days | `BACKUP_RETENTION_DAYS` |

**Change a retention value → change the notice → bump the version.** The document states
these numbers as a promise.

---

## What the system holds about a user

Name, email, Google account ID and photo (all from Google, re-read at each sign-in), role
and status, sign-in/sign-out times with IP and browser, actions taken (alerts acknowledged,
aircon toggled, reports generated, rules changed), and which alerts they've read.

**Not** collected: passwords (Google handles sign-in), tracking cookies, analytics, location.
Telemetry — CPU, network, UPS, temperature, gas — describes equipment, not people.

---

## Notes

- **Pending users never see the gate.** They have no session. They accept at their first real
  sign-in after an admin approves them.
- **The gate fails open** if `policy_current` is missing from a cached session object. Locking
  every user out over a missing field is worse than one un-gated session; the next sign-in
  supplies it.
- **Scroll-to-enable is not security.** Someone can flick the scrollbar. It just stops
  "I have read this" being stamped on a document that never moved.
- ⚠️ **The text needs ICTU / Data Protection Officer review before go-live.** It accurately
  describes what the code does, but it's a binding commitment made on CSPC's behalf.
