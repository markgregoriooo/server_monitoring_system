# Predictive Analytics

Turns the time-series we already collect into **foresight** — forecasts, trends, anomalies
and data-driven threshold suggestions — instead of only reactive threshold alerts.

**Status: complete, running on live data (2026-08-09).** Branch `analytics-integration`.
The `reports.type` migration for the Capacity Forecast report **has been applied**.

> Learning companion: `predictive-analytics-study-guide.md` (what to watch, in what order).
> Related: `server-metrics.md`, `Environment.md`, `email-popup-notifications.md`.

---

## 1. Is it machine learning? — the honest answer

Say this exactly, and every word is defensible:

> *"Predictive analytics built on a supervised **linear-regression** model — trained on a
> past window, validated on a held-out future window with R²/MAE reported, and backtested
> against what actually happened — plus statistical anomaly detection and trend analysis."*

| Technique | Used for | Is it ML? |
|---|---|---|
| **Linear regression** | disk-full ETA, UPS battery degradation, link saturation | ✅ Yes — textbook supervised ML (also "just statistics") |
| Holt-Winters (additive) / EWMA smoothing | temp/CPU + router CPU/mem/clients projection, daily cycle included | ⚠️ Time-series **statistics**, not ML by most definitions |
| z-score / IQR | anomaly detection (servers, environment, router) | ❌ Statistics |
| Percentiles (p50/p95/p99) | threshold recommendations | ❌ Descriptive statistics |

**Predictive analytics** = the *goal* (use history to predict the future), reachable with
statistics **or** ML. **Machine learning** = techniques that *learn parameters from data*
and generalize (train → test → predict). Only the regression does that here.

⚠️ **Never call the whole feature "machine learning."** That is the one claim that would
actually cost marks.

---

## 2. What each feature uses — data + technique

| Feature | Data source | Technique | ML? |
|---|---|---|---|
| **Disk-full ETA** | InfluxDB `server_volumes.percent`, **per mount** | Regression → project up to 100% | ✅ |
| **UPS battery ETA** | InfluxDB `ups_metrics.runtime_remaining_min` + `battery_status` (RFC 1628 enum) | Regression → project **down** to a 5-min floor; the enum overrides when worse | ✅ |
| **Link saturation ETA** | InfluxDB `network_traffic.utilization_pct`, per `interface_name` | Regression → project up to a 90% ceiling | ✅ |
| **Forecast accuracy** | the same series, replayed | Rolling-origin backtest (walk-forward validation) | ✅ validation |
| **Trend projection** | `server_metrics`, `sensor_environment`, `router_metrics` | hour-of-day profile removed → Holt (α=0.5, β=0.2) on the remainder → profile added back, anchored to the last reading. EWMA (α=0.3) is display-only | ⚠️ statistics |
| **Anomaly detection** | same as trend | z-score per **(day-type, hour)** bucket, \|z\|>3, + Tukey IQR fences | ❌ statistics |
| **Threshold recommendations** | same as trend | percentiles: warn = p95, crit = p99 | ❌ statistics |
| **Alert analytics** | MySQL `alerts` | counts, MTTR, severity mix | ❌ statistics |
| **Device identity** | MySQL `devices`, `network_interfaces` | `COALESCE(NULLIF(display_name, ''), device_name)` | — |

---

## 3. The math

**Least squares** fits `ŷ = m·x + b`, where `x` = hours since the first sample:

```
         Σ (xᵢ − x̄)(yᵢ − ȳ)
slope m = ─────────────────── ,   intercept b = ȳ − m·x̄
            Σ (xᵢ − x̄)²
```

**ETA** = solve for when the line crosses a bound, minus now:

```
disk:  100 = m·x + b   →   ETA_hours = (100 − b)/m − x_now
UPS:     5 = m·x + b   →   same algebra, slope negative (falling to a floor)
link:   90 = m·x + b   →   same, rising to a ceiling
```

**Validation** (what makes it ML rather than a drawn line): split **chronologically** —
first 80% train, last 20% test. Never shuffle; a random split leaks the future into
training.

- **R²** = fraction of variance explained. `1` perfect, `0` no better than the mean,
  **`<0` worse than the mean**.
- **MAE** = average miss in the metric's own unit (e.g. ±2.3%).

---

## 4. Why it often says "Stable" — the gates

Least squares will happily fit a line to pure noise. Three gates stop that becoming a date:

| Gate | Value | Meaning |
|---|---|---|
| `MIN_POINTS` | 6 | Fewer → "insufficient data" |
| `MIN_ETA_R2` | 0.4 | Fit worse than this → **no ETA**, show "Stable" |
| `MAX_ETA_DAYS` | 365 | A >1-year projection is not a forecast |

**"Stable" is the system declining to guess, not a bug.** Say that plainly if asked.

---

## 5. Lookback windows — matched to the physics

Sample count was never the constraint; whether the window *contains the signal* is.

| Panel | Options | Default | Why |
|---|---|---|---|
| Disk-full | 14 / 30 / 90d | 30d | Disks fill over weeks |
| Link saturation | 30 / 90 / 180d | 90d | Campus traffic grows over a semester |
| **UPS battery** | 90 / 180 / 365d | **180d** | A battery ages over **years** |
| Trend | *(fixed)* | 48h → 12h | Smoothing forgets old points anyway (§8) |
| Anomaly baseline | 7 / 14 / 30d | 14d | Needs enough samples per hour-of-day bucket |
| Alert analytics | 7 / 30 / 90d | 30d | Usual incident-review period |
| Recommendations | *(fixed)* | 30d | A tunable window invites tuning it until it agrees with you |

**UPS battery is the one that matters.** A VRLA battery lasts 3–5 years, so genuine decline
over 30 days is a fraction of a minute — while runtime *also* swings by many minutes with
load. Below ~90 days the signal sits under the noise and the panel correctly says "Stable".

`bucketForDays()` widens the Flux aggregate as the window grows (1h ≤30d, 6h ≤120d, 1d
beyond), so every window lands in the same few-hundred-point band.

---

## 6. Two UI numbers that are easy to misread

**History column** — the *actual* span of data behind a row, not the window requested.
Amber below half. It falls short when the device is newer than the window, or when InfluxDB
retention is shorter than it (retention is not enforced in code, so a 30-day bucket
silently answers a 180-day request). The trend chart reports the same thing as
`30h history · +12h projected`.

**Bias (accuracy panel)** — signed error. `over` = predicted more usage than happened
(safe). `under` = predicted less (dangerous — you run out sooner than promised). `mae`
cannot tell those apart; bias is the number to read.

---

## 7. Alerting — predictions reach people

`services/analyticsAlerts.js`, every 6h. Forecasts and anomalies raise **real** alerts
(bell + toast + severity-gated email + Alerts page) through `notificationService`, and
auto-resolve on recovery.

- ETA ≤ 7d → **critical**, ≤ 30d → **warning**, beyond → nothing raised.
- Forecast alert types are distinct from threshold types: *"disk is 95% full now"* and
  *"disk will be full in 6 days"* are different incidents with different responses.
- Anomalies raise one aggregated alert per device+metric, then self-resolve — an event,
  not an open condition.

---

## 8. Design decisions worth defending

- **Names come from MySQL, not InfluxDB.** The `device_name` tag is frozen at write time,
  so a renamed device would otherwise show its oldest label. Same for interface labels.
- **Disk forecasts every volume**, headlining the fastest-filling one — matching how disk
  alerting works. Accuracy grades that *same* volume.
- **The trend panel has no lookback control.** EWMA/Holt forget exponentially: at 15-minute
  buckets a point 5 hours old carries weight ~0.0008, so 48h vs 7d barely moves the
  projection. A control that cannot change the output should not imply that it can.
- **Anomaly baselines split weekday/weekend** (48 buckets). Pooling them let quiet campus
  weekends inflate σ, which blinded the detector on weekdays.
- **Accuracy is backtested, not logged.** Logging live predictions measures the same thing
  but yields nothing for weeks; rolling-origin validation answers it today.

---

## 9. Honest caveats

- **Forecasts need history** — ~1–2 weeks minimum; UPS battery wants months.
- **Regression assumes a roughly linear trend.** A one-off large copy skews the slope.
- **Campus traffic follows the academic calendar** — a window on semester start projects a
  ramp that later plateaus. Capacity planning, not promises.
- **Backtesting grades the model against the past it was trained near.** A new workload
  will beat it.
- **UPS battery and link saturation have no accuracy panel.** `forecastAccuracy` only
  reaches metrics in the `METRICS` registry (`server_metrics` / `sensor_environment` /
  `router_metrics`), not `ups_metrics` or `network_traffic`.

---

## 10. Where the code is

| File | Role |
|---|---|
| `backend/services/analyticsMath.js` | **All the math. Import-free, which is why it can be unit-tested.** |
| `backend/services/analyticsService.js` | InfluxDB + MySQL reads, result shaping |
| `backend/services/analyticsAlerts.js` | Scheduled job raising forecast/anomaly alerts |
| `backend/routes/analytics.js` | `/forecast/disk`, `/forecast/ups-battery`, `/forecast/link-saturation`, `/trends/:metric`, `/anomalies`, `/recommendations`, `/accuracy`, `/alerts/summary` |
| `backend/tests/analyticsMath.test.js` | 60+ tests, no DB required |
| `frontend/src/pages/Analytics.tsx` | The page (4 tabs) |
| `reportService.buildForecast` | Capacity Forecast PDF/CSV |

---

## 11. What to learn

Watch the concept, then open the file and find the lines that implement it. Search terms
and channels are in **`predictive-analytics-study-guide.md`**.

| Priority | Topic | Why it matters | In our code |
|---|---|---|---|
| **1** | Least squares — slope & intercept | The ML centrepiece | `linearRegression()` |
| **1** | **R²** and MAE | The confidence gate; know R² can go negative | `score()` |
| **1** | Train/test split — **chronological** for time series | What makes it *validated* ML | `splitTrainTest()`, `validate()` |
| 2 | EWMA / exponential smoothing | The smoothed trend line | `ewma()` |
| 2 | Additive Holt-Winters (level + trend + daily seasonality) | The 12h projection | `forecastSeasonal()` + `hourlyProfile()` + `holtLinear()` |
| 2 | Normal distribution, σ, **z-score** (3-sigma rule) | Anomaly detection | `detectAnomalies()` |
| 3 | IQR / boxplot outliers | Anomaly context tag | `percentile()` |
| 3 | Percentiles p50/p95/p99 (SRE "tail latency" framing) | Threshold suggestions | `recommendThresholds()` |
| 3 | Walk-forward / rolling-origin validation | Proving forecasts came true | `backtestSeries()` |
| 4 | *Domain, not math:* SNMP basics, UPS runtime-vs-load, link capacity planning | Explains **why a forecast can be wrong** | — |

**The three questions a panel will ask, and where the answer is:**

1. *"Is this really machine learning?"* → §1.
2. *"How accurate is it?"* → §3 (R²/MAE on held-out data) + the Accuracy panel (§6).
3. *"What if it's wrong?"* → §4 (it refuses to guess) + §9.
