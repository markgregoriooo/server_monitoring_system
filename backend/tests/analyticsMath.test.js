import test from "node:test";
import assert from "node:assert/strict";

import {
  linearRegression,
  score,
  splitTrainTest,
  validate,
  percentile,
  ewma,
  holtLinear,
  forecastSeries,
  projectToBound,
  worstVolumeForecast,
  byEtaAsc,
  confidenceLabel,
  localHour,
  everyForHours,
  parseEveryMs,
  bucketForDays,
  spanDays,
  clampInt,
  clampNum,
  MIN_POINTS,
} from "../services/analyticsMath.js";

// Unit tests for the predictive-analytics math. These run with NO MySQL, NO InfluxDB
// and NO .env — that is the whole reason analyticsMath.js is import-free. See
// predictive-analytics.md §2–§4 for the math each of these pins down.

const HOUR = 3_600_000;
// Build a series of hourly points starting `hoursAgo` back, y = f(i).
const series = (n, f, startMs = 0) =>
  Array.from({ length: n }, (_, i) => ({ t: startMs + i * HOUR, y: f(i) }));
const pts = (n, f) => Array.from({ length: n }, (_, i) => ({ x: i, y: f(i) }));

// ─── linearRegression ─────────────────────────────────────────────────────────

test("linearRegression recovers the exact slope and intercept of a perfect line", () => {
  const m = linearRegression(pts(10, (i) => 3 * i + 5));
  assert.ok(Math.abs(m.slope - 3) < 1e-9, `slope ${m.slope}`);
  assert.ok(Math.abs(m.intercept - 5) < 1e-9, `intercept ${m.intercept}`);
  assert.equal(m.r2, 1);
  assert.ok(m.mae < 1e-9);
});

test("linearRegression finds a negative slope for a falling series", () => {
  const m = linearRegression(pts(10, (i) => 100 - 2 * i));
  assert.ok(Math.abs(m.slope + 2) < 1e-9);
});

test("linearRegression returns null when a line cannot be fit", () => {
  assert.equal(linearRegression([]), null, "empty");
  assert.equal(linearRegression([{ x: 1, y: 1 }]), null, "single point");
  // All x identical → zero denominator → no slope exists.
  assert.equal(
    linearRegression([{ x: 5, y: 1 }, { x: 5, y: 9 }]),
    null,
    "vertical",
  );
});

test("linearRegression on flat data gives zero slope", () => {
  const m = linearRegression(pts(8, () => 42));
  assert.equal(m.slope, 0);
  assert.equal(m.intercept, 42);
});

// ─── score (R² / MAE) ─────────────────────────────────────────────────────────

test("score: R²=1 on a perfect fit, and MAE is in the metric's own unit", () => {
  const model = { slope: 2, intercept: 0 };
  const s = score(model, pts(5, (i) => 2 * i));
  assert.equal(s.r2, 1);
  assert.equal(s.mae, 0);
});

test("score: a model no better than the mean scores R²≈0", () => {
  // Data is flat at 10; a flat model AT the mean explains nothing beyond the mean.
  const s = score({ slope: 0, intercept: 10 }, pts(5, () => 10));
  assert.equal(s.r2, 1, "zero variance and zero residual is defined as a perfect fit");

  // Non-zero variance, model predicts the mean → R² = 0.
  const data = [{ x: 0, y: 0 }, { x: 1, y: 10 }];
  const s2 = score({ slope: 0, intercept: 5 }, data);
  assert.equal(s2.r2, 0);
});

test("score: R² goes NEGATIVE when the model is worse than the mean", () => {
  // This is the case the confidence gate exists to catch.
  const data = [{ x: 0, y: 0 }, { x: 1, y: 10 }];
  const s = score({ slope: -5, intercept: 20 }, data);
  assert.ok(s.r2 < 0, `expected negative R², got ${s.r2}`);
});

test("score: MAE is the mean ABSOLUTE error, so misses never cancel out", () => {
  // +2 and −2 average to zero but are two units of error each.
  const data = [{ x: 0, y: 2 }, { x: 1, y: -2 }];
  const s = score({ slope: 0, intercept: 0 }, data);
  assert.equal(s.mae, 2);
});

// ─── splitTrainTest ───────────────────────────────────────────────────────────

test("splitTrainTest splits CHRONOLOGICALLY, never shuffling", () => {
  const p = pts(10, (i) => i);
  const { train, test: held } = splitTrainTest(p, 0.8);
  assert.equal(train.length, 8);
  assert.equal(held.length, 2);
  // The test window must be the RECENT tail — training on the future would leak it.
  assert.deepEqual(train.map((q) => q.y), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(held.map((q) => q.y), [8, 9]);
});

test("splitTrainTest keeps every point across the two halves", () => {
  for (const n of [2, 5, 7, 13, 100]) {
    const { train, test: held } = splitTrainTest(pts(n, (i) => i), 0.8);
    assert.equal(train.length + held.length, n, `n=${n}`);
  }
});

test("validate falls back to the in-sample score below 10 points", () => {
  const p = pts(8, (i) => i);
  const model = linearRegression(p);
  const v = validate(p, model);
  assert.equal(v.r2, model.r2, "too short to hold out a test window");
});

test("validate scores OUT of sample once there are enough points", () => {
  // A series that bends: the held-out tail departs from the trained line, so the
  // out-of-sample R² must be worse than the flattering in-sample one.
  const p = pts(20, (i) => (i < 16 ? i : 16 - (i - 16) * 4));
  const model = linearRegression(p);
  const v = validate(p, model);
  assert.ok(v.r2 < model.r2, `out-of-sample ${v.r2} should be worse than ${model.r2}`);
});

// ─── confidenceLabel (the gate) ───────────────────────────────────────────────

test("confidenceLabel bands R² into high/medium/low", () => {
  assert.equal(confidenceLabel(0.95), "high");
  assert.equal(confidenceLabel(0.7), "high");
  assert.equal(confidenceLabel(0.69), "medium");
  assert.equal(confidenceLabel(0.4), "medium");
  assert.equal(confidenceLabel(0.39), "low");
  assert.equal(confidenceLabel(-2), "low");
  assert.equal(confidenceLabel(null), "low", "no fit at all is not confidence");
});

// ─── percentile ───────────────────────────────────────────────────────────────

test("percentile interpolates and handles the edges", () => {
  const v = [1, 2, 3, 4, 5];
  assert.equal(percentile(v, 0), 1);
  assert.equal(percentile(v, 50), 3, "p50 is the median");
  assert.equal(percentile(v, 100), 5);
  assert.equal(percentile([1, 2], 50), 1.5, "interpolated between the two");
});

test("percentile is order-independent and ignores non-finite values", () => {
  assert.equal(percentile([5, 1, 4, 2, 3], 50), 3);
  assert.equal(percentile([1, NaN, 3, Infinity], 50), 2);
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([7], 95), 7, "a single value is every percentile");
});

test("percentile: p95 < p99 on a skewed distribution (the warn/crit suggestion)", () => {
  const vals = [...Array(95).fill(10), ...Array(4).fill(80), 99];
  const p95 = percentile(vals, 95);
  const p99 = percentile(vals, 99);
  assert.ok(p95 < p99, `p95 ${p95} should sit below p99 ${p99}`);
});

// ─── ewma ─────────────────────────────────────────────────────────────────────

test("ewma anchors on the first value and smooths toward the data", () => {
  const out = ewma([10, 20, 30], 0.5);
  assert.equal(out[0], 10, "seeded with the first observation");
  assert.equal(out[1], 15, "0.5*20 + 0.5*10");
  assert.equal(out[2], 22.5, "0.5*30 + 0.5*15");
  assert.equal(out.length, 3, "one smoothed point per input");
});

test("ewma with alpha=1 is a pass-through; a lower alpha lags more", () => {
  assert.deepEqual(ewma([1, 9, 4], 1), [1, 9, 4]);
  const slow = ewma([0, 100], 0.1);
  const fast = ewma([0, 100], 0.9);
  assert.ok(slow[1] < fast[1], "smaller alpha reacts more slowly");
  assert.deepEqual(ewma([], 0.3), []);
});

test("ewma leaves a constant series unchanged", () => {
  assert.deepEqual(ewma([5, 5, 5, 5], 0.3), [5, 5, 5, 5]);
});

// ─── holtLinear ───────────────────────────────────────────────────────────────

test("holtLinear projects a steady climb forward", () => {
  const h = holtLinear([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(h.trend > 0, "should detect a rising trend");
  assert.ok(h.forecast(5) > h.level, "forecasting ahead continues the climb");
  assert.equal(h.smoothed.length, 10);
});

test("holtLinear detects a falling trend and needs two points", () => {
  const h = holtLinear([100, 90, 80, 70, 60]);
  assert.ok(h.trend < 0);
  assert.equal(holtLinear([1]), null, "a single point has no trend");
  assert.equal(holtLinear([]), null);
});

test("holtLinear holds a flat series flat", () => {
  const h = holtLinear([7, 7, 7, 7, 7]);
  assert.ok(Math.abs(h.trend) < 1e-9);
  assert.ok(Math.abs(h.forecast(10) - 7) < 1e-9, "no drift on flat input");
});

// ─── forecastSeries (disk-full ETA) ───────────────────────────────────────────

const diskEntry = (raw) => ({ deviceId: 1, name: "Server-01", raw });

test("forecastSeries: a steadily filling disk yields a filling status and an ETA", () => {
  // Climbs 1%/hour over 24h, so the LAST sample is 73% — the ETA runs from there,
  // not from the start of the window: (100 − 73) / 1 = 27 hours ≈ 1.13 days.
  const f = forecastSeries(diskEntry(series(24, (i) => 50 + i)), 100);
  assert.equal(f.status, "filling");
  assert.ok(f.etaDays > 0, "an ETA must be produced");
  assert.ok(Math.abs(f.etaDays - 27 / 24) < 0.2, `eta ${f.etaDays} days`);
  assert.equal(f.confidence, "high", "a perfect line is a confident fit");
  assert.ok(f.advice, "a near-term fill should advise action");
});

test("forecastSeries: slope is reported per DAY, not per hour", () => {
  const f = forecastSeries(diskEntry(series(24, (i) => 50 + i)), 100);
  assert.ok(Math.abs(f.slopePerDay - 24) < 0.01, `slopePerDay ${f.slopePerDay}`);
});

test("forecastSeries: a flat disk is stable with no ETA and no advice", () => {
  const f = forecastSeries(diskEntry(series(24, () => 40)), 100);
  assert.equal(f.status, "stable");
  assert.equal(f.etaDays, null);
  assert.equal(f.advice, null);
});

test("forecastSeries: a shrinking disk reports falling", () => {
  const f = forecastSeries(diskEntry(series(24, (i) => 90 - i)), 100);
  assert.equal(f.status, "falling");
  assert.equal(f.etaDays, null);
});

test("forecastSeries: an already-full disk is 'full' — a fact, not a forecast", () => {
  const f = forecastSeries(diskEntry(series(24, (i) => 99 + i * 0.1)), 100);
  assert.equal(f.status, "full");
  assert.equal(f.etaDays, 0);
  assert.equal(f.advice.level, "critical");
});

test("forecastSeries: too few points reports insufficient_data, never a guess", () => {
  const f = forecastSeries(diskEntry(series(MIN_POINTS - 1, (i) => 50 + i)), 100);
  assert.equal(f.status, "insufficient_data");
  assert.equal(f.etaDays, null);
  assert.equal(f.slopePerDay, null);
});

test("forecastSeries: noise with a technically positive slope reports Stable, not a bogus date", () => {
  // The regression here is real arithmetic but the fit is garbage — exactly the case
  // the R² gate exists to suppress (predictive-analytics.md §3).
  const noisy = [12, 88, 15, 91, 9, 84, 20, 79, 11, 95, 14, 86, 18, 90, 8, 93];
  const f = forecastSeries(diskEntry(series(noisy.length, (i) => noisy[i])), 100);
  assert.equal(f.status, "stable", "a low-confidence fit must not produce an ETA");
  assert.equal(f.etaDays, null);
  assert.equal(f.confidence, "low");
});

test("forecastSeries: a fill so slow it lands beyond the horizon reports Stable", () => {
  // ~0.001%/hour → tens of years away. Real slope, meaningless forecast.
  const f = forecastSeries(diskEntry(series(48, (i) => 50 + i * 0.001)), 100);
  assert.equal(f.status, "stable");
  assert.equal(f.etaDays, null);
});

test("forecastSeries: advice escalates from plan-ahead to act-now as the ETA nears", () => {
  const soon = forecastSeries(diskEntry(series(24, (i) => 90 + i * 0.2)), 100);
  assert.equal(soon.advice.level, "critical", "days away = act now");

  // ~0.2%/hour from 50% → last sample 54.6%, so ≈9.5 days out: inside the 30-day
  // plan-ahead band but past the 7-day act-now one.
  const later = forecastSeries(diskEntry(series(24, (i) => 50 + i * 0.2)), 100);
  assert.equal(later.advice?.level, "warning", "weeks away = plan ahead");

  // Beyond 30 days there is nothing to do yet, so no advice is attached at all.
  const distant = forecastSeries(diskEntry(series(24, (i) => 50 + i * 0.05)), 100);
  assert.equal(distant.status, "filling");
  assert.equal(distant.advice, null, "a 40-day horizon needs no action today");
});

test("forecastSeries: unsorted input is sorted before fitting", () => {
  const ordered = series(12, (i) => 50 + i);
  const shuffled = [ordered[5], ordered[0], ordered[11], ...ordered.slice(1, 5), ...ordered.slice(6, 11)];
  const a = forecastSeries(diskEntry(ordered), 100);
  const b = forecastSeries(diskEntry(shuffled), 100);
  assert.equal(b.status, a.status);
  assert.equal(b.etaDays, a.etaDays);
});

test("forecastSeries respects a custom 'full' bound", () => {
  const f = forecastSeries(diskEntry(series(24, (i) => 50 + i)), 90);
  assert.equal(f.full, 90);
  assert.ok(f.etaDays < forecastSeries(diskEntry(series(24, (i) => 50 + i)), 100).etaDays);
});

// ─── projectToBound (UPS battery / link saturation) ───────────────────────────

test("projectToBound down: a declining UPS runtime reaches its floor", () => {
  // Falls 0.5 min/hour over 48h, so the last sample is 36.5 min. From there the
  // 5-minute floor is (36.5 − 5) / 0.5 = 63 hours ≈ 2.6 days away.
  const p = projectToBound(series(48, (i) => 60 - i * 0.5), { bound: 5, direction: "down" });
  assert.equal(p.status, "declining");
  assert.ok(p.etaDays > 0);
  assert.ok(Math.abs(p.etaDays - 63 / 24) < 0.5, `eta ${p.etaDays}`);
});

test("projectToBound down: runtime already at/below the floor is 'reached'", () => {
  const p = projectToBound(series(12, () => 3), { bound: 5, direction: "down" });
  assert.equal(p.status, "reached");
  assert.equal(p.etaDays, 0);
});

test("projectToBound down: a RISING runtime never produces a replacement ETA", () => {
  const p = projectToBound(series(24, (i) => 30 + i), { bound: 5, direction: "down" });
  assert.equal(p.status, "stable");
  assert.equal(p.etaDays, null);
});

test("projectToBound up: climbing link utilization reaches the ceiling", () => {
  // Climbs 0.5%/hour over 48h → last sample 53.5%, so the 90% ceiling is
  // (90 − 53.5) / 0.5 = 73 hours ≈ 3 days out.
  const p = projectToBound(series(48, (i) => 30 + i * 0.5), { bound: 90, direction: "up" });
  assert.equal(p.status, "rising");
  assert.ok(Math.abs(p.etaDays - 73 / 24) < 0.5, `eta ${p.etaDays}`);
});

test("projectToBound up: a saturated link is 'reached'", () => {
  const p = projectToBound(series(12, () => 95), { bound: 90, direction: "up" });
  assert.equal(p.status, "reached");
  assert.equal(p.etaDays, 0);
});

test("projectToBound: the same R² gate applies — bursty traffic gives no date", () => {
  const bursty = [5, 70, 8, 65, 12, 80, 4, 72, 15, 68, 6, 77, 10, 74, 9, 82];
  const p = projectToBound(series(bursty.length, (i) => bursty[i]), { bound: 90, direction: "up" });
  assert.equal(p.status, "stable");
  assert.equal(p.etaDays, null);
});

test("projectToBound: too few points is insufficient_data", () => {
  const p = projectToBound(series(3, (i) => 50 - i), { bound: 5, direction: "down" });
  assert.equal(p.status, "insufficient_data");
  assert.equal(p.etaDays, null);
});

// ─── worstVolumeForecast ──────────────────────────────────────────────────────

test("worstVolumeForecast picks the SOONEST to fill, not the fullest right now", () => {
  const vols = [
    { mount: "C:", currentPercent: 88, etaDays: 40 },
    { mount: "D:", currentPercent: 42, etaDays: 3 },
  ];
  assert.equal(worstVolumeForecast(vols).mount, "D:", "3 days beats 40 even at half the usage");
});

test("worstVolumeForecast falls back to the fullest when nothing has an ETA", () => {
  const vols = [
    { mount: "C:", currentPercent: 71, etaDays: null },
    { mount: "D:", currentPercent: 12, etaDays: null },
  ];
  assert.equal(worstVolumeForecast(vols).mount, "C:");
});

test("worstVolumeForecast prefers a real ETA over a fuller idle volume", () => {
  const vols = [
    { mount: "C:", currentPercent: 95, etaDays: null },
    { mount: "D:", currentPercent: 30, etaDays: 12 },
  ];
  assert.equal(worstVolumeForecast(vols).mount, "D:");
  assert.equal(worstVolumeForecast([]), null);
});

// ─── byEtaAsc ─────────────────────────────────────────────────────────────────

test("byEtaAsc sorts soonest first and sinks 'no ETA' to the bottom", () => {
  const rows = [
    { name: "c", etaDays: null },
    { name: "a", etaDays: 2 },
    { name: "d", etaDays: null },
    { name: "b", etaDays: 9 },
  ];
  assert.deepEqual(rows.sort(byEtaAsc).map((r) => r.name), ["a", "b", "c", "d"]);
});

// ─── window / bucket helpers ──────────────────────────────────────────────────

test("localHour shifts UTC into server-room local time (UTC+8)", () => {
  const utcMidnight = Date.UTC(2026, 0, 1, 0, 0, 0);
  assert.equal(localHour(utcMidnight), 8, "00:00 UTC is 8 AM in Naga");
  assert.equal(localHour(Date.UTC(2026, 0, 1, 18, 0, 0)), 2, "wraps past midnight");
  assert.equal(localHour(Date.UTC(2026, 0, 1, 16, 0, 0)), 0);
});

test("everyForHours widens the bucket as the lookback grows", () => {
  assert.equal(everyForHours(6), "15m");
  assert.equal(everyForHours(24), "15m");
  assert.equal(everyForHours(48), "30m");
  assert.equal(everyForHours(72), "30m");
  assert.equal(everyForHours(168), "1h");
});

test("parseEveryMs understands the bucket strings it is paired with", () => {
  assert.equal(parseEveryMs("15m"), 900_000);
  assert.equal(parseEveryMs("30m"), 1_800_000);
  assert.equal(parseEveryMs("1h"), HOUR);
  assert.equal(parseEveryMs("1d"), 86_400_000);
  assert.equal(parseEveryMs("garbage"), HOUR, "falls back to an hour");
});

test("bucketForDays widens the aggregate so long windows stay a few hundred points", () => {
  assert.equal(bucketForDays(7), "1h");
  assert.equal(bucketForDays(30), "1h");
  assert.equal(bucketForDays(90), "6h");
  assert.equal(bucketForDays(120), "6h");
  assert.equal(bucketForDays(180), "1d");
  assert.equal(bucketForDays(365), "1d");

  // The point of the widening: no window explodes the row count. A 180-day battery
  // window at 1h would be ~4300 points per device; at 1d it is ~180.
  const pointsFor = (d) => (d * 24) / (parseEveryMs(bucketForDays(d)) / HOUR);
  for (const d of [7, 30, 90, 180, 365]) {
    assert.ok(pointsFor(d) <= 800, `${d}d → ${pointsFor(d)} points`);
    assert.ok(pointsFor(d) >= MIN_POINTS, `${d}d → ${pointsFor(d)} points`);
  }
});

test("spanDays reports the ACTUAL history covered, not the window requested", () => {
  // Asking for 180 days but only holding 10 (short retention, or a new device) must
  // report 10 — that gap is the difference between a real forecast and a guess.
  assert.equal(spanDays(series(11, () => 1)), 0.4, "11 hourly points ≈ 0.4 days");
  const tenDays = Array.from({ length: 11 }, (_, i) => ({ t: i * 24 * HOUR, y: 1 }));
  assert.equal(spanDays(tenDays), 10);
  assert.equal(spanDays([]), 0);
  assert.equal(spanDays([{ t: 0, y: 1 }]), 0, "one point spans nothing");
});

test("spanDays is order-independent", () => {
  const pts = [{ t: 5 * 86_400_000, y: 1 }, { t: 0, y: 1 }, { t: 2 * 86_400_000, y: 1 }];
  assert.equal(spanDays(pts), 5);
});

// ─── input clamping (the Flux-injection guarantee) ────────────────────────────

test("clampInt/clampNum coerce junk to the default and bound the range", () => {
  assert.equal(clampInt("14", 1, 90, 30), 14);
  assert.equal(clampInt("999", 1, 90, 30), 90, "clamped to max");
  assert.equal(clampInt("0", 1, 90, 30), 1, "clamped to min");
  assert.equal(clampInt("; drop database", 1, 90, 30), 30, "no number = default");
  assert.equal(clampInt(undefined, 1, 90, 30), 30);
  assert.equal(clampNum("90.5", 50, 100, 90), 90.5);
  assert.equal(clampNum("abc", 50, 100, 90), 90);
});
