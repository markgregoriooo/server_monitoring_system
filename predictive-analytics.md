# Predictive Analytics — Blueprint & Study Guide

A plan **and** a learning document for the analytics feature on the
`predictive-analytics` branch. It turns the time-series we already collect
(servers, environment, alerts) into **foresight** — forecasts, trends, and
data-driven threshold suggestions — instead of only reactive threshold alerts.

> **Why this doc exists:** so the feature can be studied later, not just built.
> Sections 1–4 teach the *concepts and math* (linear regression, R²/MAE,
> train/test split, anomaly detection). Sections 5–9 are the *implementation
> blueprint* grounded in this repo's real conventions. Read top-to-bottom.

> Related docs: `server-metrics.md` (the `server_metrics` data we forecast on),
> `Environment.md` (sensor pipeline), `email-popup-notifications.md` +
> `alertRulesService` (the Alert Rules this feeds back into).

---

## 0. TL;DR — the decision

- **Technique:** **linear regression** is the core. It is the one method that is
  both genuinely useful *and* legitimately **machine learning** (supervised
  regression), and it runs in pure Node — no Python service, fully explainable.
- **Flagship feature:** **disk-full ETA** — "Server X reaches 100% disk in ~9
  days." The single most useful prediction for a server room.
- **Scope now:** servers + environment + alerts, **plus network/UPS/MikroTik
  analytics** — all of it live. The SNMP/MikroTik pollers that write
  `ups_metrics` / `network_traffic` / `router_metrics` merged into `main`, and the
  analytics merged onto that (branch `analytics-integration`), so every forecast now
  reads **real** data. See §8.
- **Honesty note for a defense:** linear regression *is* ML. Holt-Winters/EWMA
  and z-score are *statistics*, not ML. Don't oversell — see §1.

> **Status (2026-06-22): Phases 1–4 IMPLEMENTED** on branch `predictive-analytics` —
> all server/environment analytics are live (backend `services/analyticsService.js`
> + `routes/analytics.js`; frontend `pages/Analytics.tsx`). Built so far:
> - **Phase 1** — disk-full ETA (linear regression, train/test R²/MAE) + alert analytics.
> - **Phase 2** — `forecastTrend()` (EWMA smoothing + Holt's linear projection) →
>   `GET /analytics/trends/:metric`; SVG trend chart on the page.
> - **Phase 3** — `detectAnomalies()` (per-hour-of-day z-score + global IQR fences) →
>   `GET /analytics/anomalies`.
> - **Phase 4** — `recommendThresholds()` (p50/p95/p99 → suggested warn/crit vs current
>   `alert_rules`) → `GET /analytics/recommendations`; admin "Apply" writes global rules.
>
> Verified: backend `node --check`, frontend `tsc --noEmit` clean, route mounted.
> See §10 for the Phase-1 checklist and SESSION_NOTES.md.
>
> **Update (2026-07-01): Phase 2b/3b (network/UPS/MikroTik analytics) BUILT** —
> `forecastUpsBattery()` (runtime → battery-replacement ETA) + `forecastLinkSaturation()`
> (interface utilization → uplink-saturation ETA) + MikroTik `router_cpu`/`router_mem`/`router_clients`
> trend & anomaly metrics; exposed at `GET /api/analytics/forecast/ups-battery` and
> `/forecast/link-saturation`, with matching Analytics-page panels. Reuses the same
> regression core via `projectToBound()` (project *down* to a floor for battery,
> *up* to a ceiling for link) — additive, no rewrite.
>
> **Update (2026-08-09): merged with `main` and finished** — branch
> `analytics-integration` = `main` (SNMP + MikroTik pollers, per-volume disk, server
> display names) + the analytics work. What changed on merge:
> - **Live data, not seeded.** The pollers write the exact fields the forecasts read
>   (`ups_metrics.runtime_remaining_min`, `network_traffic.utilization_pct` +
>   `interface_name`, `router_metrics.cpu_percent`/`mem_percent`/`connected_clients`),
>   so §12 item 8 is closed. `seed-analytics-history.js` is now dev-only convenience.
> - **Disk forecasts every VOLUME** (`server_volumes`) and headlines the fastest-filling
>   one. Root-only `disk_percent` contradicted `main`'s worst-volume alerting — a server
>   filling `D:` alerted while the forecast read "Stable".
> - **Device identity comes from MySQL**, not the frozen InfluxDB `device_name` tag, so a
>   renamed device reads the same here as on every other page. See §14.
> - **The math is unit-tested** — extracted to `services/analyticsMath.js` (import-free)
>   with 48 tests in `backend/tests/analyticsMath.test.js`. See §15.

---

## 1. Concepts: predictive analytics vs machine learning

These get muddled. Keep them straight:

- **Predictive analytics** = the *goal*: use history to predict the future. It's
  an outcome, achievable with statistics **or** ML.
- **Machine learning** = a *family of techniques* where a model **learns
  parameters from data** and generalizes (train → test → predict).

Where each technique in this plan lands:

| Technique | Used for | Is it ML? |
|---|---|---|
| **Linear regression** | disk-full ETA, UPS battery degradation, link saturation | ✅ Yes — textbook supervised ML (also "just statistics") |
| Holt-Winters / EWMA smoothing | temp/CPU + MikroTik CPU/mem/clients short-horizon projection | ⚠️ Time-series **statistics**, not ML by most definitions |
| z-score / IQR / EWMA bands | anomaly detection (servers, environment, MikroTik) | ❌ Statistics |
| Percentiles (p50/p95/p99) | threshold recommendations (servers, environment) | ❌ Descriptive statistics |

**Takeaway:** linear regression is the legitimate ML centerpiece; the rest are
supporting statistics. To make the ML claim *unambiguous* to a panel, we add a
**train/test split + R²/MAE accuracy** (§3) — that's what turns "drew a trend
line" into "trained and validated a supervised model."

---

## 2. The math: simple linear regression (least squares)

We fit a straight line `ŷ = m·x + b` to historical points, where:
- `x` = time (we use **hours since the first sample** in the window)
- `y` = the metric (e.g. `disk_percent`)

**Slope and intercept** (ordinary least squares):

```
x̄ = mean(x),  ȳ = mean(y)

         Σ (xᵢ − x̄)(yᵢ − ȳ)
slope m = ─────────────────────
            Σ (xᵢ − x̄)²

intercept b = ȳ − m·x̄
```

**Forecast to a threshold** (e.g. disk reaches 100%):

```
solve  100 = m·x + b   →   x_full = (100 − b) / m

ETA_hours = x_full − x_now        (x_now = hours-value of the latest sample)
```

Guards:
- `m ≤ 0` → metric is flat or falling → **no ETA** ("not filling").
- `ETA_hours` negative or absurdly large → clamp / show "stable."

**Reference implementation** (pure JS, ~20 lines — no dependency needed):

```js
// points: [{ x: hours, y: value }]  (x strictly increasing)
export function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;                 // need ≥2 points for a line
  const sx  = points.reduce((s, p) => s + p.x, 0);
  const sy  = points.reduce((s, p) => s + p.y, 0);
  const xb = sx / n, yb = sy / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.x - xb) * (p.y - yb); den += (p.x - xb) ** 2; }
  if (den === 0) return null;             // all x identical
  const slope = num / den;
  const intercept = yb - slope * xb;

  // R² and MAE (fit quality on these points)
  let ssRes = 0, ssTot = 0, absErr = 0;
  for (const p of points) {
    const yhat = slope * p.x + intercept;
    ssRes  += (p.y - yhat) ** 2;
    ssTot  += (p.y - yb)   ** 2;
    absErr += Math.abs(p.y - yhat);
  }
  const r2  = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  const mae = absErr / n;
  return { slope, intercept, r2, mae };
}
```

> If you'd rather use a library: `ml-regression-simple-linear` gives the same
> result. Hand-rolling keeps the dependency tree clean and is more defensible
> ("we implemented the algorithm") — recommended here.

---

## 3. Validating it as ML: train/test split + accuracy

A trend line alone isn't convincing as "machine learning." Validation is:

1. **Split chronologically** (NOT randomly — this is time series; you must train
   on the past and test on the future): first **80%** of points = *train*, last
   **20%** = *test*.
2. **Fit on train only** → get `m`, `b`.
3. **Score on test:** compute predictions for the test points and measure:
   - **R² (coefficient of determination)** = `1 − SS_res/SS_tot`. Fraction of
     variance explained. `1` = perfect, `0` = no better than the mean, `<0` =
     worse than the mean. Use as a **confidence gate**.
   - **MAE (mean absolute error)** = `mean(|yᵢ − ŷᵢ|)`. Average miss in the
     metric's own unit (e.g. "±2.3%").
4. **Gate the output:** only show an ETA when the fit is trustworthy, e.g.
   `R² ≥ 0.5`. Otherwise display *"trend unclear — need more data."* Honest and
   robust; protects against a confident-looking but garbage prediction.

> **Implemented** in `forecastSeries()`: an ETA is surfaced only when
> `r2 ≥ MIN_ETA_R2` (0.4 — i.e. not "low" confidence) **and** the projection is
> within `MAX_ETA_DAYS` (365). A near-flat/noisy disk has a tiny positive slope that
> is real arithmetic but a meaningless ~660-day forecast — it now reports **"Stable"**
> with no date/advice, instead of a bogus year-out ETA. (`disk_percent ≥ full` still
> reports "Full" — a measured fact, not a forecast.)

This is the bit that lets you say, accurately: *"a supervised linear-regression
model, validated on a held-out test window (R²/MAE reported)."*

---

## 4. The other techniques (later phases, for reference)

**Forecasting cyclical metrics (temp, CPU)** — a straight line is wrong for data
with daily peaks. Use **EWMA** (exponentially weighted moving average) or
**Holt-Winters** (level + trend + seasonality). These are statistics, used for
*short-horizon* projection and trend bands — not for ETA.

**Anomaly detection (Phase 3)** — flag readings that are abnormal *for their
context*:
- **z-score:** `z = (x − μ) / σ`; flag `|z| > 3`.
- **Per-hour-of-day baseline:** compute `μ, σ` in 24 hourly buckets so "normal at
  2 PM" ≠ "normal at 2 AM." Catches what static thresholds miss (e.g. a 2 AM CPU
  spike that's still under 80%).

**Threshold recommendation (Phase 4)** — compute the historical distribution of a
metric and suggest rule values: e.g. `warn = p95`, `crit = p99`. Surface on the
**Alert Rules** page as "recommended" values the admin can accept. Closes the
loop: analytics → better config → fewer false alarms.

---

## 5. Data we forecast on (what exists on `main`)

| Source | Store | Measurement / table | Fields we use |
|---|---|---|---|
| Servers | InfluxDB | `server_metrics` | `cpu_percent`, `mem_percent` (tags: `device_id`, `device_name`) |
| Server volumes | InfluxDB | `server_volumes` | `percent` per mount (tags: `device_id`, `mount`) — what the disk ETA regresses |
| Environment | InfluxDB | `sensor_environment` | temperature, gas, humidity |
| Routers / MikroTik | InfluxDB | `router_metrics` | `cpu_percent`, `mem_percent`, `connected_clients` |
| Interfaces | InfluxDB | `network_traffic` | `utilization_pct` (tags: `device_id`, `interface_name`) |
| UPS | InfluxDB | `ups_metrics` | `runtime_remaining_min` |
| Alerts | MySQL | `alerts` | severity, type, device, `created_at`, `acknowledged_at`, `resolved_at` |
| Device identity | MySQL | `devices`, `network_interfaces` | `display_name`/`device_name`, `device_type`, `location_label` — see §14 |

Read via the shared InfluxDB clients in `backend/config/influx.js`
(`queryClient`, `bucket`) — same path `serverHistoryHandler.js` already uses.

> **All of these are live.** The SNMP + MikroTik pollers on `main` write the
> router/UPS/interface measurements, so nothing here depends on seeded data any more.
> `backend/scripts/seed-analytics-history.js` remains only as a dev convenience for
> working on forecasts without waiting weeks for history to accrue.

---

## 6. Backend blueprint

Follows the repo's existing layout (service + route file, mounted at
`/api/<resource>`, gated with `requireRole`).

### 6.1 `backend/services/analyticsService.js` (new)
The reusable engine. Pure functions + Influx reads, no Express here.
- `linearRegression(points)` — §2.
- `splitTrainTest(points, ratio = 0.8)` — chronological split (§3).
- `percentile(values, p)` — for Phase 4.
- `forecastDiskFull({ deviceId?, lookbackDays = 14, full = 100 })`:
  1. Query `server_metrics` `disk_percent` (Flux below), grouped by `device_id`.
  2. Convert each series to `{ x: hoursSinceFirst, y: disk_percent }`.
  3. `splitTrainTest` → `linearRegression(train)` → score on test (R²/MAE).
  4. Compute `ETA_hours` (§2); gate on R² and `slope > 0`.
  5. Return per-server `{ deviceId, name, currentPercent, slopePerDay, etaDays,
     fitR2, mae, confidence }`.

**Flux to pull disk history** (grounded in the real measurement/fields; mirrors
the whitelisted-window pattern in `serverHistoryHandler.js` — never interpolate
raw user input into Flux):

```js
const flux = `
  from(bucket: "${bucket}")
    |> range(start: -${lookbackDays}d)
    |> filter(fn: (r) => r._measurement == "server_metrics")
    |> filter(fn: (r) => r._field == "disk_percent")
    |> aggregateWindow(every: 1h, fn: mean, createEmpty: false)
    |> keep(columns: ["_time", "_value", "device_id", "device_name"])
`;
// then group rows by device_id in JS, regress each series
```

### 6.2 `backend/routes/analytics.js` (new)
All endpoints `authMiddleware` + `requireRole("admin", "it_staff")`.

| Method & path | Purpose | Phase |
|---|---|---|
| `GET /api/analytics/forecast/disk` | disk-full ETA for all servers | 1 |
| `GET /api/analytics/forecast/disk/:id` | single server forecast + series for charting | 1 |
| `GET /api/analytics/alerts/summary?days=30` | MTTR, counts by severity, noisiest devices/rules (MySQL `alerts`) | 1 |
| `GET /api/analytics/trends/:metric?range=` | rolling mean / heatmap data | 2 |
| `GET /api/analytics/anomalies?range=` | z-score / per-hour anomalies | 3 |
| `GET /api/analytics/recommendations` | suggested `alert_rules` values (percentiles) | 4 |

### 6.3 `backend/src/server.js` (edit)
Two lines, alongside the other routes:
```js
import analyticsRoutes from "../routes/analytics.js";
// ...
app.use("/api/analytics", analyticsRoutes);
```

### 6.4 Performance / best practice
- **Aggregate in InfluxDB** (`aggregateWindow`), never pull raw 10s points into
  Node — a 14-day window at 1h buckets is ~336 points/server.
- On-demand is fine for Phase 1. If forecasts get heavy or horizons long,
  **precompute** with a scheduled job (like the offline sweep / retention purge
  `setInterval`s already in `server.js`) and cache the result — don't recompute
  per request.

---

## 7. Frontend blueprint

New **Analytics** page, Grafana `--gf-*` tokens only (no `slate-*`/`dark:`).

| File | Change |
|---|---|
| `frontend/src/pages/Analytics.tsx` | **new** — disk-full ETA cards (server, current %, ETA, "full by" date, R²/confidence badge) + alert-summary panel. Phase 2+ adds trend/anomaly charts. |
| `frontend/src/App.tsx` | import `Analytics`; add `"/analytics": "Analytics"` to `pageTitles`; add a `<Route path="/analytics">` wrapped in `ProtectedRoute`. |
| `frontend/src/data/users.ts` | add `"analytics"` to `admin.pages` **and** `it_staff.pages` (route guard reads this). |
| `frontend/src/components/layout/Sidebar.tsx` | add an "Analytics" nav item (SVG icon) → `/analytics`. |
| `frontend/src/api/api.ts` | add `getDiskForecast()`, `getDiskForecast(id)`, `getAlertSummary(days)` — each returns `ApiResult<T>` via `apiClient`. |

> **Route-guard gotcha:** a page is only reachable if its slug is in the role's
> `pages[]` in `data/users.ts` **and** has a `<Route>` in `App.tsx`. Miss either
> and you get the Unauthorized screen or a blank route. (Note Phase 1 makes
> Analytics visible to both roles; if forecasts should be admin-only, omit it
> from `it_staff.pages`.)

---

## 8. Phasing & branch strategy

Build off `main` (this branch). Each phase is shippable on its own.

| Phase | Deliverable | Data | Depends on |
|---|---|---|---|
| **1** | Engine (`analyticsService`) + **disk-full ETA** + **alert analytics** + Analytics page | `server_metrics`, `alerts` | nothing — all on `main` |
| **2** | Trend charts (rolling mean, hour/day heatmaps) + EWMA temp/CPU projection | `server_metrics`, `sensor_environment` | Phase 1 |
| **3** | Anomaly detection (z-score / per-hour baseline) | same | Phase 1 |
| **4** | Threshold **recommendations** → Alert Rules page | history + `alert_rules` | Phase 1 + `alertRulesService` |
| **2b/3b** | **Network throughput forecast** + **UPS battery degradation** + MikroTik trend/anomaly — ✅ **DONE, on live data (2026-08-09)** | `router_metrics`, `ups_metrics`, `network_traffic` | merged with `main`, so the SNMP + MikroTik pollers now feed it |

**Why not wait for the other branches:** the flagship and ~half the scope need
only data already on `main`. Building on top of unfinished, still-rebasing
branches creates painful conflicts. Branch off `main` → Analytics stays
independently reviewable and merges in any order. When network/UPS land, rebase
and add §8 row "2b/3b" — same engine, additive code.

**Merge-time overlap** will only be a few shared files (`App.tsx`,
`Sidebar.tsx`, `api.ts`, `data/users.ts`, `server.js` route list) — each feature
adds its own line; trivial conflicts, not structural.

> **How it played out:** the 2b/3b **analytics** was built ahead of the router/mikrotik
> merge and validated against seeded history; the merge then supplied the live pipeline
> without a single change to the forecast code — the field names lined up exactly. That
> is the payoff of branching off `main` rather than off an in-flight branch.

---

## 9. Caveats & honesty notes

- **Predictions need history to be meaningful.** Disk-full ETA over a 14-day
  lookback is noise until you actually have ~1–2 weeks of `server_metrics`. The
  R² gate (§3) makes this safe (it shows "need more data" rather than a bogus
  date), but set expectations: Phase 1 *forecasts* mature with time; the **alert
  analytics** half is useful on day one regardless.
- **Linear regression assumes a roughly linear trend.** Disk usage usually fits;
  bursty fills (a one-off big copy) will skew the slope. The R² gate and a
  recent-window lookback mitigate this.
- **Don't call the whole feature "machine learning."** Regression is ML;
  EWMA/z-score/percentiles are statistics. The accurate phrasing: *"predictive
  analytics built on a supervised linear-regression model (validated with
  train/test R²/MAE) plus statistical anomaly detection and trend analysis."*
- **InfluxDB retention** still applies (see `server-metrics.md` §10) — long
  lookbacks need the points to still exist in the bucket.

---

## 10. Build order checklist (Phase 1) — ✅ DONE (2026-06-22)

1. ✅ `backend/services/analyticsService.js` — `linearRegression`, `score`,
   `splitTrainTest`, `forecastDiskFull`, `alertSummary`.
2. ✅ `backend/routes/analytics.js` — the three Phase-1 endpoints + role gate.
3. ✅ `backend/src/server.js` — import + `app.use("/api/analytics", …)`.
4. ✅ `frontend/src/api/api.ts` — `getDiskForecast`, `getAlertSummary`.
5. ✅ `frontend/src/pages/Analytics.tsx` — ETA table + alert summary.
6. ✅ `frontend/src/App.tsx`, `data/users.ts`, `Sidebar.tsx` — route + nav wired.
7. ⏳ Live test: needs ~1–2 weeks of real `server_metrics` for a meaningful ETA.
   So far verified by `node --check` + `tsc --noEmit` (clean) and a route probe
   (`GET /api/analytics/*` → 401 unauthenticated, i.e. mounted). The R² gate makes
   the page safe to ship before history accrues (shows "Need more data").

## 11. Build order checklist (Phases 2–4) — ✅ DONE (2026-06-22)

Shared metric registry (`METRICS` in `analyticsService.js`) maps the `alert_rules`
metric vocabulary (`cpu`/`mem`/`disk` + `temperature`/`humidity`/`gas`) to its InfluxDB
source, so server and environment metrics flow through one `fetchMetricSeries()` path.

1. ✅ **Phase 2** — `ewma()`, `holtLinear()`, `forecastTrend()` +
   `GET /api/analytics/trends/:metric`. Frontend: metric/server selector, inline-SVG
   `TrendChart` (actual + EWMA + dashed projection, forecast region shaded).
2. ✅ **Phase 3** — `percentile()`, `detectAnomalies()` (per-hour-of-day z-score, |z|>3
   default; global IQR fences for context) + `GET /api/analytics/anomalies`. Frontend:
   anomaly stat tiles + recent-anomaly table (driven by the same metric selector).
3. ✅ **Phase 4** — `recommendThresholds()` (warn = p95, crit = p99, vs current global
   rules) + `GET /api/analytics/recommendations`. Frontend: recommendation table; admin
   **Apply** upserts the global `alert_rules` via the existing create/update API
   (comparison `>`), per-server overrides untouched.
4. ✅ **Actionable advisories** — metric-aware remediation copy (`METRIC_ACTION` +
   `diskAdvice()` / `trendAdvice()`). Disk forecast attaches `advice` from ETA urgency
   (act-now < 7d / plan-ahead < 30d); trend forecast attaches `advice` when the projection
   is predicted to cross the metric's effective `alert_rules` threshold within the horizon
   ("Memory on Server-01 is projected to cross the warning threshold (80%) in ~6h —
   upgrade the RAM…"). Rendered as `AdviceCallout`s under the Disk and Trend panels.
   Network/UPS/router action copy lives in `analyticsMath.METRIC_ACTION`.
5. ✅ Verified: backend `node --check`, frontend `tsc --noEmit` clean.
6. ⏳ Live test matures with history (trend/anomaly need ~1 week; recommendations ~2 weeks).

> **Honesty note (unchanged):** Phase 2's projector is **Holt's linear method**
> (double-exponential smoothing — the *non-seasonal* case of Holt-Winters). Daily
> seasonality is captured instead by Phase 3's per-hour-of-day baseline. All of
> Phases 2–4 are **statistics, not ML** — linear regression (Phase 1) remains the sole ML
> centerpiece. Phrase accordingly (see §9).

> **Status:** all of §10–§12 now runs on live data (see the 2026-08-09 update at the
> top). Remaining work is maturity, not code — forecasts sharpen as history accrues.

## 12. Build order checklist (Phase 2b/3b) — ✅ DONE (analytics 2026-07-01, live data 2026-08-09)

Built on this branch **ahead of** the router-ups / mikrotik merge, so the same
engine is proven before the data lands. All additive — the server/environment
paths (§10, §11) are untouched.

1. ✅ `analyticsService.js` — `fetchSeriesGrouped()` (hourly-averaged field grouped
   by device + optional tag, e.g. `interface_name`) and `projectToBound()` — the
   shared projector that mirrors `forecastSeries()`'s gating (R² ≥ `MIN_ETA_R2`,
   horizon ≤ `MAX_ETA_DAYS`). `direction: "down"` → falls to a floor; `"up"` → rises
   to a ceiling.
2. ✅ `forecastUpsBattery()` — regress `runtime_remaining_min` (`ups_metrics`) down
   to a critical floor (default 5 min) → battery-replacement ETA + severity advice.
3. ✅ `forecastLinkSaturation()` — regress per-interface `utilization_pct`
   (`network_traffic`) up to a ceiling (default 90%) → uplink-saturation ETA.
4. ✅ MikroTik `router_cpu` / `router_mem` / `router_clients` in the `METRICS`
   registry (`router_metrics`) → flow through the existing `forecastTrend()` /
   `detectAnomalies()`.
5. ✅ `routes/analytics.js` — `GET /api/analytics/forecast/ups-battery` +
   `/forecast/link-saturation` (same `requireRole("admin", "it_staff")` gate).
6. ✅ Frontend `pages/Analytics.tsx` — "UPS Battery Forecast" + "Link Saturation
   Forecast" panels + MikroTik/Network options in the trend/anomaly selector;
   `api.getUpsBatteryForecast()` / `getLinkSaturationForecast()`.
7. ✅ Dev data: `dev-snmpsim/data/*.snmprec` (flat live values) +
   `backend/scripts/seed-analytics-history.js` (synthetic **trending** ~30-day
   history so ETAs are meaningful without hardware). Test device_ids 9001/9002/9101.
8. ✅ **Live ingestion — closed 2026-08-09.** The SNMP + MikroTik pollers merged from
   `main` write exactly the fields these forecasts read, verified field-by-field against
   `upsMetricsHandler.js` / `networkMetricsHandler.js`. No forecast code changed.

> **Honesty note:** the forecasts now read live SNMP/MikroTik data, but §9 still
> applies — a *trustworthy* ETA needs ~1–2 weeks of accrued history, and until then the
> R² gate reports "Stable"/"need more data" rather than a number. No new math vs
> Phase 1: UPS/link reuse the linear-regression core; MikroTik reuses the Phase 2–3
> trend/anomaly code.

---

## 13. Network / UPS / MikroTik — how each technique applies (2b/3b reference)

Ground truth for the MikroTik side comes from `mikrotik-monitoring.md`. Read this
before presenting the network metrics so the labels are accurate.

### 13.1 Topology reframe — one router, interfaces = buildings

The campus has **one large MikroTik** that all buildings route through (~4–5
Ethernet interfaces); **each interface (port) = one building**. Development uses a
**small MikroTik** as a stand-in — same code, different IP/credentials. So:

- **"per-building" means per-interface**, not per-router. We monitor **one device**
  and label its interfaces with building names (`network_interfaces.interface_name
  → location_label`).
- **Interface-level** (`utilization_pct`, throughput, link up/down — `network_traffic`):
  on the **MikroTik** this is **per building** (interface = building); the field is
  written by **both** the MikroTik and the non-MikroTik SNMP collectors (see §13.2).
- **Device-level** (the **MikroTik** router as a whole, one number): `cpu_percent`,
  `mem_percent`, `connected_clients` (`router_metrics`) — filled by the MikroTik
  RouterOS poller; the non-MikroTik SNMP poller leaves these `null` (see the note in
  §13.2), so in practice they are **MikroTik** values.

### 13.2 Metric glossary (what the analytics actually reads)

| Analytics metric | InfluxDB field / measurement | Scope | Technique |
|---|---|---|---|
| `router_cpu` | `cpu_percent` / `router_metrics` | **MikroTik router** (device-level) | Trend (EWMA+Holt) + Anomaly |
| `router_mem` | `mem_percent` / `router_metrics` | **MikroTik router** (device-level) | Trend + Anomaly |
| `router_clients` | `connected_clients` / `router_metrics` | **MikroTik router — campus-wide total** | Trend + Anomaly |
| link saturation | `utilization_pct` / `network_traffic` | **any interface — both collectors** (MikroTik iface = building; non-MikroTik = a port) | Regression ETA (→ ceiling) |
| UPS battery | `runtime_remaining_min` / `ups_metrics` | UPS device | Regression ETA (→ floor) |

> **Which router? The MikroTik — always.** `router_metrics` is a *shared* measurement
> written by **both** collectors: the **MikroTik** RouterOS poller (source **B**) *and*
> the **non-MikroTik** SNMP poller (source **C** — other routers/switches). But
> `cpu_percent` / `mem_percent` / `connected_clients` are populated **only by the
> MikroTik** path; the SNMP path leaves them `null` (vendor CPU/mem MIBs are hard).
> So these three `router_*` metrics are, in practice, **the MikroTik router** — the code
> labels them "**MikroTik CPU / Memory / Clients**." A non-MikroTik router contributes
> only `uptime_seconds` / `reachable` to `router_metrics` (plus its per-interface
> `network_traffic`), so it has no CPU/mem/clients series to forecast.

> **Link saturation is the exception — it comes from BOTH routers.** Unlike
> CPU/mem/clients, per-interface `utilization_pct` (`network_traffic`) is written by
> **both** collectors: the MikroTik RouterOS poller **and** the non-MikroTik SNMP
> poller (IF-MIB provides per-interface byte counters + link speed, so utilization is
> derivable for any router/switch). `forecastLinkSaturation()` groups by `device_id` +
> `interface_name` with **no device-type filter**, so it forecasts **every** interface
> on **every** network device that reports traffic. The "**= building**" equivalence is
> **MikroTik-only**: the one campus MikroTik's interfaces are labeled by building; on a
> non-MikroTik router/switch an interface is just a port (labeled by its own
> `location_label`, not necessarily a building).

> **`router_clients` is the campus-wide total, NOT per-building.** It's counted from
> the MikroTik's **DHCP leases** (bound leases), i.e. *all* end devices across *all*
> interfaces, as one trend line. It can only be split per building if each building
> is its own subnet / DHCP server / VLAN (`mikrotik-monitoring.md` §10 Q3) — and even
> then that split lives in the per-interface data, not this device-level field.
> It's a device *count* (not people; one user = phone + laptop = 2), and it excludes
> static-IP devices. Label it "**total connected devices on the campus network**."

### 13.3 The regression ETAs (UPS battery, link saturation) — X/Y axes

Same least-squares line as disk-full ETA (§2), via `projectToBound()`. **X is always
time; Y is the metric; the `bound` is a horizontal target line, and the ETA is where
the line crosses it minus "now."** Only Y and the bound change:

| Forecast | X axis | Y axis | Bound (target line) | Slope |
|---|---|---|---|---|
| Disk-full (ref.) | hours since first sample | `disk_percent` (%) | 100% ceiling | rising `+` |
| **UPS battery** | hours since first sample | `runtime_remaining_min` (min of backup left) | **5 min floor** | falling `−` |
| **Link saturation** | hours since first sample | `utilization_pct` (% of link capacity) | **90% ceiling** | rising `+` |

- **UPS battery** (`forecastUpsBattery`, `direction:"down"`): runtime trends down as
  the battery ages → solve `5 = m·x + b` → "replace battery in ~N days."
- **Link saturation** (`forecastLinkSaturation`, `direction:"up"`): utilization
  trends up as traffic grows → solve `90 = m·x + b` → "uplink saturates in ~N days."
  Most useful on the **ISP-uplink interface** — the shared pipe all buildings pass through.
- Both reuse the R² gate + `MAX_ETA_DAYS` horizon: a noisy/flat series reports
  **"stable"** instead of a bogus date. Network traffic is bursty, so the gate matters.

### 13.4 Trend (EWMA + Holt's linear) on `router_cpu` / `router_mem` / `router_clients`

Runs through the generic `forecastTrend()` (`GET /api/analytics/trends/:metric`),
48h lookback → 12h horizon:

1. **EWMA (`α=0.3`) smooths the noisy history** — the router's per-poll CPU/mem/clients
   are spiky; this is the smoothed line drawn over the raw data.
2. **Holt's linear (`α=0.5, β=0.2`) projects forward** — run on the smoothed series
   (level + trend), extrapolated to the 12h horizon; CPU/mem clamp to `[0,100]`,
   clients unbounded.
3. **Advisory** if the projection is predicted to cross the metric's effective
   `alert_rules` threshold within the horizon (e.g. "MikroTik CPU projected to cross
   the warning threshold (80%) in ~4h").

Reads as: router CPU creeping up (heavy routing/NAT load), a slow memory climb/leak,
or connected-device count trending up over the week. **Short-horizon nudge, not an ETA.**

### 13.5 Anomaly detection on `router_cpu` / `router_mem` / `router_clients`

Runs through the generic `detectAnomalies()` (`GET /api/analytics/anomalies`), 7-day
lookback — **device-level only** (no per-interface anomaly path):

- **Per-hour-of-day z-score** (primary): 24 hourly buckets (local UTC+8), mean μ / σ
  per hour, flag `|z| > 3`. Catches what static thresholds miss — a **2 AM router-CPU
  spike still under the 80% alarm** is abnormal *for 2 AM*.
- **Global IQR fences** (Tukey 1.5·IQR): context tag (`iqrOutlier`), not the trigger.

Useful signals: CPU anomaly (runaway process / attack / scan), mem anomaly
(leak/spike), **clients anomaly** (many devices at 3 AM on an empty campus → rogue
devices; a sharp daytime drop → outage).

> **Honesty note — "EWMA bands" is generous.** The *implemented* anomaly detector is
> **per-hour-of-day z-score + IQR fences**. EWMA in this codebase is the Phase 2
> *trend smoothing* (§13.4), **not** anomaly bands. Describe it as "per-hour z-score
> with IQR context." And per §9: only the regression ETAs (disk/UPS/link) are ML —
> the MikroTik trend + anomaly are **statistics**.

---

## 14. Device identity — why names come from MySQL, not InfluxDB

With servers, MikroTik, routers and UPS all forecasting on one page, "which device is
this row?" stopped being obvious. Two rules now govern every name the Analytics page shows.

### 14.1 The name is resolved at QUERY time, from MySQL

Every ingest handler stamps a `device_name` **tag** onto its InfluxDB points. That tag is
frozen at write time and never rewritten, so a 30-day window contains every name the
device has had. Reading the name off the series therefore gives you the name it had when
the *oldest* point was written — the exact opposite of what you want.

`analyticsService.fetchDeviceIdentities()` resolves against MySQL instead:

```sql
SELECT device_id,
       COALESCE(NULLIF(display_name, ''), device_name) AS name,
       device_name AS hostname, device_type AS type, location
  FROM devices WHERE device_id IN (?)
```

That is the same effective-name rule `agentService` uses, so a server renamed from the
dashboard (`devices.display_name`, the `serverRenamed` socket event) reads identically on
the Analytics page and everywhere else. `display_name` lives on the shared `devices`
table, so one query covers all four device classes.

**Fallback:** a device_id with no MySQL row keeps the Influx tag name. That covers the
dev-seed ids (9001/9002/9101) and a decommissioned device whose history outlives its row.

### 14.2 Interfaces are labelled by what they serve

`forecastLinkSaturation()` groups by `interface_name` and resolves
`network_interfaces.location_label` separately (`fetchInterfaceLabels()`), for the same
reason: the label is what an admin edits and the MikroTik poller re-syncs, while the
Influx tag is frozen. Grouping on the *label* would also split one port's history in two
the moment somebody relabels it.

The UI leads with the label and keeps the port as the sub-line — on the campus MikroTik
an interface **is** a building (§13.1), so "CSICT Building" identifies a row and
"ether1" does not.

### 14.3 What the API returns

Every forecast row now carries: `name` (operator-facing), `hostname` (the raw
`device_name`, shown when it differs — i.e. the device was renamed), `deviceType` +
`typeLabel` (`Server` / `Router` / `MikroTik` / `UPS`), and `location`. The page renders
these through one `<DeviceLabel>` component with a colour-coded class badge.

---

## 15. Tests — where the ML claim gets its evidence

The statistics live in **`backend/services/analyticsMath.js`**, which has **no imports**.
That is deliberate: `analyticsService.js` opens MySQL and InfluxDB connections at import
time, so anything defined there cannot be unit-tested without a running stack. This is
the same split the repo already uses for `serverMetricUtils.js` and `historyRange.js`.

`backend/tests/analyticsMath.test.js` runs under plain `npm test` (`node --test`, no DB,
no `.env`, no network) and covers:

| Area | What is pinned down |
|---|---|
| `linearRegression` | exact slope/intercept on a known line; null on degenerate input |
| `score` | R²=1 on a perfect fit; **R² < 0 when worse than the mean**; MAE doesn't cancel |
| `splitTrainTest` / `validate` | the split is **chronological**, loses no points, and scores out-of-sample |
| `forecastSeries` | filling / stable / falling / full / insufficient_data; **noise yields no ETA** |
| `projectToBound` | UPS down-to-floor and link up-to-ceiling, both gated the same way |
| `worstVolumeForecast` | soonest-to-fill beats fullest-right-now |
| `percentile`, `ewma`, `holtLinear` | textbook values, hand-checked |
| `clampInt` / `clampNum` | junk input can never reach Flux (the injection guarantee) |

**Why this matters for a defense.** "We trained a supervised model and validated it on a
held-out window" is a claim a panel can ask you to prove. The test that asserts R² goes
*negative* when the model is worse than the mean, and the one that asserts a noisy series
produces **no ETA at all**, are the evidence that the confidence gate in §3 is real and
not decoration.

---

## 16. Lookback windows — matching the window to the physics

A single shared 7/14/30-day control was wrong, because the four things this page
forecasts move on completely different timescales. Sample count was never the issue
(30 days at 1h buckets is 720 points against a `MIN_POINTS` of 6) — the question is
whether the window is long enough to contain the signal.

| Panel | Options | Default | Why |
|---|---|---|---|
| Disk-full | 14 / 30 / **90**d | 30d | Disks fill over weeks. 14d is easily skewed by one large copy or a log rotation |
| Link saturation | 30 / **90** / 180d | 90d | Campus traffic grows over a semester |
| UPS battery | 90 / **180** / 365d | 180d | A UPS battery ages over **years** |
| Trend projection | *(fixed)* | 48h back, 12h ahead | Smoothing forgets old points anyway — see §16.6–16.7 |
| Anomaly baseline | 7 / **14** / 30d | 14d | Needs several samples per hour-of-day bucket |
| Alert analytics | 7 / **30** / 90d | 30d | Descriptive; 30d is the usual incident-review period |
| Recommendations | *(fixed)* | 30d | Deliberately not tunable — see §16.5 |

### 16.1 Why UPS battery is the one that really needed changing

A VRLA/SLA UPS battery has a 3–5 year service life, so genuine runtime decline over
30 days is a fraction of a minute. Meanwhile **runtime depends on load**, which swings
by many minutes hour to hour as the servers work. At a 30-day window the degradation
signal sits far below the load noise, so the R² gate correctly refuses to produce an
ETA — honest, but it means the panel reads "Stable" forever and never earns its place.
Months of history are what make the trend separable. The default is now 180 days.

**Say this plainly in a defense:** below ~90 days the UPS panel showing "Stable" is the
system declining to guess, not a bug.

### 16.2 The seasonality caveat on link saturation

Campus traffic follows the academic calendar, not a straight line. A 90-day window
landing on semester start extrapolates a ramp that will plateau; one spanning the
semester break projects a decline. The number is real, its validity depends on where in
the term the window sits. Treat link ETAs as capacity planning input, not a promise —
this is the honest caveat to volunteer before a panel asks for it.

### 16.3 Bucket width scales with the window

`bucketForDays()` widens the Flux `aggregateWindow` as the window grows — 1h up to 30d,
6h to 120d, 1d beyond. A 180-day window at 1h buckets would drag ~4,300 points per
device into Node to fit a straight line through, and hourly resolution tells you nothing
about a trend that unfolds over a year. Every window now lands in the same few-hundred-
point band, which is all a regression needs. Tested in `analyticsMath.test.js`.

### 16.4 `historyDays` — the window asked for vs the history that exists

Every forecast row reports `historyDays`, the actual span between its first and last
sample, rendered as the **History** column (amber when under half the requested window).
Two things make it fall short:

1. **The device is newer than the window** — a UPS registered last week has no 180-day trend.
2. **InfluxDB retention is shorter than the window.** Retention is not enforced in code
   (`deployment-guide.md` §3), so a bucket set to 30 days silently returns 30 days for a
   180-day request.

Surfacing the real span means neither case can quietly masquerade as a confident
forecast, and it removes the need to know the retention setting in advance — the page
reports what it actually got.

> **Retention prerequisite:** for the long windows to mean anything, the InfluxDB bucket
> retention must exceed the longest lookback in use (365 days if the UPS panel is set to
> its maximum). Check the bucket's retention policy before relying on a multi-month ETA.

### 16.5 Why threshold recommendations have NO window control

The lookback is the one input that changes the suggested number. Exposing it on the page
would let an admin slide the window until the recommendation happens to agree with the
threshold they already had in mind — which is exactly the bias a data-driven suggestion
exists to remove. It is fixed at **30 days** (`REC_WINDOW_DAYS`): long enough not to tune
to a quiet week, short enough not to bake in load the hardware has since outgrown.

The endpoint still accepts `?days=` (clamped 1–90) for deliberate analysis; the UI simply
does not offer it as a control.

### 16.6 Lookback and horizon are separate questions

The trend panel's horizon was briefly derived from its lookback (≈¼ of it). That coupled
two unrelated things: choosing a 24h window to steady the trend line also silently cut the
forecast to 6h, which is not what "look back further" means to anyone reading the control.

The horizon is now a fixed **12h** (`TREND_HORIZON_HOURS`), independent of the lookback —
far enough ahead to act on before the next shift, short enough that a straight-line
projection is still defensible. The lookback controls only how much history the EWMA and
Holt's fit see.

The panel subtitle is rendered from the values the **backend returned**
(`trend.lookbackHours` / `trend.horizonHours`), not from the pending selector state, so it
can never describe a window other than the one actually plotted.

### 16.7 Why the trend panel has no lookback control either

Its projector is exponential smoothing — EWMA (α=0.3) feeding Holt's linear (α=0.5,
β=0.2) — and exponential smoothing is *designed to forget*:

```
EWMA weight of a point k buckets back = 0.3 x 0.7^k
Holt level weight decays as 0.5^k
```

At 15-minute buckets a point five hours old carries a weight around 0.0008. Beyond
roughly half a day, history contributes essentially nothing to the projection, so
switching a 48-hour window to 7 days barely moves the forecast. What such a control
would really change is how much history is *drawn on the chart*, plus a secondary effect
where the bucket widens (15m -> 30m -> 1h) and slightly alters the trend estimate.

That makes it a chart-zoom wearing a model-parameter label. By the same rule applied to
threshold recommendations (§16.5), a control that cannot meaningfully change the output
should not imply that it can — so the window is fixed at **48h**
(`TREND_LOOKBACK_HOURS`), which is ample history for the fit.

> **Contrast this with the ANOMALY window, which stays adjustable.** There the lookback
> is a genuine model parameter: it sets how many samples land in each hour-of-day bucket,
> and therefore how stable the mean/deviation baseline is and which points get flagged.
> Same tab, opposite conclusion, for a concrete reason — the anomaly detector uses every
> point in the window equally, the trend projector does not.

---

## 17. Forecast accuracy — proving the predictions were right

R² and MAE (§3) describe how well a line **fits history**. Neither says whether a forecast
came *true*. That distinction is the first thing a panel will press on, so it gets its own
measurement.

### 17.1 Why backtesting, not a prediction log

The obvious approach is to record every prediction and grade it later. It measures the
right thing but yields **nothing until predictions mature** — weeks for disk, months for a
UPS battery. Demoed before then, it reads "0 evaluated".

`backtestSeries()` instead uses **rolling-origin validation** on the history already on
disk:

```
for several points in the past ("origins"):
    fit using ONLY the data that existed at that origin
    predict the value `horizon` ahead
    compare against what the metric actually did
```

Same question, answered today, with many samples instead of a handful. It is also standard
practice for time-series models, not an improvisation.

### 17.2 Why it scores VALUE error, not ETA error

"We said 9 days, it took 11" is only computable once the disk has actually filled — which
is almost never, and the cases that *do* resolve are the fastest-filling ones. Scoring only
those would quietly flatter the model.

Value error at the horizon ("we said 71%, it was 73%") is always computable and censors
nothing, so it's what `GET /api/analytics/accuracy` reports:

| Field | Meaning |
|---|---|
| `mae` | Typical miss, ignoring direction |
| `bias` | **Signed** mean. Positive = predicted more usage than happened |
| `worst` | Largest single miss |
| `folds` | How many past predictions could actually be checked |

**`bias` is the one to read.** A model that's noisy but centred is far safer than one that
consistently under-predicts, since under-predicting a disk means running out of space
earlier than promised. The two look identical in `mae`.

`folds` is reported per device and never hidden: an accuracy figure from two checks is not
the same claim as one from eight, and presenting them alike would be the dishonest version
of this feature.

### 17.3 What it can't tell you

It measures the model against **the past it was trained near**. A metric that behaves
differently in future (semester start, a new workload) will beat the backtest — which is
§16.2's seasonality caveat, restated. A good backtest score means the method is sound on
observed behaviour, not that the future is guaranteed to comply.
