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
- **Scope now:** servers + environment + alerts (all already on `main`).
  Network/UPS analytics are **deferred** until the `router-ups-monitoring` /
  `mikrotik-monitoring` branches merge — they reuse the same engine, so it's
  additive, not a rewrite. See §8.
- **Honesty note for a defense:** linear regression *is* ML. Holt-Winters/EWMA
  and z-score are *statistics*, not ML. Don't oversell — see §1.

> **Status (2026-06-22): Phase 1 IMPLEMENTED** on branch `predictive-analytics` —
> disk-full ETA + alert analytics are live (backend `services/analyticsService.js`
> + `routes/analytics.js`; frontend `pages/Analytics.tsx`). Verified: backend
> `node --check`, frontend `tsc --noEmit` clean, route mounted (401 when
> unauthenticated). Phases 2–4 and the network/UPS forecast are **not** started.
> See §10 for the checklist and SESSION_NOTES.md (SESSION 14).

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
| **Linear regression** | disk-full ETA, UPS degradation | ✅ Yes — textbook supervised ML (also "just statistics") |
| Holt-Winters / EWMA smoothing | temp/CPU short-horizon projection | ⚠️ Time-series **statistics**, not ML by most definitions |
| z-score / IQR / EWMA bands | anomaly detection | ❌ Statistics |
| Percentiles (p50/p95/p99) | threshold recommendations | ❌ Descriptive statistics |

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
| Servers | InfluxDB | `server_metrics` | `disk_percent`, `disk_used_gb`, `disk_total_gb`, `cpu_percent`, `mem_percent` (tags: `device_id`, `device_name`) |
| Environment | InfluxDB | `sensor_environment` | temperature, gas, humidity |
| Alerts | MySQL | `alerts` | severity, type, device, `created_at`, `acknowledged_at`, `resolved_at` |

Read via the shared InfluxDB clients in `backend/config/influx.js`
(`queryClient`, `bucket`) — same path `serverHistoryHandler.js` already uses.

> **Deferred (not on `main` yet):** `router_metrics` / `network_traffic`
> (throughput forecasting) and `ups_metrics` (battery degradation) live on the
> router/mikrotik branches. See §8.

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
| **2b/3b** | **Network throughput forecast** + **UPS battery degradation** | `router_metrics`, `ups_metrics` | **router-ups + mikrotik merged to `main`**, then rebase this branch |

**Why not wait for the other branches:** the flagship and ~half the scope need
only data already on `main`. Building on top of unfinished, still-rebasing
branches creates painful conflicts. Branch off `main` → Analytics stays
independently reviewable and merges in any order. When network/UPS land, rebase
and add §8 row "2b/3b" — same engine, additive code.

**Merge-time overlap** will only be a few shared files (`App.tsx`,
`Sidebar.tsx`, `api.ts`, `data/users.ts`, `server.js` route list) — each feature
adds its own line; trivial conflicts, not structural.

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

> **Next:** Phase 2 (trend charts + EWMA projection), then 3 (anomaly detection),
> then 4 (threshold recommendations → Alert Rules). Network/UPS forecast after the
> router-ups / mikrotik branches merge — see §8.
