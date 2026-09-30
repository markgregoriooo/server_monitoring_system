import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDeviceTime,
  DEVICE_UTC_OFFSET,
  MAX_FUTURE_MS,
  MAX_AGE_MS,
} from "../services/backfillTime.js";

// A fixed "now" so none of these drift with the wall clock.
const NOW = Date.parse("2026-08-21T05:14:20.000Z"); // 13:14:20 +08:00

test("a naked device timestamp is read as Philippine time, not the server's timezone", () => {
  // This is the assertion that would fail if someone dropped the offset and let
  // `new Date()` adopt the backend's zone: on a UTC host the row would land 8h early.
  const { at, reason } = parseDeviceTime("2026-08-21 13:14:20", NOW);
  assert.equal(reason, "ok");
  assert.equal(at.toISOString(), "2026-08-21T05:14:20.000Z");
});

test("the 'T' separator is accepted too, and matches the space form exactly", () => {
  const a = parseDeviceTime("2026-08-21 13:14:20", NOW).at;
  const b = parseDeviceTime("2026-08-21T13:14:20", NOW).at;
  assert.equal(a.getTime(), b.getTime());
});

test("a timestamp that already carries a zone is left alone", () => {
  const { at, reason } = parseDeviceTime("2026-08-21T05:14:20Z", NOW);
  assert.equal(reason, "ok");
  assert.equal(at.toISOString(), "2026-08-21T05:14:20.000Z");
});

test("the uptime fallback is reported as no-clock, not as a bad date", () => {
  // Separate from "unparseable": the RTC had no time, which points at the coin cell.
  const { at, reason } = parseDeviceTime("UP 00:12:33", NOW);
  assert.equal(at, null);
  assert.equal(reason, "no-clock");
});

test("garbage is unparseable", () => {
  for (const bad of ["", "   ", "not a date", "2026-13-45 99:99:99", null, undefined, 42]) {
    const { at, reason } = parseDeviceTime(bad, NOW);
    assert.equal(at, null, `expected null for ${JSON.stringify(bad)}`);
    assert.equal(reason, "unparseable", `expected unparseable for ${JSON.stringify(bad)}`);
  }
});

test("a row from the firmware's build date is refused, not written as history", () => {
  // Dead coin cell: the firmware sets the clock to its build date, which gives a valid
  // date that is wrong.
  const buildDate = new Date(NOW - MAX_AGE_MS - 86_400_000).toISOString();
  const { at, reason } = parseDeviceTime(buildDate, NOW);
  assert.equal(at, null);
  assert.equal(reason, "stale");
});

test("a plausibly long outage still replays", () => {
  // Three weeks is well inside the buffer's sizing, and must not be mistaken for a
  // clock fault — the guard exists to catch wrong dates, not long outages.
  const threeWeeks = new Date(NOW - 21 * 86_400_000).toISOString();
  assert.equal(parseDeviceTime(threeWeeks, NOW).reason, "ok");
});

test("a clock running ahead is refused, with a little tolerance for skew", () => {
  const justInside = new Date(NOW + MAX_FUTURE_MS - 1000).toISOString();
  assert.equal(parseDeviceTime(justInside, NOW).reason, "ok");

  const wayAhead = new Date(NOW + 60 * 60 * 1000).toISOString();
  assert.equal(parseDeviceTime(wayAhead, NOW).reason, "future");
});

test("the boundaries themselves are inclusive on the accepting side", () => {
  const exactlyMaxAge = new Date(NOW - MAX_AGE_MS).toISOString();
  assert.equal(parseDeviceTime(exactlyMaxAge, NOW).reason, "ok");

  const oneMsPast = new Date(NOW - MAX_AGE_MS - 1).toISOString();
  assert.equal(parseDeviceTime(oneMsPast, NOW).reason, "stale");
});

test("the offset constant is the one the firmware compiles in", () => {
  // If the ESP32's configTime offset ever changes, this pair must change together —
  // the test is here so the second half is not forgotten.
  assert.equal(DEVICE_UTC_OFFSET, "+08:00");
});
