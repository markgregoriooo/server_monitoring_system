import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveRange,
  windowForSpan,
  PRESET_WINDOW,
  DEFAULT_RANGE,
  MIN_CUSTOM_SPAN_SEC,
} from "../services/snmpUtils.js";

// Range resolution for the network + UPS history endpoints. Pure — no Influx needed.
// Run: cd backend && npm test

// ─── Presets ──────────────────────────────────────────────────────────────────

test("every preset resolves to its whitelisted window", () => {
  for (const [key, every] of Object.entries(PRESET_WINDOW)) {
    const r = resolveRange({ range: key });
    assert.equal(r.rangeExpr, `start: ${key}`);
    assert.equal(r.every, every);
    assert.equal(r.custom, false);
  }
});

test("presets cover 1h through 30d", () => {
  assert.deepEqual(Object.keys(PRESET_WINDOW), ["-1h", "-6h", "-24h", "-7d", "-30d"]);
});

test("every preset lands at a sane point count (~150-200)", () => {
  // A range that returns 6 points is useless and one that returns 40k stalls the
  // browser; this is the invariant that keeps every preset costing the same to draw.
  const secs = { "-1h": 3600, "-6h": 21600, "-24h": 86400, "-7d": 604800, "-30d": 2592000 };
  const windowSec = (w) => {
    const n = parseInt(w, 10);
    return w.endsWith("s") ? n : w.endsWith("m") ? n * 60 : w.endsWith("h") ? n * 3600 : n * 86400;
  };
  for (const [key, every] of Object.entries(PRESET_WINDOW)) {
    const points = secs[key] / windowSec(every);
    assert.ok(points >= 100 && points <= 250, `${key} → ${every} gives ${points} points`);
  }
});

test("an unknown or missing preset falls back to the default instead of erroring", () => {
  for (const bad of [undefined, "", "-99y", "banana", "-1h; drop"]) {
    const r = resolveRange({ range: bad });
    assert.equal(r.rangeExpr, `start: ${DEFAULT_RANGE}`, `input ${JSON.stringify(bad)}`);
    assert.equal(r.custom, false);
  }
});

test("an unknown preset cannot inject Flux — it never reaches the query", () => {
  const r = resolveRange({ range: '-1h) |> yield(name: "x"' });
  assert.equal(r.rangeExpr, "start: -1h");
  assert.ok(!r.rangeExpr.includes("yield"));
});

// ─── Custom windows ───────────────────────────────────────────────────────────

test("a custom window resolves to canonical ISO bounds", () => {
  const r = resolveRange({ start: "2026-08-01T00:00:00Z", stop: "2026-08-02T00:00:00Z" });
  assert.equal(r.custom, true);
  assert.equal(r.startISO, "2026-08-01T00:00:00.000Z");
  assert.equal(r.stopISO, "2026-08-02T00:00:00.000Z");
  assert.equal(r.rangeExpr, 'start: time(v: "2026-08-01T00:00:00.000Z"), stop: time(v: "2026-08-02T00:00:00.000Z")');
});

test("custom bounds are re-serialised, so input text never reaches the query", () => {
  // Date can parse plenty of loose formats; whatever goes in, only a canonical
  // ISO instant comes out — the escaping is incidental, the re-serialisation is
  // the actual defence.
  const r = resolveRange({ start: "2026-08-01T00:00:00+08:00", stop: "2026-08-01T12:00:00+08:00" });
  assert.match(r.rangeExpr, /^start: time\(v: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"\), stop: time\(v: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"\)$/);
});

test("a Flux-injection attempt in a custom bound is rejected, not escaped", () => {
  for (const bad of ['2026-08-01T00:00:00Z") |> yield(name: "x', "banana", "', drop()", true, {}, []]) {
    assert.throws(
      () => resolveRange({ start: bad, stop: "2026-08-02T00:00:00Z" }),
      (e) => e.status === 400,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test("stop defaults to now when only start is given", () => {
  const start = new Date(Date.now() - 3600_000).toISOString();
  const r = resolveRange({ start });
  assert.equal(r.custom, true);
  assert.ok(Math.abs(new Date(r.stopISO).getTime() - Date.now()) < 5000);
});

test("stop without start is rejected — an open-ended window is ambiguous", () => {
  assert.throws(() => resolveRange({ stop: "2026-08-02T00:00:00Z" }), (e) => e.status === 400);
});

test("a reversed or zero-length window is rejected", () => {
  assert.throws(
    () => resolveRange({ start: "2026-08-02T00:00:00Z", stop: "2026-08-01T00:00:00Z" }),
    (e) => e.status === 400 && /earlier/.test(e.message),
  );
  assert.throws(
    () => resolveRange({ start: "2026-08-01T00:00:00Z", stop: "2026-08-01T00:00:00Z" }),
    (e) => e.status === 400,
  );
});

test("a too-short window is rejected before it can ask for a sub-second aggregate", () => {
  const start = "2026-08-01T00:00:00Z";
  const tooShort = new Date(Date.parse(start) + (MIN_CUSTOM_SPAN_SEC - 1) * 1000).toISOString();
  assert.throws(() => resolveRange({ start, stop: tooShort }), (e) => e.status === 400);
  // Exactly at the floor is allowed.
  const atFloor = new Date(Date.parse(start) + MIN_CUSTOM_SPAN_SEC * 1000).toISOString();
  assert.equal(resolveRange({ start, stop: atFloor }).custom, true);
});

test("a window longer than a year is rejected", () => {
  assert.throws(
    () => resolveRange({ start: "2020-01-01T00:00:00Z", stop: "2026-01-01T00:00:00Z" }),
    (e) => e.status === 400 && /year/.test(e.message),
  );
});

test("`start` wins over `range` when both are sent", () => {
  const r = resolveRange({ range: "-24h", start: "2026-08-01T00:00:00Z", stop: "2026-08-02T00:00:00Z" });
  assert.equal(r.custom, true);
  assert.ok(!r.rangeExpr.includes("-24h"));
});

// ─── Window sizing ────────────────────────────────────────────────────────────

test("windowForSpan keeps a custom range at a drawable density", () => {
  const cases = [
    [3600, "21s"],       // 1 hour
    [86400, "8m"],       // 1 day
    [604800, "58m"],     // 1 week
    [2592000, "4h"],     // 30 days
    [31536000, "2d"],    // 1 year
  ];
  for (const [span, expected] of cases) {
    assert.equal(windowForSpan(span), expected, `span ${span}s`);
  }
});

test("windowForSpan never returns a zero or sub-second window", () => {
  for (const span of [1, 10, 60, 120]) {
    const w = windowForSpan(span);
    assert.match(w, /^[1-9]\d*[smhd]$/, `span ${span}s → ${w}`);
  }
});
