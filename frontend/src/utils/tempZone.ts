// Which AUTO-COOLING zone a room temperature is in (`aircon_ir_config`) — the boundaries
// the ESP32's getIRZone() fires IR at, and the five zones the AirConditioner page is built
// around.
//
// SCOPE: this is the AirConditioner page's module. That page is about the cooling zones,
// names the active one outright ("ACCEPTABLE · LIVE") and lets an admin edit the
// boundaries, so colouring by zone there is the subject matter. Everywhere else —
// Dashboard, Environment — temperature is coloured by the ALERT RULES instead, via
// `temperatureColor` in utils/envThresholds.ts. Cooling ramps before the alarm, so the two
// sets of numbers differ on purpose; what changed is that only the cooling PAGE now paints
// with the cooling numbers.
//
// The boundaries are ADMIN-EDITABLE, so nothing here may assume the defaults: pass the
// config loaded from GET /api/aircon/ir-config.

/** The auto-cooling zone boundaries the ESP32 actually uses (`aircon_ir_config`). */
export interface IRZones {
  coldBelow: number;
  normalMax: number;
  acceptableMax: number;
  nearCritMax: number;
}

/** Firmware-compiled defaults: <22 / 22–24 / 25–27 / 28–29 / >29 °C. Used ONLY until the
 *  saved config loads. Mirrors `IR_CFG_DEFAULTS` in backend/services/airconService.js and
 *  the `IR_TEMP_*` globals in iot/esp32/env_monitor_v2.ino — one definition per layer, and
 *  all three must move together. */
export const ZONE_DEFAULTS: IRZones = {
  coldBelow: 22,
  normalMax: 24,
  acceptableMax: 27,
  nearCritMax: 29,
};

export type TempZone = "TOO_COLD" | "NORMAL" | "ACCEPTABLE" | "NEAR_CRIT" | "CRITICAL";

// Four colours for five zones: NORMAL and ACCEPTABLE are both green because both mean the
// same thing to whoever is looking — the room is fine, there is nothing to do. What the
// two zones do differ in is the IR target they drive (26°C vs 24°C), and that difference
// is carried by the zone LABEL, which every caller prints beside the value. A colour
// cannot say whether 27.5°C is ACCEPTABLE or NEAR CRITICAL; the label can.
// Hexes are the status palette from CLAUDE.md, shared with utils/envThresholds.ts.
// CRITICAL is #E02F44 (the palette's CRITICAL), not #F2495C (its DANGER).
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

/** Which auto-cooling zone a reading falls in. The boundary comparisons mirror the
 *  firmware's `getIRZone()` EXACTLY — `<` on the cold edge, `<=` on the rest. A dashboard
 *  that disagreed with the device at a boundary would name a zone the AC is not in. */
export function zoneOf(t: number, z: IRZones = ZONE_DEFAULTS): TempZone {
  if (t <  z.coldBelow)     return "TOO_COLD";
  if (t <= z.normalMax)     return "NORMAL";
  if (t <= z.acceptableMax) return "ACCEPTABLE";
  if (t <= z.nearCritMax)   return "NEAR_CRIT";
  return "CRITICAL";
}

/** The colour for a zone itself, for UI that renders the zone TABLE rather than a reading
 *  (the AirConditioner page's five-zone reference). Keeps that table and the live tile
 *  reading from the same map — they disagreed once already. */
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

/** Colour for a reading. Anything that is not a finite number returns `fallback` — the
 *  `"--"` a page shows before the first sample, and the `null` Chart.js parses for a gap
 *  in a series. A dead sensor must read as "no data", not as a healthy green room. */
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

/** Normalise whatever GET /api/aircon/ir-config returned into `IRZones`, falling back to
 *  the firmware defaults field-by-field. The endpoint also carries `updatedBy*` metadata
 *  the colour path has no use for. */
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
