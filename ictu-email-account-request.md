# ICTU Request — Email Account for Automated Alerts

**Status:** ⏳ Not yet submitted
**Requested from:** `ictusupport@cspc.edu.ph`
**Requested by:** Mark Angelo Gregorio
**Date drafted:** 2026-08-06
**Blocks:** production deployment of the alert email channel (bell + toast work without it)

> **What this document is.** The monitoring system emails ICTU staff when something goes wrong.
> To send mail it needs one CSPC Google Workspace account to authenticate as. This is the request
> for that account, the reasoning behind it, and what to do once it's granted.
>
> Technical detail lives in `email-popup-notifications.md` §8 (how the transport works) and §9
> (the deployment checklist).

---

## 1. The ask in one line

**Enable 2-Step Verification on `ictusupport@cspc.edu.ph` and generate an App Password for it.**

No new account. No new license. No DNS changes. No mailbox to monitor.

---

## 2. Why an account is needed at all

Email carries no built-in proof of who sent it, so receiving servers (Gmail, Outlook) check DNS
records on the sending domain — **SPF** and **DKIM** — to decide whether a sender is authorized to
send as `@cspc.edu.ph`. Unauthorized mail is spam-filed or rejected outright.

There are two ways to satisfy that check:

| Approach | What it requires | Verdict |
|---|---|---|
| Third-party sending API (Resend, SendGrid, Mailgun) | ICTU adds that provider's DKIM/SPF records to the **live campus domain** — the same records carrying all faculty and student mail | ❌ Large, risky change to request |
| **Send through a real Workspace mailbox** | Nothing. Google already publishes SPF/DKIM for `cspc.edu.ph`, so mail from a CSPC account is authorized exactly like a staff member's | ✅ **Chosen** |

The second approach means the system simply logs into a mailbox and sends, the same as a person
would. That's why the only thing needed is a set of credentials.

---

## 3. Why `ictusupport@cspc.edu.ph` specifically

- **Departmental, not personal.** It isn't tied to an individual, so it survives staff turnover.
  A student or staff account gets deprovisioned and the alerts would stop silently.
- **Already exists.** No new Workspace user, so no additional license cost — the usual reason this
  kind of request gets declined.
- **Recognizable.** Staff already know this address and won't treat the alerts as suspicious.

---

## 4. Exactly what's needed

1. **2-Step Verification** enabled on the account
   (Google Account → Security → How you sign in to Google)
2. An **App Password** generated from it
   (`https://myaccount.google.com/apppasswords` → name it e.g. "Server Room Monitoring" → Create)

An App Password is a 16-character credential that lets one program sign into one mailbox. It does
**not** grant access to anything else in the Google account, and it can be revoked independently at
any time without changing the account password.

The App Password is stored in the monitoring system's server-side configuration
(`backend/.env`, never exposed to the dashboard or any browser) on the on-premise machine. **ICTU is
welcome to enter it directly on the server rather than share it.**

---

## 5. The email to send

> **Subject:** Request: App Password for automated alert emails — server room monitoring system
>
> Hi ICTU,
>
> I'm deploying a server room monitoring system for the department (my thesis project). When
> something goes wrong — a server going offline, the room overheating, a UPS switching to battery —
> it emails the ICTU staff who need to act on it.
>
> It sends through Gmail's SMTP server, so it needs one Workspace account to authenticate as. I'd
> like to use **`ictusupport@cspc.edu.ph`**, since it's already a departmental account and staff
> will recognise the sender.
>
> What I need on that account:
>
> 1. **2-Step Verification** enabled
> 2. An **App Password** generated (Google Account → Security → App passwords)
>
> The App Password would be stored in the system's server-side configuration on the on-premise
> machine — you're welcome to enter it yourselves rather than share it with me.
>
> Notes:
>
> - The system only **sends**; it never reads the mailbox, and nothing needs monitoring.
> - Emails are marked "automated alert — do not reply."
> - Volume is low (a handful per day at most; de-duplication prevents repeats).
> - I've already confirmed App Passwords work on CSPC Workspace accounts.
>
> If you'd prefer the alerts came from a separate identity, `monitoring@cspc.edu.ph` could be added
> as a free **alias** on that account instead — no additional license required. It would also need
> adding under Gmail → Settings → Accounts → "Send mail as."
>
> Thanks,
> Mark Angelo Gregorio

---

## 6. Questions ICTU may ask

**"Why not use your own account?"**
A student account is deprovisioned at graduation. The alerts would stop silently — the send fails,
gets logged, and is swallowed by design so a mail problem can never break monitoring itself. Nobody
would notice until an incident went unreported.

**"Is this even allowed on our tenant?"**
Yes — already verified. On **2026-08-06** an App Password generated on `magregorio@my.cspc.edu.ph`
(a CSPC Workspace student account) authenticated against `smtp.gmail.com:587` and delivered
successfully to both a CSPC address and an external non-CSPC address. App Passwords are not
disabled tenant-wide.

**"Does this give the system access to our support inbox?"**
No. The credential is used only to send. The system never reads, lists, or deletes mail. An App
Password can also be revoked on its own at any time.

**"How much mail will it send?"**
One email per recipient per alert, and only for **critical** severity by default
(`NOTIFY_EMAIL_MIN_SEVERITY`). A 30-minute de-duplication window (`NOTIFY_COOLDOWN_MIN`) prevents
the same condition re-alerting repeatedly. Realistic volume is a handful per day — with 5 staff
and 10 critical alerts that's 50 messages, roughly 2.5% of a Workspace account's ~2,000/day limit.

**"Will this eat into our own sending quota?"**
Yes — worth deciding on deliberately. Google's ~2,000 messages/day limit is **per account**, so
alerts share the budget with whatever staff send manually from `ictusupport@`. Normal ticket
replies leave plenty of headroom, but a **bulk send** (e.g. an announcement to all students) that
hits the cap gets the whole account blocked from sending for ~24 hours — which would stop support
replies *and* alerts at the same time. Alert emails fail **silently** by design (a mail problem
must never break monitoring), so nobody would notice the alerts had stopped.

Three ways to handle it:
1. **Accept it** — fine if `ictusupport@` is only used for ticket replies.
2. **A dedicated account** (`monitoring@cspc.edu.ph` as a real user) gets its own separate quota.
   ⚠️ An **alias does NOT** — it shares the underlying account's limit.
3. **Google Workspace SMTP relay** (~10,000/day), a free Admin-console feature on the existing
   license.

Please advise which you'd prefer; option 1 is fine unless bulk mail goes out from that address.

**"What if staff reply to an alert?"**
The template footer reads *"CSPC-ICTU Server Room Monitoring — automated alert. Do not reply."*
Replies would land in the support inbox as ordinary mail; nothing automated consumes them.

---

## 7. Once granted — what to change

Three values in `backend/.env`, then restart the backend:

```
SMTP_USER=ictusupport@cspc.edu.ph
SMTP_PASS=<the 16-character App Password>
MAIL_FROM=CSPC ICTU Monitoring <ictusupport@cspc.edu.ph>
```

`MAIL_FROM` sets the **display name** only — recipients see "CSPC ICTU Monitoring" instead of a bare
address. No code changes; dev and production differ only by these values.

Verify before announcing it works:

```bash
cd backend
npm run mail:check                          # connect + authenticate, sends nothing
npm run mail:check -- someone@cspc.edu.ph   # send one real test alert
```

Then work the full §9 checklist in `email-popup-notifications.md` — above all confirming
`NOTIFY_EMAIL_TO` is **blank**, since a value there silently redirects every staff member's mail to
one inbox while the dashboard still looks healthy.

⚠️ **Ongoing gotcha for the handover document:** a Google App Password is **revoked when the
account's main password changes.** On a shared support account whose password may rotate, that means
alert emails stop with no visible symptom. If alerts ever go quiet, regenerating the App Password is
the first thing to check.

---

## 8. If the request is declined

Nothing in the code is tied to Google — the transport is generic SMTP, so a fallback is a config
change only.

| Fallback | Trade-off |
|---|---|
| **Alias on another ICTU account** (`monitoring@cspc.edu.ph`) | Free, but still needs 2SV + an App Password on the underlying account, plus "Send mail as" configuration |
| **A staff member's Workspace account** | Works immediately, but reintroduces the deprovisioning risk |
| **Third-party SMTP relay** (Brevo, Mailjet, SMTP2GO) | Verifies a single sender address by emailed link — no domain, no DNS, no Workspace account. Free tiers around 300/day. Mail comes from a non-CSPC address, so it looks less official and is likelier to be spam-filed |
| **Ship with email off** | Blank `SMTP_USER`/`SMTP_PASS` disables the channel cleanly. The **bell feed, toasts and OS popups still work** — only email is lost |

The last row matters: email is one of three delivery channels, and the system degrades gracefully
without it. This request is worth making, but it is not a blocker for deployment.
