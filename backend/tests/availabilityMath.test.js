import test from "node:test";
import assert from "node:assert/strict";
import {
  clampInterval,
  mergeIntervals,
  formatDuration,
  computeAvailability,
} from "../services/availabilityMath.js";

// A 30-day window, the shape a monthly ICTU report actually asks for.
const START = new Date("2026-08-01T00:00:00Z");
const END = new Date("2026-08-31T00:00:00Z");
// A clock well past the window, so `now` never truncates it unless a test says so.
const AFTER = new Date("2026-09-05T00:00:00Z");

const at = (iso) => new Date(iso);
const run = (outages, now = AFTER) =>
  computeAvailability({ periodStart: START, periodEnd: END, outages, now });

// ─── clampInterval ────────────────────────────────────────────────────────────

test("an outage wholly inside the window is kept as-is", () => {
  assert.deepEqual(clampInterval(10, 20, 0, 100), { start: 10, end: 20 });
});

test("an outage that began before the window contributes only its overlap", () => {
  // A server down since last month is not a month of this month's downtime.
  assert.deepEqual(clampInterval(-500, 30, 0, 100), { start: 0, end: 30 });
});

test("an outage running past the window end is cut at the end", () => {
  assert.deepEqual(clampInterval(80, 5000, 0, 100), { start: 80, end: 100 });
});

test("an outage entirely outside the window is dropped", () => {
  assert.equal(clampInterval(200, 300, 0, 100), null);
  assert.equal(clampInterval(-300, -200, 0, 100), null);
});

test("an outage that only touches the boundary is not downtime", () => {
  // Zero-length overlap would otherwise add an incident with no duration.
  assert.equal(clampInterval(100, 150, 0, 100), null);
  assert.equal(clampInterval(-50, 0, 0, 100), null);
});

test("a non-finite bound is refused rather than producing NaN downtime", () => {
  assert.equal(clampInterval(NaN, 20, 0, 100), null);
  assert.equal(clampInterval(10, 20, 0, Number.NaN), null);
});

// ─── mergeIntervals ───────────────────────────────────────────────────────────

test("disjoint outages stay separate", () => {
  assert.deepEqual(mergeIntervals([{ start: 30, end: 40 }, { start: 0, end: 10 }]), [
    { start: 0, end: 10 },
    { start: 30, end: 40 },
  ]);
});

test("overlapping outages fuse into one window", () => {
  assert.deepEqual(mergeIntervals([{ start: 0, end: 20 }, { start: 10, end: 30 }]), [
    { start: 0, end: 30 },
  ]);
});

test("touching outages fuse — one resolving as the next opens is one outage", () => {
  assert.deepEqual(mergeIntervals([{ start: 0, end: 10 }, { start: 10, end: 20 }]), [
    { start: 0, end: 20 },
  ]);
});

test("an outage fully contained in another does not extend it", () => {
  assert.deepEqual(mergeIntervals([{ start: 0, end: 100 }, { start: 20, end: 30 }]), [
    { start: 0, end: 100 },
  ]);
});

test("merge does not mutate its input", () => {
  const input = [{ start: 0, end: 20 }, { start: 10, end: 30 }];
  mergeIntervals(input);
  assert.deepEqual(input, [{ start: 0, end: 20 }, { start: 10, end: 30 }]);
});

// ─── computeAvailability ──────────────────────────────────────────────────────

test("a period with no outages is 100% available", () => {
  const r = run([]);
  assert.equal(r.availabilityPct, 100);
  assert.equal(r.downtimeSec, 0);
  assert.equal(r.incidents, 0);
  assert.equal(r.uptimeSec, r.periodSec);
});

test("one resolved outage produces its own duration as downtime", () => {
  const r = run([{ createdAt: at("2026-08-05T00:00:00Z"), resolvedAt: at("2026-08-05T02:30:00Z") }]);
  assert.equal(r.downtimeSec, 2.5 * 3600);
  assert.equal(r.incidents, 1);
  assert.equal(r.uptimeSec, r.periodSec - 2.5 * 3600);
});

test("an unresolved outage runs to now, not to the end of time", () => {
  const r = computeAvailability({
    periodStart: START,
    periodEnd: END,
    outages: [{ createdAt: at("2026-08-30T00:00:00Z"), resolvedAt: null }],
    now: at("2026-08-30T06:00:00Z"),
  });
  assert.equal(r.downtimeSec, 6 * 3600);
  assert.equal(r.incidents, 1);
});

test("the denominator stops at now, so running a report early cannot inflate uptime", () => {
  // Half a day elapsed, all of it down. Dividing by the full requested period would
  // report ~98% for a server that was down the whole time.
  const r = computeAvailability({
    periodStart: at("2026-08-01T00:00:00Z"),
    periodEnd: at("2026-08-31T00:00:00Z"),
    outages: [{ createdAt: at("2026-08-01T00:00:00Z"), resolvedAt: null }],
    now: at("2026-08-01T12:00:00Z"),
  });
  assert.equal(r.periodSec, 12 * 3600);
  assert.equal(r.downtimeSec, 12 * 3600);
  assert.equal(r.availabilityPct, 0);
});

test("overlapping outages are never double-counted", () => {
  // Two alerts covering 00:00-04:00 and 02:00-06:00 is SIX hours down, not eight.
  const r = run([
    { createdAt: at("2026-08-10T00:00:00Z"), resolvedAt: at("2026-08-10T04:00:00Z") },
    { createdAt: at("2026-08-10T02:00:00Z"), resolvedAt: at("2026-08-10T06:00:00Z") },
  ]);
  assert.equal(r.downtimeSec, 6 * 3600);
  assert.equal(r.incidents, 1, "one continuous outage, however many rows recorded it");
});

test("downtime can never exceed the period, so uptime is never negative", () => {
  // The failure this guards: enough overlapping rows to sum past the window,
  // which would print a negative uptime and an availability below zero.
  const many = Array.from({ length: 40 }, () => ({ createdAt: START, resolvedAt: END }));
  const r = run(many);
  assert.equal(r.downtimeSec, r.periodSec);
  assert.equal(r.uptimeSec, 0);
  assert.equal(r.availabilityPct, 0);
});

test("a brief blip never rounds up to a clean 100%", () => {
  // 30 seconds on a 30-day window is 99.9988%, which two decimals prints as 100 —
  // beside a non-zero downtime column that reads as a contradiction.
  const r = run([{ createdAt: at("2026-08-15T00:00:00Z"), resolvedAt: at("2026-08-15T00:00:30Z") }]);
  assert.equal(r.downtimeSec, 30);
  assert.equal(r.availabilityPct, 99.99);
  assert.ok(r.availabilityPct < 100);
});

test("outages outside the window are ignored entirely", () => {
  const r = run([
    { createdAt: at("2026-07-01T00:00:00Z"), resolvedAt: at("2026-07-02T00:00:00Z") },
    { createdAt: at("2026-09-01T00:00:00Z"), resolvedAt: at("2026-09-02T00:00:00Z") },
  ]);
  assert.equal(r.availabilityPct, 100);
  assert.equal(r.incidents, 0);
});

test("an outage straddling the window start counts only the part inside", () => {
  const r = run([{ createdAt: at("2026-07-31T22:00:00Z"), resolvedAt: at("2026-08-01T02:00:00Z") }]);
  assert.equal(r.downtimeSec, 2 * 3600);
  assert.equal(r.incidents, 1);
});

test("an inverted or zero-length period reports no percentage rather than dividing by zero", () => {
  const r = computeAvailability({ periodStart: END, periodEnd: START, outages: [] });
  assert.equal(r.availabilityPct, null);
  assert.equal(r.periodSec, 0);
  assert.equal(r.incidents, 0);
});

test("distinct outages on different days count as distinct incidents", () => {
  const r = run([
    { createdAt: at("2026-08-05T00:00:00Z"), resolvedAt: at("2026-08-05T01:00:00Z") },
    { createdAt: at("2026-08-12T00:00:00Z"), resolvedAt: at("2026-08-12T01:00:00Z") },
    { createdAt: at("2026-08-20T00:00:00Z"), resolvedAt: at("2026-08-20T01:00:00Z") },
  ]);
  assert.equal(r.incidents, 3);
  assert.equal(r.downtimeSec, 3 * 3600);
});

// ─── formatDuration ───────────────────────────────────────────────────────────

test("durations render at a fixed shape per magnitude, so a column stays comparable", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(45), "45s");
  assert.equal(formatDuration(90), "1m");
  assert.equal(formatDuration(3600), "1h 0m");
  // Exactly one day keeps its zero units — "1d" beside "1d 3h 20m" reads as a
  // truncated cell rather than a shorter duration.
  assert.equal(formatDuration(86400), "1d 0h 0m");
  assert.equal(formatDuration(2 * 86400 + 4 * 3600 + 12 * 60), "2d 4h 12m");
  assert.equal(formatDuration(29 * 86400 + 4 * 3600 + 12 * 60), "29d 4h 12m");
});

test("a negative or junk duration reads as zero, never as NaN in a cell", () => {
  assert.equal(formatDuration(-100), "0s");
  assert.equal(formatDuration(undefined), "0s");
  assert.equal(formatDuration(NaN), "0s");
});
