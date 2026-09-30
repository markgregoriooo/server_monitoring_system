import test from "node:test";
import assert from "node:assert/strict";
import alertBandState from "../services/alertBandState.js";

// alertBandState is import-free (no MySQL/InfluxDB/.env), so it runs under `npm test`.
// Default ALERT_RECOVERY_SAMPLES = 3 — these assume that.

test("confirmRecovery holds until N consecutive normals, then confirms", () => {
  alertBandState.resetBand(1, "cpu");

  assert.equal(alertBandState.confirmRecovery(1, "cpu"), false, "1st normal: hold");
  assert.equal(alertBandState.confirmRecovery(1, "cpu"), false, "2nd normal: hold");
  assert.equal(alertBandState.confirmRecovery(1, "cpu"), true, "3rd normal: confirmed");

  // Counter resets after confirming, so the next recovery needs a fresh run.
  assert.equal(alertBandState.confirmRecovery(1, "cpu"), false, "streak restarts");
  alertBandState.resetBand(1, "cpu");
});

test("breakRecovery resets the streak — an oscillating metric never confirms", () => {
  alertBandState.resetBand(1, "cpu");

  // Flap: normal, breach, normal, breach… never reaches 3 in a row.
  for (let i = 0; i < 10; i++) {
    assert.equal(alertBandState.confirmRecovery(1, "cpu"), false, `flap ${i}: must not confirm`);
    alertBandState.breakRecovery(1, "cpu");
  }

  // Once it genuinely settles, 3 clean readings confirm.
  assert.equal(alertBandState.confirmRecovery(1, "cpu"), false);
  assert.equal(alertBandState.confirmRecovery(1, "cpu"), false);
  assert.equal(alertBandState.confirmRecovery(1, "cpu"), true, "settled → confirmed");
  alertBandState.resetBand(1, "cpu");
});

test("streaks are per (device, metric) and don't bleed across", () => {
  alertBandState.resetDevice(1);
  alertBandState.resetDevice(2);

  alertBandState.confirmRecovery(1, "cpu");
  alertBandState.confirmRecovery(1, "cpu"); // device 1 cpu at 2/3
  alertBandState.confirmRecovery(1, "mem"); // different metric, own counter
  alertBandState.confirmRecovery(2, "cpu"); // different device, own counter

  assert.equal(alertBandState.confirmRecovery(1, "cpu"), true, "device 1 cpu completes");
  assert.equal(alertBandState.confirmRecovery(1, "mem"), false, "device 1 mem still at 2/3");
  assert.equal(alertBandState.confirmRecovery(2, "cpu"), false, "device 2 cpu still at 2/3");

  alertBandState.resetDevice(1);
  alertBandState.resetDevice(2);
});

test("resetBand / resetDevice clear a partial streak (no stale count after re-arm)", () => {
  alertBandState.resetBand(1, "cpu");
  alertBandState.confirmRecovery(1, "cpu");
  alertBandState.confirmRecovery(1, "cpu"); // 2/3 pending

  alertBandState.resetBand(1, "cpu"); // e.g. an alert was resolved → re-arm
  assert.equal(alertBandState.confirmRecovery(1, "cpu"), false, "counts from zero again");
  assert.equal(alertBandState.confirmRecovery(1, "cpu"), false);
  assert.equal(alertBandState.confirmRecovery(1, "cpu"), true);

  alertBandState.confirmRecovery(3, "disk"); // 1/3 pending
  alertBandState.resetDevice(3);
  assert.equal(alertBandState.confirmRecovery(3, "disk"), false, "resetDevice cleared it too");
  alertBandState.resetDevice(3);
  alertBandState.resetBand(1, "cpu");
});

test("room-level (deviceId null) has its own namespace", () => {
  alertBandState.resetBand(null, "gas");
  alertBandState.resetBand(1, "gas");

  alertBandState.confirmRecovery(null, "gas");
  alertBandState.confirmRecovery(null, "gas"); // room gas at 2/3

  assert.equal(alertBandState.confirmRecovery(1, "gas"), false, "device 1 gas is separate");
  assert.equal(alertBandState.confirmRecovery(null, "gas"), true, "room gas completes");

  alertBandState.resetBand(null, "gas");
  alertBandState.resetBand(1, "gas");
});

test("band tracking still works alongside streaks", () => {
  alertBandState.resetBand(1, "cpu");
  assert.equal(alertBandState.getBand(1, "cpu"), "normal", "missing key defaults to normal");

  alertBandState.setBand(1, "cpu", "critical");
  assert.equal(alertBandState.getBand(1, "cpu"), "critical");

  alertBandState.resetBand(1, "cpu");
  assert.equal(alertBandState.getBand(1, "cpu"), "normal", "resolve re-arms the detector");
});

// ─── settle(): the band to act on for one reading ─────────────────────────────
// Replays the 2026-09-25 case: memory between 88–96% against 80% warning / 95%
// critical. A drop from critical to warning used to close nothing, so the critical
// alert stayed open.

test("settle: critical → warning closes the critical alert after N readings", () => {
  alertBandState.resetDevice(46);
  const s = (prev, band) => alertBandState.settle(46, "mem", prev, band);

  assert.deepEqual(s("critical", "warning"), { effective: "critical", resolveAbove: null }, "1st: hold");
  assert.deepEqual(s("critical", "warning"), { effective: "critical", resolveAbove: null }, "2nd: hold");
  assert.deepEqual(s("critical", "warning"), { effective: "warning", resolveAbove: "warning" },
    "3rd: confirmed — close what outranks warning");
  alertBandState.resetDevice(46);
});

test("settle: a return to normal closes everything", () => {
  alertBandState.resetDevice(46);
  alertBandState.settle(46, "mem", "critical", "normal");
  alertBandState.settle(46, "mem", "critical", "normal");
  assert.deepEqual(alertBandState.settle(46, "mem", "critical", "normal"),
    { effective: "normal", resolveAbove: "normal" });
  alertBandState.resetDevice(46);
});

test("settle: a mixed run of warning and normal readings still confirms the drop", () => {
  alertBandState.resetDevice(46);
  alertBandState.settle(46, "mem", "critical", "warning");
  alertBandState.settle(46, "mem", "critical", "normal");
  const r = alertBandState.settle(46, "mem", "critical", "warning");
  assert.equal(r.effective, "warning", "three readings below critical = confirmed");
  alertBandState.resetDevice(46);
});

test("settle: climbing back to the held band breaks the run", () => {
  alertBandState.resetDevice(46);
  alertBandState.settle(46, "mem", "critical", "warning");
  alertBandState.settle(46, "mem", "critical", "warning");
  assert.deepEqual(alertBandState.settle(46, "mem", "critical", "critical"),
    { effective: "critical", resolveAbove: null }, "back at critical — the streak is gone");
  assert.equal(alertBandState.settle(46, "mem", "critical", "warning").effective, "critical",
    "a fresh run is needed");
  alertBandState.resetDevice(46);
});

test("settle: escalation is instant and never resolves anything", () => {
  alertBandState.resetDevice(46);
  assert.deepEqual(alertBandState.settle(46, "mem", "normal", "critical"),
    { effective: "critical", resolveAbove: null });
  assert.deepEqual(alertBandState.settle(46, "mem", "warning", "critical"),
    { effective: "critical", resolveAbove: null });
  assert.deepEqual(alertBandState.settle(46, "mem", "normal", "normal"),
    { effective: "normal", resolveAbove: null }, "normal → normal is not a recovery");
  alertBandState.resetDevice(46);
});

test("severitiesAbove / worse", () => {
  assert.deepEqual(alertBandState.severitiesAbove("warning"), ["critical"]);
  assert.deepEqual(alertBandState.severitiesAbove("normal"), ["info", "warning", "critical"]);
  assert.deepEqual(alertBandState.severitiesAbove("critical"), []);
  assert.equal(alertBandState.worse("warning", "critical"), "critical");
  assert.equal(alertBandState.worse("critical", "warning"), "critical");
  assert.equal(alertBandState.worse("normal", "info"), "info");
});
