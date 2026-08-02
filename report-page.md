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
                              │   1. INSERT reports row (status=pending)          │
                              │   2. build dataset live, per type:                │
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
                              └───────────────┬──────────────────────────────────┘
                                              │
            MySQL `reports` (metadata) ◀──────┤──────▶ backend/reports/ (CSV + PDF, git-ignored)
                                              │
                                              ▼
                         GET /api/reports/:id/download?format=csv|pdf  → res.download(file)
```

Reports are **generated on request**, not on a schedule. Generation is synchronous
(the POST returns once the files are written) — fine for the campus scale where
reports are produced occasionally.

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
   - optional **title** (defaults to e.g. "Environment Report"),
   - pick a **period** — quick `Last 24h / 7 days / 30 days`, or **Custom** dates.
5. Hit **Generate**. The new row appears at the top with status **generated**.
6. Download it as **CSV** or **PDF** from the row. Admins can **delete** a report
   (removes the DB row + both files).

No migration is needed — the `reports` table already ships in the schema
(`V10cspc-ictu-monitoring-system-schema.sql`). `pdfkit` is the only added dependency
(`backend/package.json`).

---

## 3. File map

### Backend
| File | Role |
|------|------|
| `backend/routes/reports.js` | REST routes: list / generate / download / delete. |
| `backend/services/reportService.js` | The feature core — persistence, the per-type data builders (InfluxDB/MySQL), file writing, lifecycle, download resolution, delete. |
| `backend/services/reportRenderer.js` | Store-agnostic layout: turns a normalized `{ summary, table }` into a CSV string and a PDF `Buffer` (pdfkit). Knows nothing about where the data came from. |
| `backend/reports/` | Generated files (`report-<id>.csv` / `.pdf`). Created at startup, **git-ignored**. |
| ~~`backend/data/db.js`~~ | **Deleted.** `reports` was the last mock it backed, so the whole `backend/data/` folder went with this feature. |

### Frontend
| File | Role |
|------|------|
| `frontend/src/pages/Reports.tsx` | Grafana-styled page: stat cards, search + type filter, reports table (per-row CSV/PDF + admin delete), and the Generate modal. Builds the download filename client-side. |
| `frontend/src/api/api.ts` | `getReports()`, `generateReport(opts)`, `downloadReport(id, format, filename?)`, `deleteReport(id)`. |

---

## 4. Data model

### MySQL `reports` (existing table — now actually used)
| Column | Notes |
|--------|-------|
| `report_id` | PK. |
| `generated_by` | FK → `users.user_id` (who generated it). Joined to show the author name. |
| `title` | Display title; defaults to `"<Type> Report"`. |
| `type` | ENUM — all six values are used: `environment` / `server` / `network` / `ups` / `alerts` / `aircon`. The ENUM already shipped with `network` + `ups`, so wiring those two needed **no migration**. |
| `status` | `pending` → `generated`, or `failed` if the build threw. |
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
| `network` | InfluxDB `router_metrics` (grouped `mean`/`max`) + `network_traffic` (`increase()` → `last()` for counters, `max` for utilization, bool→float `mean` for link state); device facts + offline events from MySQL | devices reporting, total traffic, busiest port, link errors, offline events | **two tables** — per device: kind, avg/max CPU, avg mem, avg clients, RX/TX GB, offline count; per port: RX/TX GB, peak util, errors, link-up % |
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
| `POST` | `/` | admin + it_staff | Generate. Body `{ type, title?, periodStart?, periodEnd? }`. Defaults: period = last 7 days. Returns the finished `{ report }`. |
| `GET` | `/:id/download?format=csv\|pdf` | admin + it_staff | Streams the stored file via `res.download`. `404` if not generated / missing. |
| `DELETE` | `/:id` | **admin** | Deletes the row + both files. |

Validation errors (`bad type`, `start >= end`) return `400`; a build failure marks the
row `failed` and returns `500`.

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
- **Generation is synchronous.** A very large window (e.g. 30 days of dense server
  metrics) makes the POST take longer; the modal shows a spinner until done.

### Possible follow-ups
- Scheduled/auto reports (cron) writing the same table.
- Email the generated file via the existing Resend wrapper (`emailService.js`).
- A daily purge of old report files mirroring the alerts retention job.
