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
