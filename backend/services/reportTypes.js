// ─── Report types ─────────────────────────────
// One row per report type: the label, which device types it can be limited to, and
// its builder. These used to be four separate lists in reportService.js, and a
// missing entry in one of them failed quietly. `scope: null` means campus-wide.
// See audits/design-patterns-report-2026-08-25.md (P-08).

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

// ─── Titles ──────────────────────────────────────────────────────────────────

/** `reports.title` is varchar(100). MySQL in non-strict mode truncates anything longer
 *  without complaining, which would clip a control number off the end. */
export const TITLE_MAX = 100;

/**
 * The title a report gets when none was typed. Shared with titleWithReference, which
 * compares against it to detect an automatic title.
 */
export function defaultTitle(type, deviceName) {
  return `${TYPE_LABEL[type] ?? type} Report${deviceName ? ` — ${deviceName}` : ""}`;
}

/**
 * Add the control number to an automatic title. A title someone typed is left as it
 * is. The title is also the download file name, so this keeps downloaded files apart.
 * Detected by comparing with the default title, so no extra column is needed.
 *
 * @param {{title: string, type: string, deviceName?: string|null}} report
 * @param {string|null} reference
 * @returns {string}
 */
export function titleWithReference({ title, type, deviceName }, reference) {
  if (!reference || !title) return title;
  if (title !== defaultTitle(type, deviceName)) return title;

  const suffix = ` (${reference})`;
  const room = TITLE_MAX - suffix.length;
  // Truncate the DESCRIPTION, never the number: a clipped device name is still readable,
  // a clipped control number is simply wrong. Only bites on a very long device name.
  const base = title.length > room ? `${title.slice(0, room - 1).trimEnd()}…` : title;
  return base + suffix;
}

/**
 * Fail at startup if a type has no builder, instead of the report silently failing
 * later. Called once when reportService loads.
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

export default {
  REPORT_TYPE_META,
  REPORT_TYPES,
  TYPE_LABEL,
  SCOPE_TYPES,
  TITLE_MAX,
  defaultTitle,
  titleWithReference,
  assertBuildersComplete,
};
