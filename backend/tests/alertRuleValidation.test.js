import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanRule,
  COMPARISONS,
  SEVERITIES,
  severityOrderError,
  duplicateSeverityError,
  scopeConflictError,
} from "../services/alertRuleValidation.js";

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

// ─── Severity ordering within one scope ───────────────────────────────────────
//
// Every test above validates ONE rule in isolation, which is exactly the gap this
// closes: nothing compared a rule against its siblings, so `temperature warning >= 29`
// and `temperature critical >= 29` could both exist. At equal thresholds the warning
// rule is unreachable — worstBreach always returns the more severe band — so it is a
// row that looks like a setting and changes nothing.

const up = (severity, v) => ({ severity, threshold_value: v, comparison: ">=" });
const down = (severity, v) => ({ severity, threshold_value: v, comparison: "<=" });

test("equal thresholds across severities are rejected", () => {
  // The reported case: temperature warning and critical both at 29.
  const why = severityOrderError(up("warning", 29), [up("critical", 29)]);
  assert.ok(why, "expected a rejection");
  assert.match(why, /both be 29/);
});

test("equal is rejected from either direction of the edit", () => {
  // Editing the critical row down onto the warning row is the same fault, and an admin
  // can arrive at it either way round.
  assert.ok(severityOrderError(up("critical", 30), [up("warning", 30)]));
});

test("higher-is-worse: critical must exceed warning", () => {
  assert.equal(severityOrderError(up("warning", 29), [up("critical", 35)]), null);
  const why = severityOrderError(up("warning", 40), [up("critical", 35)]);
  assert.match(why, /must be HIGHER/);
});

test("lower-is-worse: critical must fall below warning", () => {
  // ⚠️ The reason direction is read from `comparison` instead of assumed. ups_runtime /
  // ups_charge use `<=`, where warning 20 / critical 10 is the CORRECT ladder — a
  // hard-coded "critical is the bigger number" would forbid the UPS rules outright.
  assert.equal(severityOrderError(down("warning", 20), [down("critical", 10)]), null);
  const why = severityOrderError(down("warning", 5), [down("critical", 10)]);
  assert.match(why, /must be LOWER/);
});

test("the full info < warning < critical ladder is enforced", () => {
  const siblings = [up("warning", 30), up("critical", 35)];
  assert.equal(severityOrderError(up("info", 25), siblings), null);
  assert.ok(severityOrderError(up("info", 32), siblings), "info above warning must be rejected");
});

test("a scope whose rules disagree on direction is rejected", () => {
  // Ordering a mixed-direction scope is meaningless, and picking the incoming rule's
  // direction would make the verdict depend on which row happened to be edited last.
  const why = severityOrderError(up("warning", 30), [down("critical", 10)]);
  assert.match(why, /must agree on whether a higher or a lower reading is worse/);
});

test("a rule with no siblings is always fine", () => {
  assert.equal(severityOrderError(up("critical", 35), []), null);
  assert.equal(severityOrderError(up("critical", 35)), null);
});

test("same-severity siblings are not an ordering fault", () => {
  // Two rules at the same severity are a duplicate, which is a different problem with a
  // different fix. This check must not mis-report it as an ordering error.
  assert.equal(severityOrderError(up("warning", 30), [up("warning", 31)]), null);
});

test("unparseable siblings and candidates are skipped, not crashed on", () => {
  // The field parsers reject these first; this only proves the ordering check cannot be
  // the thing that throws, since it runs on already-validated input in production but on
  // whatever the caller passes in a test.
  assert.equal(severityOrderError({ severity: "nope", threshold_value: 1, comparison: ">=" }, [up("critical", 2)]), null);
  assert.equal(severityOrderError(up("warning", 30), [{ severity: "critical", threshold_value: "abc", comparison: ">=" }]), null);
});

// ─── Duplicate severity within one scope ──────────────────────────────────────
//
// A different fault from the ladder, with a different fix. Two `temperature warning`
// rules are not additive — `getRoomThresholds` resolves a severity with `.find()`, so the
// value pushed to the ESP32 is decided by row order and editing the losing row changes
// nothing. Backed by a DB uniqueness index too (2026-08-26_alert_rule_scope_uniqueness.sql).

test("a second rule at the same severity is rejected", () => {
  const why = duplicateSeverityError(up("warning", 28), [up("warning", 30)]);
  assert.ok(why);
  assert.match(why, /already exists/);
});

test("a different severity in the same scope is fine", () => {
  assert.equal(duplicateSeverityError(up("info", 25), [up("warning", 30)]), null);
  assert.equal(duplicateSeverityError(up("critical", 35), [up("warning", 30)]), null);
});

test("the duplicate message names the existing threshold, so it can be found", () => {
  // "A rule already exists" with no value sends an admin hunting through a list. The
  // number is what identifies which row they are colliding with.
  assert.match(duplicateSeverityError(up("warning", 28), [up("warning", 31)]), /31/);
});

test("scopeConflictError reports the duplicate BEFORE the ladder", () => {
  // A duplicate is the more actionable of the two: while two warning rules exist, any
  // ladder complaint is about a row that may not even be the one in force. Ordering the
  // messages this way means fixing what the admin is told to fix resolves the next one.
  const siblings = [up("warning", 30), up("critical", 35)];
  const why = scopeConflictError(up("warning", 99), siblings);
  assert.match(why, /already exists/, "duplicate should win over the ladder complaint");
});

test("scopeConflictError still reports a pure ladder fault", () => {
  const why = scopeConflictError(up("warning", 40), [up("critical", 35)]);
  assert.match(why, /must be HIGHER/);
});

test("an unknown severity is left to the field parser", () => {
  assert.equal(duplicateSeverityError({ severity: "fatal", threshold_value: 1 }, [up("warning", 30)]), null);
});
