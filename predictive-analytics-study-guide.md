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

> Cross-references: `predictive-analytics.md` (blueprint + the math in §2–§4),
> `server-metrics.md` (the `server_metrics` data we forecast on).
