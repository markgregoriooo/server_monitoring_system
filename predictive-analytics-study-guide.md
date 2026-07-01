# Predictive Analytics — Study Guide (YouTube & concepts)

A learning companion to `predictive-analytics.md`. That doc is the *blueprint*
(what we built and why); this one is the *curriculum* — what to study, in what
order, and what to search/watch on YouTube to actually understand the math
behind the analytics feature.

> **How to use this:** after each video, open the file/line listed in the
> "in our code" column and find the lines that implement what you just watched.
> That loop — *watch the concept → read your own code* — is what makes it stick
> (and what lets you defend it to a panel).

---

## 0. The one idea to get straight first

From `predictive-analytics.md` §1:

- **Predictive analytics** = the *goal* (use history to predict the future).
- **Machine learning** = *one family of techniques* to reach that goal.

In this feature **only linear regression is ML.** Holt-Winters, EWMA, z-score,
and percentiles are **statistics**. Internalize this distinction — it's the
honest framing for a defense, and it tells you which video to watch for what.

---

## 1. Linear regression — the ML centerpiece (Phase 1, BUILT)

The core of the disk-full ETA. **Spend the most time here.**

**In our code:** `backend/services/analyticsService.js`
- `linearRegression()` (line ~12) — slope/intercept via least squares
- `score()` (line ~29) — R² and MAE
- `forecastSeries()` (line ~111) — solves `100 = m·x + b` for the ETA

**Understand:**
- **Least squares** — fitting a line = minimizing the sum of *squared* vertical
  distances. This is the `num / den` slope formula in the code.
- **Slope & intercept** — and how solving `full = m·x + b` for `x` gives the ETA.
- **R² (coefficient of determination)** — "fraction of variance explained";
  used as our **confidence gate** (`confidenceLabel`).
- **MAE (mean absolute error)** — average miss in the metric's own unit (e.g. ±2%).

**Watch / search:**
- StatQuest: `StatQuest linear regression`
- StatQuest: `StatQuest fitting a line to data least squares`
- StatQuest: `StatQuest R-squared clearly explained`  ← explains the confidence gate
- `ordinary least squares regression explained`
- Khan Academy: `least squares regression line Khan Academy`
- `MAE MSE RMSE explained`

---

## 2. Train/test split & validation — "why it's really ML" (Phase 1, BUILT)

A trend line alone isn't convincing; held-out validation is what makes it a
*trained, validated supervised model*.

**In our code:** `splitTrainTest()` (line ~46) + `score()` on the test slice
inside `forecastSeries()` (line ~138).

**Key non-obvious point:** for time series you split **chronologically, never
randomly** — train on the past, test on the recent tail. A random shuffle leaks
the future into training.

**Watch / search:**
- `train test split machine learning explained`
- `time series cross validation walk forward validation`  ← why the split is chronological
- `why you cannot shuffle time series data`
- StatQuest: `machine learning fundamentals bias and variance`

---

## 3. EWMA & Holt-Winters smoothing (Phase 2 — BUILT)

For *cyclical* metrics (temp, CPU) where a straight line is wrong because of
daily peaks.
- **EWMA** (exponentially weighted moving average) — a moving average that
  weights recent points more heavily.
- **Holt-Winters** — EWMA upgraded with **level + trend + seasonality**.

These are **statistics**, used for short-horizon projection — not for ETA.

**In our code:** `analyticsService.js` → `ewma()` and `holtLinear()`, combined in
`forecastTrend()`; surfaced by `GET /api/analytics/trends/:metric` and the
"Trend & Short-Term Projection" chart on the Analytics page. Note: we implement
**Holt's linear method** (level + trend = the *non-seasonal* Holt-Winters); the
daily *seasonality* term is handled separately by the per-hour baseline in §4.
Watching the Holt-Winters video still teaches the full picture — our code is its
trend half.

**Watch / search** (ritvikmath's "Time Series Talk" playlist is the best here):
- `ritvikmath exponential smoothing`
- `ritvikmath Holt Winters`
- `exponentially weighted moving average explained`
- `Holt Winters triple exponential smoothing explained`

---

## 4. z-score / IQR / EWMA bands — anomaly detection (Phase 3 — BUILT)

Flag a reading that's abnormal *for its context* (e.g. a 2 AM CPU spike that's
still under 80%). Learn the **normal distribution** and **standard deviation**
first.
- **z-score:** `z = (x − μ) / σ`; flag `|z| > 3` (the "3-sigma rule").
- **IQR:** outliers via quartiles (the boxplot method).
- **Per-hour-of-day baseline:** compute μ, σ in 24 hourly buckets so "normal at
  2 PM" ≠ "normal at 2 AM."

**In our code:** `analyticsService.js` → `detectAnomalies()` (builds the 24-hour
μ/σ baseline, flags `|z| > 3`, and adds global IQR fences for context); surfaced
by `GET /api/analytics/anomalies` and the "Anomaly Detection" panel.

**Watch / search:**
- StatQuest: `StatQuest normal distribution clearly explained`
- StatQuest: `StatQuest standard deviation` (or variance)
- `z-score explained Khan Academy`
- `3 sigma rule anomaly detection`
- `IQR interquartile range outlier detection`
- `ritvikmath anomaly detection`

---

## 5. Percentiles p50 / p95 / p99 — threshold recommendations (Phase 4 — BUILT)

Look at the historical distribution and suggest rule values: `warn = p95`,
`crit = p99`. **p50 = median.** Two angles worth watching:
- **Stats angle:** `StatQuest quantiles and percentiles clearly explained`,
  `percentiles Khan Academy`.
- **Systems/SRE angle (the practical one):** `p99 latency explained`,
  `tail latency percentiles` — shows why ops people use p95/p99 instead of
  averages. This *is* our use case.

**In our code:** `analyticsService.js` → `percentile()` and `recommendThresholds()`
(p50/p95/p99 vs current `alert_rules`); surfaced by
`GET /api/analytics/recommendations` and the "Threshold Recommendations" panel,
where an admin can apply the suggestion straight into the Alert Rules.

---

## 6. Network & UPS forecasts — Phase 2b/3b (BUILT, no new math)

The newest additions (`predictive-analytics.md` §8 row "2b/3b"): **UPS battery
degradation**, **link saturation**, and **MikroTik/router** trend + anomaly
metrics. Data now comes from the router/UPS branches (`ups_metrics`,
`network_traffic`, `router_metrics`).

> **Key point for a defense: there is NO new statistics or ML to learn here.**
> These features reuse the *exact same* linear-regression engine from §1–§2 and
> the same trend/anomaly code from §3–§4. If you understand disk-full ETA, you
> already understand all three. What's new is **domain knowledge** (where the
> data comes from and why the forecast can be wrong) — not math.

**How each new feature maps to what you already studied:**

| New feature | What it does | Same technique as |
|---|---|---|
| **UPS battery forecast** | regress `runtime_remaining_min` **down** to a 5-min floor → "replace battery in ~N days" | Linear regression + R²/MAE + train/test gate (§1–§2) |
| **Link saturation** | regress per-interface `utilization_pct` **up** to a 90% ceiling → "uplink hits 90% in ~N days" | Same as disk-full ETA (project to a bound) |
| **MikroTik CPU / Mem / Clients** | trend projection + anomaly flagging on router metrics | EWMA/Holt (§3) + z-score/IQR (§4) |

**In our code:** `backend/services/analyticsService.js`
- `projectToBound()` (line ~679) — the shared projector. `direction: "down"`
  falls to a floor (UPS runtime), `direction: "up"` rises to a ceiling (link %).
  It mirrors `forecastSeries()`'s gating exactly (R² ≥ `MIN_ETA_R2`, horizon cap),
  so a noisy/flat series reports "stable" instead of a bogus date.
- `forecastUpsBattery()` (line ~737) — UPS analogue of disk-full ETA.
- `forecastLinkSaturation()` (line ~765) — per-interface capacity forecast.
- `METRICS` registry `router_cpu` / `router_mem` / `router_clients` entries —
  route MikroTik data through the existing `forecastTrend()` / `detectAnomalies()`.
- Endpoints: `GET /api/analytics/forecast/ups-battery`,
  `GET /api/analytics/forecast/link-saturation`; UI = "UPS Battery Forecast" and
  "Link Saturation Forecast" panels on the Analytics page.

**The one conceptual wrinkle (not a new video):** disk-full projects *up* to
100%; UPS battery projects *down* to a floor. It's the same `bound = m·x + b`
algebra solved for a lower bound with `slope < 0` instead of `slope > 0`. Same
line, mirrored.

**What's actually worth studying here = domain, not math.** You only need a video
or two each — enough to explain where the numbers come from and, crucially, **why
a forecast can be wrong** (the honest caveats a panel will ask about):
- **SNMP** (how router/UPS metrics are collected — the snmpsim dev data):
  `SNMP OID MIB explained`, `SNMP polling monitoring basics`.
- **UPS runtime & battery** — the key caveat: **runtime depends on load**, so the
  ETA is only reliable when load is steady (this is noted right in the code):
  `UPS runtime vs load`, `UPS battery degradation`.
- **Network link utilization** — it's capacity planning, per interface:
  `network link utilization capacity planning`, `interface bandwidth saturation`.
- **MikroTik / RouterOS** (light — just what the device is): `MikroTik RouterOS overview`.

---

## Channels to bookmark

| Channel | Best for |
|---|---|
| **StatQuest with Josh Starmer** | Linear regression, R², z-scores, distributions — the #1 resource |
| **ritvikmath** ("Time Series Talk") | EWMA, Holt-Winters, anomaly detection |
| **Khan Academy** | Foundations: mean / variance / std-dev / percentiles |
| **3Blue1Brown** | Optional — deeper math intuition if you want it |

---

## A one-week path

1. **Foundations** — mean, variance, standard deviation (Khan Academy). ~½ day.
2. **Linear regression + R² + MAE** (StatQuest). The core. 1–2 days.
3. **Train/test split for time series.** ~½ day.
4. **Re-read `analyticsService.js`** — every formula should now be recognizable.
5. **Phases 2–4 as you reach them:** EWMA → Holt-Winters → z-score/IQR →
   percentiles (ritvikmath + StatQuest).
6. **Network & UPS (§6) — no new math.** Skip the stats videos; instead skim the
   domain reading (SNMP, UPS runtime-vs-load, link utilization) so you can explain
   *where the data comes from* and *why the forecast can be wrong*. ~½ day.

> Cross-references: `predictive-analytics.md` (blueprint + the math in §2–§4),
> `server-metrics.md` (the `server_metrics` data we forecast on).
