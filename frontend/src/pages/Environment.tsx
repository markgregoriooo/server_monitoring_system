import { useState, useEffect, useRef, useMemo } from "react";
import React from "react";
import { Line } from "react-chartjs-2";
import { Chart, registerables } from "chart.js";
import "../chart/ChartConfig";
import type { ChartOptions, ChartData, ScriptableContext } from "chart.js";
import { socket } from "../socket/socket";
import { api } from "../api/api";
import { useAuth } from "../context/AuthContext";
import { useGasSensors } from "../hooks/useGasSensors";
import AddGasSensorModal from "../components/environment/AddGasSensorModal";
import RangePicker, { DEFAULT_RANGE } from "../components/ui/RangePicker";
import type { RangeValue } from "../components/ui/RangePicker";
import { useRoomThresholds } from "../hooks/useRoomThresholds";
import { withGaps } from "../utils/seriesGaps";
import { fitCanvas } from "../utils/hidpiCanvas";
import { useCanvasRedraw } from "../hooks/useCanvasRedraw";
import {
  gasLabel, humidityLabel, temperatureColor, temperatureLabel, alertTint, withAlpha,
  normalizeStatus,
} from "../utils/envThresholds";
import type { EnvStatus, TempStatus } from "../utils/envThresholds";

Chart.register(...registerables);

// The `changeRange` socket event takes either a quick-range string or an absolute
// { start, stop } window, which is exactly the shape RangeValue already carries.
const rangePayload = (r: RangeValue) =>
  r.kind === "preset" ? r.preset : { start: r.start, stop: r.stop };

// ─── Gas sensor recalibration ─────────────────────────────────────────────────
// The MQ-2 needs a "clean air" reference (Ro) that differs per sensor and per room.
// It used to require editing RO_CLEAN_AIR_* in the firmware and reflashing on every
// move; the ESP32 now measures and stores it itself, and this button asks it to
// re-measure. Admin-only, confirmed, because the device records whatever it smells
// AT THAT MOMENT as clean — calibrating in poor air makes it under-report smoke.

type CalibResult = { ok: boolean; msg: string };

/**
 * The button and its result render in TWO PLACES, so the state lives in a hook.
 *
 * ⚠️ Why they had to be separated. The toolbar holding the button is
 * `flex-nowrap overflow-x-auto justify-end` on a phone, and a result chip inside it made
 * that row wider than the viewport. Under `justify-content: flex-end` the surplus
 * overflows to the LEFT of the scroll origin — which no browser lets you scroll back to —
 * so the message, and sometimes the button beside it, was pushed off-screen and was
 * unreachable rather than merely clipped. Capping the chip at `45vw`/`60vw` and shortening
 * its text only moved the cliff: the range picker alone is most of a 360px row.
 *
 * So the button stays in the toolbar and the result gets its own full-width line beneath
 * it, on every screen size. One render site, no width to fight over, and the whole
 * sentence fits on one line at 360px — which also means the mobile/desktop text split
 * this used to carry is gone, and the numbers can never be the part that gets dropped.
 */
function useGasRecalibration() {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CalibResult | null>(null);

  useEffect(() => {
    const onDone = (d: { ok?: boolean; ro1?: number; ro2?: number }) => {
      setBusy(false);
      setResult(
        d?.ok
          ? {
              ok: true,
              msg: `Calibrated — Ro1 ${Number(d.ro1).toFixed(2)} kΩ · Ro2 ${Number(d.ro2).toFixed(2)} kΩ`,
            }
          : {
              ok: false,
              // "Rejected" alone does not say the old baseline survived, which is the
              // reassurance that stops somebody re-running it in whatever air failed.
              msg: "Rejected — reading out of range. Previous baseline kept.",
            },
      );
      setTimeout(() => setResult(null), 8000);
    };
    socket.on("gasCalibrated", onDone);
    return () => { socket.off("gasCalibrated", onDone); };
  }, []);

  const run = async () => {
    if (!confirm(
      "Re-measure the gas sensor's clean-air baseline?\n\n" +
      "The ESP32 will treat the air RIGHT NOW as clean. Only do this when the room is " +
      "well ventilated and nothing is burning, soldering or smoking nearby.\n\n" +
      "Calibrating in poor air makes the sensor under-report real smoke.",
    )) return;

    setBusy(true);
    setResult(null);
    const r = await api.calibrateGasSensor();
    if (!r.success) {
      setBusy(false);
      setResult({ ok: false, msg: r.error ?? "Could not request calibration." });
      setTimeout(() => setResult(null), 8000);
    }
    // On success we stay "busy" until the ESP32 reports back via `gasCalibrated`.
  };

  return { isAdmin: user?.role === "admin", busy, result, run };
}

/** Toolbar half: the button alone, so it keeps its natural width in a nowrap row. */
function RecalibrateGasButton({ busy, run }: { busy: boolean; run: () => void }) {
  return (
    /* .gf-btn supplies the raised face, border, hover and press-inset (and its own
       :disabled), so the hand-rolled border/background go. */
    <button
      onClick={run}
      disabled={busy}
      title="Re-measure the MQ-2 clean-air baseline (admin) — use after moving the sensor"
      // The visible label is hidden on a phone, so the accessible name has to come from
      // here — an icon-only button with no aria-label is unnamed to a screen reader.
      aria-label={busy ? "Calibrating gas sensors" : "Recalibrate gas sensors"}
      className="gf-btn text-[13px] px-2 sm:px-2.5 py-1 inline-flex items-center gap-1.5"
      style={{ color: "var(--gf-text-muted)" }}
    >
      {/* Spins while busy. On desktop the label already says "Calibrating…"; on a phone
          that label is gone, so without this a press would look like nothing happened —
          and a calibration takes seconds, not milliseconds. */}
      <svg
        width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"
        className={`shrink-0 ${busy ? "animate-spin motion-reduce:animate-none" : ""}`}
      >
        <path
          d="M14 8a6 6 0 1 1-1.8-4.3M14 1.5V5h-3.5"
          stroke="currentColor" strokeWidth="1.5"
          strokeLinecap="round" strokeLinejoin="round"
        />
        <circle cx="8" cy="8" r="1.6" fill="currentColor" />
      </svg>
      <span className="hidden sm:inline">
        {busy ? "Calibrating…" : "Recalibrate gas"}
      </span>
    </button>
  );
}

/**
 * Result half: a full-width line under the toolbar. `role="status"` because it is the only
 * confirmation the press did anything — the button's label is an icon on a phone — so a
 * screen reader has to announce it without the focus having moved.
 */
function GasCalibrationNotice({ result }: { result: CalibResult }) {
  const tone = result.ok ? "#73BF69" : "#F2495C";
  return (
    <div
      role="status"
      className="mx-4 mt-3 text-[12px] leading-snug px-3 py-2 rounded-[2px] break-words"
      style={{ color: tone, background: tone + "14", border: `1px solid ${tone}40` }}
    >
      {result.msg}
    </div>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

// The device's three-band vocabulary, shared with the colour helpers. Every value that
// reaches these types has been through `normalizeStatus`, so the legacy DANGER spelling
// held by pre-2026-08-15 InfluxDB tags is already folded into CRITICAL.
type AlertLevel     = EnvStatus;
type TempLevel      = TempStatus;

interface SensorData {
  temperature:        number;
  humidity:           number;
  mq2_1_ppm:         number;
  /** Per-sensor readings with the label already resolved server-side. Absent from an ESP32
   *  that has not been reflashed for multi-sensor gas, where the legacy pair is all there is. */
  gas?:              { channel: number; ppm: number; label: string }[];
  gas_ppm?:          number;
  mq2_2_ppm:         number;
  heat_index:         number;
  smoke_status:       AlertLevel;
  temp_status:        TempLevel;
  environment_status: AlertLevel;
  timestamp:          string;
}

interface HistoryData {
  time:               string;
  temperature:        number | null;
  humidity:           number | null;
  mq2_1_ppm:         number | null;
  /** { "1": 38.2, "3": 41.0 } — one entry per channel that reported in this window. Null for
   *  windows older than the multi-sensor cutover, where only the legacy pair exists. */
  gas?:              Record<string, number> | null;
  mq2_2_ppm:         number | null;
  heat_index:         number | null;
  smoke_status:       AlertLevel | null;
  temp_status:        TempLevel | null;
  environment_status: AlertLevel | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// DANGER is no longer a band the device reports (see normalizeStatus) — the key is kept
// only so a status that somehow skipped normalisation still resolves to a red rather than
// to `undefined`, which these maps would render as no colour at all.
const STATUS_COLOR: Record<string, string> = {
  NORMAL:   "#73BF69",
  TOO_COLD: "#5794F2",
  WARNING:  "#FF780A",
  DANGER:   "#F2495C",
  CRITICAL: "#E02F44",
};

// Fallback for the temperature series — used only until a reading arrives, and as the
// colour Chart.js falls back to before per-segment zone colours resolve.
const TEMP_SERIES = "#F59E0B";

// IDENTITY colours for the series that share a chart with another. Humidity sits beside
// temperature; the two MQ-2 lines sit beside each other. Each holds its own hue while
// within the alert rules and turns orange/red only where it breached them (`alertTint`) —
// if every normal series went green, each of these charts would be drawing one line twice.
// The stat TILES have no such neighbour and use the full green/orange/red band colour.
const HUM_SERIES  = "#38BDF8";
const MQ1_SERIES  = "#A78BFA";
const MQ2_SERIES  = "#F472B6";
/* One identity hue per gas sensor, indexed by channel-1.
   Each sensor KEEPS its own colour while clean and only turns orange/red on breach
   (`alertTint`). Painting them all green when clean would merge them into one indistinct
   band for the majority of the time the chart is on screen — and watching two sensors
   DISAGREE is the entire reason for having more than one.
   Channels 3 and 4 continue away from violet/pink rather than near them: amber and teal sit
   far from both on the wheel, and far from the orange/red a breach turns them. */
const GAS_SERIES = [MQ1_SERIES, MQ2_SERIES, "#FBBF24", "#2DD4BF"] as const;
// The modulo makes this total for any channel, so a 5th sensor on a second ESP32 wraps
// round to violet rather than rendering colourless.
const gasSeriesColor = (channel: number): string =>
  GAS_SERIES[(channel - 1) % GAS_SERIES.length]!;

/* Which gas channels a history payload actually CARRIES, unioned with the ones the sensor
   config already knows about.

   ⚠️ Read from the DATA, never from the config alone. `useGasSensors` fetches over HTTP
   while `sensorHistory` arrives on an already-open socket, so on a client-side navigation
   into this page the history wins that race and `gasChannelsRef` is still empty — the gas
   series came back `{}` and then rebuilt itself one live point every 3 s, against labels
   that were already a full window long. Chart.js pairs data[i] with labels[i] on a category
   axis, so the short series drew across the LEFT of the axis and the smoke line lagged its
   own x-axis. A reload appeared to "fix" it only because a cold socket delays the history
   long enough for the fetch to land first, which is why it looked intermittent.

   Ingest now waits on nothing async; `gasChannels` still decides what is DRAWN, so a
   channel an admin has not confirmed is wired is still not charted. */
function channelsIn(history: HistoryData[], known: number[]): number[] {
  const out = new Set<number>(known);
  for (const r of history) {
    for (const k of Object.keys(r.gas ?? {})) {
      const n = Number(k);
      if (Number.isFinite(n)) out.add(n);
    }
    if (typeof r.mq2_1_ppm === "number") out.add(1);
    if (typeof r.mq2_2_ppm === "number") out.add(2);
  }
  return [...out].sort((a, b) => a - b);
}

const STATUS_BG: Record<string, string> = {
  NORMAL:   "rgba(115,191,105,0.15)",
  TOO_COLD: "rgba(87,148,242,0.15)",
  WARNING:  "rgba(255,120,10,0.15)",
  DANGER:   "rgba(242,73,92,0.15)",
  CRITICAL: "rgba(224,47,68,0.20)",
};

// ─── Grafana palette — values come from CSS vars set on the root div ──────────
// GF references are consumed by all sub-components; the actual light/dark
// values are injected by the Environment root element based on isDark.

const GF = {
  bg:          "var(--gf-bg)",
  panel:       "var(--gf-panel)",
  panelBorder: "var(--gf-panel-border)",
  header:      "var(--gf-header)",
  divider:     "var(--gf-divider)",
  textPrimary: "var(--gf-text-primary)",
  textMuted:   "var(--gf-text-muted)",
  textDim:     "var(--gf-text-dim)",
};

// ─── X-axis label formatter ───────────────────────────────────────────────────
// Always produces "Mon DD HH:mm" so every range shows date + time.

function fmtLabel(d: Date): string {
  const mon  = d.toLocaleDateString("en-US", { month: "short" });
  const day  = String(d.getDate()).padStart(2, "0");
  const year = d.getFullYear();
  const h    = String(d.getHours()).padStart(2, "0");
  const m    = String(d.getMinutes()).padStart(2, "0");
  return `${mon} ${day} ${year} ${h}:${m}`;
}

// Splits "Jun 04 2026 14:30" → ["Jun 04 2026", "14:30"] for two-line tick rendering
const MONTH_NUM: Record<string, number> = {
  Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12,
};

// "Jun 04 2026" → "06/04/2026" (compact numeric date for narrow x-axis on mobile)
function toNumericDate(date: string): string {
  const [mon, day, year] = date.split(" ");
  const m = mon ? MONTH_NUM[mon] : undefined;
  if (!m || !day || !year) return date; // unexpected format → leave as-is
  return `${String(m).padStart(2, "0")}/${day.padStart(2, "0")}/${year}`;
}

function splitLabel(raw: string, isMobile = false): string[] {
  const i = raw.lastIndexOf(" ");
  if (i === -1) return [raw];
  let date = raw.slice(0, i);
  const time = raw.slice(i + 1);
  // On mobile, show the date as mm/dd/yyyy so it stays compact on a narrow x-axis.
  if (isMobile) date = toNumericDate(date);
  return [date, time];
}

// ─── Chart helpers ────────────────────────────────────────────────────────────

/**
 * Takes ONE options object, not seven positional arguments.
 *
 * It used to be called as
 *   makeCombinedOptions(isDark, isMobile, minTempY, maxTempY, minHumY, maxHumY, colors)
 * — four adjacent numbers with identical types. Transposing any two of them is silently
 * wrong: the chart renders with the wrong axis bounds and nothing errors. Two adjacent
 * booleans had the same problem. Named fields make a transposition impossible.
 * See audits/naming-readability-report-2026-08-25.md — N-01.
 */
function makeCombinedOptions({
  isDark,
  isMobile,
  minTemp,
  maxTemp,
  minHum,
  maxHum,
  colors,
}: {
  isDark: boolean;
  isMobile: boolean;
  minTemp: number;
  maxTemp: number;
  minHum: number;
  maxHum: number;
  /** Colours resolved from live data by the component, since this builder sits outside it.
   *  `tempAxis`/`humAxis` are each series' colour RIGHT NOW (a multi-coloured line needs an
   *  axis that still matches some part of it); `at` resolves the colour of one hovered
   *  point, for the tooltip's swatch — Chart.js would otherwise draw it from the dataset's
   *  static `borderColor`, which here is only the pre-first-reading fallback. */
  colors: {
    tempAxis: string;
    humAxis: string;
    at: (datasetIndex: number, y: number | null) => string;
  };
}): ChartOptions<"line"> {
  const gridColor = isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.06)";
  const dateColor = isDark ? "#4B5563" : "#9CA3AF";
  const timeColor = isDark ? "#9CA3AF" : "#6B7280";
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: isDark ? "#1A1D23" : "rgba(255,255,255,0.97)",
        borderColor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)",
        borderWidth: 1,
        titleColor: isDark ? "#6B7280" : "rgba(80,100,130,0.7)",
        bodyColor:  isDark ? "#D9D9D9" : "#1e293b",
        padding: 12,
        titleFont: { family: "monospace", size: 10 },
        bodyFont:  { family: "monospace", size: 12 },
        callbacks: {
          label: (ctx) => {
            const y = ctx.parsed.y as number | null;
            if (y === null || y === undefined) return "";
            return ctx.datasetIndex === 0 ? ` ${y.toFixed(1)} °C` : ` ${y.toFixed(1)} %`;
          },
          labelColor: (ctx) => {
            const c = colors.at(ctx.datasetIndex, ctx.parsed.y as number | null);
            return { borderColor: c, backgroundColor: c, borderWidth: 0 };
          },
        },
      },
    },
    scales: {
      x: {
        grid: { color: gridColor, drawTicks: false }, border: { display: false },
        ticks: {
          // Chart.js typings only allow a single Color from this callback, but it
          // also accepts a [date, time] array at runtime for two-line ticks — cast.
          color: ((ctx: { tick?: { label?: unknown } }) =>
            ctx.tick?.label === undefined
              ? timeColor
              : (Array.isArray(ctx.tick.label) && ctx.tick.label.length > 1
                  ? [dateColor, timeColor]
                  : timeColor)) as unknown as string,
          font: { size: isMobile ? 8 : 9, family: "monospace" },
          maxTicksLimit: isMobile ? 4 : 7, maxRotation: 0,
          // `value` is the DATA index on a category scale. `index` is only the position
          // among the ticks Chart.js decided to DRAW (0…maxTicksLimit-1), so passing it to
          // getLabelForValue labelled all seven ticks from the first seven samples — which
          // is why a tick could read "Jun" while the tooltip for that same point read
          // "Jul", and why the months appeared to jump around.
          callback: function(value, index, ticks): string[] {
            const dataIndex = typeof value === "number" ? value : (ticks[index]?.value ?? index);
            const raw = (this.getLabelForValue as (i: number) => string)(dataIndex);
            return splitLabel(raw, isMobile);
          },
        },
      },
      yTemp: {
        type: "linear", position: "left",
        grid: { color: gridColor, drawTicks: false }, border: { display: false },
        ticks: { color: colors.tempAxis, font: { size: 9, family: "monospace" }, padding: 8, callback: (v) => `${v}°` },
        min: minTemp, max: maxTemp,
      },
      yHum: {
        type: "linear", position: "right",
        grid: { display: false }, border: { display: false },
        ticks: { color: colors.humAxis, font: { size: 9, family: "monospace" }, padding: 8, callback: (v) => `${v}%` },
        min: minHum, max: maxHum,
      },
    },
  };
}

/** One options object — same reasoning as makeCombinedOptions (N-01). */
function makeSmokeOptions({
  isDark,
  isMobile,
  minPPM,
  maxPPM,
  colors,
  labelFor,
}: {
  isDark: boolean;
  isMobile: boolean;
  minPPM: number;
  maxPPM: number;
  /** DATASET INDEX → what to call that sensor. Index, not channel: the chart only draws the
   *  fitted channels, so with 1 and 3 wired dataset 1 is channel 3. Resolved by the caller,
   *  which owns the channel list. Passed in rather than read from a module constant because
   *  the name lives in MySQL and an admin can rename it while this page is open. */
  labelFor: (datasetIndex: number) => string;
  /** `ppmAxis` = the WORSE of the two MQ-2 sensors, since one axis serves both lines.
   *  `at` resolves one hovered point's colour for the tooltip swatch — see makeCombinedOptions. */
  colors: {
    ppmAxis: string;
    at: (datasetIndex: number, y: number | null) => string;
  };
}): ChartOptions<"line"> {
  const gridColor = isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.06)";
  const dateColor = isDark ? "#4B5563" : "#9CA3AF";
  const timeColor = isDark ? "#9CA3AF" : "#6B7280";
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: isDark ? "#1A1D23" : "rgba(255,255,255,0.97)",
        borderColor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)",
        borderWidth: 1,
        titleColor: isDark ? "#6B7280" : "rgba(80,100,130,0.7)",
        bodyColor:  isDark ? "#D9D9D9" : "#1e293b",
        padding: 12,
        titleFont: { family: "monospace", size: 10 },
        bodyFont:  { family: "monospace", size: 12 },
        callbacks: {
          label: (ctx) => {
            const y = ctx.parsed.y as number | null;
            if (y === null || y === undefined) return "";
            const name = labelFor(ctx.datasetIndex);
            return ` ${name}: ${y.toFixed(1)} ppm`;
          },
          labelColor: (ctx) => {
            const c = colors.at(ctx.datasetIndex, ctx.parsed.y as number | null);
            return { borderColor: c, backgroundColor: c, borderWidth: 0 };
          },
        },
      },
    },
    scales: {
      x: {
        grid: { color: gridColor, drawTicks: false }, border: { display: false },
        ticks: {
          // Chart.js typings only allow a single Color from this callback, but it
          // also accepts a [date, time] array at runtime for two-line ticks — cast.
          color: ((ctx: { tick?: { label?: unknown } }) =>
            ctx.tick?.label === undefined
              ? timeColor
              : (Array.isArray(ctx.tick.label) && ctx.tick.label.length > 1
                  ? [dateColor, timeColor]
                  : timeColor)) as unknown as string,
          font: { size: isMobile ? 8 : 9, family: "monospace" },
          maxTicksLimit: isMobile ? 4 : 7, maxRotation: 0,
          // `value` is the DATA index on a category scale. `index` is only the position
          // among the ticks Chart.js decided to DRAW (0…maxTicksLimit-1), so passing it to
          // getLabelForValue labelled all seven ticks from the first seven samples — which
          // is why a tick could read "Jun" while the tooltip for that same point read
          // "Jul", and why the months appeared to jump around.
          callback: function(value, index, ticks): string[] {
            const dataIndex = typeof value === "number" ? value : (ticks[index]?.value ?? index);
            const raw = (this.getLabelForValue as (i: number) => string)(dataIndex);
            return splitLabel(raw, isMobile);
          },
        },
      },
      y: {
        grid: { color: gridColor, drawTicks: false }, border: { display: false },
        // One axis serves BOTH MQ-2 lines, so it follows the WORSE of the two — the safe
        // direction: it can over-state one sensor's band but never under-state the room.
        ticks: { color: colors.ppmAxis, font: { size: 9, family: "monospace" }, padding: 8, callback: (v) => `${v}` },
        min: minPPM, max: maxPPM,
      },
    },
  };
}

function gradientFill(ctx: ScriptableContext<"line">, colorTop: string, colorBot: string): CanvasGradient | string {
  const canvas = ctx.chart.canvas as HTMLCanvasElement | null;
  if (!canvas) return colorTop;
  const context = canvas.getContext("2d");
  if (!context) return colorTop;
  const g = context.createLinearGradient(0, 0, 0, 200);
  g.addColorStop(0, colorTop);
  g.addColorStop(1, colorBot);
  return g;
}

// ─── LiveDot ──────────────────────────────────────────────────────────────────

function LiveDot() {
  return (
    <span className="flex items-center gap-1.5">
      <span className="relative flex h-1.5 w-1.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60" style={{ background: "#73BF69" }} />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ background: "#73BF69" }} />
      </span>
      <span className="text-[11px] font-mono tracking-widest uppercase" style={{ color: "#73BF69" }}>Live</span>
    </span>
  );
}

// ─── StatusDot ────────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: string }) {
  const color = STATUS_COLOR[status] ?? STATUS_COLOR["NORMAL"];
  return (
    <span className="flex items-center gap-2">
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color, boxShadow: `0 0 6px ${color}80` }} />
      <span className="text-[13px] font-mono font-semibold tracking-wider" style={{ color }}>{status}</span>
    </span>
  );
}

// ─── StatusBadge (kept for smoke panel) ──────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLOR[status] ?? STATUS_COLOR["NORMAL"];
  const bg    = STATUS_BG[status]    ?? STATUS_BG["NORMAL"];
  return (
    <span className="text-[12px] font-mono font-bold px-2 py-0.5 rounded tracking-widest"
      style={{ color, background: bg }}>
      {status}
    </span>
  );
}

// ─── GaugeArc ─────────────────────────────────────────────────────────────────
// 270° arc gauge (same geometry as AirConditioner.tsx), bottom clipped by canvas.

// The size the gauge OCCUPIES, in CSS pixels. The bitmap behind it is this times the
// device pixel ratio — see utils/hidpiCanvas.
const GAUGE_W = 130;
const GAUGE_H = 100;

function GaugeArc({ value, unit, pct, color, isDark }: {
  value: string | number; unit: string; pct: number; color: string; isDark: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const redraw = useCanvasRedraw(ref);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    // CSS pixels, not the bitmap: fitCanvas sizes the bitmap for the display and scales
    // the context to match, so none of the geometry below changes.
    const ctx = fitCanvas(c, GAUGE_W, GAUGE_H);
    if (!ctx) return;
    const w = GAUGE_W, h = GAUGE_H;
    const cx = w / 2, cy = h * 0.68, r = w * 0.36;
    const s = Math.PI * 0.8, e = Math.PI * 2.2, sw = e - s;
    const f = s + sw * Math.min(Math.max(pct, 0), 1);

    ctx.clearRect(0, 0, w, h);

    // background track
    ctx.beginPath(); ctx.arc(cx, cy, r, s, e);
    ctx.strokeStyle = isDark ? "rgba(128,128,128,0.12)" : "rgba(0,0,0,0.10)";
    ctx.lineWidth = w * 0.07; ctx.lineCap = "round"; ctx.stroke();

    // threshold bands (green → orange → red)
    let prev = s;
    for (const [end, col] of [
      [0.5,  "rgba(115,191,105,0.14)"],
      [0.75, "rgba(255,120,10,0.14)"],
      [1.0,  "rgba(242,73,92,0.14)"],
    ] as [number, string][]) {
      const be = s + sw * end;
      ctx.beginPath(); ctx.arc(cx, cy, r, prev, be);
      ctx.strokeStyle = col; ctx.lineWidth = w * 0.07; ctx.lineCap = "butt"; ctx.stroke();
      prev = be;
    }

    // filled value arc
    if (pct > 0) {
      ctx.beginPath(); ctx.arc(cx, cy, r, s, f);
      ctx.strokeStyle = color; ctx.lineWidth = w * 0.07; ctx.lineCap = "round"; ctx.stroke();
    }

    // value text (center)
    ctx.fillStyle = color;
    ctx.font = `bold ${Math.round(r * 0.5)}px monospace`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(value), cx, cy - r * 0.1);

    // unit text
    ctx.fillStyle = isDark ? "rgba(107,114,128,0.75)" : "rgba(71,85,105,0.85)";
    ctx.font = `${Math.round(r * 0.26)}px monospace`;
    ctx.fillText(unit, cx, cy + r * 0.36);
  }, [pct, color, value, unit, isDark, redraw]);

  return (
    <canvas ref={ref} width={GAUGE_W} height={GAUGE_H}
      style={{ width: "100%", maxWidth: GAUGE_W, height: "auto" }} />
  );
}

// Light moving-average so live raw readings render as a smooth, flowing curve
// (matching the aggregated Server Detail charts). Window of 5 ≈ ~15s of samples.
// Null-aware: a missing reading STAYS missing rather than being averaged away. Feeding
// it through as 0 (which is what `?? 0` upstream used to do) draws a plunge to zero that
// never happened — and on temperature, 0 °C is both impossible and alarming.
function smooth(data: (number | null)[], window = 5): (number | null)[] {
  if (data.length <= 2) return data;
  return data.map((v, i) => {
    if (v == null) return null;
    const start = Math.max(0, i - window + 1);
    const slice = data.slice(start, i + 1).filter((x): x is number => x != null);
    if (!slice.length) return null;
    return +(slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(2);
  });
}

// Drop the missing readings. For the stat tiles and sparklines, which state a single
// number or draw a 40px line — neither can show a hole, and both would be wrong if a
// missing reading counted as 0 in a min/avg.
const nums = (a: (number | null)[]): number[] => a.filter((v): v is number => v != null);

// ─── Sparkline ────────────────────────────────────────────────────────────────

function Sparkline({ data, color }: { data: number[]; color: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef  = useRef<Chart | null>(null);
  useEffect(() => {
    if (!canvasRef.current) return;
    chartRef.current?.destroy();
    chartRef.current = new Chart(canvasRef.current, {
      type: "line",
      data: {
        labels: data.map((_, i) => i),
        datasets: [{ data, borderColor: color, borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: color + "18", tension: 0.4 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false } },
        scales: { x: { display: false }, y: { display: false } },
      },
    });
    return () => { chartRef.current?.destroy(); };
  }, [data, color]);
  return <div className="relative w-full" style={{ height: 44 }}><canvas ref={canvasRef} /></div>;
}

// ─── StatPanel (Grafana Stat style) ───────────────────────────────────────────

interface StatPanelProps {
  title: string;
  value: string | number;
  unit: string;
  color: string;
  segPct: number;
  sparkData: number[];
  max: string;
  avg: string;
  min: string;
  isDark: boolean;
  /** Optional word for what the colour MEANS, shown beside the status dot. A colour on its
   *  own cannot say whether 27.5°C is ACCEPTABLE or NEAR CRITICAL. */
  badge?: string | null;
}

function StatPanel({ title, value, unit, color, segPct, sparkData, max, avg, min, isDark, badge }: StatPanelProps) {
  return (
    <div className="flex flex-col rounded" style={{ background: GF.panel, border: `1px solid ${GF.panelBorder}` }}>
      {/* Panel title bar */}
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5"
        style={{ borderBottom: `1px solid ${GF.divider}` }}>
        <span className="text-[12px] font-mono tracking-widest uppercase" style={{ color: GF.textMuted }}>{title}</span>
        <span className="flex items-center gap-1.5">
          {badge && (
            <span className="text-[10px] font-mono tracking-wider uppercase" style={{ color }}>{badge}</span>
          )}
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: color, boxShadow: `0 0 5px ${color}` }} />
        </span>
      </div>

      {/* Arc gauge — shows live value + unit in centre */}
      <div className="flex justify-center px-3 pt-2 pb-0">
        <GaugeArc value={value} unit={unit} pct={segPct} color={color} isDark={isDark} />
      </div>

      {/* Sparkline */}
      <div className="px-3 pb-2">
        <Sparkline data={sparkData} color={color} />
      </div>

      {/* Stats row */}
      <div className="flex justify-between px-3 pb-3 pt-1"
        style={{ borderTop: `1px solid ${GF.divider}` }}>
        {([["MAX", max], ["AVG", avg], ["MIN", min]] as [string, string][]).map(([k, v]) => (
          <div key={k} className="flex flex-col items-center gap-0.5">
            <span className="text-[11px] font-mono tracking-widest" style={{ color: GF.textDim }}>{k}</span>
            <span className="text-[13px] font-mono font-semibold" style={{ color }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── StatePanel (Grafana State style) ────────────────────────────────────────

function StatePanel({
  smokeStatus, environmentStatus, tempStatus, liveHeatIndex,
}: {
  smokeStatus: string; environmentStatus: string;
  tempStatus: string; liveHeatIndex: number | string;
}) {
  // Both statuses arrive normalised, so CRITICAL is the only top band to test — it used to
  // also check DANGER on each, which was the same two conditions under two spellings.
  const heatColor =
    tempStatus === "CRITICAL" || smokeStatus === "CRITICAL" ? "#F2495C" : "#FF780A";

  return (
    <div className="flex flex-col rounded" style={{ background: GF.panel, border: `1px solid ${GF.panelBorder}` }}>
      {/* Panel title */}
      <div className="flex items-center px-3 pt-2.5 pb-1.5"
        style={{ borderBottom: `1px solid ${GF.divider}` }}>
        <span className="text-[12px] font-mono tracking-widest uppercase" style={{ color: GF.textMuted }}>System Status</span>
      </div>

      {/* State rows */}
      <div className="flex flex-col gap-0 px-3 pt-3 pb-2 flex-1">
        {([
          ["Environment", environmentStatus],
          ["Temperature", tempStatus],
          ["Smoke / Gas",  smokeStatus],
        ] as [string, string][]).map(([label, status]) => (
          <div key={label} className="flex items-center justify-between py-2"
            style={{ borderBottom: `1px solid ${GF.divider}` }}>
            <span className="text-[13px] font-mono" style={{ color: GF.textMuted }}>{label}</span>
            <StatusDot status={status} />
          </div>
        ))}
      </div>

      {/* Heat index */}
      <div className="flex items-center justify-between px-3 pb-3 pt-2">
        <span className="text-[12px] font-mono tracking-widest uppercase" style={{ color: GF.textDim }}>Heat Index</span>
        <span className="text-[16px] font-bold font-mono" style={{ color: heatColor }}>
          {typeof liveHeatIndex === "number" ? `${liveHeatIndex.toFixed(1)} °C` : liveHeatIndex}
        </span>
      </div>
    </div>
  );
}

// ─── GraphPanel (Grafana Graph style) ─────────────────────────────────────────

// `toolbar` (the Reset zoom button) and `overlay` (the zoom selection bar) were dropped
// with the zoom feature — nothing supplied them any more, and keeping optional slots for a
// feature that no longer exists just invites someone to wire them back up.
function GraphPanel({
  title, legend, children, action,
}: {
  title: string;
  legend: React.ReactNode;
  children: React.ReactNode;
  /** Optional control in the panel header, beside the live dot — used by the smoke panel for
   *  "Add smoke sensor". Kept as a slot rather than a prop per button so a second panel that
   *  needs one does not mean touching this signature again. */
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col rounded" style={{ background: GF.panel, border: `1px solid ${GF.panelBorder}` }}>
      <div className="flex items-center justify-between px-4 py-2.5 flex-wrap gap-2"
        style={{ borderBottom: `1px solid ${GF.divider}` }}>
        <div className="flex items-center gap-4 flex-wrap">
          <span className="text-[13px] font-mono tracking-widest uppercase" style={{ color: GF.textMuted }}>{title}</span>
          {legend}
        </div>
        <div className="flex items-center gap-3">
          {action}
          <LiveDot />
        </div>
      </div>
      {children}
    </div>
  );
}

// ─── LegendItem ───────────────────────────────────────────────────────────────

function LegendItem({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[13px] font-mono">
      <span className="w-3 h-[2px] rounded-full flex-shrink-0" style={{ background: color }} />
      <span style={{ color: GF.textMuted }}>{label}</span>
      <span className="font-semibold" style={{ color }}>{value}</span>
    </span>
  );
}

// ─── CalendarGrid ─────────────────────────────────────────────────────────────
// Top-level so React preserves the instance across parent re-renders

function CalendarGrid({ month, selectedDay, onSelectDay, onPrev, onNext }: {
  month: Date; selectedDay: number; onSelectDay: (d: number) => void;
  onPrev: () => void; onNext: () => void;
}) {
  const firstDow  = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
  const totalDays = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells     = Array.from({ length: firstDow + totalDays }, (_, i) =>
    i < firstDow ? null : i - firstDow + 1
  );
  const label = month.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center justify-between mb-3">
        <button onClick={onPrev}
          className="w-6 h-6 flex items-center justify-center rounded text-xs transition-colors"
          style={{ color: GF.textMuted }}
          onMouseEnter={e => { e.currentTarget.style.background = "var(--gf-hover-strong)"; e.currentTarget.style.color = GF.textPrimary; }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = GF.textMuted; }}>
          ‹
        </button>
        <span className="text-[13px] font-mono font-semibold" style={{ color: GF.textPrimary }}>{label}</span>
        <button onClick={onNext}
          className="w-6 h-6 flex items-center justify-center rounded text-xs transition-colors"
          style={{ color: GF.textMuted }}
          onMouseEnter={e => { e.currentTarget.style.background = "var(--gf-hover-strong)"; e.currentTarget.style.color = GF.textPrimary; }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = GF.textMuted; }}>
          ›
        </button>
      </div>
      <div className="grid grid-cols-7 text-center gap-y-0.5">
        {["S","M","T","W","T","F","S"].map((d, i) => (
          <div key={i} className="text-[11px] font-mono pb-1.5" style={{ color: "#5794F2" }}>{d}</div>
        ))}
        {cells.map((day, i) => (
          <button key={i} disabled={!day} onClick={() => day && onSelectDay(day)}
            className="text-[13px] font-mono rounded transition-colors leading-none"
            style={{
              visibility: day ? "visible" : "hidden",
              padding: "5px 0",
              background: day === selectedDay ? "#5794F2" : "transparent",
              color: day === selectedDay ? "#fff" : GF.textMuted,
            }}>
            {day}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── TimeScroll ───────────────────────────────────────────────────────────────
// Top-level + memo: preserves the DOM scroll position when parent state changes

const TimeScroll = React.memo(function TimeScroll({ hour, onHour, scrollRef }: {
  hour: number;
  onHour: (h: number) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="flex flex-col flex-shrink-0" style={{ width: 60 }}>
      <div className="text-[11px] font-mono tracking-widest text-center mb-2 uppercase"
        style={{ color: GF.textDim }}>Hour</div>
      <div
        ref={scrollRef}
        className="overflow-y-auto rounded"
        style={{
          height: 196,
          scrollbarWidth: "thin",
          scrollbarColor: "rgba(255,255,255,0.1) transparent",
          background: "var(--gf-scroll-bg)",
        }}
      >
        {Array.from({ length: 24 }, (_, h) => (
          <div
            key={h}
            onClick={() => {
              onHour(h);
              scrollRef.current?.scrollTo({ top: h * 32, behavior: "smooth" });
            }}
            className="text-[13px] font-mono cursor-pointer text-center transition-colors select-none"
            style={{
              padding: "6px 0",
              background: h === hour ? "rgba(87,148,242,0.22)" : "transparent",
              color: h === hour ? "#5794F2" : GF.textMuted,
              fontWeight: h === hour ? 700 : 400,
              borderLeft: h === hour ? "2px solid #5794F2" : "2px solid transparent",
            }}
          >
            {String(h).padStart(2, "0")}:00
          </div>
        ))}
      </div>
    </div>
  );
});

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function Environment() {
  // Lives out here, not inside the button, because the button renders in the toolbar and
  // its result renders below it — see useGasRecalibration for why they are apart.
  const recal = useGasRecalibration();
  const { user } = useAuth();
  // Sensor names, live: an admin renaming one on the card below must move this page's legend
  // and tooltip at the same instant, not on the next reload.
  const { labelFor: gasLabelFor, sensors: gasSensorRows } = useGasSensors();
  const gasSensors = gasSensorRows;
  const [showAddGas, setShowAddGas] = useState(false);
  // "Has the ESP32 told us its pin map." Derived rather than tracked off `esp32Status`,
  // because the thing the modal actually needs is the GPIO numbers — and they are absent for
  // exactly one reason: the device has not connected since the backend started. A separate
  // liveness flag could disagree with the data on screen; this cannot.
  const gasPinsKnown = gasSensors.some((g) => g.gpio != null);
  const [labels,   setLabels]   = useState<string[]>([]);
  // The points' real timestamps. Both charts plot the same instants, so one array serves
  // them. The axis LABELS are formatted for reading and cannot be parsed back into times
  // ("14:20" has no date), and finding an outage needs the actual instants.
  const [times,    setTimes]    = useState<number[]>([]);
  const [temps,    setTemps]    = useState<(number | null)[]>([]);
  const [hums,     setHums]     = useState<(number | null)[]>([]);
  const [liveTemp, setLiveTemp] = useState<number | string>("--");
  const [liveHum,  setLiveHum]  = useState<number | string>("--");

  const [smokeLabels, setSmokeLabels] = useState<string[]>([]);
  /* Gas is per CHANNEL now, not a fixed pair. Keyed by channel so adding a sensor is one
     more key rather than one more pair of useState calls — the whole point of the change. */
  const [gasSeries,  setGasSeries]  = useState<Record<number, (number | null)[]>>({});
  // The socket handlers below are registered once, so they cannot close over `gasChannels`
  // — a sensor added mid-session would never appear until a reload. Same ref pattern the
  // page already uses for the range span (`envSpanRef`).
  const gasChannelsRef = useRef<number[]>([]);
  const [liveGasCh,  setLiveGasCh]  = useState<Record<number, number>>({});
  // The channels to actually DRAW: the ones an admin has confirmed are wired, in order.
  const gasChannels = useMemo(
    () => gasSensorRows.filter((g) => g.enabled).map((g) => g.channel).sort((a, b) => a - b),
    [gasSensorRows],
  );
  // Kept as derived values so the existing channel-1/2 tiles, colours and gauges keep
  // working unchanged; everything NEW reads the maps above.
  const livePPM1: number | string = liveGasCh[1] ?? "--";
  const livePPM2: number | string = liveGasCh[2] ?? "--";
  const ppm1s = gasSeries[1] ?? [];
  const ppm2s = gasSeries[2] ?? [];
  useEffect(() => { gasChannelsRef.current = gasChannels; }, [gasChannels]);

  const [liveHeatIndex,         setLiveHeatIndex]         = useState<number | string>("--");
  const [liveSmokeStatus,       setLiveSmokeStatus]       = useState<AlertLevel>("NORMAL");
  const [liveTempStatus,        setLiveTempStatus]        = useState<TempLevel>("NORMAL");
  const [liveEnvironmentStatus, setLiveEnvironmentStatus] = useState<AlertLevel>("NORMAL");

  // Room-level alert thresholds (`alert_rules`) — temperature, humidity and both MQ-2
  // sensors colour against these, changing at exactly the point the system raises an
  // alert. This is the same source as `liveTempStatus` in the System Status panel (the
  // firmware computes that from the very thresholds `envConfig` pushes it), so the tile
  // and the status row now agree instead of answering with different numbers. Follows an
  // admin's Alert Rules edits live.
  const thresholds = useRoomThresholds();
  // Each series' colour right now, for the places where ONE colour has to stand for the
  // whole line: the chart's area fill, its axis and its legend swatch.
  const liveTempColor = temperatureColor(liveTemp, thresholds, TEMP_SERIES);
  const liveHumColor = alertTint(liveHum, thresholds.humWarn, thresholds.humCrit, HUM_SERIES, HUM_SERIES);
  const livePPM1Color = alertTint(livePPM1, thresholds.gasWarn, thresholds.gasCrit, MQ1_SERIES, MQ1_SERIES);
  const livePPM2Color = alertTint(livePPM2, thresholds.gasWarn, thresholds.gasCrit, MQ2_SERIES, MQ2_SERIES);
  // The smoke chart's single ppm axis serves both sensors, so it takes the HIGHER reading's
  // band — over-stating one sensor is safe, under-stating the room is not. It falls back to
  // MQ2-1's violet while both are clean, since a "normal" band has no colour of its own here.
  const ppmAxisColor = alertTint(
    typeof livePPM1 === "number" && typeof livePPM2 === "number" ? Math.max(livePPM1, livePPM2)
      : typeof livePPM1 === "number" ? livePPM1
        : livePPM2,
    thresholds.gasWarn, thresholds.gasCrit, MQ1_SERIES, MQ1_SERIES,
  );

  // Colour bundles handed to the module-level options builders. Memoised because the
  // builders are themselves memoised on identity — a fresh object every render would
  // rebuild both charts' options several times a second.
  const combinedColors = useMemo(() => ({
    tempAxis: liveTempColor,
    humAxis: liveHumColor,
    at: (datasetIndex: number, y: number | null) =>
      datasetIndex === 0
        ? temperatureColor(y, thresholds, TEMP_SERIES)
        : alertTint(y, thresholds.humWarn, thresholds.humCrit, HUM_SERIES, HUM_SERIES),
  }), [liveTempColor, liveHumColor, thresholds]);

  const smokeColors = useMemo(() => ({
    ppmAxis: ppmAxisColor,
    at: (datasetIndex: number, y: number | null) =>
      alertTint(y, thresholds.gasWarn, thresholds.gasCrit,
        datasetIndex === 0 ? MQ1_SERIES : MQ2_SERIES,
        datasetIndex === 0 ? MQ1_SERIES : MQ2_SERIES),
  }), [ppmAxisColor, thresholds]);

  // Is the ESP32 actually reporting? Without this every reading below is the LAST one
  // received, with nothing to say how old it is — a dead sensor renders exactly like a
  // stable room. Seeded from REST (the socket only fires on a transition, which may
  // never come while the page is open) and then kept live by `esp32Status`.
  const [sensorOnline,   setSensorOnline]   = useState<boolean | null>(null);
  const [sensorLastSeen, setSensorLastSeen] = useState<string | null>(null);

  // One RangeValue instead of the old range / customRange / customLabel / showCustom
  // quartet — the shared picker owns the preset-vs-custom distinction and its own
  // popover, so none of that has to be tracked here any more.
  const [range, setRange] = useState<RangeValue>(DEFAULT_RANGE);
  const [isDark,      setIsDark]      = useState(() => document.documentElement.classList.contains("dark"));
  const [isMobile,    setIsMobile]    = useState(() => window.matchMedia("(max-width: 640px)").matches);

  // Track narrow viewports so the chart x-axis can drop the year and thin out
  // ticks on mobile (see makeCombinedOptions / makeSmokeOptions).
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartRef      = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const smokeChartRef = useRef<any>(null);

  useEffect(() => {
    const obs = new MutationObserver(() => setIsDark(document.documentElement.classList.contains("dark")));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  // ESP32 liveness: initial state over REST, then live transitions over the socket.
  useEffect(() => {
    let cancelled = false;

    const resync = () => {
      api.getSensorStatus().then((res) => {
        if (cancelled || !res.success || !res.data) return;
        setSensorOnline(Boolean(res.data.online));
        setSensorLastSeen(res.data.lastSeen ?? null);
      });
    };
    resync();

    const onStatus = (s: { online?: boolean; lastSeen?: string | null }) => {
      setSensorOnline(Boolean(s?.online));
      setSensorLastSeen(s?.lastSeen ?? null);
    };
    socket.on("esp32Status", onStatus);

    // `esp32Status` only fires on a TRANSITION, so a client that was disconnected or
    // backgrounded when it fired never learns — and the banner silently stays wrong
    // until a manual refresh. Re-pull the authoritative state whenever we could have
    // missed one: on (re)connect, and when the tab regains focus.
    socket.on("connect", resync);
    const onVisible = () => { if (document.visibilityState === "visible") resync(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      socket.off("esp32Status", onStatus);
      socket.off("connect", resync);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    const handleHistory = (history: HistoryData[]) => {
      if (!history?.length) return;
      const lbls = history.map(r => fmtLabel(new Date(r.time)));
      setLabels(lbls);
      setTimes(history.map(r => Date.parse(r.time)));
      setTemps(history.map(r => r.temperature ?? null));
      setHums(history.map(r => r.humidity     ?? null));
      setSmokeLabels(lbls);
      /* One array per channel. `r.gas` is the per-sensor series; the legacy pair is the
         fallback, and it is the ONLY gas that exists for windows older than the cutover —
         so a range spanning it draws continuously instead of starting mid-chart. */
      const channels = channelsIn(history, gasChannelsRef.current);
      const byCh: Record<number, (number | null)[]> = {};
      for (const ch of channels) {
        byCh[ch] = history.map((r) => {
          const v = r.gas?.[String(ch)];
          if (typeof v === "number") return v;
          if (ch === 1) return r.mq2_1_ppm ?? null;
          if (ch === 2) return r.mq2_2_ppm ?? null;
          return null;
        });
      }
      setGasSeries(byCh);
      const last = history[history.length - 1];
      if (last) {
        setLiveTemp(last.temperature   ?? "--");
        setLiveHum(last.humidity       ?? "--");
        const lastGas: Record<number, number> = {};
        for (const ch of channels) {
          const v = last.gas?.[String(ch)];
          const legacy = ch === 1 ? last.mq2_1_ppm : ch === 2 ? last.mq2_2_ppm : null;
          const n = typeof v === "number" ? v : legacy;
          if (typeof n === "number") lastGas[ch] = n;
        }
        setLiveGasCh(lastGas);
        setLiveHeatIndex(last.heat_index ?? "--");
        // Normalised because this row can be OLD: a range reaching past the 2026-08-15
        // reflash carries the legacy DANGER tag, and the newest row of it seeds these tiles.
        setLiveSmokeStatus((normalizeStatus(last.smoke_status)       as AlertLevel) || "NORMAL");
        setLiveTempStatus((normalizeStatus(last.temp_status)          as TempLevel)  || "NORMAL");
        setLiveEnvironmentStatus((normalizeStatus(last.environment_status) as AlertLevel) || "NORMAL");
      }
    };

    const handleLive = (data: SensorData) => {
      if (!data) return;
      const ts   = new Date(data.timestamp);
      const time = fmtLabel(ts);

      setLiveTemp(data.temperature);
      setLiveHum(data.humidity);
      // `data.gas` carries every fitted sensor with its label already resolved; the legacy
      // pair covers an ESP32 that has not been reflashed yet.
      const liveByCh: Record<number, number> = {};
      if (Array.isArray(data.gas) && data.gas.length) {
        for (const g of data.gas) liveByCh[g.channel] = g.ppm;
      } else {
        if (typeof data.mq2_1_ppm === "number") liveByCh[1] = data.mq2_1_ppm;
        if (typeof data.mq2_2_ppm === "number") liveByCh[2] = data.mq2_2_ppm;
      }
      setLiveGasCh(liveByCh);
      setGasSeries((prev) => {
        const next: Record<number, (number | null)[]> = {};
        /* A channel appearing mid-session — a sensor just enabled, or a config that landed
           after the history — is padded to the length its siblings already have. Appending
           to an empty array would start it one point long against a full window of labels,
           which is the same misalignment channelsIn exists to prevent. */
        const len = Math.max(0, ...Object.values(prev).map((a) => a.length));
        const chans = new Set<number>([
          ...Object.keys(prev).map(Number),
          ...Object.keys(liveByCh).map(Number),
          ...gasChannelsRef.current,
        ]);
        for (const ch of chans) {
          const series = prev[ch] ?? new Array<number | null>(len).fill(null);
          next[ch] = [...series.slice(-999), liveByCh[ch] ?? null];
        }
        return next;
      });
      setLiveHeatIndex(data.heat_index);
      // Normalised for the same reason as the history path: an ESP32 still on the old
      // sketch reports DANGER live.
      setLiveSmokeStatus(normalizeStatus(data.smoke_status) as AlertLevel);
      setLiveTempStatus(normalizeStatus(data.temp_status) as TempLevel);
      setLiveEnvironmentStatus(normalizeStatus(data.environment_status) as AlertLevel);

      // Previously gated on "is the user zoomed in?", so live points stopped appending
      // while a selection was held. With zoom gone the charts always track live.
      setLabels(p      => [...p.slice(-999), time]);
      setTimes(p       => [...p.slice(-999), ts.getTime()]);
      setTemps(p       => [...p.slice(-999), data.temperature]);
      setHums(p        => [...p.slice(-999), data.humidity]);
      setSmokeLabels(p => [...p.slice(-999), time]);
    };

    socket.on("sensorHistory", handleHistory);
    socket.on("sensorData",    handleLive);
    socket.emit("changeRange", rangePayload(range));
    return () => {
      socket.off("sensorHistory", handleHistory);
      socket.off("sensorData",    handleLive);
    };
  }, [range]);

  // ── Derived ────────────────────────────────────────────────────────────────

  // Every figure below is computed over the readings that EXIST. A missing reading used
  // to arrive here as 0, which dragged the average down and made the minimum 0 °C — a
  // number the room has never been at and the sensor cannot report.
  const tempNums = nums(temps);
  const humNums  = nums(hums);
  const ppm1Nums = nums(ppm1s);
  const ppm2Nums = nums(ppm2s);

  const peakTemp = tempNums.length > 0 ? Math.max(...tempNums).toFixed(1) : "--";
  const minTemp  = tempNums.length > 0 ? Math.min(...tempNums).toFixed(1) : "--";
  const avgTemp  = tempNums.length > 0 ? (tempNums.reduce((a,b) => a+b,0) / tempNums.length).toFixed(1) : "--";
  const peakHum  = humNums.length  > 0 ? Math.max(...humNums).toFixed(1)  : "--";
  const minHum   = humNums.length  > 0 ? Math.min(...humNums).toFixed(1)  : "--";
  const avgHum   = humNums.length  > 0 ? (humNums.reduce((a,b) => a+b,0)  / humNums.length).toFixed(1) : "--";

  const maxTempY = tempNums.length > 0 ? Math.ceil(Math.max(...tempNums))  + 3  : 40;
  const minTempY = tempNums.length > 0 ? Math.floor(Math.min(...tempNums)) - 2  : 15;
  const maxHumY  = humNums.length  > 0 ? Math.ceil(Math.max(...humNums))   + 3  : 100;
  const minHumY  = humNums.length  > 0 ? Math.floor(Math.min(...humNums))  - 3  : 30;

  const allPPMs   = [...ppm1Nums, ...ppm2Nums];
  const allScale  = allPPMs.length > 0 ? allPPMs : [0];
  const maxSmokeY = Math.ceil(Math.max(...allScale))  + 50;
  const minSmokeY = Math.max(0, Math.floor(Math.min(...allScale)) - 10);

  const tempGaugePct = typeof liveTemp === "number" ? (liveTemp - 15) / 25 : 0;
  const humGaugePct  = typeof liveHum  === "number" ? (liveHum  - 30) / 70 : 0;

  // Memoized so the chart only receives new props when data actually changes — every
  // live-stat re-render would otherwise produce new object references and make
  // react-chartjs-2 call chart.update() on both charts several times a second.
  const combinedOpts = useMemo(
    () => makeCombinedOptions({
      isDark, isMobile,
      minTemp: minTempY, maxTemp: maxTempY,
      minHum: minHumY, maxHum: maxHumY,
      colors: combinedColors,
    }),
    [isDark, isMobile, minTempY, maxTempY, minHumY, maxHumY, combinedColors],
  );
  const smokeOpts = useMemo(
    () => makeSmokeOptions({
      isDark, isMobile,
      minPPM: minSmokeY, maxPPM: maxSmokeY,
      colors: smokeColors,
      labelFor: (i: number) => gasLabelFor(gasChannels[i] ?? i + 1),
    }),
    [isDark, isMobile, minSmokeY, maxSmokeY, smokeColors, gasLabelFor, gasChannels],
  );

  // Both charts break their lines wherever the ESP32 stopped reporting, so a dropout is a
  // visible hole with a start and an end rather than one straight segment drawn across
  // it. Smoothing runs FIRST, on the dense arrays: `smooth()` averages a sliding window
  // and would smear a null across its neighbours.
  const envGaps = useMemo(
    () => withGaps(times, labels, [smooth(temps), smooth(hums)]),
    [times, labels, temps, hums],
  );
  // One smoothed series per FITTED channel, in channel order — so dataset index i is
  // gasChannels[i] everywhere below, including the tooltip's labelFor.
  const smokeGaps = useMemo(
    () => withGaps(times, smokeLabels, gasChannels.map((ch) => smooth(gasSeries[ch] ?? []))),
    [times, smokeLabels, gasChannels, gasSeries],
  );

  const combinedData: ChartData<"line"> = useMemo(() => ({
    labels: envGaps.labels,
    datasets: [
      {
        label: "Temperature", data: envGaps.series[0]!, yAxisID: "yTemp",
        // Each SEGMENT takes the alert band of the point it ends on, so the line is blue
        // where the room was too cold and red where it breached critical. History keeps
        // its own colours — repainting the whole line by the newest reading would have
        // made claims about the past that were not true. `borderColor` is the fallback.
        borderColor: TEMP_SERIES,
        segment: {
          borderColor: (ctx) => temperatureColor(ctx.p1.parsed.y, thresholds, TEMP_SERIES),
        },
        // One fill region cannot be split per band, so it follows the CURRENT reading.
        backgroundColor: (ctx: ScriptableContext<"line">) =>
          gradientFill(ctx, withAlpha(liveTempColor, 0.16), withAlpha(liveTempColor, 0.01)),
        borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4,
        pointHoverBackgroundColor: (ctx: ScriptableContext<"line">) =>
          temperatureColor(ctx.parsed?.y, thresholds, TEMP_SERIES),
        fill: true, tension: 0.4,
      },
      {
        label: "Humidity", data: envGaps.series[1]!, yAxisID: "yHum",
        // Holds its own blue while within the `humidity` rules, orange/red per segment
        // where it breached them. It shares this chart with temperature, so going green
        // when normal would draw the same line twice.
        borderColor: HUM_SERIES,
        segment: {
          borderColor: (ctx) =>
            alertTint(ctx.p1.parsed.y, thresholds.humWarn, thresholds.humCrit, HUM_SERIES, HUM_SERIES),
        },
        backgroundColor: (ctx: ScriptableContext<"line">) =>
          gradientFill(ctx, withAlpha(liveHumColor, 0.12), withAlpha(liveHumColor, 0.01)),
        borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4,
        pointHoverBackgroundColor: (ctx: ScriptableContext<"line">) =>
          alertTint(ctx.parsed?.y, thresholds.humWarn, thresholds.humCrit, HUM_SERIES, HUM_SERIES),
        fill: true, tension: 0.4,
      },
    ],
  }), [envGaps, thresholds, liveTempColor, liveHumColor]);

  const smokeData: ChartData<"line"> = useMemo(() => ({
    labels: smokeGaps.labels,
    datasets: [
      // Each sensor keeps its OWN hue while clean — MQ2-1 violet, MQ2-2 pink — and turns
      // orange/red per segment where it breached the `gas` rules (`alertTint`).
      //
      // That identity is what lets you watch the two disagree, which is the whole point of
      // having two. Painting both green when clean merged them into one indistinct band
      // for the majority of the time the chart is on screen. They DO converge on the
      // same red if both go critical at once; the legend labels and values separate them
      // there, and a `borderDash` on MQ2-2 is the fix if that case ever needs to be read at
      // a glance.
      ...gasChannels.map((ch, i) => {
        const hue = gasSeriesColor(ch);
        const live = liveGasCh[ch];
        // The fill follows the CURRENT reading (one gradient cannot be split per band);
        // the LINE is coloured per segment, so history keeps the colours it actually had.
        const liveHue = alertTint(live, thresholds.gasWarn, thresholds.gasCrit, hue, hue);
        return {
          label: gasLabelFor(ch),
          data: smokeGaps.series[i]!,
          borderColor: hue,
          segment: {
            borderColor: (ctx: any) =>
              alertTint(ctx.p1.parsed.y, thresholds.gasWarn, thresholds.gasCrit, hue, hue),
          },
          backgroundColor: (ctx: ScriptableContext<"line">) =>
            // Fills are stacked on one axis, so they get fainter as sensors are added —
            // four opaque gradients would be a wash nobody can read a line out of.
            gradientFill(ctx, withAlpha(liveHue, 0.14 / Math.max(1, gasChannels.length * 0.6)),
                         withAlpha(liveHue, 0.01)),
          borderWidth: 1.5,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: (ctx: ScriptableContext<"line">) =>
            alertTint(ctx.parsed?.y, thresholds.gasWarn, thresholds.gasCrit, hue, hue),
          fill: true,
          tension: 0.4,
        };
      }),
    ],
  }), [smokeGaps, thresholds, gasChannels, liveGasCh, gasLabelFor]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{
        background:  "var(--gf-bg)",
        fontFamily:  "'JetBrains Mono','Fira Code',monospace",
        // ── Theme tokens ─────────────────────────────────────────────────────
        "--gf-bg":           isDark ? "#111217"                    : "#F8F9FA",
        "--gf-panel":        isDark ? "#181B1F"                    : "#FFFFFF",
        "--gf-panel-border": isDark ? "rgba(255,255,255,0.08)"     : "rgba(0,0,0,0.10)",
        "--gf-header":       isDark ? "#1A1D23"                    : "#F3F4F6",
        "--gf-divider":      isDark ? "rgba(255,255,255,0.07)"     : "rgba(0,0,0,0.08)",
        "--gf-text-primary": isDark ? "#D9D9D9"                    : "#1F2937",
        "--gf-text-muted":   isDark ? "#6B7280"                    : "#6B7280",
        "--gf-text-dim":     isDark ? "#4B5563"                    : "#9CA3AF",
        "--gf-hover":        isDark ? "rgba(255,255,255,0.06)"     : "rgba(0,0,0,0.05)",
        "--gf-hover-strong": isDark ? "rgba(255,255,255,0.12)"     : "rgba(0,0,0,0.08)",
        "--gf-seg-empty":    isDark ? "rgba(255,255,255,0.06)"     : "rgba(0,0,0,0.08)",
        "--gf-scroll-bg":    isDark ? "rgba(0,0,0,0.25)"           : "rgba(0,0,0,0.04)",
      } as React.CSSProperties}
    >

      {/* ── Toolbar (range picker) — page title comes from the global Header ── */}
      {/* Scrolls sideways on a phone instead of wrapping. Wrapping put Recalibrate on
          its own row above the range buttons, which reads as two unrelated toolbars and
          costs a second row of vertical space on the screen that has least of it. The
          children are held at their natural width (`shrink-0`) or the range buttons
          squash into unreadable slivers before the row ever scrolls. */}
      <div className="flex items-center justify-end px-4 py-2.5 gap-3 flex-nowrap overflow-x-auto sm:flex-wrap sm:overflow-x-visible"
        style={{ background: GF.header, borderBottom: `1px solid ${GF.panelBorder}` }}>
        {recal.isAdmin && (
          <div className="shrink-0"><RecalibrateGasButton busy={recal.busy} run={recal.run} /></div>
        )}
        {/* Same shared picker the Server Metrics / detail pages use, on its DEFAULT
            variant so the control — and the custom-range popover in particular — is
            identical everywhere. No refresh button: `sensorData` streams in live every
            ~3s, so the view is never stale enough to need one. */}
        <div className="shrink-0"><RangePicker value={range} onChange={setRange} /></div>
      </div>

      {/* Calibration result — full width, directly under the button that caused it. */}
      {recal.isAdmin && recal.result && <GasCalibrationNotice result={recal.result} />}

      {/* ── Sensor-offline banner ──────────────────────────────────────────────
          Everything below renders the LAST reading received. When the ESP32 stops
          reporting those numbers freeze, and without this banner a dead sensor is
          indistinguishable from a calm, stable room — the single most dangerous
          failure mode on this page. */}
      {sensorOnline === false && (
        <div
          className="mx-4 mt-3 flex items-start gap-3 px-4 py-3"
          style={{
            background: "rgba(224,47,68,0.10)",
            border: "1px solid rgba(224,47,68,0.35)",
            borderRadius: 2,
          }}
          role="alert"
        >
          <span style={{ color: "#E02F44", fontSize: 14, lineHeight: "18px" }}>■</span>
          <div className="flex flex-col gap-0.5">
            <span className="text-[14px] font-bold" style={{ color: "#E02F44" }}>
              Environment sensor offline — readings below are stale
            </span>
            <span className="text-[13px]" style={{ color: "var(--gf-text-muted)" }}>
              The ESP32 has stopped reporting, so temperature, humidity and smoke are
              not being monitored.
              {sensorLastSeen
                ? ` Last reading ${new Date(sensorLastSeen).toLocaleString()}.`
                : " No readings have been received."}
            </span>
          </div>
        </div>
      )}

      {/* ── Panel grid ── */}
      <div className="flex flex-col gap-3 p-4">

        {/* Row 1: Stat panels + Status */}
        {/* Temperature + Humidity + one tile per fitted sensor + the state panel.
            `auto-fit` + a min width rather than a fixed column count: the number of tiles is
            DATA now, and `lg:grid-cols-5` was right for exactly two sensors — at three it
            left a ragged orphan on its own row, at four it left two. This reflows for any
            count at any width, and the 190px floor is what stops four sensors squeezing every
            tile past readable instead of wrapping, which is the better failure. */}
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}
        >
          {/* Coloured by the `temperature` ALERT RULES (utils/envThresholds.ts), so the
              gauge, the sparkline and the MAX/AVG/MIN row all read blue / green / orange /
              red with the room rather than sitting on one fixed amber — and they change at
              the same instant the alert fires. The band is named beside the dot. */}
          <StatPanel
            title="Temperature"
            value={typeof liveTemp === "number" ? liveTemp.toFixed(1) : liveTemp}
            unit="°C" color={temperatureColor(liveTemp, thresholds)} segPct={tempGaugePct}
            badge={temperatureLabel(liveTemp, thresholds)}
            sparkData={tempNums.slice(-24)}
            max={peakTemp !== "--" ? `${peakTemp}°` : "--"}
            avg={avgTemp  !== "--" ? `${avgTemp}°`  : "--"}
            min={minTemp  !== "--" ? `${minTemp}°`  : "--"}
            isDark={isDark}
          />
          {/* Keeps its own blue while within the `humidity` rules (seeded ≥60 warning,
              ≥70 critical), orange/red once past them — the tile and the chart line
              therefore always show the same colour for the same reading. The band is
              named beside the dot, so "normal" is still stated outright. */}
          <StatPanel
            title="Humidity"
            value={typeof liveHum === "number" ? liveHum.toFixed(1) : liveHum}
            unit="%" color={alertTint(liveHum, thresholds.humWarn, thresholds.humCrit, HUM_SERIES)}
            segPct={humGaugePct}
            badge={humidityLabel(liveHum, thresholds)}
            sparkData={humNums.slice(-24)}
            max={peakHum !== "--" ? `${peakHum}%` : "--"}
            avg={avgHum  !== "--" ? `${avgHum}%`  : "--"}
            min={minHum  !== "--" ? `${minHum}%`  : "--"}
            isDark={isDark}
          />
          {/* One tile PER FITTED SENSOR, titled by location. These are where somebody reads
              MAX/AVG/MIN for one sensor, and a channel number says nothing about which part
              of the room those figures describe.
              Each keeps its own identity hue while clean — matching its line on the chart
              below — and turns orange/red against the same global `gas` rules the alerting
              uses, so a tile going orange and the alert arriving in the bell are one event. */}
          {gasChannels.map((ch) => {
            const hue = gasSeriesColor(ch);
            const live = liveGasCh[ch];
            const vals = nums(gasSeries[ch] ?? []);
            return (
              <StatPanel
                key={ch}
                title={gasLabelFor(ch)}
                value={typeof live === "number" ? live.toFixed(1) : "--"}
                unit="ppm"
                color={alertTint(live, thresholds.gasWarn, thresholds.gasCrit, hue, hue)}
                badge={gasLabel(live, thresholds)}
                segPct={typeof live === "number" ? Math.min(live / 600, 1) : 0}
                sparkData={vals.slice(-24)}
                max={vals.length ? `${Math.max(...vals).toFixed(0)}` : "--"}
                avg={vals.length ? `${(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(0)}` : "--"}
                min={vals.length ? `${Math.min(...vals).toFixed(0)}` : "--"}
                isDark={isDark}
              />
            );
          })}
          <StatePanel
            smokeStatus={liveSmokeStatus}
            environmentStatus={liveEnvironmentStatus}
            tempStatus={liveTempStatus}
            liveHeatIndex={liveHeatIndex}
          />
        </div>

        {/* Row 2: Temperature & Humidity chart */}
        <GraphPanel
          title="Temperature & Humidity"
          legend={
            <>
              {/* Muted fallback, not the chart's amber: with the ESP32 offline this reads
                  "--", and a live-looking colour beside it would suggest a reading. */}
              <LegendItem color={temperatureColor(liveTemp, thresholds)} label="Temperature"
                value={typeof liveTemp === "number" ? `${liveTemp.toFixed(1)} °C` : "--"} />
              <LegendItem color={alertTint(liveHum, thresholds.humWarn, thresholds.humCrit, HUM_SERIES)} label="Humidity"
                value={typeof liveHum === "number" ? `${liveHum.toFixed(1)} %` : "--"} />
            </>
          }
          >
          <div style={{ height: 300, padding: "12px 12px 16px" }}>
            <Line ref={chartRef} data={combinedData} options={combinedOpts} />
          </div>
        </GraphPanel>

        {showAddGas && (
          <AddGasSensorModal
            sensors={gasSensors}
            esp32Online={gasPinsKnown}
            onClose={() => setShowAddGas(false)}
          />
        )}


        {/* Row 3: Smoke PPM chart */}
        <GraphPanel
          title="Smoke / Gas (MQ-2)"
          action={
            user?.role === "admin" && (
              <button
                onClick={() => setShowAddGas(true)}
                className="gf-btn flex items-center gap-1.5 h-7 px-3 text-[12px] font-semibold"
                style={{ color: "var(--gf-text-primary)" }}
              >
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                  <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
                Add smoke sensor
              </button>
            )
          }
          legend={
            <>
              {/* One entry per FITTED sensor, labelled by location and coloured to match its
                  line. Two sensors are only worth having if they sit in different places, and
                  at that point the channel number is the least useful thing to print.
                  Falls back to MQ2-<n> for anything unnamed. */}
              {gasChannels.map((ch) => {
                const hue = gasSeriesColor(ch);
                const v = liveGasCh[ch];
                return (
                  <LegendItem
                    key={ch}
                    color={alertTint(v, thresholds.gasWarn, thresholds.gasCrit, hue)}
                    label={gasLabelFor(ch)}
                    value={typeof v === "number" ? `${v.toFixed(1)} ppm` : "--"}
                  />
                );
              })}
              <StatusBadge status={liveSmokeStatus} />
            </>
          }
          >
          {/* Threshold legend. Reads the LIVE `gas` rules — it used to print "150" and
              "300" as literals, so editing the rule left the caption stating numbers the
              chart was no longer using. A missing rule prints nothing rather than a
              number that is not in force. */}
          <div className="flex gap-5 px-4 pt-2 text-[11px] font-mono">
            {thresholds.gasWarn != null && (
              <span className="flex items-center gap-1.5">
                <span className="w-5 h-px inline-block" style={{ background: "#FF780A" }} />
                <span style={{ color: GF.textDim }}>WARNING {thresholds.gasWarn} ppm</span>
              </span>
            )}
            {thresholds.gasCrit != null && (
              <span className="flex items-center gap-1.5">
                <span className="w-5 h-px inline-block" style={{ background: "#E02F44" }} />
                <span style={{ color: GF.textDim }}>CRITICAL {thresholds.gasCrit} ppm</span>
              </span>
            )}
          </div>
          <div style={{ height: 300, padding: "8px 12px 16px" }}>
            <Line ref={smokeChartRef} data={smokeData} options={smokeOpts} />
          </div>
        </GraphPanel>

      </div>
    </div>
  );
}
