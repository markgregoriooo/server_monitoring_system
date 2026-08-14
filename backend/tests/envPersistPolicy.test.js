import test from "node:test";
import assert from "node:assert/strict";
import { shouldPersist, resolveOptions, DEFAULTS } from "../services/envPersistPolicy.js";

// A stable, clean room — the case the policy exists to make cheap. Every test below is a
// variation on "did something actually happen since this was stored?".
const STORED = {
  at: 1_000_000,
  temperature: 24.0,
  humidity: 55.0,
  mq2_1_ppm: 40,
  mq2_2_ppm: 42,
  heat_index: 25.1,
  smoke_status: "NORMAL",
  temp_status: "NORMAL",
  environment_status: "NORMAL",
};

/** The next 3s reading, unchanged unless a test says otherwise. */
const tick = (over = {}, afterMs = 3_000) => ({ ...STORED, at: STORED.at + afterMs, ...over });

test("an unchanged reading 3s later is not stored", () => {
  const { persist } = shouldPersist(tick(), STORED, DEFAULTS);
  assert.equal(persist, false);
});

test("the heartbeat stores once the interval has elapsed", () => {
  assert.equal(shouldPersist(tick({}, 29_999), STORED, DEFAULTS).persist, false);
  const { persist, reason } = shouldPersist(tick({}, 30_000), STORED, DEFAULTS);
  assert.equal(persist, true);
  assert.equal(reason, "heartbeat");
});

test("a gas rise is stored on the 3s tick that sees it, not 30s later", () => {
  // The reason this policy is safe to run at all: smoke must not wait for the heartbeat.
  const { persist, reason } = shouldPersist(tick({ mq2_1_ppm: 40 + DEFAULTS.gasDeadband }), STORED, DEFAULTS);
  assert.equal(persist, true);
  assert.equal(reason, "gas-1");
});

test("each MQ-2 is judged on its own, not on the max of the two", () => {
  // Two sensors exist to disagree; folding them into a max would hide one drifting.
  const { persist, reason } = shouldPersist(tick({ mq2_2_ppm: 42 + DEFAULTS.gasDeadband }), STORED, DEFAULTS);
  assert.equal(persist, true);
  assert.equal(reason, "gas-2");
});

test("gas noise below the deadband is not stored", () => {
  const { persist } = shouldPersist(tick({ mq2_1_ppm: 40 + DEFAULTS.gasDeadband - 0.1 }), STORED, DEFAULTS);
  assert.equal(persist, false);
});

test("any status transition is stored", () => {
  // The stored history must never disagree with an alert raised from the same reading.
  for (const field of ["smoke_status", "temp_status", "environment_status"]) {
    const { persist, reason } = shouldPersist(tick({ [field]: "WARNING" }), STORED, DEFAULTS);
    assert.equal(persist, true, `${field} transition must be stored`);
    assert.equal(reason, field);
  }
});

test("a real temperature move is stored, quantisation noise is not", () => {
  assert.equal(shouldPersist(tick({ temperature: 24.4 }), STORED, DEFAULTS).persist, false);
  const { persist, reason } = shouldPersist(tick({ temperature: 24.5 }), STORED, DEFAULTS);
  assert.equal(persist, true);
  assert.equal(reason, "temperature");
});

test("a real humidity move is stored", () => {
  assert.equal(shouldPersist(tick({ humidity: 56.9 }), STORED, DEFAULTS).persist, false);
  assert.equal(shouldPersist(tick({ humidity: 57.0 }), STORED, DEFAULTS).reason, "humidity");
});

test("the first reading after a restart is always stored", () => {
  const { persist, reason } = shouldPersist(tick(), null, DEFAULTS);
  assert.equal(persist, true);
  assert.equal(reason, "first-reading");
});

test("a long outage stores immediately on return", () => {
  // The baseline survives a reconnect, so this is covered by the heartbeat gate rather
  // than needing the socket to tell us it dropped.
  const { persist, reason } = shouldPersist(tick({}, 10 * 60_000), STORED, DEFAULTS);
  assert.equal(persist, true);
  assert.equal(reason, "heartbeat");
});

test("interval 0 disables the policy and stores everything", () => {
  const opts = { ...DEFAULTS, intervalMs: 0 };
  const { persist, reason } = shouldPersist(tick(), STORED, opts);
  assert.equal(persist, true);
  assert.equal(reason, "policy-disabled");
});

test("resolveOptions falls back on blank/absent/garbage env values", () => {
  assert.deepEqual(resolveOptions({}), { ...DEFAULTS });
  assert.deepEqual(resolveOptions({ ENV_PERSIST_INTERVAL_MS: "" }), { ...DEFAULTS });
  assert.deepEqual(resolveOptions({ ENV_PERSIST_INTERVAL_MS: "abc" }), { ...DEFAULTS });
  assert.equal(resolveOptions({ ENV_PERSIST_INTERVAL_MS: "60000" }).intervalMs, 60_000);
  // Negative is nonsense; clamp rather than invert the comparison.
  assert.equal(resolveOptions({ ENV_PERSIST_DEADBAND_GAS: "-5" }).gasDeadband, 0);
});

test("a stable room over 30s costs one point, not ten", () => {
  // The headline claim, asserted rather than asserted-in-a-comment.
  let last = STORED;
  let stored = 0;
  for (let i = 1; i <= 10; i++) {
    const s = tick({}, i * 3_000);
    const { persist } = shouldPersist(s, last, DEFAULTS);
    if (persist) { stored++; last = s; }
  }
  assert.equal(stored, 1);
});
