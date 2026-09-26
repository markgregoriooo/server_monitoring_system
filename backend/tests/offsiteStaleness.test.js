import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveThresholds,
  offsiteSeverity,
  DEFAULT_WARN_HOURS,
  DEFAULT_CRIT_HOURS,
} from "../services/offsiteStaleness.js";

const H = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-26T10:00:00.000Z");
const T = resolveThresholds("", ""); // the defaults: 26 h warning, 72 h critical
const ago = (hours) => NOW - hours * H;

test("blank env gives the documented defaults", () => {
  assert.deepEqual(T, { warnHours: DEFAULT_WARN_HOURS, critHours: DEFAULT_CRIT_HOURS });
  assert.deepEqual(T, { warnHours: 26, critHours: 72 });
});

test("a fresh sync is ok", () => {
  assert.equal(offsiteSeverity(ago(2), NOW, T), "ok");
  assert.equal(offsiteSeverity(ago(26), NOW, T), "ok"); // exactly at the line is not over it
});

test("one missed night is a WARNING — bell only, no email", () => {
  assert.equal(offsiteSeverity(ago(27), NOW, T), "warning");
  assert.equal(offsiteSeverity(ago(71), NOW, T), "warning");
});

test("three missed nights escalates to CRITICAL — the severity that reaches email", () => {
  assert.equal(offsiteSeverity(ago(73), NOW, T), "critical");
  assert.equal(offsiteSeverity(ago(24 * 30), NOW, T), "critical");
});

test("a missing marker is critical at once: the job has never succeeded", () => {
  assert.equal(offsiteSeverity(null, NOW, T), "critical");
  assert.equal(offsiteSeverity(NaN, NOW, T), "critical");
});

test("critHours 0 disables escalation — warning only, the pre-escalation behaviour", () => {
  const off = resolveThresholds("26", "0");
  assert.equal(off.critHours, 0);
  assert.equal(offsiteSeverity(ago(24 * 30), NOW, off), "warning");
  assert.equal(offsiteSeverity(null, NOW, off), "warning");
});

test("a critical threshold below the warning one is lifted to it, never fires first", () => {
  const t = resolveThresholds("48", "12");
  assert.deepEqual(t, { warnHours: 48, critHours: 48 });
  assert.equal(offsiteSeverity(ago(24), NOW, t), "ok");
  assert.equal(offsiteSeverity(ago(49), NOW, t), "critical");
});

test("junk values fall back to the defaults rather than disabling anything", () => {
  assert.deepEqual(resolveThresholds("abc", "-5"), { warnHours: 26, critHours: 72 });
  assert.deepEqual(resolveThresholds("0", "x"), { warnHours: 26, critHours: 72 });
});
