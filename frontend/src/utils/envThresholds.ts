// Temperature, humidity and gas colours from the room alert rules (`alert_rules`, global
// `device_id = NULL`), the same numbers sent to the ESP32 as `envConfig` and used for
// alerts. A reading turns orange when the warning fires and red when the critical does,
// so one rule change moves the alert, the device LED and the dashboard together.
//
// `utils/tempZone.ts` colours temperature by the auto-cooling zones, but only on the
// AirConditioner page; every other page uses the alert rules here. No imports.

/** The `envConfig` shape. Every field is optional: alerting is RULES-ONLY, so a metric
 *  with no rule has no threshold and correctly never colours. */
export interface RoomThresholds {
  tempWarn?: number;
  tempCrit?: number;
  gasWarn?: number;
  gasCrit?: number;
  humWarn?: number;
  humCrit?: number;
}

/**
 * The values seeded in `v13_cspc-ictu-monitoring-system.sql`, used only until the real
 * rules load (or if loading fails), so a smoke reading is never shown green meanwhile.
 */
export const ROOM_THRESHOLD_FALLBACK: RoomThresholds = {
  tempWarn: 27,
  tempCrit: 32,
  gasWarn: 150,
  gasCrit: 300,
  humWarn: 60,
  humCrit: 80,
};

export type EnvBand = "normal" | "warning" | "critical";

/**
 * Statuses the ESP32 reports in `smoke_status` / `environment_status`: the three
 * alert_rules severities in upper case. `temp_status` adds TOO_COLD, which has no rule.
 */
export type EnvStatus = "NORMAL" | "WARNING" | "CRITICAL";
export type TempStatus = "TOO_COLD" | EnvStatus;

/**
 * Firmware before 2026-08-15 used DANGER as the top band (and a middle DANGER band on
 * `temp_status`). These are InfluxDB tags, so old history keeps them. Normalising here
 * means everything downstream only sees the three current values.
 */
export function normalizeStatus(s: string | null | undefined): string | null {
  if (s == null) return null;
  return s === "DANGER" ? "CRITICAL" : s;
}

// Status colours from CLAUDE.md, shared with utils/tempZone.ts. `critical` is #E02F44
// (CRITICAL), not #F2495C (DANGER), which is also too close to MQ2-2's pink (#F472B6)
// to show a breach.
const BAND_COLOR: Record<EnvBand, string> = {
  normal:   "#73BF69",
  warning:  "#FF780A",
  critical: "#E02F44",
};

const BAND_LABEL: Record<EnvBand, string> = {
  normal:   "NORMAL",
  warning:  "WARNING",
  critical: "CRITICAL",
};

/** Fallback for "--" — no reading yet, or the ESP32 has stopped reporting. */
const MUTED = "#6B7280";

/**
 * Which band a value is in, given warning and critical bounds.
 *
 * Always higher-is-worse (`>=`), like every seeded temperature, gas and humidity rule,
 * the firmware (`t >= TEMP_WARNING`) and alertRulesService.compare. The direction is not
 * guessed from the numbers: an earlier version did, and setting a low critical value to
 * test a rule scrambled every band. A lower-is-worse room rule would need
 * `alert_rules.comparison` passed through getRoomThresholds(), which is also the ESP32's
 * `envConfig` format.
 *
 * Critical is checked first so the worse band wins. A missing bound is never crossed
 * (no rule, no colour).
 */
export function bandFor(
  value: number,
  warn?: number,
  crit?: number,
): EnvBand {
  const crossed = (bound?: number) => bound != null && value >= bound;

  if (crossed(crit)) return "critical";
  if (crossed(warn)) return "warning";
  return "normal";
}

function colorFor(
  v: number | string | null | undefined,
  warn: number | undefined,
  crit: number | undefined,
  fallback: string,
): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return BAND_COLOR[bandFor(v, warn, crit)];
}

function labelFor(
  v: number | string | null | undefined,
  warn: number | undefined,
  crit: number | undefined,
): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return BAND_LABEL[bandFor(v, warn, crit)];
}

/**
 * Colour for a series that shares a chart with another: its own colour while normal,
 * the alarm colour once a threshold is crossed. Otherwise two normal lines on one chart
 * (humidity with temperature, or the two MQ-2 lines) would both be green. Temperature's
 * line uses the full band colours instead (temperatureColor), since it has an axis to
 * itself.
 */
export function alertTint(
  v: number | string | null | undefined,
  warn: number | undefined,
  crit: number | undefined,
  identity: string,
  fallback: string = MUTED,
): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const band = bandFor(v, warn, crit);
  return band === "normal" ? identity : BAND_COLOR[band];
}

/**
 * Temperature also has TOO COLD. There is no alert rule for it (the rules only cover
 * the hot side, seeded >= 27 warning, >= 32 critical); the firmware keeps its compiled
 * TEMP_COLD of 22 °C (not changed by `envConfig`) and shows blue there. This mirrors it;
 * change both together (`iot/esp32/env_monitor_v2/env_monitor_v2.ino`, `TEMP_COLD`).
 */
export const TEMP_COLD_BELOW = 22;

export type TempBand = "too_cold" | "normal" | "warning" | "critical";

const TEMP_BAND_COLOR: Record<TempBand, string> = {
  too_cold: "#5794F2", // blue
  normal:   "#73BF69", // green
  warning:  "#FF780A", // orange
  critical: "#E02F44", // red
};

const TEMP_BAND_LABEL: Record<TempBand, string> = {
  too_cold: "TOO COLD",
  normal:   "NORMAL",
  warning:  "WARNING",
  critical: "CRITICAL",
};

/**
 * Which band a temperature is in: the alert rules on the hot side, the firmware's cold
 * limit on the other. Hot wins if they ever overlap.
 */
export function tempBand(
  t: number,
  th: RoomThresholds = ROOM_THRESHOLD_FALLBACK,
  coldBelow: number = TEMP_COLD_BELOW,
): TempBand {
  const band = bandFor(t, th.tempWarn, th.tempCrit);
  if (band !== "normal") return band;
  return t < coldBelow ? "too_cold" : "normal";
}

/** Colour for a temperature reading, per the `temperature` alert rules (+ the cold edge). */
export function temperatureColor(
  t: number | string | null | undefined,
  th: RoomThresholds = ROOM_THRESHOLD_FALLBACK,
  fallback: string = MUTED,
): string {
  if (typeof t !== "number" || !Number.isFinite(t)) return fallback;
  return TEMP_BAND_COLOR[tempBand(t, th)];
}

/** Band name for a temperature reading, or null when there is no reading to describe. */
export function temperatureLabel(
  t: number | string | null | undefined,
  th: RoomThresholds = ROOM_THRESHOLD_FALLBACK,
): string | null {
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  return TEMP_BAND_LABEL[tempBand(t, th)];
}

/**
 * `#RRGGBB` → `rgba(r,g,b,alpha)` for chart fills (Chart.js gradients need rgba stops).
 * Anything that is not a 6-digit hex is returned unchanged.
 */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h!, 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Colour for a gas reading (ppm), per the global `gas` rules. */
export function gasColor(
  ppm: number | string | null | undefined,
  t: RoomThresholds = ROOM_THRESHOLD_FALLBACK,
  fallback: string = MUTED,
): string {
  return colorFor(ppm, t.gasWarn, t.gasCrit, fallback);
}

/** Colour for a humidity reading (%), per the global `humidity` rules. */
export function humidityColor(
  pct: number | string | null | undefined,
  t: RoomThresholds = ROOM_THRESHOLD_FALLBACK,
  fallback: string = MUTED,
): string {
  return colorFor(pct, t.humWarn, t.humCrit, fallback);
}

/** Band name for a gas reading, or null when there is no reading to describe. */
export function gasLabel(
  ppm: number | string | null | undefined,
  t: RoomThresholds = ROOM_THRESHOLD_FALLBACK,
): string | null {
  return labelFor(ppm, t.gasWarn, t.gasCrit);
}

/** Band name for a humidity reading, or null when there is no reading to describe. */
export function humidityLabel(
  pct: number | string | null | undefined,
  t: RoomThresholds = ROOM_THRESHOLD_FALLBACK,
): string | null {
  return labelFor(pct, t.humWarn, t.humCrit);
}

/** Normalise a `GET /api/environment/thresholds` payload, dropping non-numeric fields so a
 *  metric whose rule was deleted goes back to having no threshold rather than `NaN`. */
export function toRoomThresholds(
  raw: Partial<Record<keyof RoomThresholds, unknown>> | null | undefined,
): RoomThresholds {
  const keys: (keyof RoomThresholds)[] =
    ["tempWarn", "tempCrit", "gasWarn", "gasCrit", "humWarn", "humCrit"];
  const out: RoomThresholds = {};
  for (const k of keys) {
    const n = Number(raw?.[k]);
    if (raw?.[k] != null && Number.isFinite(n)) out[k] = n;
  }
  return out;
}
