import type { ChartOptions } from "chart.js";

// ─── Shared parts of the Dashboard's three focus panels ───────────────────────
// Servers, Network and UPS all show one device's numbers and trend, so the legend,
// axis formatting and chart options are defined once here and match. Which metrics
// and units each shows stays in the component.

// Chart height, shared so panels side by side line up. Smaller than ServerDetail's
// charts; each panel is half a row.
export const FOCUS_CHART_H = 140;

const MULTI_DAY_SEC = 48 * 3600;

/** A window longer than two days needs DATES — "14:00" repeated across a week says nothing. */
export function fmtTime(iso: string, spanSec: number) {
  const d = new Date(iso);
  return spanSec >= MULTI_DAY_SEC
    ? d.toLocaleString("en-PH", {
        timeZone: "Asia/Manila", month: "short", day: "2-digit", hour: "2-digit", hour12: false,
      })
    : d.toLocaleTimeString("en-PH", {
        timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", hour12: false,
      });
}

/**
 * MB/s between two cumulative byte counters. Only the server panel needs this; the
 * network endpoint already returns bytes/sec. Math.max turns a counter reset
 * (restart, reboot) into 0 instead of a big negative spike.
 */
// rateMBs now lives in utils/format — ServerDetail had a byte-identical copy.
// Re-exported so the dashboard focus panels keep importing it from here.
export { rateMBs } from "../../utils/format";

/** Green / orange / red for a 0-100 utilisation figure. Matches the Dashboard's table. */
export function loadColor(v: number) {
  if (v >= 90) return "#F2495C";
  if (v >= 75) return "#FF780A";
  return "#73BF69";
}

// The old 2x2 `Tile` grid was removed; current values are shown on the legend.

/**
 * Legend entry, optionally with the series' current value. `valueColor` is separate
 * from `color`: the dot keeps the series colour, while the value can show its alert
 * colour (e.g. UPS battery at 15% must not look green).
 */
export function LegendDot({
  color, label, value, valueColor,
}: { color: string; label: string; value?: string; valueColor?: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px]" style={{ color: "var(--gf-text-muted)" }}>
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
      {label}
      {value && (
        <span className="font-semibold" style={{ color: valueColor ?? color }}>
          {value}
        </span>
      )}
    </span>
  );
}

/** Centred message inside a chart-sized box — loading, empty, or nothing selected. */
export function ChartMessage({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex items-center justify-center text-center px-4 text-[12px]"
      style={{ height: FOCUS_CHART_H, color: "var(--gf-text-dim)" }}
    >
      {children}
    </div>
  );
}

/**
 * Chart.js options for a focus panel. Percent charts get a fixed `min`/`max` so a
 * flat line with a little noise does not look dramatic; throughput has no ceiling
 * and auto-scales.
 */
export function focusLineOptions(
  isDark: boolean,
  {
    unit = "", min, max, decimals = 1, format,
  }: {
    unit?: string;
    min?: number;
    max?: number;
    decimals?: number;
    /** Overrides unit/decimals — for values whose magnitude spans orders (throughput). */
    format?: (v: number) => string;
  },
): ChartOptions<"line"> {
  const show = format ?? ((v: number) => `${v.toFixed(decimals)}${unit}`);
  const AX = isDark ? "rgba(160,170,190,0.5)" : "rgba(71,85,105,0.85)";
  const GRID = isDark ? "rgba(255,255,255,0.04)" : "rgba(15,23,42,0.08)";
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false }, // drawn as dots below, to match the tile row's density
      tooltip: {
        backgroundColor: isDark ? "rgba(10,14,26,0.97)" : "rgba(255,255,255,0.97)",
        borderColor: "rgba(255,255,255,0.08)",
        borderWidth: 1,
        titleColor: isDark ? "rgba(150,170,210,0.6)" : "rgba(80,100,130,0.7)",
        bodyColor: isDark ? "#e8eef8" : "#1e293b",
        padding: 9,
        titleFont: { family: "monospace", size: 10 },
        bodyFont: { family: "monospace", size: 11 },
        callbacks: {
          label: (ctx) => ` ${ctx.dataset.label}: ${show(ctx.parsed.y as number)}`,
        },
      },
    },
    scales: {
      x: {
        grid: { color: GRID, drawTicks: false },
        border: { display: false },
        ticks: {
          color: AX, font: { size: 9, family: "monospace" },
          maxTicksLimit: 5, autoSkip: true, maxRotation: 0,
        },
      },
      y: {
        ...(min != null ? { min } : {}),
        ...(max != null ? { max } : {}),
        grid: { color: GRID, drawTicks: false },
        border: { display: false },
        ticks: {
          color: AX, font: { size: 9, family: "monospace" }, maxTicksLimit: 4,
          callback: (v) => (format ? format(Number(v)) : `${v}${unit}`),
        },
      },
    },
  };
}

/**
 * Shared dataset style. Chart.js breaks the line at a null, so an outage shows as a
 * gap; `spanGaps` stays false for that reason.
 */
export function lineSeries(label: string, data: (number | null)[], color: string, fill = false) {
  return {
    label,
    data,
    borderColor: color,
    backgroundColor: color + "1a",
    borderWidth: 1.5,
    tension: 0.35,
    pointRadius: 0,
    fill,
  };
}
