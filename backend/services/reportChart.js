import {
  niceMax,
  ticks,
  axisLabel,
  yFor,
  xPositions,
  barLayout,
  labelIndices,
  segments,
} from "./chartMath.js";

// ─── Report charts ───────────────────────────────────────────────────────────
// Line and bar charts drawn as vectors with pdfkit (no chart library, no images), so
// they stay sharp when printed. Layout only: the builders decide what a chart
// shows, chartMath decides where things go.
//
// Spec:
//   { title, kind: "line" | "bar", unit?, labels: string[],
//     series: [{ name, color, values: (number|null)[] }] }
//
// A `null` value is a gap, not a zero (see chartMath.segments).

const AXIS = "#9aa1ab";
const GRID = "#e5e7eb";
const INK = "#1a1d23";
const MUTED = "#6B7280";

/** Series colours, in order. Taken from the dashboard so a reader who learned "blue is
 *  CPU" on screen does not have to re-learn it on paper. */
export const SERIES_COLORS = ["#378ADD", "#7F77DD", "#EF9F27", "#73BF69", "#E02F44", "#3CC8E8"];

const PLOT_H = 132;
const LEFT_GUTTER = 34; // room for y-axis labels
const BOTTOM_GUTTER = 16; // room for x-axis labels
const LEGEND_H = 14;

/** Total vertical space one chart occupies, for page-break arithmetic. */
export const chartHeight = (spec) =>
  18 + PLOT_H + BOTTOM_GUTTER + (spec?.series?.length > 1 ? LEGEND_H : 0) + 10;

/**
 * Draw one chart at the current position.
 *
 * @param {PDFKit.PDFDocument} doc
 * @param {object} spec see the shape above
 * @param {{ font: string, bold: string, size?: number }} fonts registered font names
 */
export function drawChart(doc, spec, fonts) {
  const labels = spec?.labels ?? [];
  const series = (spec?.series ?? []).filter((s) => Array.isArray(s.values) && s.values.length);
  if (!labels.length || !series.length) return;

  const size = fonts.size ?? 7.5;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;

  // ── Title ──
  doc.fillColor(INK).font(fonts.bold).fontSize(9);
  doc.text(spec.title ?? "", left, doc.y, { width: right - left, lineBreak: false });
  const plotY = doc.y + 6;
  const plotX = left + LEFT_GUTTER;
  const plotW = right - plotX;

  // ── Axis ──
  // All series share one axis, so a small wobble and a big climb do not look the same
  // (as on the dashboard's ServerFocus chart).
  const all = series.flatMap((s) => s.values).filter((v) => typeof v === "number" && Number.isFinite(v));
  const top = spec.max ?? niceMax(all.length ? Math.max(...all) : 0);

  doc.font(fonts.font).fontSize(size);
  for (const t of ticks(top, 4)) {
    const y = yFor(t, top, plotY, PLOT_H);
    doc.moveTo(plotX, y).lineTo(plotX + plotW, y).lineWidth(0.4).strokeColor(GRID).stroke();
    doc.fillColor(MUTED).text(axisLabel(t), left, y - size / 2 - 1, {
      width: LEFT_GUTTER - 4, align: "right", lineBreak: false,
    });
  }
  // Baseline and left edge, drawn over the gridlines.
  doc.moveTo(plotX, plotY + PLOT_H).lineTo(plotX + plotW, plotY + PLOT_H)
    .lineWidth(0.7).strokeColor(AXIS).stroke();

  // ── Plot ──
  if (spec.kind === "bar") {
    const { groupW, barW, gap } = barLayout(labels.length, series.length, plotW);
    series.forEach((s, si) => {
      doc.fillColor(s.color ?? SERIES_COLORS[si % SERIES_COLORS.length]);
      s.values.forEach((v, i) => {
        if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return;
        const y = yFor(v, top, plotY, PLOT_H);
        const x = plotX + i * groupW + gap / 2 + si * barW;
        doc.rect(x, y, barW, plotY + PLOT_H - y).fill();
      });
    });
  } else {
    const xs = xPositions(labels.length, plotX, plotW);
    series.forEach((s, si) => {
      const color = s.color ?? SERIES_COLORS[si % SERIES_COLORS.length];
      // Each run of real numbers is its own path — a gap breaks the line rather than
      // being bridged by a segment through time nothing was measured in.
      for (const run of segments(s.values)) {
        if (run.values.length === 1) {
          // A lone reading still has to be visible; a zero-length path draws nothing.
          const x = xs[run.start];
          const y = yFor(run.values[0], top, plotY, PLOT_H);
          doc.circle(x, y, 1.6).fill(color);
          continue;
        }
        doc.moveTo(xs[run.start], yFor(run.values[0], top, plotY, PLOT_H));
        for (let k = 1; k < run.values.length; k++) {
          doc.lineTo(xs[run.start + k], yFor(run.values[k], top, plotY, PLOT_H));
        }
        doc.lineWidth(1.1).strokeColor(color).stroke();
      }
    });
  }

  // ── X labels ──
  // Thinned so long ranges stay readable, always keeping the first and last.
  const keep = labelIndices(labels.length, spec.kind === "bar" ? 10 : 8);
  const xs = spec.kind === "bar"
    ? labels.map((_, i) => plotX + (plotW / labels.length) * (i + 0.5))
    : xPositions(labels.length, plotX, plotW);
  doc.font(fonts.font).fontSize(size).fillColor(MUTED);
  labels.forEach((lab, i) => {
    if (!keep.has(i)) return;
    const w = 46;
    doc.text(String(lab), xs[i] - w / 2, plotY + PLOT_H + 4, {
      width: w, align: "center", lineBreak: false,
    });
  });

  let y = plotY + PLOT_H + BOTTOM_GUTTER;

  // ── Legend ──
  // Only with more than one series.
  if (series.length > 1) {
    let x = plotX;
    doc.fontSize(size);
    series.forEach((s, si) => {
      const color = s.color ?? SERIES_COLORS[si % SERIES_COLORS.length];
      doc.rect(x, y + 2, 7, 4).fill(color);
      doc.fillColor(MUTED).text(s.name ?? "", x + 10, y, { lineBreak: false });
      x += 10 + doc.widthOfString(s.name ?? "") + 14;
    });
    y += LEGEND_H;
  }

  doc.x = left;
  doc.y = y + 10;
}

export default { drawChart, chartHeight, SERIES_COLORS };
