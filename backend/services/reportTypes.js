// ─── The report-type registry — PURE, import-free ─────────────────────────────
//
// One row per report type. Previously this was FOUR parallel structures in
// reportService.js, all keyed by the same string:
//
//   REPORT_TYPES  (:44)  the valid-type list
//   TYPE_LABEL    (:45)  the human name
//   SCOPE_TYPES   (:58)  which device_types it can be scoped to
//   BUILDERS      (:729) the function that gathers the data
//
// Adding a type meant four edits, and each omission failed differently — three of them
// silently:
//
//   miss REPORT_TYPES → the type is rejected as invalid (loud, at least)
//   miss TYPE_LABEL   → the report title reads "undefined Report"
//   miss BUILDERS     → `BUILDERS[type] is not a function` inside build(), which is
//                       fire-and-forget, so the row just flips to `failed` with nothing
//                       on screen explaining why
//   miss SCOPE_TYPES  → treated as campus-wide, which is EXACTLY what `environment`
//                       relies on — so a forgotten entry is indistinguishable from a
//                       deliberate one
//
// That last case is why this is a registry rather than a convention: `scope: null` now
// states "campus-wide" outright instead of expressing it by absence.
//
// See audits/design-patterns-report-2026-08-25.md — P-08.

/**
 * @typedef {{ label: string, scope: string[] | null }} ReportTypeMeta
 * `scope: null` = campus-wide; scoping it to a device is rejected, not ignored.
 */

/** @type {Record<string, ReportTypeMeta>} */
export const REPORT_TYPE_META = {
  environment: {
    label: "Environment",
    // Describes the server room itself (one sensor cluster), so "which device" is not a
    // meaningful question.
    scope: null,
  },
  server: { label: "Server Metrics", scope: ["server"] },
  network: { label: "Network Traffic", scope: ["router", "mikrotik"] },
  ups: { label: "UPS Power", scope: ["ups"] },
  alerts: {
    label: "Alert History",
    scope: ["server", "router", "mikrotik", "ups", "aircon", "esp32"],
  },
  aircon: { label: "Aircon Activity", scope: ["aircon"] },
  forecast: {
    label: "Capacity Forecast",
    // A forecast can be narrowed to one device, but it spans three classes when unscoped
    // (disk, battery, link) — so every forecastable type is offered.
    scope: ["server", "router", "mikrotik", "ups"],
  },
};

/** Every valid report type. */
export const REPORT_TYPES = Object.keys(REPORT_TYPE_META);

/** type → human label. */
export const TYPE_LABEL = Object.fromEntries(
  REPORT_TYPES.map((t) => [t, REPORT_TYPE_META[t].label]),
);

/**
 * type → allowed device_types. Types with `scope: null` are ABSENT here, which is the
 * shape the existing callers test with `if (!allowed) throw …`.
 */
export const SCOPE_TYPES = Object.fromEntries(
  REPORT_TYPES.filter((t) => REPORT_TYPE_META[t].scope !== null).map((t) => [
    t,
    REPORT_TYPE_META[t].scope,
  ]),
);

/**
 * Fail at STARTUP if a type has no builder, rather than when someone finally generates
 * that report and it silently lands in `failed`.
 *
 * Called once at module load in reportService. Throwing here takes the backend down on
 * boot, which is the right trade: a registry/builder mismatch is a programming error
 * that a developer will see immediately, not a runtime condition to degrade around.
 */
export function assertBuildersComplete(builders) {
  const missing = REPORT_TYPES.filter((t) => typeof builders[t] !== "function");
  if (missing.length) {
    throw new Error(
      `reportTypes: no builder for report type(s): ${missing.join(", ")}. ` +
        `Add one to BUILDERS in reportService.js, or remove the type from REPORT_TYPE_META.`,
    );
  }
  const orphans = Object.keys(builders).filter((t) => !REPORT_TYPE_META[t]);
  if (orphans.length) {
    throw new Error(
      `reportTypes: builder(s) with no registry entry: ${orphans.join(", ")}. ` +
        `Add them to REPORT_TYPE_META or delete them.`,
    );
  }
  return true;
}

export default { REPORT_TYPE_META, REPORT_TYPES, TYPE_LABEL, SCOPE_TYPES, assertBuildersComplete };
