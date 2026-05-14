import { useEffect, useRef } from "react";
import "../chart/ChartConfig";
import Chart from "../chart/ChartConfig";

interface Server {
  id: string;
  name: string;
  ip: string;
  status: string;
  cpu: number;
  memory: number;
  memoryTotalGB: number;
  diskUsed: number;
  diskTotalGB: number;
  uptime: string;
  os: string;
  kernel: string;
  cores: number;
  arch: string;
  gateway: string;
  dns: string;
  region: string;
  role: string;
}

interface Props {
  server: Server;
  onBack: () => void;
}

function barColor(v: number) {
  if (v > 70) return "#E24B4A";
  if (v > 50) return "#EF9F27";
  return "#73BF69";
}

function genHistory(base: number, variance: number, count = 60) {
  return Array.from({ length: count }, (_, i) => {
    const noise = (Math.random() - 0.5) * variance * 2;
    const trend = Math.sin(i / 6) * (variance * 0.4);
    return Math.min(100, Math.max(0, Math.round(base + noise + trend)));
  });
}

const hours = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}:00`);

function useChart(
  ref: React.RefObject<HTMLCanvasElement | null>,
  config: () => ConstructorParameters<typeof Chart>[1],
  deps: unknown[]
) {
  useEffect(() => {
    if (!ref.current) return;
    const chart = new Chart(ref.current, config());
    return () => chart.destroy();
  }, deps);
}

// ─── GaugePanel (like Grafana Memory / Google hits panels) ───────────────────
function GaugePanel({
  title, value, unit, pct, color,
}: {
  title: string; value: string; unit: string; pct: number; color: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const w = c.width, h = c.height;
    const cx = w / 2, cy = h * 0.72, r = Math.min(w, h) * 0.38;
    const startA = Math.PI * 0.85;
    const endA   = Math.PI * 2.15;
    const fillA  = startA + (endA - startA) * Math.min(Math.max(pct, 0), 1);

    ctx.clearRect(0, 0, w, h);

    // Track bg
    ctx.beginPath();
    ctx.arc(cx, cy, r, startA, endA);
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 10;
    ctx.lineCap = "round";
    ctx.stroke();

    // Threshold bands (subtle background layers like Grafana)
    const bands = [
      { end: 0.5,  color: "rgba(115,191,105,0.15)" },
      { end: 0.75, color: "rgba(239,159,39,0.15)" },
      { end: 1.0,  color: "rgba(226,75,74,0.15)" },
    ];
    let prev = startA;
    for (const band of bands) {
      const bEnd = startA + (endA - startA) * band.end;
      ctx.beginPath();
      ctx.arc(cx, cy, r, prev, bEnd);
      ctx.strokeStyle = band.color;
      ctx.lineWidth = 10;
      ctx.lineCap = "butt";
      ctx.stroke();
      prev = bEnd;
    }

    // Filled arc
    ctx.beginPath();
    ctx.arc(cx, cy, r, startA, fillA);
    ctx.strokeStyle = color;
    ctx.lineWidth = 10;
    ctx.lineCap = "round";
    ctx.stroke();

    // Value text
    ctx.fillStyle = color;
    ctx.font = `bold ${Math.round(r * 0.38)}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(value, cx, cy - r * 0.08);

    // Unit text
    ctx.fillStyle = "rgba(200,210,220,0.55)";
    ctx.font = `${Math.round(r * 0.22)}px monospace`;
    ctx.fillText(unit, cx, cy + r * 0.28);

    // Min / Max labels
    ctx.fillStyle = "rgba(180,190,200,0.4)";
    ctx.font = `${Math.round(r * 0.18)}px monospace`;
    ctx.textAlign = "left";
    ctx.fillText("0", cx - r * 0.92, cy + r * 0.22);
    ctx.textAlign = "right";
    ctx.fillText("100", cx + r * 0.92, cy + r * 0.22);
  }, [pct, color, value, unit]);

  return (
    <div className="bg-[#111217] dark:bg-[#111217] bg-slate-100 border border-white/[0.07] dark:border-white/[0.07] border-slate-200 rounded-lg overflow-hidden flex flex-col">
      <div className="px-3 pt-2.5 pb-1 border-b border-white/[0.06] dark:border-white/[0.06] border-slate-200">
        <span className="text-[11px] font-medium text-slate-400 dark:text-slate-400 text-slate-500">{title}</span>
      </div>
      <div className="flex-1 flex items-center justify-center py-1">
        <canvas ref={canvasRef} width={180} height={110} style={{ width: "100%", maxWidth: 180, height: "auto" }} />
      </div>
    </div>
  );
}

// ─── SparkStatPanel (like Grafana Support calls / Sign ups panels) ────────────
function SparkStatPanel({
  title, value, unit, data, color,
}: {
  title: string; value: string; unit: string; data: number[]; color: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef  = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    chartRef.current?.destroy();
    chartRef.current = new Chart(canvasRef.current, {
      type: "line",
      data: {
        labels: data.map((_, i) => i),
        datasets: [{
          data,
          borderColor: color,
          borderWidth: 1.5,
          pointRadius: 0,
          fill: true,
          backgroundColor: color + "33",
          tension: 0.4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } },
        layout: { padding: 0 },
      },
    });
    return () => { chartRef.current?.destroy(); };
  }, [data, color]);

  return (
    <div className="bg-[#111217] dark:bg-[#111217] bg-slate-100 border border-white/[0.07] dark:border-white/[0.07] border-slate-200 rounded-lg overflow-hidden flex flex-col">
      <div className="px-3 pt-2.5 pb-1 border-b border-white/[0.06] dark:border-white/[0.06] border-slate-200">
        <span className="text-[11px] font-medium text-slate-400 dark:text-slate-400 text-slate-500">{title}</span>
      </div>
      <div className="relative flex-1" style={{ minHeight: 80 }}>
        {/* Spark chart fills the whole panel */}
        <div className="absolute inset-0">
          <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />
        </div>
        {/* Value overlaid bottom-left like Grafana */}
        <div className="absolute bottom-2 left-3 flex items-baseline gap-1">
          <span className="text-[22px] font-bold font-mono leading-none" style={{ color }}>{value}</span>
          <span className="text-[11px] font-mono text-slate-400 dark:text-slate-400">{unit}</span>
        </div>
      </div>
    </div>
  );
}

// ─── InfoCard ─────────────────────────────────────────────────────────────────
function InfoCard({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="bg-[#111217] dark:bg-[#111217] bg-white border border-white/[0.07] dark:border-white/[0.07] border-slate-200 rounded-lg p-4">
      <div className="text-[11px] font-medium text-slate-400 dark:text-slate-400 text-slate-500 mb-3">{title}</div>
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between items-center py-1.5 border-b border-white/[0.05] dark:border-white/[0.05] border-slate-100 last:border-none text-xs">
          <span className="text-slate-400 dark:text-slate-400 text-slate-500">{k}</span>
          <span className="font-mono font-medium text-white dark:text-white text-slate-900">{v}</span>
        </div>
      ))}
    </div>
  );
}

// ─── ChartCard ────────────────────────────────────────────────────────────────
function ChartCard({
  title, legend, canvasRef, height = 140,
}: {
  title: string;
  legend: { color: string; label: string }[];
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  height?: number;
}) {
  return (
    <div className="bg-[#111217] dark:bg-[#111217] bg-white border border-white/[0.07] dark:border-white/[0.07] border-slate-200 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.06] dark:border-white/[0.06] border-slate-100">
        <span className="text-[11px] font-medium text-slate-400 dark:text-slate-400 text-slate-500">{title}</span>
        <div className="flex gap-3">
          {legend.map(l => (
            <span key={l.label} className="flex items-center gap-1 text-[10px] text-slate-400 dark:text-slate-400 text-slate-500">
              <span className="w-5 h-[2px] rounded-full inline-block" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      </div>
      <div className="relative px-3 pt-2 pb-3" style={{ height }}>
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}

// ─── ServerDetail ─────────────────────────────────────────────────────────────
export default function ServerDetail({ server: s, onBack }: Props) {
  const cpuRef  = useRef<HTMLCanvasElement>(null);
  const memRef  = useRef<HTMLCanvasElement>(null);
  const diskRef = useRef<HTMLCanvasElement>(null);
  const netRef  = useRef<HTMLCanvasElement>(null);

  const memUsedGB  = +((s.memory  / 100) * s.memoryTotalGB).toFixed(1);
  const diskUsedGB = Math.round((s.diskUsed / 100) * s.diskTotalGB);
  const diskFreeGB = s.diskTotalGB - diskUsedGB;

  const cpuHistory  = genHistory(s.cpu,      15);
  const memHistory  = genHistory(s.memory,   10);
  const diskHistory = genHistory(s.diskUsed, 8);
  const netHistory  = genHistory(35,         20);

  const lineChartOpts = (color: string, data: number[], yLabel = "%") => ({
    type: "line" as const,
    data: {
      labels: hours,
      datasets: [{
        data,
        borderColor: color,
        borderWidth: 1.5,
        tension: 0.4,
        pointRadius: 0,
        fill: true,
        backgroundColor: color + "1a",
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: {
        duration: 0,
      },
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: "rgba(160,170,190,0.5)", font: { size: 9 }, maxTicksLimit: 6, autoSkip: true },
          grid: { color: "rgba(255,255,255,0.04)" },
          border: { display: false },
        },
        y: {
          ticks: { color: "rgba(160,170,190,0.5)", font: { size: 9 }, maxTicksLimit: 4 },
          grid: { color: "rgba(255,255,255,0.04)" },
          border: { display: false },
        },
      },
    },
  });

  useChart(cpuRef,  () => lineChartOpts("#378ADD", cpuHistory),  [s.id]);
  useChart(memRef,  () => lineChartOpts("#7F77DD", memHistory),  [s.id]);

  useChart(diskRef, () => ({
    type: "bar" as const,
    data: {
      labels: ["Disk"],
      datasets: [
        { label: "Used", data: [diskUsedGB], backgroundColor: "#EF9F27", borderRadius: 3 },
        { label: "Free", data: [diskFreeGB], backgroundColor: "#73BF69", borderRadius: 3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: "y" as const,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { stacked: true, ticks: { color: "rgba(160,170,190,0.5)", font: { size: 9 } }, grid: { color: "rgba(255,255,255,0.04)" }, border: { display: false } },
        y: { stacked: true, ticks: { display: false }, grid: { display: false }, border: { display: false } },
      },
    },
  }), [s.id]);

  useChart(netRef, () => ({
    type: "line" as const,
    data: {
      labels: hours,
      datasets: [
        { label: "In",  data: genHistory(12, 8), borderColor: "#5DCAA5", borderWidth: 1.5, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: "#5DCAA51a" },
        { label: "Out", data: genHistory(7, 6),  borderColor: "#D85A30", borderWidth: 1.5, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: "#D85A301a" },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "rgba(160,170,190,0.5)", font: { size: 9 }, maxTicksLimit: 6, autoSkip: true }, grid: { color: "rgba(255,255,255,0.04)" }, border: { display: false } },
        y: { ticks: { color: "rgba(160,170,190,0.5)", font: { size: 9 }, maxTicksLimit: 4 }, grid: { color: "rgba(255,255,255,0.04)" }, border: { display: false } },
      },
    },
  }), [s.id]);

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4 bg-[#0b0e14] dark:bg-[#0b0e14] bg-slate-50 min-h-full">

      {/* Header */}
      <div className="flex items-center gap-3 pb-3 border-b border-white/[0.07] dark:border-white/[0.07] border-slate-200">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-slate-400 dark:text-slate-400 text-slate-500 hover:text-white dark:hover:text-white hover:text-slate-900 transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          All servers
        </button>
        <div className="flex-1" />
        <span className="text-[10px] font-mono text-slate-400 dark:text-slate-400 text-slate-500">{s.ip} · {s.region} · {s.role}</span>
        <span className={`text-xs font-medium px-2.5 py-1 rounded-sm ${
          s.status === "Online"
            ? "bg-green-900/40 text-green-400 border border-green-700/40"
            : "bg-red-900/40 text-red-400 border border-red-700/40"
        }`}>
          {s.status}
        </span>
      </div>

      {/* Server name */}
      <div className="flex items-center gap-3">
        <div className="w-1 h-5 rounded-full" style={{ background: barColor(s.cpu) }} />
        <div>
          <div className="text-base font-semibold text-white dark:text-white text-slate-900 font-mono">{s.name}</div>
          <div className="text-[10px] text-slate-500 font-mono mt-0.5">{s.os} · {s.kernel} · {s.cores} cores</div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[10px] text-slate-500 font-mono">uptime</span>
          <span className="text-[11px] font-mono font-medium text-green-400">{s.uptime}</span>
        </div>
      </div>

      {/* Top row — 2 gauge panels + 2 spark-stat panels (like Grafana top row) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" style={{ height: 160 }}>
        <GaugePanel
          title="CPU load"
          value={`${s.cpu}`}
          unit="%"
          pct={s.cpu / 100}
          color={barColor(s.cpu)}
        />
        <GaugePanel
          title="Memory"
          value={`${memUsedGB}`}
          unit={`of ${s.memoryTotalGB} GB`}
          pct={s.memory / 100}
          color={barColor(s.memory)}
        />
        <SparkStatPanel
          title="Disk used"
          value={`${s.diskUsed}`}
          unit="%"
          data={diskHistory}
          color={barColor(s.diskUsed)}
        />
        <SparkStatPanel
          title="Network activity"
          value={`${netHistory[netHistory.length - 1]}`}
          unit="MB/s"
          data={netHistory}
          color="#5DCAA5"
        />
      </div>

      {/* Chart panels — 2 columns like Grafana */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ChartCard
          title="CPU usage — last 24h"
          legend={[{ color: "#378ADD", label: "cpu %" }]}
          canvasRef={cpuRef}
          height={150}
        />
        <ChartCard
          title="Memory usage — last 24h"
          legend={[{ color: "#7F77DD", label: "memory %" }]}
          canvasRef={memRef}
          height={150}
        />
        <ChartCard
          title="Disk — used vs free (GB)"
          legend={[{ color: "#EF9F27", label: "used" }, { color: "#73BF69", label: "free" }]}
          canvasRef={diskRef}
          height={100}
        />
        <ChartCard
          title="Network I/O — MB/s"
          legend={[{ color: "#5DCAA5", label: "in" }, { color: "#D85A30", label: "out" }]}
          canvasRef={netRef}
          height={150}
        />
      </div>

      {/* Info rows */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <InfoCard title="System info" rows={[
          ["OS",     s.os],
          ["Kernel", s.kernel],
          ["Cores",  String(s.cores)],
          ["Arch",   s.arch],
          ["Memory", `${s.memoryTotalGB} GB`],
          ["Disk",   `${s.diskTotalGB} GB`],
        ]} />
        <InfoCard title="Network info" rows={[
          ["IP address", s.ip],
          ["Gateway",    s.gateway],
          ["DNS",        s.dns],
          ["Region",     s.region],
        ]} />
      </div>

    </div>
  );
}