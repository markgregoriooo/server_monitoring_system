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
current layout — the letterhead, the order of sections, the wording of the signature
block — was decided by us, not by you. As of **2026-08-25** the PDF carries both logos,
a centred wordmark and *Prepared by / Noted by* lines, but that arrangement is our best
guess at an institutional format, not anything ICTU approved. **Treat it as a draft to
correct, not a finished design.** If these reports will be filed, submitted upward, or
shown during accreditation, the format matters as much as the numbers.

**"Whatever you think is best" is a fine answer** for anything you don't have a
preference on. We only need to know where you *do*.

> 🔑 **The single most useful thing:** an **existing report you already produce** for
> the server room or ICTU operations — any monthly/quarterly report, even a scanned or
> Word copy. One sample answers most of this form at once. If none exists, say so; that
> is also a useful answer.

---

## What to send us — the actual files ⭐

Ticked boxes on this form help. **Files help more.** In rough order of usefulness:

| # | What we're asking for | Why it matters | Format |
|---|---|---|---|
| 1 | **Any real ICTU report you already file** — monthly accomplishment report, incident report, inventory, anything already accepted | One genuine document answers most of this form at once: letterhead, fonts, signature wording, paper size, control number, date format. This is by far the most valuable item. | Word or PDF — a phone photo of a printed copy is fine |
| 2 | **The official letterhead template**, if ICTU has a standard one | We copy it exactly instead of approximating it | `.docx` / `.dotx` |
| 3 | **ICTU logo — high resolution, transparent background** | The copy we have is a 447×447 **JPEG**. JPEG cannot store transparency, so the logo prints inside a white rectangle. Invisible on a plain white page, obvious on any coloured or bordered letterhead. | PNG with transparency, or SVG / AI / EPS |
| 4 | **CSPC logo — the current official version** | We are using the one from the website. If print work uses a different or newer version, we should match it. | PNG with transparency, or SVG / AI / EPS |
| 5 | **Font files** — only if your template uses a non-standard typeface | The PDF engine ships only Helvetica, Times and Courier. Anything else has to be supplied as a file; we cannot substitute it by name. | `.ttf` / `.otf` |
| 6 | **One sample control / reference number** | Far easier to copy from a real example than from a description | Just write one out, e.g. `ICTU-ENV-2026-001` |
| 7 | **Names and exact position titles** of the signatories — *only if* they should be pre-printed | Right now we print blank lines, which needs no names at all | Text |

> ⚠️ **Please do not send scanned signature images.** We print blank rules on purpose.
> If a stored signature were embedded, anyone able to click "Generate Report" could
> produce a document already bearing someone's name without that person seeing it. A
> blank rule is what makes the signature evidence that a specific person approved a
> specific printed copy.

---

## Section 0 — What we produce right now

So you're reacting to something concrete rather than a blank page. Current PDF, as of
**2026-08-25** — note the letterhead and signature lines are **our draft**, not an
ICTU-approved format:

```
┌──────────────────────────────────────────────────────────┐
│ [CSPC]    CAMARINES SUR POLYTECHNIC COLLEGES     [ICTU]  │
│  logo   Information and Communications Technology Unit    │
│           Server Infrastructure Monitoring System         │
│ ──────────────────────────────────────────────────────── │
│ Environment Report                                        │
│ Type: Environment                                         │
│ Period: 2026-07-01 → 2026-07-31 UTC                       │
│ Generated: 2026-08-02 13:20:11 UTC                        │
│                                                           │
│ Summary                                                   │
│   Days covered: 31                                        │
│   Avg temperature: 28.4 °C                                │
│   Peak temperature: 34.5 °C                               │
│                                                           │
│ Details                                                   │
│ ┌──────────┬──────────┬──────────┬───────────┐            │
│ │ Date     │ Avg Temp │ Max Temp │ Peak Gas  │  ← striped │
│ ├──────────┼──────────┼──────────┼───────────┤    table,  │
│ │ ...      │          │          │           │    header  │
│ └──────────┴──────────┴──────────┴───────────┘    repeats │
│                                                           │
│ Prepared by:                Noted by:                     │
│                                                           │
│ ____________________        ____________________          │
│ Signature over              Signature over                │
│  printed name                printed name                 │
│ Date: ______________        Date: ______________          │
└──────────────────────────────────────────────────────────┘
```

Paper size **A4**. Timestamps in **UTC**. No page numbers. No control/reference number.
Signature lines are **blank** — no names printed. The letterhead appears on **page 1
only**; the signature block on the **last page only**.

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

> **Why:** the PDF now prints both logos with a centred wordmark, but we chose that
> arrangement ourselves from the marks we had on hand. We need to know what's *correct*
> — including whether the wording below is the right way to name the office.

| Question | Your answer |
|---|---|
| Is the current letterhead acceptable as-is? | ☐ Yes, keep it ☐ No, use ours (send the template) |
| Should the **CSPC logo** appear on the report? | ☐ Yes (current) ☐ No |
| Should the **ICTU logo** appear on the report? | ☐ Yes (current) ☐ No |
| Is the logo placement right? (CSPC left, ICTU right) | ☐ Yes ☐ No — describe: |
| Exact office name to print (e.g. "Information and Communications Technology Unit") | |
| Should the full college name appear above it? | ☐ Yes ☐ No |
| Any required **letterhead** we should copy? (attach or point us to a sample) | |
| Do reports need a **control / reference number** (e.g. `ICTU-ENV-2026-001`)? | ☐ Yes ☐ No — if yes, what format: |

---

## Section 3 — Signature block ⭐

> **Why this one still matters most:** institutional reports in the Philippines are
> usually not accepted without *Prepared by / Noted by / Approved by* lines. We have
> added **Prepared by / Noted by** with blank rules, but we guessed both the wording and
> the number of signatories. Getting this wrong means reprinting everything already
> filed, so it is worth a moment of your time.

| Question | Your answer |
|---|---|
| Does the report need signature lines? | ☐ Yes (current) ☐ No, remove them |
| Are **Prepared by / Noted by** the right roles, in that order? | ☐ Yes ☐ No — correct wording/order: |
| Is a third line needed (e.g. **Approved by**)? | ☐ No ☐ Yes — role: |
| Should the block appear on the **last page only** (current) or every page? | ☐ Last page ☐ Every page |
| Which roles, in order? (e.g. Prepared by → Noted by → Approved by) | |
| Should **"Prepared by"** be filled automatically with the logged-in user's name? | ☐ Yes ☐ No |
| Should names/positions be **pre-printed** or left blank to sign? | ☐ Pre-printed ☐ Blank lines (current) |
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

---

# ✅ ICTU's answers — received 2026-08-26, transcribed 2026-08-28

Answered in person by the **MIS Section** on the printed request letter. Source images
are in `reports_template/` (the annotated letter, and a handwritten content outline on
its reverse). Transcribed from those photographs and confirmed with the team.

**This section is the requirement of record.** Where it disagrees with the body of this
document above, this section wins — the text above is the question we asked, not the
answer we got.

## A. Format answers

| Question asked | ICTU's answer | Status |
|---|---|---|
| A report ICTU already files | **PDF**, as a **downloadable file** | Built — PDF is the primary artifact; CSV still ships alongside it |
| Official letterhead template | *"Dynamic"* — braced across the report/letterhead/logo rows | Built — the letterhead is configuration, not a committed file |
| ICTU logo, high-res | *"Dynamic"* — **ICTU uploads it themselves**, because they may change their logo | Built — admin uploads it on the Reports page |
| Font file | **Arial, 11 or 12 pt** | ⚠️ **Not built** — see the note below |
| Paper size — A4, Letter, or Folio? | *"Dynamic (long - default)"* — **the operator picks; default is Long / Folio** | Built — per-report picker, admin-set default, ships as Folio |
| Philippine time (UTC+8) or UTC? | **UTC+8 (Philippine time)** — annotated *"N/A"* + *"System Generated Report"*, clarified verbally | Built — every timestamp in a report is `PHT` |
| Are "Prepared by" / "Noted by" right, and is "Approved by" needed? | **Yes — all three lines** | Built — three signature columns |
| Is a control or reference number required? | **Yes, advisable to have** | Built — `ICTU-<TYPE>-<YEAR>-<NNN>`, matching ICTU's own sample |

### ⚠️ The one open item: Arial

ICTU asked for **Arial 11/12**. The PDF is still set in **Helvetica**, which is one of
pdfkit's built-in fonts.

This is deliberate for now, not an oversight. Helvetica and Arial are metrically
near-identical, so nothing about the layout changes — but embedding a real Arial `.ttf`
means shipping a **licensed Microsoft font** in the repository, which we should not do
without ICTU confirming they hold a licence that covers it. The alternative is a
metric-compatible open font (Liberation Sans, or Arimo) which is licensed for
redistribution and renders at the same widths.

**Decision needed from ICTU:** ship Liberation Sans/Arimo as the Arial stand-in, or have
them supply the Arial file from a licence they hold. One line in `reportRenderer.js`
changes once that is settled.

## B. Report content — ICTU's own outline

Written on the reverse of the letter. This is now the **section order of the Server
Metrics report**, deliberately, because it is what they will read it against.

```
Server Monitoring          2) Server Availability Report   3) Resource Utilization
  Server Name                   Uptime                         CPU
  IP Address                    Downtime                       Memory
  Operating System              Percentage                     Network
  Monitoring Period             Incident(s)
  Date and Time Created
  Responsible                4) Server Status
                             5) Performance monitoring
                             6) Temperature / Humidity
```

| Item | Where it now appears |
|---|---|
| Server Name / IP Address / Operating System | Identity block under the title when the report is scoped to one server; a **Servers Monitored** table when it covers all of them |
| Monitoring Period / Date and Time Created / Responsible | Identity block, every report type. *Responsible* is the user who generated it |
| Uptime / Downtime / Percentage / Incidents | New **Server Availability** section |
| CPU / Memory / Network | **Resource Utilization** section — Network was collected but never reported until now |
| 4) Server Status | Covered by Availability (a status is a point in time; the report covers a period) |
| 5) Performance monitoring | Covered by Resource Utilization |
| 6) Temperature / Humidity | Already the separate **Environment** report type |

### Two measurement notes worth keeping

1. **"Uptime" is not the agent's `uptime_seconds`.** That counter resets to zero on every
   reboot, so it answers "how long since this box last booted". Availability asks what
   share of *the period* the server was reachable, across however many reboots — so it is
   derived from the offline-alert record instead (`services/availabilityMath.js`).
   Planned maintenance is excluded: `setMaintenance` suppresses the offline sweep, so no
   alert is raised and the window is not counted against the server.

2. **Network bytes are cumulative counters.** `psnet.IOCounters` reports bytes since boot,
   so averaging them the way CPU is averaged would print a mean odometer reading. The
   report uses Flux `increase()`, which sums non-negative deltas and reads a reboot as 0
   rather than as the whole counter again.

## C. Still unanswered

These were on the form and ICTU did not mark them. Left as-is and recorded as dev-team
decisions rather than client requirements:

- Scheduled/automatic report emailing (Section 5) — the mechanism exists; no timer was requested.
- Charts inside the PDF (Section 6) — still tables only.
- Retention (`REPORT_RETENTION_DAYS`, 90 days) and who may generate/delete (Section 7).

One stray word — `cost` — is written at the foot of the letter, attached to no question.
Unresolved; ask at the next meeting whether it refers to something they expected to see.


### ⚠️ The signature block diverges from this answer — deliberately

ICTU answered **yes to all three** lines: Prepared by / Noted by / Approved by. Two
things changed afterwards, both at the project team’s instruction rather than the
client’s, and both are recorded here so nobody later reads the code as if it were the
client’s answer:

1. **The block is configurable** (2026-08-28). ICTU asked for it — “they have options on
   how many signatures need to put” — so an admin sets how many lines there are, their
   labels, and whose names. Capped at six, which is two rows of three; past that a
   column is narrower than a signature.

2. **The DEFAULT is now two lines, not three** — Prepared by and Approved by. The
   reasoning was that most reports go straight from preparer to approver and the middle
   line is the one usually left blank. **“Noted by:” is one press of “Add line” away**,
   and any install that already stored three keeps three: a saved block always wins over
   the shipped default.

**Worth confirming with ICTU at the next meeting**, since their written answer says three
and a fresh install now produces two. If they want three back it is a one-line change to
`DEFAULT_SIGNATORIES` in `backend/services/reportTemplate.js` — or simply pressing Add
line once on an existing install.
