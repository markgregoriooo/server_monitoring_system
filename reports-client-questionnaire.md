# Reports — Format & Content Request

**To:** CSPC-ICTU (server-room team / unit head)
**From:** Monitoring System team
**Re:** What the generated **reports** should look like and contain

---

## Why we're asking

The dashboard can already generate reports from live monitoring data and save them as
**CSV** (opens in Excel) and **PDF**. Six kinds exist today: Environment, Server
Metrics, Network Traffic, UPS Power, Alert History, and Aircon Activity.

What we do **not** know is what ICTU actually needs the paper/PDF to look like. The
current layout — the header, the order of sections, the fact that there is **no
signature block** — was decided by us, not by you. If these reports will be filed,
submitted upward, or shown during accreditation, the format matters as much as the
numbers.

**"Whatever you think is best" is a fine answer** for anything you don't have a
preference on. We only need to know where you *do*.

> 🔑 **The single most useful thing:** an **existing report you already produce** for
> the server room or ICTU operations — any monthly/quarterly report, even a scanned or
> Word copy. One sample answers most of this form at once. If none exists, say so; that
> is also a useful answer.

---

## Section 0 — What we produce right now

So you're reacting to something concrete rather than a blank page. Current PDF:

```
┌────────────────────────────────────────────────┐
│ CSPC-ICTU Monitoring            ← plain text,  │
│ Environment Report                no logo      │
│ Type: Environment                              │
│ Period: 2026-07-01 → 2026-07-31 UTC            │
│ Generated: 2026-08-02 13:20:11 UTC             │
│                                                │
│ Summary                                        │
│   Days covered: 31                             │
│   Avg temperature: 28.4 °C                     │
│   Peak temperature: 34.5 °C                    │
│                                                │
│ Details                                        │
│ ┌──────────┬──────────┬──────────┬───────────┐ │
│ │ Date     │ Avg Temp │ Max Temp │ Peak Gas  │ │  ← striped table,
│ ├──────────┼──────────┼──────────┼───────────┤ │    repeats its header
│ │ ...      │          │          │           │ │    on each new page
│ └──────────┴──────────┴──────────┴───────────┘ │
│                                                │
│              (no signature block)              │
└────────────────────────────────────────────────┘
```

Paper size **A4**. Timestamps in **UTC**. No page numbers. No control/reference number.

---

## Section 1 — Who reads it, and why

| Question | Your answer |
|---|---|
| Who receives these reports? (ICTU head, VP for Admin, MIS, accreditation body…) | |
| What are they used for? (routine monitoring, incident documentation, accreditation/ISO, budget justification…) | |
| Are they **printed** and filed, or kept digital only? | ☐ Printed ☐ Digital ☐ Both |
| Does any external body ever see them? (CHED, ISO auditor, COA…) | ☐ Yes ☐ No ☐ Not sure — if yes, who: |

---

## Section 2 — Header & identity

> **Why:** the dashboard already carries the official CSPC logo, but the PDF currently
> prints only the plain text "CSPC-ICTU Monitoring". Easy to change — we just need to
> know what's correct.

| Question | Your answer |
|---|---|
| Should the **CSPC logo** appear on the report? | ☐ Yes ☐ No |
| Exact office name to print (e.g. "Information and Communications Technology Unit") | |
| Should the full college name appear above it? | ☐ Yes ☐ No |
| Any required **letterhead** we should copy? (attach or point us to a sample) | |
| Do reports need a **control / reference number** (e.g. `ICTU-ENV-2026-001`)? | ☐ Yes ☐ No — if yes, what format: |

---

## Section 3 — Signature block ⭐

> **Why this one matters most:** institutional reports in the Philippines are usually
> not accepted without *Prepared by / Noted by / Approved by* lines. Our reports have
> **none**. If yours need them, this is the single biggest change — and it is easier to
> build now than after you've already filed reports without it.

| Question | Your answer |
|---|---|
| Does the report need signature lines? | ☐ Yes ☐ No |
| Which roles, in order? (e.g. Prepared by → Noted by → Approved by) | |
| Should **"Prepared by"** be filled automatically with the logged-in user's name? | ☐ Yes ☐ No |
| Should names/positions of the approvers be **pre-printed** or left blank to sign? | ☐ Pre-printed ☐ Blank lines |
| Names + exact positions to pre-print, if any | |

---

## Section 4 — Paper, format & language

| Question | Your answer |
|---|---|
| Paper size | ☐ A4 (current) ☐ Letter / short bond ☐ Legal ☐ No preference |
| Orientation | ☐ Portrait (current) ☐ Landscape ☐ Depends on report |
| Which file formats do you need? | ☐ PDF ☐ CSV/Excel ☐ Both (current) ☐ Word |
| Timestamps: keep **UTC**, or convert to **Philippine time (UTC+8)**? | ☐ UTC ☐ PH time ☐ No preference |
| Date format | ☐ 2026-08-02 (current) ☐ August 2, 2026 ☐ 08/02/2026 |
| Page numbers ("Page 1 of 4")? | ☐ Yes ☐ No |
| Language | ☐ English (current) ☐ Filipino ☐ Mixed |

> **Note on time:** the system stores everything in UTC. Philippine time is UTC+8, so a
> reading at 8:00 AM local shows as 00:00 UTC. If these reports are read by non-technical
> staff, converting to PH time is strongly recommended — tell us and we'll change it.

---

## Section 5 — Which reports, and how often

Tick the ones ICTU will actually use, and how often each is needed.

| Report | Needed? | How often | Covering what period |
|---|---|---|---|
| **Environment** (temperature, humidity, gas) | ☐ | ☐ Daily ☐ Weekly ☐ Monthly ☐ On demand | |
| **Server Metrics** (CPU, memory, disk) | ☐ | ☐ Daily ☐ Weekly ☐ Monthly ☐ On demand | |
| **Network Traffic** (routers + MikroTik, per port) | ☐ | ☐ Daily ☐ Weekly ☐ Monthly ☐ On demand | |
| **UPS Power** (battery, runtime, load) | ☐ | ☐ Daily ☐ Weekly ☐ Monthly ☐ On demand | |
| **Alert History** (what went wrong, when) | ☐ | ☐ Daily ☐ Weekly ☐ Monthly ☐ On demand | |
| **Aircon Activity** (who turned what on/off) | ☐ | ☐ Daily ☐ Weekly ☐ Monthly ☐ On demand | |

| Question | Your answer |
|---|---|
| Should regular reports generate **automatically** on a schedule, or only when someone clicks Generate? | ☐ Automatic ☐ Manual (current) ☐ Both |
| If automatic — should they be **emailed** to someone when ready? To whom? | |
| Is there a report you need that is **not** in the list above? | |

---

## Section 6 — Content

| Question | Your answer |
|---|---|
| Are the current columns enough? (see `report-page.md` §5 for the full list per type) | ☐ Yes ☐ No — what's missing: |
| Any column that is **not** useful and should be dropped? | |
| Do you need **charts/graphs** in the PDF, or are tables enough? | ☐ Tables are fine (current) ☐ Charts needed |
| Should a report state **whether readings stayed within acceptable limits** (a pass/fail or remarks line), not just the numbers? | ☐ Yes ☐ No |
| If yes — what are the official acceptable limits for the server room? (temp, humidity) | |
| Should an empty period print "No data" (current) or should it refuse to generate? | ☐ Print "No data" ☐ Refuse |

---

## Section 7 — Records & retention

| Question | Your answer |
|---|---|
| How long must generated reports be kept? (we currently auto-delete after **90 days**) | |
| Who may **delete** a report? (currently: admin only) | |
| Who may **download/email** reports? (currently: admin + IT staff) | |
| Should downloads be recorded in the audit log? (currently: **yes** — every download is logged with who and when) | ☐ Keep ☐ Not needed |

---

## Glossary

| Term | Meaning |
|---|---|
| **CSV** | A spreadsheet file. Opens in Excel or Google Sheets. Good for computing your own totals. |
| **PDF** | A fixed-layout document. What you'd print, file, or attach to an email. |
| **Reporting period** | The date range the report covers, e.g. 1–31 July. Separate from the date it was generated. |
| **UTC** | World standard time. Philippine time is UTC **+8** hours. |
| **Audit log** | The History page — a record of who did what and when, including who generated or downloaded a report. |
| **Retention** | How long we keep something before automatically deleting it. |

---

## What happens with your answers

1. **Signature block, logo and paper size** (Sections 2–4) — layout changes in
   `reportRenderer.js`. No database change; we can turn these around quickly.
2. **Scheduling and auto-email** (Section 5) — the email mechanism already exists and
   works; only the timer and the recipient list would be new.
3. **New columns or charts** (Section 6) — depends on the item; charts in the PDF are
   the largest single piece of work here.
4. **Retention and permissions** (Section 7) — configuration, not code.

Anything you leave blank, we keep as it is today and note as a dev-team decision rather
than a client requirement.
