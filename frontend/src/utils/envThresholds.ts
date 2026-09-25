// Temperature, humidity and gas colour, driven by the room-level ALERT RULES
// (`alert_rules`, global `device_id = NULL`) — the same numbers the ESP32 gets as
// `envConfig` and the same ones notificationService raises alerts against. A reading turns
// orange at the moment the system starts calling it a warning, and red at the moment it
// calls it critical. One rule change moves the alert, the device's LED and the dashboard
// together.
//
// This replaces per-page copies of the numbers. Dashboard.tsx carried its own
// `GAS_WARN = 150` / `GAS_CRIT = 300` under a comment asking whoever retuned the rules to
// retune the constants as well — an unenforceable promise, and invisible to the admin
// actually editing Alert Rules. Now there is one source and the pages read it.
//
// NOTE: `utils/tempZone.ts` also resolves a temperature to a colour, but against the
// AUTO-COOLING zones. That module is now the AirConditioner page's alone — that page is
// about the cooling zones and labels them outright. Every other page colours temperature
// from the alert rules, here.
//
// Import-free on purpose, like utils/tempZone.ts.

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

/** The values seeded in `v13_cspc-ictu-monitoring-system.sql`. Used ONLY until the real
 *  rules load — not as a substitute for them. They exist so a tile is never briefly green
 *  under 500 ppm of smoke while the first request is in flight, and so a failed request
 *  degrades to the shipped thresholds rather than to "everything is fine". */
export const ROOM_THRESHOLD_FALLBACK: RoomThresholds = {
  tempWarn: 27,
  tempCrit: 32,
  gasWarn: 150,
  gasCrit: 300,
  humWarn: 60,
  humCrit: 80,
};

export type EnvBand = "normal" | "warning" | "critical";

/** The status strings the ESP32 reports in `smoke_status` / `environment_status` — the
 *  same three severities as `alert_rules`, upper-cased. `temp_status` adds TOO_COLD, which
 *  is not a severity but a separate axis (there is no `alert_rules` rule behind it). */
export type EnvStatus = "NORMAL" | "WARNING" | "CRITICAL";
export type TempStatus = "TOO_COLD" | EnvStatus;

/** Firmware before 2026-08-15 named the top band DANGER on `smoke_status` and
 *  `environment_status`, and carried a fourth, middle DANGER band on `temp_status`.
 *
 * Those strings are InfluxDB **TAGS**, so every point written before the change keeps
 *  them — this is not a migration window that eventually closes, it is how history reads
 *  forever. Any range that reaches back past the reflash returns both spellings, and the
 *  most recent history row seeds the live tiles on page load.
 *
 *  Normalising on the way in is what keeps that a one-line concern: downstream comparisons
 *  only ever see the three-value vocabulary, so a missed `=== "DANGER"` can't paint a
 *  smoke reading green. */
export function normalizeStatus(s: string | null | undefined): string | null {
  if (s == null) return null;
  return s === "DANGER" ? "CRITICAL" : s;
}

// The status palette from CLAUDE.md, shared with utils/tempZone.ts so "orange means
// warning" holds across every panel in the app.
//
// `critical` is #E02F44, the palette's CRITICAL — not #F2495C, which is DANGER. Beyond
// being the documented colour, the deeper red is what makes a breach visible on the smoke
// chart: MQ2-2's identity pink is #F472B6, near enough to #F2495C that the line hardly
// changed at the exact moment it most needed to.
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

/** Which band a value falls in, given a warning and a critical bound.
 *
 *  Always HIGHER-IS-WORSE (`>=`) — the comparison every seeded `temperature`, `gas` and
 *  `humidity` rule uses, the one the firmware applies (`t >= TEMP_WARNING`), and the one
 *  `alertRulesService.compare` evaluates the same rows with server-side.
 *
 * It previously INFERRED the direction from the bounds: `crit < warn` was read as
 *  "lower is worse" and flipped both comparisons. That inference was wrong in the exact
 *  situation it mattered — TESTING a rule. To make a clean room show critical you have to
 *  drop the critical threshold below the live reading, which leaves it under the untouched
 *  warning threshold; the metric silently became lower-is-worse and every band came out
 *  scrambled (10 ppm with crit=5, warn=150 reported WARNING, because `10 <= 150` matched
 *  first). Direction is a property of the RULE, not something to guess from two numbers.
 *
 *  A lower-is-worse environment rule would need `alert_rules.comparison` plumbed through
 *  `getRoomThresholds()`, which is deliberately not done here: that function's flat shape
 *  is also the `envConfig` payload the ESP32 parses, and widening it means touching
 *  firmware.
 *
 *  Critical is tested first so the worse band wins when both bounds are crossed. A missing
 *  bound cannot be crossed, matching the rules-only alerting model: no rule, no colour. */
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
 * Colour for a series that SHARES A CHART with another: it keeps its own identity hue
 * while normal, and takes the alarm colour once a threshold is crossed.
 *
 * Why this exists. Panels can all be green when nothing is wrong — they sit apart and a
 * colour is the whole message. Lines cannot: humidity shares an axis pair with
 * temperature, and the two MQ-2 lines share the smoke chart with each other. If every
 * normal series went green, a chart's two lines would be the same colour exactly when it
 * is being read most casually, and telling them apart is a chart's basic job.
 *
 * So on a shared canvas a line stays recognisably itself until there is something to
 * shout about, then it shouts. Temperature's line is the exception and is fully
 * zone-coloured (utils/tempZone.ts) — it is one series per axis, so nothing collides, and
 * its blue/green carry meaning of their own.
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
 * Temperature has a band the others do not: TOO COLD, below which the room is over-cooled.
 *
 * There is no `alert_rules` row for it — the rules only describe the hot side (seeded
 * `>= 27` warning, `>= 32` critical) — and the firmware says why: `TEMP_COLD` is the one
 * threshold `envConfig` does not overwrite, so the device keeps its compiled 22 °C and
 * lights its LED blue there. This mirrors that constant so the dashboard and the box on
 * the wall call the same room too cold. Change one and change the other
 * (`iot/esp32/env_monitor_v2.ino`, `TEMP_COLD`).
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

/** Which band a temperature falls in: the `temperature` alert rules on the hot side, the
 *  firmware's cold constant on the other. Hot wins if they ever overlap — a room that is
 *  somehow both is a misconfiguration, and the hot end is the one that damages hardware. */
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

/** `#RRGGBB` → `rgba(r,g,b,alpha)`. Chart area fills are built from a band colour at a low
 *  alpha, and Chart.js gradients need real rgba stops rather than `#RRGGBBAA`. Returns the
 *  input unchanged if it is not a 6-digit hex, so a CSS variable degrades instead of
 *  throwing. */
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
