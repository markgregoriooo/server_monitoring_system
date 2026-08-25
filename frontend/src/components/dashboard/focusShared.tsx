import type { ChartOptions } from "chart.js";

// ─── Shared parts of the Dashboard's three "focus" panels ───────────────────────
//
// Servers, Network and UPS all answer the same shape of question on the Dashboard —
// pick one device, see its headline numbers, see whether they are moving — so the tile,
// the legend, the axis formatting and the chart options live here once. Three copies of
// a Chart.js options object is exactly how two panels quietly end up with different tick
// densities and a reader starts mistrusting the axes.
//
// What is NOT shared: which metrics each panel shows, and their units. Those differ per
// device class and belong in the individual components.

// Chart body height, shared so the three panels line up when they sit side by side in a
// two-column row. Smaller than pages/ServerDetail's charts on purpose: this is the
// glance, and each panel now occupies half a row rather than the full width.
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
 * MB/s between two CUMULATIVE byte counters.
 *
 * Only the SERVER path needs this: `server_metrics` stores raw counters, so the rate
 * exists only as a difference. The network endpoint already derives its rate server-side
 * (`derivative(nonNegative: true)`) and hands back bytes/sec directly.
 *
 * Math.max clamps a counter reset — an agent restart or host reboot — to 0 rather than
 * graphing a large negative spike.
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

// A `Tile` component lived here, drawing the 2x2 headline-number grid each panel used to
// carry above its chart. Those grids are gone: on the server panel they restated the
// table directly above them, and on all three they cost more height than the chart they
// introduced. The current values now ride on the legend, which had the labels anyway.

/**
 * Legend entry, optionally carrying the series' CURRENT value.
 *
 * `valueColor` is separate from `color` on purpose. The dot must stay the series' colour
 * — it is what maps this label to a line on the chart — while the value is free to take
 * its own alert band. UPS battery needs exactly that: its line is green because green is
 * the battery series, but 15% must not read green.
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
 * Chart.js options for a focus panel's line chart.
 *
 * `min`/`max` are passed explicitly rather than left to auto-scaling for the PERCENT
 * charts: a metric sitting flat at 12% with 1% of noise auto-scales into a dramatic
 * mountain range. Throughput has no natural ceiling, so it auto-scales and omits them.
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
 * Shared dataset styling, so the three charts draw with the same weight and smoothing.
 *
 * `null` is a meaningful value here, not a missing one: Chart.js breaks the line at a
 * null, which is how an outage is drawn as a hole rather than as a straight segment
 * across it. `spanGaps` is left at its default (false) for exactly that reason.
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
