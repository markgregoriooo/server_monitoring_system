import test from "node:test";
import assert from "node:assert/strict";
import { cleanRule, COMPARISONS, SEVERITIES } from "../services/alertRuleValidation.js";

// Characterisation tests for the alert-rule gate. Written to pin the behaviour of the
// original alertRulesService.clean() BEFORE it was turned into a spec table, so the
// refactor could be proven not to change what gets accepted or rejected.
//
// This is the only validation standing between a client payload and `alert_rules`, and
// alerting is rules-only: a rule that slips through wrong is a silent alarm or a false
// one. See audits/code-complexity-report-2026-08-25.md — C-01.

const VALID = {
  metricName: "cpu",
  thresholdValue: 80,
  comparison: ">=",
  severity: "warning",
};

test("create: a minimal valid rule normalises to its column shape", () => {
  assert.deepEqual(cleanRule(VALID), {
    device_id: null,
    interface_name: null,
    metric_name: "cpu",
    threshold_value: 80,
    comparison: ">=",
    severity: "warning",
    is_active: 1,
  });
});

test("create: omitting any required field throws 400", () => {
  for (const key of ["metricName", "thresholdValue", "comparison", "severity"]) {
    const payload = { ...VALID };
    delete payload[key];
    assert.throws(() => cleanRule(payload), (e) => e.status === 400, `${key} should be required`);
  }
});

test("create: optional fields take their defaults", () => {
  const out = cleanRule(VALID);
  assert.equal(out.device_id, null, "omitted deviceId = global default");
  assert.equal(out.interface_name, null);
  assert.equal(out.is_active, 1, "rules are active unless said otherwise");
});

test("patch: absent fields are left out entirely, not defaulted", () => {
  assert.deepEqual(cleanRule({}, { partial: true }), {});
  assert.deepEqual(cleanRule({ severity: "critical" }, { partial: true }), { severity: "critical" });
});

test("metricName is lower-cased and trimmed", () => {
  assert.equal(cleanRule({ ...VALID, metricName: "  Router_CPU  " }).metric_name, "router_cpu");
});

test("metricName rejects empty and over-long values", () => {
  for (const bad of ["", "   ", "x".repeat(51)]) {
    assert.throws(() => cleanRule({ ...VALID, metricName: bad }), (e) => e.status === 400);
  }
});

test("deviceId accepts an integer, null and empty string; rejects anything else", () => {
  assert.equal(cleanRule({ ...VALID, deviceId: 7 }).device_id, 7);
  assert.equal(cleanRule({ ...VALID, deviceId: "7" }).device_id, 7, "numeric strings are coerced");
  assert.equal(cleanRule({ ...VALID, deviceId: null }).device_id, null);
  assert.equal(cleanRule({ ...VALID, deviceId: "" }).device_id, null, "empty string = global");
  for (const bad of [1.5, "abc", {}]) {
    assert.throws(() => cleanRule({ ...VALID, deviceId: bad }), (e) => e.status === 400);
  }
});

test("thresholdValue rejects non-finite numbers", () => {
  assert.equal(cleanRule({ ...VALID, thresholdValue: "42.5" }).threshold_value, 42.5);
  for (const bad of ["abc", NaN, Infinity]) {
    assert.throws(() => cleanRule({ ...VALID, thresholdValue: bad }), (e) => e.status === 400);
  }
});

test("comparison and severity are closed vocabularies", () => {
  for (const op of COMPARISONS) {
    assert.equal(cleanRule({ ...VALID, comparison: op }).comparison, op);
  }
  for (const sev of SEVERITIES) {
    assert.equal(cleanRule({ ...VALID, severity: sev }).severity, sev);
  }
  // '=' is deliberately unsupported — it gives no useful hysteresis.
  assert.throws(() => cleanRule({ ...VALID, comparison: "=" }), (e) => e.status === 400);
  assert.throws(() => cleanRule({ ...VALID, severity: "fatal" }), (e) => e.status === 400);
});

test("isActive is coerced to 0/1", () => {
  assert.equal(cleanRule({ ...VALID, isActive: true }).is_active, 1);
  assert.equal(cleanRule({ ...VALID, isActive: false }).is_active, 0);
  assert.equal(cleanRule({ ...VALID, isActive: 0 }).is_active, 0);
});

test("interfaceName trims, nulls the empty case, and caps at 50", () => {
  assert.equal(cleanRule({ ...VALID, deviceId: 3, interfaceName: " ether1 " }).interface_name, "ether1");
  assert.equal(cleanRule({ ...VALID, interfaceName: "" }).interface_name, null);
  assert.equal(cleanRule({ ...VALID, interfaceName: null }).interface_name, null);
  assert.throws(
    () => cleanRule({ ...VALID, deviceId: 3, interfaceName: "x".repeat(51) }),
    (e) => e.status === 400,
  );
});

test("a port-scoped rule without a device is rejected", () => {
  assert.throws(
    () => cleanRule({ ...VALID, interfaceName: "ether1" }),
    (e) => e.status === 400 && /needs a device/.test(e.message),
  );
});

test("cross-field validation sees the MERGED row on a patch", () => {
  // Patch adds only the port; the device comes from the existing row → allowed.
  assert.doesNotThrow(() =>
    cleanRule({ interfaceName: "ether1" }, { partial: true, existing: { device_id: 4 } }));
  // Existing row is global, patch adds only a port → still rejected.
  assert.throws(
    () => cleanRule({ interfaceName: "ether1" }, { partial: true, existing: { device_id: null } }),
    (e) => e.status === 400,
  );
});
