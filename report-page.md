# Reports — On-demand CSV/PDF reports from live data

Guide to the Reports feature: an admin/IT-staff user picks a **report type** and a
**time window**, the backend builds a summary **live** from the monitoring stores
(InfluxDB + MySQL), saves it to the real `reports` table, and writes a **CSV** and a
**PDF** to disk. Both files stay downloadable afterwards.

> This replaces the old mock: `routes/reports.js` used to serve a hardcoded
> in-memory array from `data/db.js` that reset on every restart. That array is gone.
>
> Scope: this document covers the Reports page, the report service/renderer, and the
> report API. For the data sources themselves see `server-metrics.md` (server
> metrics), `Environment.md` (sensor pipeline), `email-popup-notifications.md`
> (alerts), and `CLAUDE.md` (aircon logs, auth/roles).

---

## 1. Architecture

```
  React — Reports page (pages/Reports.tsx)
  ┌──────────────────────────────────────────────┐
  │  Generate modal: type + title + date range   │   POST /api/reports
  │  Table: per-row CSV / PDF download, delete    │ ───────────────────────┐
  └──────────────────────────────────────────────┘                        │
                                                                           ▼
                              ┌──────────────────────────────────────────────────┐
                              │  Express backend                                  │
                              │  routes/reports.js → services/reportService.js    │
                              │   1. create(): INSERT row (pending) → 202 + emit  │
                              │   ── request ends here; the rest is background ── │
                              │   2. build(): dataset live, per type:             │
                              │        environment → InfluxDB sensor_environment  │
                              │        server      → InfluxDB server_metrics      │
                              │        network     → InfluxDB router_metrics +    │
                              │                      network_traffic (+ MySQL)    │
                              │        ups         → InfluxDB ups_metrics (+ MySQL)│
                              │        alerts      → MySQL alerts                 │
                              │        aircon      → MySQL aircon_logs            │
                              │   3. reportRenderer.js → CSV + PDF (pdfkit)       │
                              │   4. write backend/reports/report-<id>.{csv,pdf}  │
                              │   5. UPDATE status=generated, file_path=stem      │
                              │   6. io.emit("reportUpdated") → every dashboard   │
                              └───────────────┬──────────────────────────────────┘
                                              │
            MySQL `reports` (metadata) ◀──────┤──────▶ backend/reports/ (CSV + PDF, git-ignored)
                                              │
                                              ▼
                         GET /api/reports/:id/download?format=csv|pdf  → res.download(file)
```

Reports are **generated on request**, not on a schedule, and generation is
**asynchronous**: the POST answers `202` with a `pending` row and the build runs in
the background, pushing the result to every open dashboard over Socket.IO (§11, §12).
Every action is also written to the audit trail the History page reads (§11).

---

## 2. Quick start — how to use it

1. **MySQL + InfluxDB must be running** (the backend needs both; environment/server
   reports query InfluxDB, alerts/aircon query MySQL).
2. Start backend + frontend and log in.
   ```powershell
   cd backend  ; nodemon src/server.js     # :3000
   cd frontend ; npm run dev               # :5173
   ```
3. Open **Reports** in the sidebar (admin or IT staff).
4. Click **Generate report**:
   - pick a **type** (Environment / Server Metrics / Network Traffic / UPS Power /
     Alert History / Aircon Activity),
   - optional **device** — only shown for types that can be scoped (§13),
   - optional **title** (defaults to e.g. "Environment Report"),
   - pick a **period** — quick `Last 24h / 7 days / 30 days`, or **Custom** dates.
5. Hit **Generate**. The modal closes and the row appears at the top as **pending**,
   flipping to **generated** on its own when the background build finishes — on every
   open Reports page, not just yours (§11).
6. Download it as **CSV** or **PDF**, or **email** yourself the PDF. Admins can
   **delete** a report (removes the DB row + both files).

**Run `migrations/2026-08-02_report_device_scope.sql` once** (adds `reports.device_id`
for per-device scope). The `reports` table itself already ships in the schema
(`V10cspc-ictu-monitoring-system-schema.sql`), and `pdfkit` is the only added
dependency (`backend/package.json`).

---

## 3. File map

### Backend
| File | Role |
|------|------|
| `backend/routes/reports.js` | REST routes: list / scope-options / generate / download / email / delete. Audits every mutating action to `system_logs`. |
| `backend/services/reportService.js` | The feature core — persistence, the per-type data builders (InfluxDB/MySQL), file writing, lifecycle + Socket.IO broadcast, download resolution, email, delete, retention. |
| `backend/services/auditService.js` | Shared `audit()` helper — report actions land in `system_logs` under `module: 'reports'` (§11). |
| `backend/services/emailService.js` | Shared Resend wrapper — `sendReportEmail` attaches the stored PDF (§14). |
| `backend/services/reportRenderer.js` | Store-agnostic layout: turns a normalized `{ summary, table }` into a CSV string and a PDF `Buffer` (pdfkit). Knows nothing about where the data came from. |
| `backend/reports/` | Generated files (`report-<id>.csv` / `.pdf`). Created at startup, **git-ignored**. |
| ~~`backend/data/db.js`~~ | **Deleted.** `reports` was the last mock it backed, so the whole `backend/data/` folder went with this feature. |

### Frontend
| File | Role |
|------|------|
| `frontend/src/pages/Reports.tsx` | Grafana-styled page: stat cards, search + type filter, reports table (per-row CSV/PDF/email + admin delete), the Generate modal (type cards, device scope, period), and the three live socket handlers. Builds the download filename client-side. |
| `frontend/src/api/api.ts` | `getReports()`, `getReportScopeOptions(type)`, `generateReport(opts)`, `downloadReport(id, format, filename?)`, `emailReport(id)`, `deleteReport(id)`. |
| `frontend/src/pages/History.tsx` | Renders the report audit rows under the **Reports** category pill. |

---

## 4. Data model

### MySQL `reports` (existing table — now actually used)
| Column | Notes |
|--------|-------|
| `report_id` | PK. |
| `generated_by` | FK → `users.user_id` (who generated it). Joined to show the author name. |
| `title` | Display title; defaults to `"<Type> Report"`, or `"<Type> Report — <Device>"` when scoped. |
| `type` | ENUM — all six values are used: `environment` / `server` / `network` / `ups` / `alerts` / `aircon`. The ENUM already shipped with `network` + `ups`, so wiring those two needed **no migration**. |
| `device_id` | **Added by `migrations/2026-08-02_report_device_scope.sql`.** FK → `devices`, NULL = campus-wide. `ON DELETE SET NULL` so decommissioning a router doesn't delete the reports describing it. See §13. |
| `status` | `pending` → `generated`, or `failed` if the build threw. Now genuinely observable — generation is asynchronous (§12). |
| `file_path` | The **stem** `report-<id>` (no extension). The route appends `.csv` / `.pdf`. |
| `period_start`, `period_end` | The reporting window. |
| `created_at`, `updated_at` | Timestamps. |

### On-disk files
`backend/reports/report-<id>.csv` and `report-<id>.pdf`. The stem is **id-based and
internal** (stable, collision-free). It is *not* what the user sees — see §7.

---

## 5. Report types & what each pulls

`reportService.js` has one builder per type; each returns a normalized payload of a
**summary** (key stats) + a **table** (columns + rows).

| Type | Source | Summary | Table |
|------|--------|---------|-------|
| `environment` | InfluxDB `sensor_environment` — 3 daily-window queries (`mean` / `max` / `min`, `every: 1d`, `timeSrc: "_start"`) | days covered, avg temp, peak temp, peak gas | per day: avg/max/min temp, avg humidity, peak gas (max of the two MQ-2 sensors) |
| `server` | InfluxDB `server_metrics` — grouped `mean` + `max` per `device_id`/`_field`, names joined from MySQL `devices` (`device_type='server'`) | servers reporting, busiest CPU | per server: avg/max CPU, mem, disk % |
| `network` | InfluxDB `router_metrics` (grouped `mean`/`max`, **incl. `latency_ms` / `packet_loss_pct`**) + `network_traffic` (`increase()` → `last()` for counters, `max` for utilization, bool→float `mean` for link state); device facts + offline events from MySQL | devices reporting, total traffic, busiest port, link errors, **worst packet loss**, offline events | **two tables** — per device: kind, avg/max CPU, avg mem, avg clients, **avg/max latency ms, loss %**, RX/TX GB, offline count; per port: RX/TX GB, peak util, errors, link-up % |

> ⚠️ **The ICMP columns are what make a ping-only router reportable at all.** A router
> registered with no SNMP community (an ISP-owned CPE — see `router-ups-monitoring.md`)
> reports no CPU, no memory, no clients, no interfaces and no traffic, so before
> `latency_ms`/`packet_loss_pct` were queried here its row came out blank in every
> column: a device polled all month appeared never to have reported. **Worst packet loss**
> is in the summary for the same reason — a WAN link that never went "offline" but dropped
> a third of its traffic is a failure nothing else in this report would surface.
| `ups` | InfluxDB `ups_metrics` (grouped `mean`/`min`/`max`, plus bool→float `mean` for `on_battery`); device facts + events from MySQL `alerts` | units reporting, lowest battery, shortest runtime, peak load, on-battery + offline events | **two tables** — battery & load: avg/min charge, avg/min runtime, avg/max load, on-battery %; voltage & events: in/out/battery volts, max temp, event counts |
| `alerts` | MySQL `alerts` (`created_at BETWEEN`) joined to `devices` | total + critical/warning/info counts | each alert: time, severity, device, title, value, status |
| `aircon` | MySQL `aircon_logs` (`created_at BETWEEN`) joined to `devices` + `users` | total, manual vs auto | each action: time, unit, action, trigger, who, reason |

All InfluxDB Flux is **whitelisted** (no user strings interpolated into the query) —
only the ISO period bounds vary, so there is no Flux-injection surface. MySQL uses
parameterized queries.

Empty windows are handled: no data → empty table + zeroed/`—` summary (the report
still generates successfully).

### Three things the network/UPS builders deliberately get right

1. **Byte and error counters are cumulative**, so a `mean` over them is meaningless.
   The builder uses `increase()` (sum of non-negative deltas — a counter reset on
   reboot reads as `0`, not as terabytes) then `last()` for the period total. A series
   with only one sample yields no delta and therefore no row: one poll genuinely
   cannot tell you a volume.
2. **Uptime/availability does NOT come from InfluxDB.** `writeNetworkSample` is only
   called for a device that answered, so the `reachable` field is *always* `true` in
   Influx and a "reachability %" derived from it would read 100 % during an outage.
   Offline counts come from MySQL `alerts` where `type = 'device_offline'` instead —
   the structured record `deviceAlerts.checkReachability` already writes.
3. **UPS time-on-battery is reported as a share of polls**, not minutes. There is no
   honest "minutes on battery" without assuming a fixed poll interval, and
   `SNMP_POLL_INTERVAL_MS` is configurable. The share-of-polls figure is correct at any
   cadence; the `ups_on_battery` **event count** (from `alerts`) is the "how many times"
   half of the picture.

**MikroTik has no report type of its own** — `mikrotikPollerService` reuses
`writeNetworkSample`, so it writes the same two measurements as an SNMP router and is
covered by the `network` report, with a **Kind** column separating them. A device whose
MySQL row was deleted still has history in Influx; those show as `#<id>` with kind `—`
rather than being silently mislabelled.

---

## 6. API

All routes are under `/api/reports` and require a valid JWT (`authMiddleware`).

| Method | Path | Role | Purpose |
|--------|------|------|---------|
| `GET` | `/` | admin + it_staff | List reports, newest first. Optional `?type=` filter. |
| `GET` | `/scope-options?type=` | admin + it_staff | Devices this report type can be scoped to. Empty array = campus-wide only. |
| `POST` | `/` | admin + it_staff | Start a report. Body `{ type, title?, periodStart?, periodEnd?, deviceId? }`. Defaults: period = last 7 days, scope = all devices. **Returns `202` with the `pending` row** — see §12. |
| `POST` | `/:id/email` | admin + it_staff | Mails the stored PDF to the requesting user. Does not rebuild. |
| `GET` | `/:id/download?format=csv\|pdf` | admin + it_staff | Streams the stored file via `res.download`. `404` if not generated / missing. |
| `DELETE` | `/:id` | **admin** | Deletes the row + both files. |

Validation errors (`bad type`, `start >= end`, bad/mismatched `deviceId`) return `400`.
A build failure no longer returns `500` — the request has already been answered `202`,
so failure surfaces as `status: "failed"` on the row plus a `reportUpdated` push.
Email returns `503` when `RESEND_API_KEY` is unset and `502` if Resend rejects it.

---

## 7. Download filename (title + period)

The user-facing download name is **`<title>_<start>_to_<end>.<fmt>`**, e.g.:

```
Daily_Temperature_Report_2026-06-20_to_2026-06-26.csv
```

It is built **client-side** in `Reports.tsx` (`downloadName`) and passed into
`api.downloadReport`. Why client-side: the backend also sets this name on
`Content-Disposition`, **but that header is not readable cross-origin** (dashboard on
`:5173`, backend on `:3000`) unless explicitly exposed, so the browser fetch can't see
it. Building the name from the report's `title` + `period` (which the page already has)
avoids depending on the header. The backend's `fileFor` sets the same name as a
fallback for direct (same-origin / API) hits.

Filenames are sanitized (`[^\w.-] → _`) so they're safe on Windows/macOS/Linux. The
report **type** is intentionally **not** in the filename (the default title already
conveys it).

---

## 8. Output format

Both formats are produced from the same normalized payload by `reportRenderer.js`.

A builder returns **either** a single `table: { columns, rows }` **or** several titled
`tables: [{ title, columns, rows }]`. The renderer normalizes both, so the older
single-table types are untouched while `network` and `ups` — which have a per-device
roll-up *and* a per-port / per-metric breakdown — return two sections each.

**CSV** — metadata header (Title / Type / Period / Generated), a `Summary` block, then
the table(s). With more than one table each block is preceded by its title and a blank
line; a single table has no title row, so it still opens cleanly in Excel/Sheets.
Properly escaped (quotes/commas/newlines).

**PDF** (pdfkit, A4) — branded header, the period + generated timestamp, the summary as
label/value lines, then each table as a striped block with a colored header row that
**paginates** (re-draws the header on each new page) and truncates over-wide cells. A
section heading that would land at the very foot of a page breaks to the next one
instead. Pure JS — no headless Chrome, which suits the on-prem deployment.

> `drawTable` positions every cell absolutely, so it now explicitly leaves `doc.y`
> below its last row. Without that a second table is drawn straight over the first —
> invisible while only single-table reports existed.

---

## 9. Permissions

| Action | admin | it_staff |
|--------|:-----:|:--------:|
| View list + download | ✅ | ✅ |
| Generate | ✅ | ✅ |
| Delete | ✅ | ✕ |

The page mirrors the backend gate: the **Generate** button shows for admin + it_staff,
the **Delete** action only for admin. (The old page checked a non-existent
`super_admin` role — fixed to `admin`.)

---

## 10. Notes & gotchas

- **`backend/reports/` is git-ignored.** Only the MySQL metadata is versioned/backed
  up. If the directory is wiped, rows remain but downloads `404` — regenerate.
- **`file_path` stores a stem**, not a full path or filename. The route appends the
  extension. A path-traversal guard ensures the resolved file stays inside
  `backend/reports/`.
- **Working directory matters** — `REPORTS_DIR = process.cwd()/reports`, consistent
  with multer's `uploads/`. Both assume the backend is started from the `backend/`
  dir (as the npm scripts do).
- **InfluxDB day boundaries are UTC** (`aggregateWindow every: 1d`). For a UTC+8
  campus the daily buckets are offset from local midnight; acceptable for summary
  reporting. `timeSrc: "_start"` labels each row with the day it summarizes.

---

## 11. Live updates & the audit trail

### The list is shared, so the push is too

`GET /api/reports` returns **every** report regardless of who made it — the page has a
"Generated by" column. So the three lifecycle events broadcast to every dashboard
(`io.emit`), not to the creator's room:

| Event | Fired by | Effect on every open Reports page |
|-------|----------|-----------------------------------|
| `reportCreated` | `create()` | The `pending` row appears |
| `reportUpdated` | `build()` | It flips to `generated` / `failed` |
| `reportDeleted` | `remove()` | It disappears |

An admin watching the page sees a colleague's report appear, build and finish without
refreshing.

> **Every path that adds a row goes through one insert-or-replace by id
> (`upsertReport`)** — the socket handlers *and* the Generate response.
>
> They race, and **the socket usually wins**: `create()` emits `reportCreated` before
> returning, and the route then `await`s an audit-log write before sending its 202. So
> the row is normally in state by the time the HTTP response resolves. The Generate
> handler originally did an unconditional prepend, which duplicated the row on screen
> every single time — not intermittently, because the audit write makes the socket win
> reliably.
>
> Keeping the insert on the 202 path (rather than deleting it and trusting the socket)
> means the row still appears if the socket is down. Making it idempotent is what makes
> both safe. The same property covers a reconnect that replays `reportCreated`.

Only the **toast** is creator-specific: the page compares `generatedBy` to the signed-in
user, so nobody gets a popup for somebody else's report.

> The nightly retention purge calls `remove(id, { silent: true })` — otherwise it would
> fire one socket event per deleted row at 3am, when nobody is watching and a page
> opened later loads the correct list anyway.

### Every action lands in History

Report actions are audited to `system_logs` with `module: 'reports'` — a value the
schema already carried — so they appear on the **History** page next to auth, aircon
and alert activity. No migration needed.

| Action | Level | Logged because |
|--------|-------|----------------|
| `generate_report` | info | Who asked for what data, over which window |
| `download_report` | info | An **export** of campus monitoring data leaving the system |
| `email_report` | info | Same, plus where it was sent |
| `delete_report` | **warning** | Destructive and irreversible — the files go too |

> **The actor is not the author.** A History row's actor is whoever performed *that*
> action — for a delete, the admin. So `download`/`email`/`delete` carry the original
> author in the description (`— created by <name>`), because for a delete the row it
> came from no longer exists to look it up in:
>
> ```
> Mark Gregorio | delete_report | Deleted report: UPS Power Report (ups) — created by Ralph Aguirre
> ```
>
> `remove()`, `fileFor()` and `email()` each return the report for this reason.
> `generate_report` omits it — there the actor *is* the author. The name falls back to
> `user #<id>` if that account was since deleted.

Reads (`GET /`, `/scope-options`) are **not** audited: they are noise, and History is
for actions that changed or exported something. Auditing is best-effort by design
(`auditService`), so a failed audit write can never break the action that triggered it.

## 12. Asynchronous generation

`POST /api/reports` answers **202** as soon as the row is recorded, then builds in the
background. A 30-day network report runs several InfluxDB queries and would otherwise
hold the request open.

```
create()  INSERT status='pending'  →  202 { report }      (request ends here)
build(id) run builder → write CSV+PDF → status='generated'
          → io.to(`user:<id>`).emit("reportUpdated", report)
```

- `reportService.init(io)` is called once at startup (`server.js`), matching
  `notificationService.init` / `alertsService.init`.
- **`build()` never throws.** It is called fire-and-forget from the route, where a
  rejection would be an unhandled rejection *after the response was already sent*. It
  catches, marks the row `failed`, and reports that the same way it reports success.
  The route still attaches a `.catch()` as a second line of defence.
- The row **is** the progress record, so a crash mid-build leaves a visible `pending`
  row rather than a silent gap. A client that missed the socket push sees the real
  status on next load.
- The Reports page already rendered `pending`/`failed` via `STATUS_COLOR`, and already
  gated the CSV/PDF buttons on `status === "generated"` — that state was simply
  unreachable before. The only UI change needed was the socket listener.

## 13. Per-device scope

`deviceId` on `POST /api/reports` narrows a report to one device; omit it for
campus-wide (the previous behaviour, still the default).

`SCOPE_TYPES` in `reportService.js` maps report type → the `device_type`s it may be
scoped to. **The same map drives both the validator and `GET /scope-options`**, which
populates the modal's dropdown — so the picker cannot offer something the validator
would reject.

`environment` is deliberately absent: it describes the server room itself, so
scoping it is **rejected with a 400**, not silently ignored. Likewise, asking for a
Network report scoped to a UPS is an error, not an empty report.

> **Flux injection.** `deviceId` is the first user-supplied value ever to reach a Flux
> query string, so §5's "no injection surface" claim needed defending. Two gates:
> `create()` validates it is a positive integer *and* that the device exists and is of
> a permitted type, storing it in an INT column; `fluxDeviceFilter()` re-validates with
> `Number.isInteger` before interpolating. A string like `1" or r.device_id != "` is
> rejected at the first gate.

## 14. Email delivery

`POST /api/reports/:id/email` sends the **stored PDF** to the requesting user, using
the existing Resend wrapper (`emailService.sendReportEmail`).

- **Separate from generate on purpose.** Re-sending must not rebuild: a saved report's
  numbers are frozen, and a rebuild would silently produce different ones.
- Recipient is resolved server-side from the row/session — the endpoint takes no
  address, so it can't be used to mail arbitrary recipients.
- PDF only. The CSV is for spreadsheet work, which is a download job.
- No-ops safely: `503` when `RESEND_API_KEY` is unset, `502` if Resend rejects it.
  `NOTIFY_EMAIL_TO` still forces all mail to one address for testing.

## 15. Retention

`REPORT_RETENTION_DAYS` (blank = **90**) purges reports older than that, at startup
and daily — same cadence and shape as the alerts purge in `server.js`.

It deletes the **row and both files**, via `remove()` so the path-traversal guard stays
one code path. Deleting only the file would leave a row whose downloads 404, which is
worse than no row. The default is longer than `NOTIFY_RETENTION_DAYS` (30) because a
report is an artifact somebody deliberately generated, not an auto-raised alert.

> `purgeOld` reads its argument as `Number.isFinite(raw) && raw >= 0 ? raw : 90` —
> **not** `Number(days) || 90`. Zero is falsy, so the `||` form silently turns "purge
> everything" into "keep 90 days", the opposite instruction. (`notificationService.purgeOld`
> still has the `||` form; same latent edge, not fixed here to keep this change scoped.)

---

> ⚠️ **The layout is a dev-team guess, not a client-approved template.** The header,
> section order, A4 paper, UTC timestamps and the **absence of a signature block** were
> all chosen here, not supplied by CSPC-ICTU. Institutional reports in the Philippines
> usually need *Prepared by / Noted by / Approved by* lines, and the PDF header
> hardcodes the plain text `"CSPC-ICTU Monitoring"` while the dashboard itself already
> renders the real CSPC logo (`VITE_LOGO_SRC`). Confirm with the client before this is
> used for anything filed: `reports-client-questionnaire.md`.

### Possible follow-ups
- Scheduled/auto reports (cron) writing the same table.
- Signature block, logo and PH-time timestamps — pending the client questionnaire.
- Multi-device scope (an array rather than one `device_id`).
- A "users / audit activity" report type — **deliberately not built**: `system_logs`
  already captures user actions and `historyService` already renders them on the
  History page, so this would be a third view of the same rows *and* the only report
  type needing an ENUM migration. A CSV export on the History page is the cheaper
  answer if an audit trail is ever asked for.
