import test from "node:test";
import assert from "node:assert/strict";
import { normalizeGas, worstGas, legacyFields } from "../services/gasReadings.js";

test("legacy two-field payload maps to channels 1 and 2", () => {
  const r = normalizeGas({ mq2_1_ppm: 38.2, mq2_2_ppm: 41 }, [1, 2]);
  assert.deepEqual(r, [
    { channel: 1, ppm: 38.2 },
    { channel: 2, ppm: 41 },
  ]);
});

test("new array payload maps by index+1", () => {
  const r = normalizeGas({ gas_ppm: [10, 20, 30, 40] }, [1, 2, 3, 4]);
  assert.deepEqual(r.map((x) => x.channel), [1, 2, 3, 4]);
  assert.equal(r[2].ppm, 30);
});

test("the array wins when a device sends both shapes", () => {
  // A reflashed ESP32 keeps sending the legacy pair so an un-upgraded backend still works.
  // The backend must not then count channel 1 twice or prefer the narrower shape.
  const r = normalizeGas({ gas_ppm: [11, 22, 33], mq2_1_ppm: 99, mq2_2_ppm: 98 }, [1, 2, 3]);
  assert.deepEqual(r, [
    { channel: 1, ppm: 11 },
    { channel: 2, ppm: 22 },
    { channel: 3, ppm: 33 },
  ]);
});

test("a channel nobody has confirmed is wired is DROPPED, not trusted", () => {
  // The safety property. An unwired ADC pin floats and reads noise, and MQ-2 noise through an
  // exponential curve is a plausible ppm — it must never be able to raise a smoke alarm.
  const r = normalizeGas({ gas_ppm: [10, 20, 9999, 8888] }, [1, 2]);
  assert.deepEqual(r.map((x) => x.channel), [1, 2]);
});

test("non-finite readings are dropped", () => {
  const r = normalizeGas({ gas_ppm: [10, null, undefined, NaN, "x"] }, [1, 2, 3, 4, 5]);
  assert.deepEqual(r, [{ channel: 1, ppm: 10 }]);
});

test("no enabled channels means no readings at all", () => {
  assert.deepEqual(normalizeGas({ mq2_1_ppm: 500, mq2_2_ppm: 600 }, []), []);
});

test("worstGas takes the MAX, never the mean", () => {
  // Coverage logic: averaging would let one sensor sit in a fire while the others dilute it
  // below the threshold.
  const w = worstGas([
    { channel: 1, ppm: 30 },
    { channel: 2, ppm: 420 },
    { channel: 3, ppm: 35 },
  ]);
  assert.equal(w.ppm, 420);
  assert.equal(w.channel, 2, "must name WHICH sensor, for the alert text");
});

test("worstGas on nothing is null, so the caller can skip the metric", () => {
  // Returning 0 would let an all-clear resolve a smoke alert on no evidence.
  assert.equal(worstGas([]), null);
});

test("legacyFields mirrors only channels 1 and 2", () => {
  const f = legacyFields([
    { channel: 1, ppm: 12 },
    { channel: 2, ppm: 13 },
    { channel: 3, ppm: 14 },
  ]);
  assert.deepEqual(f, { mq2_1_ppm: 12, mq2_2_ppm: 13 });
});

test("a disabled channel 2 leaves its legacy field ABSENT, not zero", () => {
  // Written as a gap rather than a 0 — a zero would drag every mean() over the range down and
  // quietly halve the room's reported gas level.
  const f = legacyFields([{ channel: 1, ppm: 12 }]);
  assert.deepEqual(f, { mq2_1_ppm: 12 });
  assert.equal("mq2_2_ppm" in f, false);
});
