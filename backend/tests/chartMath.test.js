import test from "node:test";
import assert from "node:assert/strict";
import {
  niceMax,
  ticks,
  axisLabel,
  yFor,
  xPositions,
  barLayout,
  labelIndices,
  segments,
} from "../services/chartMath.js";

// ─── niceMax ──────────────────────────────────────────────────────────────────

test("the axis top rounds UP to a round number, never sits on the data", () => {
  // An axis ending exactly at the peak puts that point on the frame, where it reads as
  // clipped rather than as the maximum.
  assert.equal(niceMax(92), 100);
  assert.equal(niceMax(23), 25);
  assert.equal(niceMax(4.2), 5);
  assert.equal(niceMax(140), 200);
  assert.equal(niceMax(0.42), 0.5);
});

test("an exact round value is not inflated to the next decade", () => {
  assert.equal(niceMax(100), 100);
  assert.equal(niceMax(50), 50);
  assert.equal(niceMax(1), 1);
});

test("a flat-zero or unusable series still yields a drawable axis", () => {
  // Dividing by a zero axis top would put every point at NaN and draw nothing.
  for (const bad of [0, -5, NaN, undefined, null, "x"]) {
    const t = niceMax(bad);
    assert.ok(Number.isFinite(t) && t > 0, `${bad} -> ${t}`);
  }
});

// ─── ticks ────────────────────────────────────────────────────────────────────

test("gridlines span 0 to the top inclusive", () => {
  assert.deepEqual(ticks(100, 4), [0, 25, 50, 75, 100]);
  assert.deepEqual(ticks(1, 2), [0, 0.5, 1]);
});

test("tick values are clean, not floating-point noise", () => {
  // 0.1 + 0.2 arithmetic would give 30.000000000000004 on an axis label.
  for (const v of ticks(0.3, 3)) assert.equal(String(v).length <= 6, true, String(v));
});

test("a nonsense axis top still returns something drawable", () => {
  assert.deepEqual(ticks(0, 4), [0, 1]);
  assert.deepEqual(ticks(NaN, 4), [0, 1]);
});

// ─── axisLabel ────────────────────────────────────────────────────────────────

test("labels drop trailing noise but keep meaningful decimals", () => {
  assert.equal(axisLabel(100), "100");
  assert.equal(axisLabel(0.5), "0.5");
  assert.equal(axisLabel(128.4), "128.4");
  assert.equal(axisLabel(NaN), "");
});

test("a fractional gridline keeps its decimals — a rounded one would be a WRONG number", () => {
  // niceMax can return a 2.5x10^n top, giving ticks at 6.25 / 12.5 / 18.75. Rounding
  // those puts an incorrect label against a correctly drawn line.
  assert.equal(axisLabel(12.5), "12.5");
  assert.equal(axisLabel(6.25), "6.25");
  assert.equal(axisLabel(18.75), "18.75");
  // Past a thousand a fraction cannot matter to the reading.
  assert.equal(axisLabel(1234.5), "1235");
});

// ─── yFor ─────────────────────────────────────────────────────────────────────

test("a bigger value sits HIGHER on the page — a smaller y", () => {
  // PDF coordinates grow downward. Getting this backwards draws every chart upside
  // down while every number in it stays correct.
  const top = yFor(100, 100, 50, 200);
  const bottom = yFor(0, 100, 50, 200);
  assert.equal(top, 50, "the maximum sits on the top edge");
  assert.equal(bottom, 250, "zero sits on the bottom edge");
  assert.ok(yFor(75, 100, 50, 200) < yFor(25, 100, 50, 200));
});

test("the midpoint lands halfway", () => {
  assert.equal(yFor(50, 100, 0, 200), 100);
});

test("values beyond the axis are clamped inside the box, never drawn outside it", () => {
  assert.equal(yFor(150, 100, 0, 200), 0);
  assert.equal(yFor(-20, 100, 0, 200), 200);
});

test("a missing value falls to the baseline rather than to NaN", () => {
  assert.equal(yFor(null, 100, 0, 200), 200);
  assert.equal(yFor(undefined, 100, 0, 200), 200);
});

// ─── xPositions ───────────────────────────────────────────────────────────────

test("points span the full width, first on the left edge and last on the right", () => {
  assert.deepEqual(xPositions(3, 0, 100), [0, 50, 100]);
});

test("a single point is centred, not pinned to the axis", () => {
  // One sample hard against the left edge reads as a series that got cut off.
  assert.deepEqual(xPositions(1, 0, 100), [50]);
});

test("an empty series yields no positions", () => {
  assert.deepEqual(xPositions(0, 0, 100), []);
});

// ─── barLayout ────────────────────────────────────────────────────────────────

test("bars share their group's slot and leave a gap between groups", () => {
  const { groupW, barW, gap } = barLayout(4, 2, 400);
  assert.equal(groupW, 100);
  assert.equal(gap, 25);
  assert.equal(barW, 37.5);
  assert.ok(barW * 2 + gap <= groupW + 0.001, "bars plus gap fit inside the slot");
});

test("bar width never collapses to zero or negative", () => {
  const { barW } = barLayout(200, 4, 100);
  assert.ok(barW >= 1);
});

// ─── labelIndices ─────────────────────────────────────────────────────────────

test("a short series labels every point", () => {
  assert.deepEqual([...labelIndices(5, 8)].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
});

test("a long series is thinned but ALWAYS keeps the first and last", () => {
  // Those two are what tell a reader what period the chart covers.
  const idx = labelIndices(30, 6);
  assert.ok(idx.has(0), "first labelled");
  assert.ok(idx.has(29), "last labelled");
  assert.ok(idx.size <= 8, `thinned to ${idx.size}`);
});

test("an empty series labels nothing", () => {
  assert.equal(labelIndices(0).size, 0);
});

// ─── segments ─────────────────────────────────────────────────────────────────

test("a gap BREAKS the line rather than being bridged", () => {
  // Joining across a missing day draws a straight segment through time nothing was
  // measured in, which a reader takes for a measurement.
  assert.deepEqual(segments([1, 2, null, 4, 5]), [
    { start: 0, values: [1, 2] },
    { start: 3, values: [4, 5] },
  ]);
});

test("a fully populated series is one run", () => {
  assert.deepEqual(segments([1, 2, 3]), [{ start: 0, values: [1, 2, 3] }]);
});

test("non-numbers count as gaps, including NaN and strings", () => {
  assert.deepEqual(segments([NaN, "5", 3]), [{ start: 2, values: [3] }]);
});

test("an all-empty series has no runs to draw", () => {
  assert.deepEqual(segments([null, undefined, NaN]), []);
  assert.deepEqual(segments([]), []);
  assert.deepEqual(segments(undefined), []);
});
