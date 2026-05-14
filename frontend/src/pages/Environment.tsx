import { useState, useEffect, useRef, useCallback } from "react";
import React from "react";
import { Line } from "react-chartjs-2";
import { Chart, registerables } from "chart.js";
import "../chart/ChartConfig";
import type { ChartOptions, ChartData, ScriptableContext } from "chart.js";
import { socket } from "../socket/socket";

Chart.register(...registerables);

// ─── Types ────────────────────────────────────────────────────────────────────

type QuickRangeType = "-30m" | "-1h" | "-3h" | "-6h" | "-12h" | "-24h" | "-2d" | "-7d" | "-30d";
type RangeType = QuickRangeType | "custom";

interface CustomRange { start: string; stop: string; }
interface SensorData  { temperature: number; humidity: number; timestamp: string; }
interface HistoryData { time: string; temperature: number; humidity: number; }

// ─── Constants ────────────────────────────────────────────────────────────────

const QUICK_RANGES: { label: string; value: QuickRangeType }[] = [
  { label: "Past 30m",  value: "-30m"  },
  { label: "Past 1h",   value: "-1h"   },
  { label: "Past 3h",   value: "-3h"   },
  { label: "Past 6h",   value: "-6h"   },
  { label: "Past 12h",  value: "-12h"  },
  { label: "Past 24h",  value: "-24h"  },
  { label: "Past 2d",   value: "-2d"   },
  { label: "Past 7d",   value: "-7d"   },
  { label: "Past 30d",  value: "-30d"  },
];

const RANGE_LABEL: Record<QuickRangeType, string> = {
  "-30m": "Past 30m", "-1h": "Past 1h",  "-3h": "Past 3h",
  "-6h":  "Past 6h",  "-12h": "Past 12h", "-24h": "Past 24h",
  "-2d":  "Past 2d",  "-7d": "Past 7d",   "-30d": "Past 30d",
};

// ─── Chart options ─────────────────────────────────────────────────────────────

function makeCombinedOptions(
  isDark: boolean,
  minTemp: number, maxTemp: number,
  minHum: number,  maxHum: number,
): ChartOptions<"line"> {
  const gridColor = isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.06)";
  const tickColor = isDark ? "rgba(140,160,200,0.45)" : "rgba(80,100,130,0.6)";
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: isDark ? "rgba(10,14,26,0.97)" : "rgba(255,255,255,0.97)",
        borderColor: "rgba(255,255,255,0.1)",
        borderWidth: 1,
        titleColor: isDark ? "rgba(150,170,210,0.6)" : "rgba(80,100,130,0.7)",
        bodyColor:  isDark ? "#e8eef8" : "#1e293b",
        padding: 10,
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
          pan:  { enabled: true, mode: "x" },
          zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: "x" },
        },
      }) as unknown as ChartOptions<"line">["plugins"]),
    },
    scales: {
      x: {
        grid:   { color: gridColor, drawTicks: false },
        border: { display: false },
        ticks:  { color: tickColor, font: { size: 9, family: "monospace" }, maxTicksLimit: 8, maxRotation: 0 },
      },
      yTemp: {
        type: "linear", position: "left",
        grid:   { color: gridColor, drawTicks: false },
        border: { display: false },
        ticks:  { color: "#f59e0b", font: { size: 9, family: "monospace" }, padding: 8, callback: (v) => `${v}°` },
        min: minTemp, max: maxTemp,
      },
      yHum: {
        type: "linear", position: "right",
        grid:   { display: false },
        border: { display: false },
        ticks:  { color: "#38bdf8", font: { size: 9, family: "monospace" }, padding: 8, callback: (v) => `${v}%` },
        min: minHum, max: maxHum,
      },
    },
  };
}

function gradientFill(ctx: ScriptableContext<"line">, colorTop: string, colorBot: string): CanvasGradient | string {
  const canvas = ctx.chart.canvas as HTMLCanvasElement | null;
  if (!canvas) return colorTop;
  const context = canvas.getContext("2d");
  if (!context) return colorTop;
  const g = context.createLinearGradient(0, 0, 0, 180);
  g.addColorStop(0, colorTop);
  g.addColorStop(1, colorBot);
  return g;
}

// ─── LiveDot ──────────────────────────────────────────────────────────────────

function LiveDot() {
  return (
    <span className="flex items-center gap-1.5">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
      </span>
      <span className="text-[9px] font-mono text-green-400/70 tracking-widest">LIVE</span>
    </span>
  );
}

// ─── SegBar ───────────────────────────────────────────────────────────────────

function SegBar({ pct, color }: { pct: number; color: string }) {
  const total = 40;
  const on    = Math.round(pct * total);
  return (
    <div className="flex gap-[2px] h-[5px]">
      {Array.from({ length: total }, (_, i) => (
        <div key={i} className="flex-1 rounded-[1px]"
          style={{ background: i < on ? color : "rgba(255,255,255,0.07)" }} />
      ))}
    </div>
  );
}

// ─── Gauge ────────────────────────────────────────────────────────────────────

function Gauge({ pct, color, label }: { pct: number; color: string; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext("2d"); if (!ctx) return;
    const cx = 45, cy = 58, r = 34;
    const startA = Math.PI * 0.85, endA = Math.PI * 2.15;
    const fillA = startA + (endA - startA) * Math.min(Math.max(pct, 0), 1);
    ctx.clearRect(0, 0, 90, 70);
    ctx.beginPath(); ctx.arc(cx, cy, r, startA, endA);
    ctx.strokeStyle = "rgba(255,255,255,0.07)"; ctx.lineWidth = 8; ctx.lineCap = "round"; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r, startA, fillA);
    ctx.strokeStyle = color; ctx.lineWidth = 8; ctx.lineCap = "round"; ctx.stroke();
    ctx.fillStyle = color; ctx.font = "bold 11px monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(label, cx, cy);
  }, [pct, color, label]);
  return <canvas ref={canvasRef} width={90} height={70} />;
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
        datasets: [{ data, borderColor: color, borderWidth: 1.5, pointRadius: 0, fill: true, backgroundColor: color + "22", tension: 0.3 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false } },
        scales: { x: { display: false }, y: { display: false } },
      },
    });
    return () => { chartRef.current?.destroy(); };
  }, [data, color]);
  return <div className="relative" style={{ height: 60 }}><canvas ref={canvasRef} /></div>;
}

// ─── SensorCard ───────────────────────────────────────────────────────────────

interface SensorCardProps {
  label: string; value: string | number; unit: string; color: string;
  segPct: number; sparkData: number[]; max: string; avg: string; min: string;
  gaugePct: number; gaugeLabel: string;
}

function SensorCard({ label, value, unit, color, segPct, sparkData, max, avg, min, gaugePct, gaugeLabel }: SensorCardProps) {
  return (
    <div className="relative overflow-hidden rounded-lg bg-slate-100 dark:bg-[#0d1117] border border-slate-200 dark:border-white/[0.07] p-3 flex flex-col gap-2.5">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-[13px] font-bold font-mono text-slate-500 dark:text-slate-400">{label}</span>
        <span className="text-[26px] font-bold font-mono leading-none" style={{ color }}>{value} {unit}</span>
      </div>
      <SegBar pct={segPct} color={color} />
      <div className="grid gap-2" style={{ gridTemplateColumns: "80px 1fr 90px", alignItems: "center" }}>
        <Sparkline data={sparkData} color={color} />
        <div className="flex flex-col gap-1.5 px-1">
          {([["Max:", max], ["Avg:", avg], ["Min:", min]] as [string, string][]).map(([k, v]) => (
            <div key={k} className="flex justify-between items-center text-[10px] font-mono">
              <span className="text-slate-400 dark:text-slate-500">{k}</span>
              <span className="font-bold" style={{ color }}>{v}</span>
            </div>
          ))}
        </div>
        <Gauge pct={gaugePct} color={color} label={gaugeLabel} />
      </div>
    </div>
  );
}

// ─── CombinedChartPanel ───────────────────────────────────────────────────────

function CombinedChartPanel({ liveTemp, liveHum, data, options, chartRef, onResetZoom }: {
  liveTemp: string | number; liveHum: string | number;
  data: ChartData<"line">; options: ChartOptions<"line">;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chartRef: React.RefObject<any>; onResetZoom: () => void;
}) {
  return (
    <div className="rounded-lg bg-slate-100 dark:bg-[#0d1117] border border-slate-200 dark:border-white/[0.07] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-white/[0.06]">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 text-[11px] font-mono">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#f59e0b" }} />
            <span className="text-slate-600 dark:text-slate-300">Temperature</span>
            <span className="font-semibold" style={{ color: "#f59e0b" }}>{liveTemp} °C</span>
          </span>
          <span className="flex items-center gap-1.5 text-[11px] font-mono">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: "#38bdf8" }} />
            <span className="text-slate-600 dark:text-slate-300">Humidity</span>
            <span className="font-semibold" style={{ color: "#38bdf8" }}>{liveHum} %</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <LiveDot />
          <button
            onClick={onResetZoom}
            className="text-[9px] font-mono text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 border border-slate-300 dark:border-white/10 hover:border-slate-400 dark:hover:border-white/20 px-2 py-0.5 rounded transition-colors"
          >
            ⟳ Reset
          </button>
        </div>
      </div>
      <div className="px-3 pt-3 pb-4" style={{ height: 240 }}>
        <Line ref={chartRef} data={data} options={options} />
      </div>
    </div>
  );
}

// ─── CustomRangePicker ────────────────────────────────────────────────────────

function CustomRangePicker({ onApply, onClose }: {
  onApply: (start: string, stop: string) => void;
  onClose: () => void;
}) {
  const now   = new Date();
  const start = new Date(now.getTime() - 60 * 60 * 1000);

  const daysInMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const monthName   = (d: Date) => d.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const [startMonth, setStartMonth] = useState(new Date(start.getFullYear(), start.getMonth(), 1));
  const [stopMonth,  setStopMonth]  = useState(new Date(now.getFullYear(),   now.getMonth(),   1));
  const [startDay,   setStartDay]   = useState(start.getDate());
  const [stopDay,    setStopDay]    = useState(now.getDate());
  const [startHour,  setStartHour]  = useState(start.getHours());
  const [stopHour,   setStopHour]   = useState(now.getHours());
  const [startMin,   setStartMin]   = useState(start.getMinutes());
  const [stopMin,    setStopMin]    = useState(now.getMinutes());

  const timeRef1 = useRef<HTMLDivElement>(null);
  const timeRef2 = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTimeout(() => {
      timeRef1.current?.scrollTo({ top: startHour * 34, behavior: "smooth" });
      timeRef2.current?.scrollTo({ top: stopHour  * 34, behavior: "smooth" });
    }, 100);
  }, []);

  const buildISO = (month: Date, day: number, hour: number, min: number) =>
    new Date(month.getFullYear(), month.getMonth(), day, hour, min, 0).toISOString();

  const fmtDisplay = (month: Date, day: number, hour: number, min: number) => {
    const d = new Date(month.getFullYear(), month.getMonth(), day, hour, min, 0);
    return d.toISOString().slice(0, 19).replace("T", " ");
  };

  const CalendarGrid = ({
    month, selectedDay, onSelectDay, onPrev, onNext,
  }: {
    month: Date; selectedDay: number;
    onSelectDay: (d: number) => void;
    onPrev: () => void; onNext: () => void;
  }) => {
    const firstDow = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
    const days     = daysInMonth(month);
    const cells    = Array.from({ length: firstDow + days }, (_, i) =>
      i < firstDow ? null : i - firstDow + 1
    );
    return (
      <div className="flex-1">
        <div className="flex items-center justify-between mb-2 px-1">
          <button onClick={onPrev} className="text-slate-400 hover:text-white text-sm w-6 h-6 flex items-center justify-center rounded hover:bg-white/10 transition">◀</button>
          <span className="text-[11px] font-mono text-slate-300">{monthName(month)}</span>
          <button onClick={onNext} className="text-slate-400 hover:text-white text-sm w-6 h-6 flex items-center justify-center rounded hover:bg-white/10 transition">▶</button>
        </div>
        <div className="grid grid-cols-7 gap-0.5 text-center">
          {["Su","Mo","Tu","We","Th","Fr","Sa"].map(d => (
            <div key={d} className="text-[9px] font-mono text-green-400 py-1">{d}</div>
          ))}
          {cells.map((day, i) => (
            <button
              key={i}
              disabled={!day}
              onClick={() => day && onSelectDay(day)}
              className={`text-[11px] font-mono py-1.5 rounded transition-colors ${
                !day ? "invisible" :
                day === selectedDay
                  ? "bg-blue-500 text-white font-bold"
                  : "text-slate-300 hover:bg-white/10"
              }`}
            >
              {day ?? ""}
            </button>
          ))}
        </div>
      </div>
    );
  };

  const TimeScroll = ({
    hour, onHour, scrollRef,
  }: {
    hour: number; onHour: (h: number) => void;
    scrollRef: React.RefObject<HTMLDivElement | null>;
  }) => (
    <div className="flex flex-col w-16 flex-shrink-0">
      <div className="text-[9px] font-mono text-slate-500 tracking-widest text-center mb-1">TIME</div>
      <div
        ref={scrollRef}
        className="h-48 overflow-y-auto"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.1) transparent" }}
      >
        {Array.from({ length: 24 }, (_, h) => (
          <div
            key={h}
            onClick={() => { onHour(h); scrollRef.current?.scrollTo({ top: h * 34, behavior: "smooth" }); }}
            className={`px-2 py-2 text-[11px] font-mono cursor-pointer text-center transition-colors ${
              h === hour
                ? "bg-blue-500/30 text-blue-300 font-bold"
                : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
            }`}
          >
            {String(h).padStart(2, "0")}:00
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#111827] border border-white/[0.12] rounded-xl shadow-2xl w-[680px] max-w-[95vw] p-6 flex flex-col gap-5 relative">

        {/* Close */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 w-7 h-7 rounded-full bg-blue-500 text-white text-sm flex items-center justify-center hover:bg-blue-400 transition font-bold"
        >✕</button>

        {/* Start / Stop text inputs */}
        <div className="grid grid-cols-2 gap-4">
          {[
            { label: "Start", value: fmtDisplay(startMonth, startDay, startHour, startMin) },
            { label: "Stop",  value: fmtDisplay(stopMonth,  stopDay,  stopHour,  stopMin)  },
          ].map(({ label, value }) => (
            <div key={label} className="flex flex-col gap-1">
              <span className="text-[10px] font-mono text-slate-400 tracking-widest uppercase">{label}</span>
              <div className="bg-[#0d1117] border border-white/[0.1] rounded-lg px-3 py-2 text-[13px] font-mono text-white">
                {value}
              </div>
            </div>
          ))}
        </div>

        {/* Calendars + Time pickers */}
        <div className="grid grid-cols-2 gap-3">
          {/* Start picker */}
          <div className="flex gap-2 bg-[#0d1117] border border-white/[0.07] rounded-lg p-3">
            <CalendarGrid
              month={startMonth}
              selectedDay={startDay}
              onSelectDay={setStartDay}
              onPrev={() => setStartMonth(p => new Date(p.getFullYear(), p.getMonth() - 1, 1))}
              onNext={() => setStartMonth(p => new Date(p.getFullYear(), p.getMonth() + 1, 1))}
            />
            <TimeScroll hour={startHour} onHour={setStartHour} scrollRef={timeRef1} />
          </div>

          {/* Stop picker */}
          <div className="flex gap-2 bg-[#0d1117] border border-white/[0.07] rounded-lg p-3">
            <CalendarGrid
              month={stopMonth}
              selectedDay={stopDay}
              onSelectDay={setStopDay}
              onPrev={() => setStopMonth(p => new Date(p.getFullYear(), p.getMonth() - 1, 1))}
              onNext={() => setStopMonth(p => new Date(p.getFullYear(), p.getMonth() + 1, 1))}
            />
            <TimeScroll hour={stopHour} onHour={setStopHour} scrollRef={timeRef2} />
          </div>
        </div>

        {/* Apply button */}
        <button
          onClick={() => onApply(
            buildISO(startMonth, startDay, startHour, startMin),
            buildISO(stopMonth,  stopDay,  stopHour,  stopMin),
          )}
          className="w-full py-3 bg-blue-500 hover:bg-blue-400 text-white font-bold font-mono text-sm rounded-lg transition tracking-widest"
        >
          APPLY TIME RANGE
        </button>
      </div>
    </div>
  );
}

// ─── RangePicker ──────────────────────────────────────────────────────────────

function RangePicker({ range, customLabel, onChange, onCustom, onRefresh }: {
  range: RangeType;
  customLabel: string;
  onChange: (r: QuickRangeType) => void;
  onCustom: () => void;
  onRefresh: () => void;
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

  const currentLabel = range === "custom"
    ? customLabel
    : RANGE_LABEL[range as QuickRangeType];

  const step = (dir: 1 | -1) => {
    if (range === "custom") return;
    const idx  = QUICK_RANGES.findIndex(r => r.value === range);
    const next = QUICK_RANGES[idx + dir];
    if (next) onChange(next.value);
  };

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex items-center rounded-md border border-slate-200 dark:border-white/[0.12] bg-white dark:bg-[#181d2a] overflow-hidden text-[11px] font-mono">
        <button
          onClick={() => step(-1)}
          className="px-2.5 py-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/5 border-r border-slate-200 dark:border-white/[0.08] transition-colors"
        >‹‹</button>

        <button
          onClick={() => setOpen(o => !o)}
          className="flex items-center gap-2 px-3 py-1.5 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors min-w-[120px] justify-between"
        >
          <span className="flex items-center gap-1.5">
            <svg width="11" height="11" viewBox="0 0 14 14" fill="none" className="text-slate-400 flex-shrink-0">
              <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.5" />
              <path d="M7 4v3l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span className="truncate max-w-[140px]">{currentLabel}</span>
          </span>
          <svg width="8" height="8" viewBox="0 0 10 10" fill="none" className="text-slate-400 dark:text-slate-500 flex-shrink-0">
            <path d={open ? "M2 7l3-3 3 3" : "M2 3l3 3 3-3"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>

        <button
          onClick={() => step(1)}
          className="px-2.5 py-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/5 border-l border-slate-200 dark:border-white/[0.08] transition-colors"
        >››</button>

        <button
          onClick={onRefresh}
          className="flex items-center gap-1.5 px-3 py-1.5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5 border-l border-slate-200 dark:border-white/[0.08] transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 14 14" fill="none">
            <path d="M12 7A5 5 0 1 1 7 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <path d="M12 2v5h-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Refresh
        </button>
      </div>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-52 rounded-lg bg-white dark:bg-[#181d2a] border border-slate-200 dark:border-white/[0.12] shadow-2xl overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-100 dark:border-white/[0.08]">
            <span className="text-[9px] font-mono text-slate-400 dark:text-slate-500 tracking-widest uppercase">Time Range</span>
          </div>

          {/* Custom */}
          <button
            onClick={() => { onCustom(); setOpen(false); }}
            className={`w-full text-left px-4 py-2.5 text-[11px] font-mono transition-colors border-b border-slate-100 dark:border-white/[0.06] ${
              range === "custom"
                ? "bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400"
                : "text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.05]"
            }`}
          >
            Custom Time Range
          </button>

          {/* Quick ranges */}
          <div className="max-h-64 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
            {QUICK_RANGES.map(r => (
              <button
                key={r.value}
                onClick={() => { onChange(r.value); setOpen(false); }}
                className={`w-full text-left px-4 py-2.5 text-[11px] font-mono transition-colors ${
                  range === r.value
                    ? "bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400"
                    : "text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.05]"
                }`}
              >
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
  const [labels,      setLabels]      = useState<string[]>([]);
  const [temps,       setTemps]       = useState<number[]>([]);
  const [hums,        setHums]        = useState<number[]>([]);
  const [liveTemp,    setLiveTemp]    = useState<number | string>("--");
  const [liveHum,     setLiveHum]     = useState<number | string>("--");
  const [range,       setRange]       = useState<RangeType>("-1h");
  const [customRange, setCustomRange] = useState<CustomRange | null>(null);
  const [customLabel, setCustomLabel] = useState("Custom Range");
  const [showCustom,  setShowCustom]  = useState(false);
  const [isDark,      setIsDark]      = useState(
    () => document.documentElement.classList.contains("dark")
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartRef  = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resetZoom = useCallback((ref: React.RefObject<any>) => { ref.current?.resetZoom?.(); }, []);

  useEffect(() => {
    const obs = new MutationObserver(() =>
      setIsDark(document.documentElement.classList.contains("dark"))
    );
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    const handleHistory = (history: HistoryData[]) => {
      if (!history?.length) return;
      const lbls = history.map(r =>
        new Date(r.time).toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" })
      );
      setLabels(lbls);
      setTemps(history.map(r => r.temperature));
      setHums(history.map(r => r.humidity));
      const last = history[history.length - 1];
      setLiveTemp(last?.temperature ?? "--");
      setLiveHum(last?.humidity ?? "--");
    };

    const handleLive = (data: SensorData) => {
      if (!data) return;
      const time = new Date(data.timestamp).toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" });
      setLiveTemp(data.temperature);
      setLiveHum(data.humidity);
      setLabels(p => [...p.slice(-999), time]);
      setTemps(p  => [...p.slice(-999), data.temperature]);
      setHums(p   => [...p.slice(-999), data.humidity]);
    };

    socket.on("sensorHistory", handleHistory);
    socket.on("sensorData",    handleLive);

    // Emit initial fetch
    if (customRange) {
      socket.emit("changeRange", customRange);
    } else {
      socket.emit("changeRange", range);
    }

    return () => {
      socket.off("sensorHistory", handleHistory);
      socket.off("sensorData",    handleLive);
    };
  }, [range, customRange]);

  const changeRange = (r: QuickRangeType) => {
    setRange(r);
    setCustomRange(null);
    socket.emit("changeRange", r);
  };

  const handleRefresh = () => {
    if (customRange) {
      socket.emit("changeRange", customRange);
    } else {
      socket.emit("changeRange", range);
    }
  };

  const applyCustomRange = (start: string, stop: string) => {
    const cr: CustomRange = { start, stop };
    setCustomRange(cr);
    setRange("custom");
    setShowCustom(false);
    const s = new Date(start);
    const e = new Date(stop);
    const fmt = (d: Date) => d.toLocaleDateString("en-PH", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    setCustomLabel(`${fmt(s)} → ${fmt(e)}`);
    socket.emit("changeRange", cr);
  };

  // ── Derived ────────────────────────────────────────────────────────────────

  const peakTemp = temps.length > 0 ? Math.max(...temps).toFixed(1) : "--";
  const minTemp  = temps.length > 0 ? Math.min(...temps).toFixed(1) : "--";
  const avgTemp  = temps.length > 0 ? (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1) : "--";
  const peakHum  = hums.length  > 0 ? Math.max(...hums).toFixed(1)  : "--";
  const minHum   = hums.length  > 0 ? Math.min(...hums).toFixed(1)  : "--";
  const avgHum   = hums.length  > 0 ? (hums.reduce((a, b) => a + b, 0) / hums.length).toFixed(1) : "--";

  const maxTempY = temps.length > 0 ? Math.ceil(Math.max(...temps))  + 3 : 40;
  const minTempY = temps.length > 0 ? Math.floor(Math.min(...temps)) - 2 : 15;
  const maxHumY  = hums.length  > 0 ? Math.ceil(Math.max(...hums))   + 3 : 100;
  const minHumY  = hums.length  > 0 ? Math.floor(Math.min(...hums))  - 3 : 30;

  const tempGaugePct = typeof liveTemp === "number" ? (liveTemp - 15) / 25 : 0;
  const humGaugePct  = typeof liveHum  === "number" ? (liveHum  - 30) / 70 : 0;

  const combinedData: ChartData<"line"> = {
    labels,
    datasets: [
      {
        label: "Temperature", data: temps,
        borderColor: "#f59e0b",
        backgroundColor: (ctx: ScriptableContext<"line">) =>
          gradientFill(ctx, "rgba(245,158,11,0.18)", "rgba(245,158,11,0.01)"),
        borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4,
        pointHoverBackgroundColor: "#f59e0b", fill: true, tension: 0.3, yAxisID: "yTemp",
      },
      {
        label: "Humidity", data: hums,
        borderColor: "#38bdf8",
        backgroundColor: (ctx: ScriptableContext<"line">) =>
          gradientFill(ctx, "rgba(56,189,248,0.15)", "rgba(56,189,248,0.01)"),
        borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4,
        pointHoverBackgroundColor: "#38bdf8", fill: true, tension: 0.3, yAxisID: "yHum",
      },
    ],
  };

  const combinedOpts = makeCombinedOptions(isDark, minTempY, maxTempY, minHumY, maxHumY);

  return (
    <div
      className="min-h-screen bg-white dark:bg-[#0b0f1a] text-slate-900 dark:text-white p-4 lg:p-6 flex flex-col gap-4"
      style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-1 h-5 rounded-full bg-gradient-to-b from-amber-400 to-sky-500" />
          <div>
            <div className="text-sm font-bold text-slate-900 dark:text-slate-100 tracking-wide">Environment Monitoring</div>
            <div className="text-[10px] text-slate-400 dark:text-slate-500 tracking-widest uppercase mt-0.5">DHT Sensor · Real-time</div>
          </div>
        </div>
        <RangePicker
          range={range}
          customLabel={customLabel}
          onChange={changeRange}
          onCustom={() => setShowCustom(true)}
          onRefresh={handleRefresh}
        />
      </div>

      {/* Sensor Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <SensorCard
          label="Temperature:"
          value={typeof liveTemp === "number" ? liveTemp.toFixed(1) : liveTemp}
          unit="°C" color="#f59e0b" segPct={tempGaugePct} sparkData={temps.slice(-24)}
          max={peakTemp !== "--" ? `${peakTemp} °C` : "--"}
          avg={avgTemp  !== "--" ? `${avgTemp} °C`  : "--"}
          min={minTemp  !== "--" ? `${minTemp} °C`  : "--"}
          gaugePct={tempGaugePct}
          gaugeLabel={typeof liveTemp === "number" ? `${liveTemp.toFixed(0)} °C` : "--"}
        />
        <SensorCard
          label="Humidity:"
          value={typeof liveHum === "number" ? liveHum.toFixed(1) : liveHum}
          unit="%H" color="#38bdf8" segPct={humGaugePct} sparkData={hums.slice(-24)}
          max={peakHum !== "--" ? `${peakHum} %H` : "--"}
          avg={avgHum  !== "--" ? `${avgHum} %H`  : "--"}
          min={minHum  !== "--" ? `${minHum} %H`  : "--"}
          gaugePct={humGaugePct}
          gaugeLabel={typeof liveHum === "number" ? `${liveHum.toFixed(0)} %H` : "--"}
        />
      </div>

      {/* Combined chart */}
      <CombinedChartPanel
        liveTemp={typeof liveTemp === "number" ? liveTemp.toFixed(1) : liveTemp}
        liveHum={typeof liveHum   === "number" ? liveHum.toFixed(1)  : liveHum}
        data={combinedData} options={combinedOpts}
        chartRef={chartRef} onResetZoom={() => resetZoom(chartRef)}
      />

      <div className="text-center text-[9px] font-mono text-slate-400 dark:text-slate-600 tracking-widest">
        SCROLL TO ZOOM · DRAG TO PAN · CLICK RESET TO FIT
      </div>

      {/* Custom range modal */}
      {showCustom && (
        <CustomRangePicker
          onApply={applyCustomRange}
          onClose={() => setShowCustom(false)}
        />
      )}
    </div>
  );
}