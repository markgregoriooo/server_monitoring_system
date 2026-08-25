import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPORT_TYPE_META,
  REPORT_TYPES,
  TYPE_LABEL,
  SCOPE_TYPES,
  assertBuildersComplete,
} from "../services/reportTypes.js";

// The report-type registry replaced four parallel maps in reportService.js. These tests
// pin the two things that made the old shape dangerous: that the derived views still
// agree with each other, and that a type without a builder is caught loudly.
// See audits/design-patterns-report-2026-08-25.md — P-08.

test("every registered type has a label", () => {
  for (const t of REPORT_TYPES) {
    assert.equal(typeof TYPE_LABEL[t], "string", `${t} has no label`);
    assert.ok(TYPE_LABEL[t].length > 0, `${t} has an empty label`);
  }
});

test("the derived views cover exactly the registry", () => {
  assert.deepEqual(REPORT_TYPES, Object.keys(REPORT_TYPE_META));
  assert.deepEqual(Object.keys(TYPE_LABEL).sort(), [...REPORT_TYPES].sort());
});

test("campus-wide types are ABSENT from SCOPE_TYPES, not empty in it", () => {
  // The callers test `if (!allowed) throw` — an empty array would pass that check and
  // silently allow scoping a room-level report to a device.
  assert.equal(SCOPE_TYPES.environment, undefined);
  assert.equal(REPORT_TYPE_META.environment.scope, null, "null states it outright");
  for (const [t, scope] of Object.entries(SCOPE_TYPES)) {
    assert.ok(Array.isArray(scope) && scope.length > 0, `${t} has an unusable scope list`);
  }
});

test("every scoped type lists real device_type values", () => {
  const KNOWN = new Set(["server", "router", "mikrotik", "ups", "aircon", "esp32"]);
  for (const [t, scope] of Object.entries(SCOPE_TYPES)) {
    for (const d of scope) {
      assert.ok(KNOWN.has(d), `${t} scopes to unknown device_type "${d}"`);
    }
  }
});

test("assertBuildersComplete accepts a complete set", () => {
  const builders = Object.fromEntries(REPORT_TYPES.map((t) => [t, () => {}]));
  assert.equal(assertBuildersComplete(builders), true);
});

test("assertBuildersComplete rejects a missing builder", () => {
  const builders = Object.fromEntries(REPORT_TYPES.map((t) => [t, () => {}]));
  delete builders.forecast;
  assert.throws(() => assertBuildersComplete(builders), /no builder for report type\(s\): forecast/);
});

test("assertBuildersComplete rejects a builder with no registry entry", () => {
  const builders = Object.fromEntries(REPORT_TYPES.map((t) => [t, () => {}]));
  builders.somethingNew = () => {};
  assert.throws(() => assertBuildersComplete(builders), /no registry entry: somethingNew/);
});

// ─── Contract: the registry vs the DATABASE enum ──────────────────────────────
//
// `reports.type` is an ENUM in the schema, which makes the SQL a FIFTH place the report
// types are written down — and the one the registry cannot derive from. An enum that
// lacks a type does not fail at boot like a missing builder does: `create()` passes
// validation, then the INSERT is rejected (or, on a non-strict server, silently coerced
// to ''), so the failure appears at the database and points nowhere useful.
//
// Same tactic as tests/contract.test.js, which parses the Go agent's metrics.go and fails
// when its json tags drift from NUMERIC_FIELDS. A drift test beats a comment.

const SCHEMA = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "v13_cspc-ictu-monitoring-system.sql",
);

function reportsEnumValues() {
  const sql = fs.readFileSync(SCHEMA, "utf8");
  const create = sql.slice(sql.indexOf("CREATE TABLE `reports`"));
  const m = create.match(/`type`\s+enum\(([^)]*)\)/i);
  if (!m) return null;
  return m[1].split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
}

test("the reports.type SQL enum matches the registry exactly", () => {
  const enumValues = reportsEnumValues();
  assert.ok(enumValues, "could not find the `type` enum in CREATE TABLE `reports`");

  const inSqlOnly = enumValues.filter((v) => !REPORT_TYPES.includes(v));
  const inCodeOnly = REPORT_TYPES.filter((v) => !enumValues.includes(v));

  assert.deepEqual(
    inCodeOnly, [],
    `Report type(s) in REPORT_TYPE_META but NOT in the reports.type enum: ${inCodeOnly.join(", ")}. ` +
    "Generating one would pass validation and then be rejected by the INSERT. " +
    "Add a migration widening the enum.",
  );
  assert.deepEqual(
    inSqlOnly, [],
    `Report type(s) in the reports.type enum but NOT in REPORT_TYPE_META: ${inSqlOnly.join(", ")}. ` +
    "Either add a registry entry (with a builder) or narrow the enum.",
  );
});
