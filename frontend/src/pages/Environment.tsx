import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import React from "react";
import { Line } from "react-chartjs-2";
import { Chart, registerables } from "chart.js";
import "../chart/ChartConfig";
import type { ChartOptions, ChartData, ScriptableContext } from "chart.js";
import { socket } from "../socket/socket";
import { api } from "../api/api";
import { useAuth } from "../context/AuthContext";

Chart.register(...registerables);

// ─── Gas sensor recalibration ─────────────────────────────────────────────────
// The MQ-2 needs a "clean air" reference (Ro) that differs per sensor and per room.
// It used to require editing RO_CLEAN_AIR_* in the firmware and reflashing on every
// move; the ESP32 now measures and stores it itself, and this button asks it to
// re-measure. Admin-only, confirmed, because the device records whatever it smells
// AT THAT MOMENT as clean — calibrating in poor air makes it under-report smoke.

function RecalibrateGas({ isDark }: { isDark: boolean }) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    const onDone = (d: { ok?: boolean; ro1?: number; ro2?: number }) => {
      setBusy(false);
      setResult(
        d?.ok
          ? { ok: true, msg: `Calibrated — Ro1 ${Number(d.ro1).toFixed(2)} kΩ · Ro2 ${Number(d.ro2).toFixed(2)} kΩ` }
          : { ok: false, msg: "Rejected — reading out of range. Previous baseline kept." },
      );
      setTimeout(() => setResult(null), 8000);
    };
    socket.on("gasCalibrated", onDone);
    return () => { socket.off("gasCalibrated", onDone); };
  }, []);

  if (user?.role !== "admin") return null;

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

  return (
    <div className="flex items-center gap-2">
      {result && (
        <span className="text-[12px] px-2 py-1 rounded-[2px] whitespace-nowrap"
          style={{
            color: result.ok ? "#73BF69" : "#F2495C",
            background: (result.ok ? "#73BF69" : "#F2495C") + "14",
            border: `1px solid ${(result.ok ? "#73BF69" : "#F2495C")}40`,
          }}>
          {result.msg}
        </span>
      )}
      {/* .gf-btn supplies the raised face, border, hover and press-inset (and its own
          :disabled), so the hand-rolled border/background go. */}
      <button
        onClick={run}
        disabled={busy}
        title="Re-measure the MQ-2 clean-air baseline (admin) — use after moving the sensor"
        className="gf-btn text-[13px] px-2.5 py-1"
        style={{ color: "var(--gf-text-muted)" }}
      >
        {busy ? "Calibrating…" : "Recalibrate gas"}
      </button>
    </div>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

type QuickRangeType = "-30m" | "-1h" | "-3h" | "-6h" | "-12h" | "-24h" | "-2d" | "-7d" | "-30d";
type RangeType      = QuickRangeType | "custom";
type AlertLevel     = "NORMAL" | "WARNING" | "DANGER";
type TempLevel      = "TOO_COLD" | "NORMAL" | "WARNING" | "DANGER" | "CRITICAL";

interface CustomRange { start: string; stop: string; }

interface SensorData {
  temperature:        number;
  humidity:           number;
  mq2_1_ppm:         number;
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
  mq2_2_ppm:         number | null;
  heat_index:         number | null;
  smoke_status:       AlertLevel | null;
  temp_status:        TempLevel | null;
  environment_status: AlertLevel | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const QUICK_RANGES: { label: string; value: QuickRangeType }[] = [
  { label: "Last 30 minutes", value: "-30m"  },
  { label: "Last 1 hour",     value: "-1h"   },
  { label: "Last 3 hours",    value: "-3h"   },
  { label: "Last 6 hours",    value: "-6h"   },
  { label: "Last 12 hours",   value: "-12h"  },
  { label: "Last 24 hours",   value: "-24h"  },
  { label: "Last 2 days",     value: "-2d"   },
  { label: "Last 7 days",     value: "-7d"   },
  { label: "Last 30 days",    value: "-30d"  },
];

const RANGE_LABEL: Record<QuickRangeType, string> = {
  "-30m": "Last 30 minutes", "-1h": "Last 1 hour",   "-3h": "Last 3 hours",
  "-6h":  "Last 6 hours",    "-12h": "Last 12 hours", "-24h": "Last 24 hours",
  "-2d":  "Last 2 days",     "-7d": "Last 7 days",   "-30d": "Last 30 days",
};

const STATUS_COLOR: Record<string, string> = {
  NORMAL:   "#73BF69",
  TOO_COLD: "#5794F2",
  WARNING:  "#FF780A",
  DANGER:   "#F2495C",
  CRITICAL: "#E02F44",
};

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

// Parses "Jun 04 2026 14:30" back to ISO — used when applying a drag-zoom selection as a range
function parseLabelToISO(label: string): string {
  const months: Record<string, number> = {
    Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11,
  };
  const [mon, day, year, time = "00:00"] = label.split(" ");
  const [h = "0", m = "0"] = time.split(":");
  return new Date(+(year ?? 0), months[mon ?? ""] ?? 0, +(day ?? 1), +h, +m).toISOString();
}

// ─── Chart helpers ────────────────────────────────────────────────────────────

function makeCombinedOptions(
  isDark: boolean,
  isMobile: boolean,
  minTemp: number, maxTemp: number,
  minHum: number,  maxHum: number,
  onZoom?: (start: string, end: string) => void,
): ChartOptions<"line"> {
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
        },
      },
      ...(({
        zoom: {
          zoom: {
            wheel: { enabled: true },
            drag: { enabled: true, backgroundColor: "rgba(87,148,242,0.08)", borderColor: "#5794F2", borderWidth: 1 },
            pinch: { enabled: true },
            mode: "x",
            onZoomComplete: ({ chart }: any) => {
              const labels = (chart.data.labels ?? []) as string[];
              const xs = chart.scales.x;
              if (!labels.length || !onZoom) return;
              const lo = Math.max(0, Math.floor(xs.min));
              const hi = Math.min(labels.length - 1, Math.ceil(xs.max));
              onZoom(labels[lo] ?? "", labels[hi] ?? "");
            },
          },
        },
      }) as unknown as ChartOptions<"line">["plugins"]),
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
          callback: function(_val, index): string[] {
            const raw = (this.getLabelForValue as (i: number) => string)(index);
            return splitLabel(raw, isMobile);
          },
        },
      },
      yTemp: {
        type: "linear", position: "left",
        grid: { color: gridColor, drawTicks: false }, border: { display: false },
        ticks: { color: "#F59E0B", font: { size: 9, family: "monospace" }, padding: 8, callback: (v) => `${v}°` },
        min: minTemp, max: maxTemp,
      },
      yHum: {
        type: "linear", position: "right",
        grid: { display: false }, border: { display: false },
        ticks: { color: "#38BDF8", font: { size: 9, family: "monospace" }, padding: 8, callback: (v) => `${v}%` },
        min: minHum, max: maxHum,
      },
    },
  };
}

function makeSmokeOptions(
  isDark: boolean,
  isMobile: boolean,
  minPPM: number,
  maxPPM: number,
  onZoom?: (start: string, end: string) => void,
): ChartOptions<"line"> {
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
            const name = ctx.datasetIndex === 0 ? "MQ2-1" : "MQ2-2";
            return ` ${name}: ${y.toFixed(1)} ppm`;
          },
        },
      },
      ...(({
        zoom: {
          zoom: {
            wheel: { enabled: true },
            drag: { enabled: true, backgroundColor: "rgba(87,148,242,0.08)", borderColor: "#5794F2", borderWidth: 1 },
            pinch: { enabled: true },
            mode: "x",
            onZoomComplete: ({ chart }: any) => {
              const labels = (chart.data.labels ?? []) as string[];
              const xs = chart.scales.x;
              if (!labels.length || !onZoom) return;
              const lo = Math.max(0, Math.floor(xs.min));
              const hi = Math.min(labels.length - 1, Math.ceil(xs.max));
              onZoom(labels[lo] ?? "", labels[hi] ?? "");
            },
          },
        },
      }) as unknown as ChartOptions<"line">["plugins"]),
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
          callback: function(_val, index): string[] {
            const raw = (this.getLabelForValue as (i: number) => string)(index);
            return splitLabel(raw, isMobile);
          },
        },
      },
      y: {
        grid: { color: gridColor, drawTicks: false }, border: { display: false },
        ticks: { color: "#A78BFA", font: { size: 9, family: "monospace" }, padding: 8, callback: (v) => `${v}` },
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

// ─── ZoomRangeBox ─────────────────────────────────────────────────────────────
// Shown inside a GraphPanel after the user drag-selects or scroll-zooms a range.

function ZoomRangeBox({ start, end, onClose, onApply }: {
  start: string; end: string;
  onClose: () => void;
  onApply: (start: string, end: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 text-[13px] font-mono flex-wrap"
      style={{ background: "rgba(87,148,242,0.07)", borderBottom: "1px solid rgba(87,148,242,0.22)" }}>
      <svg width="10" height="10" viewBox="0 0 14 14" fill="none" style={{ color: "#5794F2", flexShrink: 0 }}>
        <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7 4v3l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <span className="text-[11px] tracking-widest uppercase font-semibold" style={{ color: "#5794F2" }}>Selection</span>
      <span className="flex-1" style={{ color: GF.textPrimary }}>{start} → {end}</span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onApply(start, end)}
          className="gf-raise px-2.5 py-1 rounded text-[12px] font-bold tracking-wider transition-colors"
          style={{ background: "#5794F2", color: "#fff" }}
          onMouseEnter={e => (e.currentTarget.style.background = "#4a82d8")}
          onMouseLeave={e => (e.currentTarget.style.background = "#5794F2")}>
          Apply range
        </button>
        <button
          onClick={onClose}
          className="px-1 text-[14px] transition-colors"
          style={{ color: GF.textMuted }}
          onMouseEnter={e => (e.currentTarget.style.color = GF.textPrimary)}
          onMouseLeave={e => (e.currentTarget.style.color = GF.textMuted)}>
          ✕
        </button>
      </div>
    </div>
  );
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

function GaugeArc({ value, unit, pct, color, isDark }: {
  value: string | number; unit: string; pct: number; color: string; isDark: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const w = c.width, h = c.height;
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
  }, [pct, color, value, unit, isDark]);

  return (
    <canvas ref={ref} width={130} height={100}
      style={{ width: "100%", maxWidth: 130, height: "auto" }} />
  );
}

// Light moving-average so live raw readings render as a smooth, flowing curve
// (matching the aggregated Server Detail charts). Window of 5 ≈ ~15s of samples.
function smooth(data: number[], window = 5): number[] {
  if (data.length <= 2) return data;
  return data.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = data.slice(start, i + 1);
    return +(slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(2);
  });
}

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
}

function StatPanel({ title, value, unit, color, segPct, sparkData, max, avg, min, isDark }: StatPanelProps) {
  return (
    <div className="flex flex-col rounded" style={{ background: GF.panel, border: `1px solid ${GF.panelBorder}` }}>
      {/* Panel title bar */}
      <div className="flex items-center justify-between px-3 pt-2.5 pb-1.5"
        style={{ borderBottom: `1px solid ${GF.divider}` }}>
        <span className="text-[12px] font-mono tracking-widest uppercase" style={{ color: GF.textMuted }}>{title}</span>
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: color, boxShadow: `0 0 5px ${color}` }} />
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
  const heatColor =
    tempStatus === "CRITICAL" || tempStatus === "DANGER" || smokeStatus === "DANGER"
      ? "#F2495C" : "#FF780A";

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

function GraphPanel({
  title, legend, children, toolbar, overlay,
}: {
  title: string;
  legend: React.ReactNode;
  children: React.ReactNode;
  toolbar: React.ReactNode;
  overlay?: React.ReactNode;
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
          <LiveDot />
          {toolbar}
        </div>
      </div>
      {overlay}
      {children}
    </div>
  );
}

// ─── ResetZoomBtn ─────────────────────────────────────────────────────────────

function ResetZoomBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick}
      className="gf-btn flex items-center gap-1 text-[12px] font-mono px-2.5 py-1"
      style={{ color: GF.textMuted }}
      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = GF.textPrimary; }}
      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = GF.textMuted; }}>
      <svg width="10" height="10" viewBox="0 0 14 14" fill="none">
        <path d="M12 7A5 5 0 1 1 7 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M12 2v5h-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Reset zoom
    </button>
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

// ─── CustomRangePicker ────────────────────────────────────────────────────────

function CustomRangePicker({ onApply, onClose }: {
  onApply: (start: string, stop: string) => void;
  onClose: () => void;
}) {
  const now   = new Date();
  const start = new Date(now.getTime() - 60 * 60 * 1000);

  const [startMonth, setStartMonth] = useState(new Date(start.getFullYear(), start.getMonth(), 1));
  const [stopMonth,  setStopMonth]  = useState(new Date(now.getFullYear(), now.getMonth(), 1));
  const [startDay,   setStartDay]   = useState(start.getDate());
  const [stopDay,    setStopDay]    = useState(now.getDate());
  const [startHour,  setStartHour]  = useState(start.getHours());
  const [stopHour,   setStopHour]   = useState(now.getHours());
  const startMin = start.getMinutes();
  const stopMin  = now.getMinutes();

  const timeRef1 = useRef<HTMLDivElement>(null);
  const timeRef2 = useRef<HTMLDivElement>(null);

  // Scroll to the selected hour once on mount — does NOT re-run on state change
  useEffect(() => {
    const t = setTimeout(() => {
      timeRef1.current?.scrollTo({ top: startHour * 32, behavior: "instant" as ScrollBehavior });
      timeRef2.current?.scrollTo({ top: stopHour  * 32, behavior: "instant" as ScrollBehavior });
    }, 60);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buildISO = (month: Date, day: number, hour: number, min: number) =>
    new Date(month.getFullYear(), month.getMonth(), day, hour, min, 0).toISOString();

  const fmtDisplay = (month: Date, day: number, hour: number) =>
    `${month.getFullYear()}-${String(month.getMonth()+1).padStart(2,"0")}-${String(day).padStart(2,"0")}  ${String(hour).padStart(2,"0")}:00`;

  const panels = [
    { label: "FROM" as const, month: startMonth, day: startDay, onDay: setStartDay,
      hour: startHour, onHour: setStartHour, scrollRef: timeRef1,
      onPrev: () => setStartMonth(p => new Date(p.getFullYear(), p.getMonth() - 1, 1)),
      onNext: () => setStartMonth(p => new Date(p.getFullYear(), p.getMonth() + 1, 1)) },
    { label: "TO"   as const, month: stopMonth,  day: stopDay,  onDay: setStopDay,
      hour: stopHour,  onHour: setStopHour,  scrollRef: timeRef2,
      onPrev: () => setStopMonth(p => new Date(p.getFullYear(), p.getMonth() - 1, 1)),
      onNext: () => setStopMonth(p => new Date(p.getFullYear(), p.getMonth() + 1, 1)) },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4"
      style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(6px)" }}>
      <div className="rounded-lg shadow-2xl flex flex-col"
        style={{ background: GF.panel, border: `1px solid ${GF.panelBorder}`, width: 620, maxWidth: "95vw", maxHeight: "90vh", overflowY: "auto" }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3"
          style={{ borderBottom: `1px solid ${GF.divider}` }}>
          <div className="flex items-center gap-2.5">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ color: "#5794F2" }}>
              <rect x="1" y="3" width="14" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
              <path d="M1 7h14M5 1v3M11 1v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
            </svg>
            <span className="text-[14px] font-mono font-semibold" style={{ color: GF.textPrimary }}>Custom time range</span>
          </div>
          <button onClick={onClose}
            className="w-6 h-6 rounded flex items-center justify-center text-xs font-bold transition-colors"
            style={{ background: "var(--gf-hover)", color: GF.textMuted }}
            onMouseEnter={e => { e.currentTarget.style.background = "var(--gf-hover-strong)"; e.currentTarget.style.color = GF.textPrimary; }}
            onMouseLeave={e => { e.currentTarget.style.background = "var(--gf-hover)"; e.currentTarget.style.color = GF.textMuted; }}>
            ✕
          </button>
        </div>

        {/* FROM / TO display bar */}
        <div className="grid grid-cols-1 sm:grid-cols-2" style={{ borderBottom: `1px solid ${GF.divider}` }}>
          {panels.map((p, i) => (
            <div key={p.label}
              className={`px-5 py-3 ${i === 0 ? "border-b sm:border-b-0 sm:border-r" : ""}`}
              style={{ borderColor: GF.divider }}>
              <div className="text-[11px] font-mono tracking-widest uppercase mb-1" style={{ color: GF.textDim }}>{p.label}</div>
              <div className="text-[14px] font-mono font-semibold" style={{ color: "#5794F2" }}>
                {fmtDisplay(p.month, p.day, p.hour)}
              </div>
            </div>
          ))}
        </div>

        {/* Calendar + hour scroll */}
        <div className="grid grid-cols-1 sm:grid-cols-2">
          {panels.map((p, i) => (
            <div key={p.label}
              className={`flex gap-3 p-4 ${i === 0 ? "border-b sm:border-b-0 sm:border-r" : ""}`}
              style={{ borderColor: GF.divider }}>
              <CalendarGrid
                month={p.month} selectedDay={p.day} onSelectDay={p.onDay}
                onPrev={p.onPrev} onNext={p.onNext}
              />
              <TimeScroll hour={p.hour} onHour={p.onHour} scrollRef={p.scrollRef} />
            </div>
          ))}
        </div>

        {/* Apply */}
        <div className="px-5 pb-5 pt-3" style={{ borderTop: `1px solid ${GF.divider}` }}>
          <button
            onClick={() => onApply(
              buildISO(startMonth, startDay, startHour, startMin),
              buildISO(stopMonth,  stopDay,  stopHour,  stopMin),
            )}
            className="w-full py-2.5 rounded font-bold font-mono text-[14px] tracking-widest transition-colors"
            style={{ background: "#5794F2", color: "#fff" }}
            onMouseEnter={e => (e.currentTarget.style.background = "#4a82d8")}
            onMouseLeave={e => (e.currentTarget.style.background = "#5794F2")}>
            APPLY TIME RANGE
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── RangePicker (Grafana time picker style) ──────────────────────────────────

function RangePicker({ range, customLabel, onChange, onCustom, onRefresh, isRefreshing }: {
  range: RangeType; customLabel: string;
  onChange: (r: QuickRangeType) => void;
  onCustom: () => void; onRefresh: () => void;
  isRefreshing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const currentLabel = range === "custom" ? customLabel : RANGE_LABEL[range as QuickRangeType];

  const step = (dir: 1 | -1) => {
    if (range === "custom") return;
    const idx  = QUICK_RANGES.findIndex(r => r.value === range);
    const next = QUICK_RANGES[idx + dir];
    if (next) onChange(next.value);
  };

  const btnBase: React.CSSProperties = {
    background: "transparent",
    color: GF.textMuted,
    border: "none",
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: 11,
    transition: "color 0.15s",
  };

  return (
    <div ref={wrapRef} className="relative flex items-center">
      {/* Refresh */}
      <button onClick={onRefresh}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-l text-[13px] font-mono transition-colors"
        style={{ background: GF.header, border: `1px solid ${GF.panelBorder}`, color: isRefreshing ? GF.textPrimary : GF.textMuted, borderRight: "none" }}
        onMouseEnter={e => (e.currentTarget.style.color = GF.textPrimary)}
        onMouseLeave={e => { if (!isRefreshing) e.currentTarget.style.color = GF.textMuted; }}>
        <svg width="11" height="11" viewBox="0 0 14 14" fill="none"
          className={isRefreshing ? "animate-spin" : ""}
          style={{ transformOrigin: "center" }}>
          <path d="M12 7A5 5 0 1 1 7 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M12 2v5h-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Refresh
      </button>

      {/* Prev / Label / Next */}
      <div className="flex items-center" style={{ border: `1px solid ${GF.panelBorder}`, background: GF.header }}>
        <button style={{ ...btnBase, padding: "6px 8px" }}
          onMouseEnter={e => (e.currentTarget.style.color = GF.textPrimary)}
          onMouseLeave={e => (e.currentTarget.style.color = GF.textMuted)}
          onClick={() => step(-1)}>‹</button>

        <button onClick={() => setOpen(o => !o)}
          className="flex items-center gap-2 px-3 py-1.5 text-[13px] font-mono transition-colors"
          style={{ color: GF.textPrimary, minWidth: 160, background: "transparent", border: "none", cursor: "pointer" }}>
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none" style={{ color: GF.textMuted, flexShrink: 0 }}>
            <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
            <path d="M7 4v3l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="truncate flex-1 text-left">{currentLabel}</span>
          <svg width="8" height="8" viewBox="0 0 10 10" fill="none" style={{ color: GF.textMuted, flexShrink: 0 }}>
            <path d={open ? "M2 7l3-3 3 3" : "M2 3l3 3 3-3"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>

        <button style={{ ...btnBase, padding: "6px 8px" }}
          onMouseEnter={e => (e.currentTarget.style.color = GF.textPrimary)}
          onMouseLeave={e => (e.currentTarget.style.color = GF.textMuted)}
          onClick={() => step(1)}>›</button>
      </div>

      {/* Zoom-to-data / rounded right */}
      <div className="w-2 rounded-r" style={{ background: GF.header, border: `1px solid ${GF.panelBorder}`, borderLeft: "none", height: 32 }} />

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded shadow-2xl overflow-hidden"
          style={{ background: GF.panel, border: `1px solid ${GF.panelBorder}` }}>
          <div className="px-3 py-2" style={{ borderBottom: `1px solid ${GF.divider}` }}>
            <span className="text-[11px] font-mono tracking-widest uppercase" style={{ color: GF.textDim }}>Time Range</span>
          </div>
          <button onClick={() => { onCustom(); setOpen(false); }}
            className="w-full text-left px-4 py-2.5 text-[13px] font-mono transition-colors"
            style={{
              background: range === "custom" ? "rgba(87,148,242,0.12)" : "transparent",
              color: range === "custom" ? "#5794F2" : GF.textMuted,
              borderBottom: `1px solid ${GF.divider}`,
            }}
            onMouseEnter={e => { if (range !== "custom") e.currentTarget.style.background = "var(--gf-hover)"; }}
            onMouseLeave={e => { if (range !== "custom") e.currentTarget.style.background = "transparent"; }}>
            Custom time range
          </button>
          <div className="overflow-y-auto" style={{ maxHeight: 280, scrollbarWidth: "thin" }}>
            {QUICK_RANGES.map(r => (
              <button key={r.value} onClick={() => { onChange(r.value); setOpen(false); }}
                className="w-full text-left px-4 py-2.5 text-[13px] font-mono transition-colors"
                style={{
                  background: range === r.value ? "rgba(87,148,242,0.12)" : "transparent",
                  color: range === r.value ? "#5794F2" : GF.textMuted,
                }}
                onMouseEnter={e => { if (range !== r.value) e.currentTarget.style.background = "var(--gf-hover)"; }}
                onMouseLeave={e => { if (range !== r.value) e.currentTarget.style.background = "transparent"; }}>
                {r.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function Environment() {
  const [labels,   setLabels]   = useState<string[]>([]);
  const [temps,    setTemps]    = useState<number[]>([]);
  const [hums,     setHums]     = useState<number[]>([]);
  const [liveTemp, setLiveTemp] = useState<number | string>("--");
  const [liveHum,  setLiveHum]  = useState<number | string>("--");

  const [smokeLabels, setSmokeLabels] = useState<string[]>([]);
  const [ppm1s,       setPpm1s]       = useState<number[]>([]);
  const [ppm2s,       setPpm2s]       = useState<number[]>([]);
  const [livePPM1,    setLivePPM1]    = useState<number | string>("--");
  const [livePPM2,    setLivePPM2]    = useState<number | string>("--");

  const [liveHeatIndex,         setLiveHeatIndex]         = useState<number | string>("--");
  const [liveSmokeStatus,       setLiveSmokeStatus]       = useState<AlertLevel>("NORMAL");
  const [liveTempStatus,        setLiveTempStatus]        = useState<TempLevel>("NORMAL");
  const [liveEnvironmentStatus, setLiveEnvironmentStatus] = useState<AlertLevel>("NORMAL");

  // Is the ESP32 actually reporting? Without this every reading below is the LAST one
  // received, with nothing to say how old it is — a dead sensor renders exactly like a
  // stable room. Seeded from REST (the socket only fires on a transition, which may
  // never come while the page is open) and then kept live by `esp32Status`.
  const [sensorOnline,   setSensorOnline]   = useState<boolean | null>(null);
  const [sensorLastSeen, setSensorLastSeen] = useState<string | null>(null);

  const [range,       setRange]       = useState<RangeType>("-1h");
  const [customRange, setCustomRange] = useState<CustomRange | null>(null);
  const [customLabel, setCustomLabel] = useState("Custom Range");
  const [showCustom,  setShowCustom]  = useState(false);
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
  const isZoomedRef   = useRef(false);
  const [zoomInfo,     setZoomInfo]     = useState<{ start: string; end: string; chart: "combined" | "smoke" } | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resetZoom = useCallback((ref: React.RefObject<any>) => {
    ref.current?.resetZoom?.();
    isZoomedRef.current = false;
    setZoomInfo(null);
  }, []);

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
      setTemps(history.map(r => r.temperature ?? 0));
      setHums(history.map(r => r.humidity     ?? 0));
      setSmokeLabels(lbls);
      setPpm1s(history.map(r => r.mq2_1_ppm  ?? 0));
      setPpm2s(history.map(r => r.mq2_2_ppm  ?? 0));
      const last = history[history.length - 1];
      if (last) {
        setLiveTemp(last.temperature   ?? "--");
        setLiveHum(last.humidity       ?? "--");
        setLivePPM1(last.mq2_1_ppm   ?? "--");
        setLivePPM2(last.mq2_2_ppm   ?? "--");
        setLiveHeatIndex(last.heat_index ?? "--");
        setLiveSmokeStatus((last.smoke_status       as AlertLevel) || "NORMAL");
        setLiveTempStatus((last.temp_status          as TempLevel)  || "NORMAL");
        setLiveEnvironmentStatus((last.environment_status as AlertLevel) || "NORMAL");
      }
    };

    const handleLive = (data: SensorData) => {
      if (!data) return;
      const ts   = new Date(data.timestamp);
      const time = fmtLabel(ts);

      setLiveTemp(data.temperature);
      setLiveHum(data.humidity);
      setLivePPM1(data.mq2_1_ppm);
      setLivePPM2(data.mq2_2_ppm);
      setLiveHeatIndex(data.heat_index);
      setLiveSmokeStatus(data.smoke_status);
      setLiveTempStatus(data.temp_status);
      setLiveEnvironmentStatus(data.environment_status);

      if (!isZoomedRef.current) {
        setLabels(p      => [...p.slice(-999), time]);
        setTemps(p       => [...p.slice(-999), data.temperature]);
        setHums(p        => [...p.slice(-999), data.humidity]);
        setSmokeLabels(p => [...p.slice(-999), time]);
        setPpm1s(p       => [...p.slice(-999), data.mq2_1_ppm]);
        setPpm2s(p       => [...p.slice(-999), data.mq2_2_ppm]);
      }
    };

    socket.on("sensorHistory", handleHistory);
    socket.on("sensorData",    handleLive);
    socket.emit("changeRange", customRange ?? range);
    return () => {
      socket.off("sensorHistory", handleHistory);
      socket.off("sensorData",    handleLive);
    };
  }, [range, customRange]);

  const changeRange = (r: QuickRangeType) => {
    setRange(r); setCustomRange(null);
    socket.emit("changeRange", r);
  };

  const handleRefresh = () => {
    socket.emit("changeRange", customRange ?? range);
    setIsRefreshing(true);
    setTimeout(() => setIsRefreshing(false), 800);
  };

  const applyCustomRange = useCallback((start: string, stop: string) => {
    const cr: CustomRange = { start, stop };
    setCustomRange(cr); setRange("custom"); setShowCustom(false);
    const fmt = (d: Date) => d.toLocaleDateString("en-PH", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    setCustomLabel(`${fmt(new Date(start))} → ${fmt(new Date(stop))}`);
    socket.emit("changeRange", cr);
  }, []);

  // ── Derived ────────────────────────────────────────────────────────────────

  const peakTemp = temps.length > 0 ? Math.max(...temps).toFixed(1) : "--";
  const minTemp  = temps.length > 0 ? Math.min(...temps).toFixed(1) : "--";
  const avgTemp  = temps.length > 0 ? (temps.reduce((a,b) => a+b,0) / temps.length).toFixed(1) : "--";
  const peakHum  = hums.length  > 0 ? Math.max(...hums).toFixed(1)  : "--";
  const minHum   = hums.length  > 0 ? Math.min(...hums).toFixed(1)  : "--";
  const avgHum   = hums.length  > 0 ? (hums.reduce((a,b) => a+b,0)  / hums.length).toFixed(1) : "--";

  const maxTempY = temps.length > 0 ? Math.ceil(Math.max(...temps))  + 3  : 40;
  const minTempY = temps.length > 0 ? Math.floor(Math.min(...temps)) - 2  : 15;
  const maxHumY  = hums.length  > 0 ? Math.ceil(Math.max(...hums))   + 3  : 100;
  const minHumY  = hums.length  > 0 ? Math.floor(Math.min(...hums))  - 3  : 30;

  const allPPMs   = [...ppm1s, ...ppm2s];
  const allScale  = allPPMs.length > 0 ? allPPMs : [0];
  const maxSmokeY = Math.ceil(Math.max(...allScale))  + 50;
  const minSmokeY = Math.max(0, Math.floor(Math.min(...allScale)) - 10);

  const tempGaugePct = typeof liveTemp === "number" ? (liveTemp - 15) / 25 : 0;
  const humGaugePct  = typeof liveHum  === "number" ? (liveHum  - 30) / 70 : 0;

  // Stable references — empty deps because they only write to refs or call stable setters
  const handleCombinedZoom = useCallback((start: string, end: string) => {
    isZoomedRef.current = true;
    setZoomInfo({ start, end, chart: "combined" });
  }, []);
  const handleSmokeZoom = useCallback((start: string, end: string) => {
    isZoomedRef.current = true;
    setZoomInfo({ start, end, chart: "smoke" });
  }, []);
  const handleApplyZoomedRange = useCallback((startLabel: string, endLabel: string) => {
    applyCustomRange(parseLabelToISO(startLabel), parseLabelToISO(endLabel));
    isZoomedRef.current = false;
    setZoomInfo(null);
    chartRef.current?.resetZoom?.();
    smokeChartRef.current?.resetZoom?.();
  }, [applyCustomRange]);

  // Memoized so the chart only receives new props when data actually changes.
  // Without this, every live-stat re-render produces new object references →
  // react-chartjs-2 calls chart.update() → zoom plugin resets.
  const combinedOpts = useMemo(
    () => makeCombinedOptions(isDark, isMobile, minTempY, maxTempY, minHumY, maxHumY, handleCombinedZoom),
    [isDark, isMobile, minTempY, maxTempY, minHumY, maxHumY, handleCombinedZoom],
  );
  const smokeOpts = useMemo(
    () => makeSmokeOptions(isDark, isMobile, minSmokeY, maxSmokeY, handleSmokeZoom),
    [isDark, isMobile, minSmokeY, maxSmokeY, handleSmokeZoom],
  );

  const combinedData: ChartData<"line"> = useMemo(() => ({
    labels,
    datasets: [
      {
        label: "Temperature", data: smooth(temps), yAxisID: "yTemp",
        borderColor: "#F59E0B",
        backgroundColor: (ctx: ScriptableContext<"line">) => gradientFill(ctx, "rgba(245,158,11,0.16)", "rgba(245,158,11,0.01)"),
        borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4,
        pointHoverBackgroundColor: "#F59E0B", fill: true, tension: 0.4,
      },
      {
        label: "Humidity", data: smooth(hums), yAxisID: "yHum",
        borderColor: "#38BDF8",
        backgroundColor: (ctx: ScriptableContext<"line">) => gradientFill(ctx, "rgba(56,189,248,0.12)", "rgba(56,189,248,0.01)"),
        borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4,
        pointHoverBackgroundColor: "#38BDF8", fill: true, tension: 0.4,
      },
    ],
  }), [labels, temps, hums]);

  const smokeData: ChartData<"line"> = useMemo(() => ({
    labels: smokeLabels,
    datasets: [
      {
        label: "MQ2-1", data: smooth(ppm1s),
        borderColor: "#A78BFA",
        backgroundColor: (ctx: ScriptableContext<"line">) => gradientFill(ctx, "rgba(167,139,250,0.14)", "rgba(167,139,250,0.01)"),
        borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4,
        pointHoverBackgroundColor: "#A78BFA", fill: true, tension: 0.4,
      },
      {
        label: "MQ2-2", data: smooth(ppm2s),
        borderColor: "#F472B6",
        backgroundColor: (ctx: ScriptableContext<"line">) => gradientFill(ctx, "rgba(244,114,182,0.10)", "rgba(244,114,182,0.01)"),
        borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4,
        pointHoverBackgroundColor: "#F472B6", fill: true, tension: 0.4,
      },
    ],
  }), [smokeLabels, ppm1s, ppm2s]);

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
      <div className="flex items-center justify-end px-4 py-2.5 flex-wrap gap-3"
        style={{ background: GF.header, borderBottom: `1px solid ${GF.panelBorder}` }}>
        <RecalibrateGas isDark={isDark} />
        <RangePicker range={range} customLabel={customLabel} onChange={changeRange} onCustom={() => setShowCustom(true)} onRefresh={handleRefresh} isRefreshing={isRefreshing} />
      </div>

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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <StatPanel
            title="Temperature"
            value={typeof liveTemp === "number" ? liveTemp.toFixed(1) : liveTemp}
            unit="°C" color="#F59E0B" segPct={tempGaugePct}
            sparkData={temps.slice(-24)}
            max={peakTemp !== "--" ? `${peakTemp}°` : "--"}
            avg={avgTemp  !== "--" ? `${avgTemp}°`  : "--"}
            min={minTemp  !== "--" ? `${minTemp}°`  : "--"}
            isDark={isDark}
          />
          <StatPanel
            title="Humidity"
            value={typeof liveHum === "number" ? liveHum.toFixed(1) : liveHum}
            unit="%" color="#38BDF8" segPct={humGaugePct}
            sparkData={hums.slice(-24)}
            max={peakHum !== "--" ? `${peakHum}%` : "--"}
            avg={avgHum  !== "--" ? `${avgHum}%`  : "--"}
            min={minHum  !== "--" ? `${minHum}%`  : "--"}
            isDark={isDark}
          />
          <StatPanel
            title="MQ2 Sensor 1"
            value={typeof livePPM1 === "number" ? livePPM1.toFixed(1) : livePPM1}
            unit="ppm" color="#A78BFA"
            segPct={typeof livePPM1 === "number" ? Math.min(livePPM1 / 600, 1) : 0}
            sparkData={ppm1s.slice(-24)}
            max={ppm1s.length > 0 ? `${Math.max(...ppm1s).toFixed(0)}` : "--"}
            avg={ppm1s.length > 0 ? `${(ppm1s.reduce((a,b)=>a+b,0)/ppm1s.length).toFixed(0)}` : "--"}
            min={ppm1s.length > 0 ? `${Math.min(...ppm1s).toFixed(0)}` : "--"}
            isDark={isDark}
          />
          <StatPanel
            title="MQ2 Sensor 2"
            value={typeof livePPM2 === "number" ? livePPM2.toFixed(1) : livePPM2}
            unit="ppm" color="#F472B6"
            segPct={typeof livePPM2 === "number" ? Math.min(livePPM2 / 600, 1) : 0}
            sparkData={ppm2s.slice(-24)}
            max={ppm2s.length > 0 ? `${Math.max(...ppm2s).toFixed(0)}` : "--"}
            avg={ppm2s.length > 0 ? `${(ppm2s.reduce((a,b)=>a+b,0)/ppm2s.length).toFixed(0)}` : "--"}
            min={ppm2s.length > 0 ? `${Math.min(...ppm2s).toFixed(0)}` : "--"}
            isDark={isDark}
          />
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
              <LegendItem color="#F59E0B" label="Temperature"
                value={typeof liveTemp === "number" ? `${liveTemp.toFixed(1)} °C` : "--"} />
              <LegendItem color="#38BDF8" label="Humidity"
                value={typeof liveHum === "number" ? `${liveHum.toFixed(1)} %` : "--"} />
            </>
          }
          toolbar={<ResetZoomBtn onClick={() => resetZoom(chartRef)} />}
          overlay={zoomInfo?.chart === "combined" ? (
            <ZoomRangeBox
              start={zoomInfo.start} end={zoomInfo.end}
              onClose={() => setZoomInfo(null)}
              onApply={handleApplyZoomedRange}
            />
          ) : undefined}>
          <div style={{ height: 300, padding: "12px 12px 16px" }}>
            <Line ref={chartRef} data={combinedData} options={combinedOpts} />
          </div>
        </GraphPanel>

        {/* Row 3: Smoke PPM chart */}
        <GraphPanel
          title="Smoke / Gas (MQ-2)"
          legend={
            <>
              <LegendItem color="#A78BFA" label="MQ2-1"
                value={typeof livePPM1 === "number" ? `${livePPM1.toFixed(1)} ppm` : "--"} />
              <LegendItem color="#F472B6" label="MQ2-2"
                value={typeof livePPM2 === "number" ? `${livePPM2.toFixed(1)} ppm` : "--"} />
              <StatusBadge status={liveSmokeStatus} />
            </>
          }
          toolbar={<ResetZoomBtn onClick={() => resetZoom(smokeChartRef)} />}
          overlay={zoomInfo?.chart === "smoke" ? (
            <ZoomRangeBox
              start={zoomInfo.start} end={zoomInfo.end}
              onClose={() => setZoomInfo(null)}
              onApply={handleApplyZoomedRange}
            />
          ) : undefined}>
          {/* Threshold legend */}
          <div className="flex gap-5 px-4 pt-2 text-[11px] font-mono">
            <span className="flex items-center gap-1.5">
              <span className="w-5 h-px inline-block" style={{ background: "#FF780A" }} />
              <span style={{ color: GF.textDim }}>WARNING 150 ppm</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-5 h-px inline-block" style={{ background: "#F2495C" }} />
              <span style={{ color: GF.textDim }}>DANGER 300 ppm</span>
            </span>
          </div>
          <div style={{ height: 300, padding: "8px 12px 16px" }}>
            <Line ref={smokeChartRef} data={smokeData} options={smokeOpts} />
          </div>
        </GraphPanel>

        {/* Footer hint */}
        <div className="text-center text-[11px] font-mono tracking-widest pb-2" style={{ color: GF.textDim }}>
          SCROLL TO ZOOM · DRAG TO SELECT RANGE · CLICK RESET TO FIT
        </div>

      </div>

      {showCustom && (
        <CustomRangePicker onApply={applyCustomRange} onClose={() => setShowCustom(false)} />
      )}
    </div>
  );
}
