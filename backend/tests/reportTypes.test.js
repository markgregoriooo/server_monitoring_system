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

// Tests for the report-type registry: the derived lists agree, and a type without a
// builder is caught. See audits/design-patterns-report-2026-08-25.md (P-08).

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

// ─── Registry vs the database ENUM ──────────────────────────────
// `reports.type` is an ENUM in the schema. A missing value only fails at INSERT (or is
// stored as '' on a non-strict server), so this checks the two agree, like
// contract.test.js does for the Go agent.

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
// reportService.create needs MySQL and InfluxDB, so the rule is tested here and kept
// next to a copy of the constant. `start < end` alone would accept a 26-year range.

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
