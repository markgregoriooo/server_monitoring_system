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

// ─── Report period width (BL-05) ──────────────────────────────────────────────
//
// `reportService.create` is not import-free (MySQL + InfluxDB), so the RULE is pinned
// here rather than the function. Both must agree; the constant and the comparison are
// duplicated deliberately and kept side by side so a drift is visible in one file.
//
// Why the rule exists: `start < end` alone accepts "2000-01-01", scheduling Flux
// queries over 26 years of history. The build is asynchronous and never throws, so the
// request looks fine while a long query holds one of ten shared pool connections.

const MAX_PERIOD_DAYS = Number(process.env.REPORT_MAX_PERIOD_DAYS) || 366;
const spanDays = (start, end) => (new Date(end) - new Date(start)) / 86_400_000;

test("the default cap is a year — wider than anything the system retains", () => {
  // NOTIFY_RETENTION_DAYS 30 / REPORT_RETENTION_DAYS 90 / SYSTEM_LOG_RETENTION_DAYS 365.
  // The cap must exceed the longest of those or it would refuse a legitimate report.
  assert.ok(MAX_PERIOD_DAYS >= 365, `cap ${MAX_PERIOD_DAYS} is narrower than log retention`);
});

test("an ordinary period is accepted", () => {
  assert.ok(spanDays("2026-08-01", "2026-08-25") <= MAX_PERIOD_DAYS);
  assert.ok(spanDays("2025-09-01", "2026-08-25") <= MAX_PERIOD_DAYS); // ~year, still fine
});

test("the 26-year span that motivated the cap is refused", () => {
  assert.ok(spanDays("2000-01-01", "2026-08-25") > MAX_PERIOD_DAYS);
});

test("the boundary is exclusive — exactly the cap is allowed, one day more is not", () => {
  const base = new Date("2026-01-01T00:00:00Z");
  const atCap = new Date(base.getTime() + MAX_PERIOD_DAYS * 86_400_000);
  const overCap = new Date(base.getTime() + (MAX_PERIOD_DAYS + 1) * 86_400_000);
  assert.ok(!(spanDays(base, atCap) > MAX_PERIOD_DAYS), "exactly the cap must pass");
  assert.ok(spanDays(base, overCap) > MAX_PERIOD_DAYS, "one day over must fail");
});
