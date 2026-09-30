// Which auto-cooling zone a room temperature is in (`aircon_ir_config`): the boundaries
// where the ESP32's getIRZone() sends IR, and the five zones the AirConditioner page
// shows. Only used on that page; the Dashboard and Environment colour temperature by the
// alert rules (`temperatureColor` in utils/envThresholds.ts). Boundaries are editable,
// so pass the config from GET /api/aircon/ir-config rather than assuming defaults.

/** The auto-cooling zone boundaries the ESP32 actually uses (`aircon_ir_config`). */
export interface IRZones {
  coldBelow: number;
  normalMax: number;
  acceptableMax: number;
  nearCritMax: number;
}

/**
 * Firmware defaults: <22 / 22–24 / 25–27 / 28–29 / >29 °C, used only until the saved
 * config loads. Same as `IR_CFG_DEFAULTS` in backend/services/airconService.js and the
 * `IR_TEMP_*` globals in the firmware; change all three together.
 */
export const ZONE_DEFAULTS: IRZones = {
  coldBelow: 22,
  normalMax: 24,
  acceptableMax: 27,
  nearCritMax: 29,
};

export type TempZone = "TOO_COLD" | "NORMAL" | "ACCEPTABLE" | "NEAR_CRIT" | "CRITICAL";

// Four colours for five zones: NORMAL and ACCEPTABLE are both green ("nothing to do");
// they differ in the AC target (26°C vs 24°C), which the zone label shows. Status colours
// from CLAUDE.md, shared with utils/envThresholds.ts. CRITICAL is #E02F44, not #F2495C
// (DANGER).
const ZONE_COLOR: Record<TempZone, string> = {
  TOO_COLD:   "#5794F2", // blue   — over-cooling, AC targets 28°C
  NORMAL:     "#73BF69", // green  — AC targets 26°C
  ACCEPTABLE: "#73BF69", // green  — AC targets 24°C
  NEAR_CRIT:  "#FF780A", // orange — AC targets 22°C, fan High
  CRITICAL:   "#E02F44", // red    — AC targets 20°C, fan High
};

const ZONE_LABEL: Record<TempZone, string> = {
  TOO_COLD:   "TOO COLD",
  NORMAL:     "NORMAL",
  ACCEPTABLE: "ACCEPTABLE",
  NEAR_CRIT:  "NEAR CRITICAL",
  CRITICAL:   "CRITICAL",
};

/** Fallback for "--" — no reading yet, or the ESP32 has stopped reporting. `--gf-text-muted`. */
const MUTED = "#6B7280";

/**
 * Which zone a reading is in. Uses the same comparisons as the firmware's getIRZone()
 * (`<` on the cold edge, `<=` on the rest), so the page names the zone the AC is in.
 */
export function zoneOf(t: number, z: IRZones = ZONE_DEFAULTS): TempZone {
  if (t <  z.coldBelow)     return "TOO_COLD";
  if (t <= z.normalMax)     return "NORMAL";
  if (t <= z.acceptableMax) return "ACCEPTABLE";
  if (t <= z.nearCritMax)   return "NEAR_CRIT";
  return "CRITICAL";
}

/**
 * Colour for a zone itself (the AirConditioner page's zone table), from the same map as
 * the live reading.
 */
export function zoneColor(zone: TempZone): string {
  return ZONE_COLOR[zone];
}

/** Zone + display label + colour for a reading. */
export function tempZone(
  t: number,
  z: IRZones = ZONE_DEFAULTS,
): { zone: TempZone; label: string; color: string } {
  const zone = zoneOf(t, z);
  return { zone, label: ZONE_LABEL[zone], color: ZONE_COLOR[zone] };
}

/**
 * Colour for a reading. Anything that is not a finite number (the "--" before the first
 * sample, a null gap) returns `fallback`, so no data never looks like a healthy room.
 */
export function tempColor(
  t: number | string | null | undefined,
  z: IRZones = ZONE_DEFAULTS,
  fallback: string = MUTED,
): string {
  if (typeof t !== "number" || !Number.isFinite(t)) return fallback;
  return ZONE_COLOR[zoneOf(t, z)];
}

/** Zone name for a reading, or null when there is no reading to describe. */
export function tempZoneLabel(
  t: number | string | null | undefined,
  z: IRZones = ZONE_DEFAULTS,
): string | null {
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  return ZONE_LABEL[zoneOf(t, z)];
}

/**
 * Normalise the GET /api/aircon/ir-config response into `IRZones`, using the firmware
 * defaults for any missing field.
 */
export function toIRZones(config: Partial<IRZones> | null | undefined): IRZones {
  const num = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    coldBelow:     num(config?.coldBelow,     ZONE_DEFAULTS.coldBelow),
    normalMax:     num(config?.normalMax,     ZONE_DEFAULTS.normalMax),
    acceptableMax: num(config?.acceptableMax, ZONE_DEFAULTS.acceptableMax),
    nearCritMax:   num(config?.nearCritMax,   ZONE_DEFAULTS.nearCritMax),
  };
}
