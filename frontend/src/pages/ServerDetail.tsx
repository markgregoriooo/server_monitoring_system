import { useEffect, useRef, useState } from "react";
import "../chart/ChartConfig";
import Chart from "../chart/ChartConfig";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import { useTheme } from "../context/ThemeContext";

interface Server {
  id: string;
  name: string;
  hostname?: string;
  displayName?: string | null;
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

interface HistoryPoint {
  time: string;            // ISO timestamp
  cpu: number | null;
  mem: number | null;
  disk: number | null;
  netSent: number | null;  // cumulative bytes
  netRecv: number | null;  // cumulative bytes
}

const RANGES = [
  { key: "-1h",  label: "1h" },
  { key: "-6h",  label: "6h" },
  { key: "-24h", label: "24h" },
];

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-PH", {
    timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

// Throughput in MB/s between two cumulative byte counters (clamps counter resets).
function rateMBs(curr: number | null, prev: number | null, currT: string, prevT: string) {
  if (curr == null || prev == null) return 0;
  const dt = (new Date(currT).getTime() - new Date(prevT).getTime()) / 1000;
  if (dt <= 0) return 0;
  return +(Math.max(0, curr - prev) / dt / 1024 / 1024).toFixed(2);
}

interface DeviceLog {
  log_level: "info" | "warning" | "critical" | "error";
  message: string;
  recorded_at: string;
}

function logColor(level: string) {
  if (level === "critical" || level === "error") return "#E24B4A";
  if (level === "warning") return "#EF9F27";
  return "#5794F2"; // info
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-PH", {
    timeZone: "Asia/Manila", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

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
  title, value, unit, pct, color, theme,
}: {
  title: string; value: string; unit: string; pct: number; color: string; theme: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isLight = theme === "light";

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
    ctx.strokeStyle = isLight ? "rgba(15,23,42,0.10)" : "rgba(255,255,255,0.08)";
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
    ctx.fillStyle = isLight ? "rgba(71,85,105,0.75)" : "rgba(200,210,220,0.55)";
    ctx.font = `${Math.round(r * 0.22)}px monospace`;
    ctx.fillText(unit, cx, cy + r * 0.28);
  }, [pct, color, value, unit, isLight]);

  return (
    <div className="bg-slate-100 dark:bg-[#111217] border border-slate-200 dark:border-white/[0.07] rounded-lg overflow-hidden flex flex-col">
      <div className="px-3 pt-2.5 pb-1 border-b border-slate-200 dark:border-white/[0.06]">
        <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{title}</span>
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
    <div className="bg-slate-100 dark:bg-[#111217] border border-slate-200 dark:border-white/[0.07] rounded-lg overflow-hidden flex flex-col">
      <div className="px-3 pt-2.5 pb-1 border-b border-slate-200 dark:border-white/[0.06]">
        <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{title}</span>
      </div>
      <div className="relative flex-1" style={{ minHeight: 80 }}>
        {/* Spark chart fills the whole panel */}
        <div className="absolute inset-0">
          <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />
        </div>
        {/* Value overlaid bottom-left like Grafana */}
        <div className="absolute bottom-2 left-3 flex items-baseline gap-1">
          <span className="text-[22px] font-bold font-mono leading-none" style={{ color }}>{value}</span>
          <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">{unit}</span>
        </div>
      </div>
    </div>
  );
}

// ─── InfoCard ─────────────────────────────────────────────────────────────────
function InfoCard({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="bg-white dark:bg-[#111217] border border-slate-200 dark:border-white/[0.07] rounded-lg p-4">
      <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-3">{title}</div>
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between items-start gap-3 py-1.5 border-b border-slate-100 dark:border-white/[0.05] last:border-none text-xs">
          <span className="text-slate-500 dark:text-slate-400 flex-shrink-0 whitespace-nowrap">{k}</span>
          <span className="font-mono font-medium text-slate-900 dark:text-white text-right break-words min-w-0">{v}</span>
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
    <div className="bg-white dark:bg-[#111217] border border-slate-200 dark:border-white/[0.07] rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100 dark:border-white/[0.06]">
        <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{title}</span>
        <div className="flex gap-3">
          {legend.map(l => (
            <span key={l.label} className="flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400">
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
  const { theme } = useTheme();
  const cpuRef  = useRef<HTMLCanvasElement>(null);
  const memRef  = useRef<HTMLCanvasElement>(null);
  const diskRef = useRef<HTMLCanvasElement>(null);
  const netRef  = useRef<HTMLCanvasElement>(null);

  const [range, setRange]     = useState("-1h");
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [logs, setLogs]       = useState<DeviceLog[]>([]);

  const memUsedGB  = +((s.memory  / 100) * s.memoryTotalGB).toFixed(1);
  const diskUsedGB = Math.round((s.diskUsed / 100) * s.diskTotalGB);
  const diskFreeGB = s.diskTotalGB - diskUsedGB;

  // Real history from InfluxDB for this server + range, then keep it live by
  // appending each incoming serverMetrics point for this server.
  useEffect(() => {
    let alive = true;
    api.getServerHistory(Number(s.id), range).then((r) => {
      if (!alive || !r.success || !r.data) return;
      setHistory(
        (r.data.history ?? []).map((p: any) => ({
          time: p.time,
          cpu: p.cpu_percent ?? null,
          mem: p.mem_percent ?? null,
          disk: p.disk_percent ?? null,
          netSent: p.net_bytes_sent ?? null,
          netRecv: p.net_bytes_recv ?? null,
        })),
      );
    });

    const onMetrics = (data: { server: any }) => {
      if (String(data?.server?.id) !== s.id) return;
      setHistory((prev) => [
        ...prev.slice(-720),
        {
          time: data.server.timestamp ?? new Date().toISOString(),
          cpu: data.server.cpuPercent ?? null,
          mem: data.server.memPercent ?? null,
          disk: data.server.diskPercent ?? null,
          netSent: data.server.netBytesSent ?? null,
          netRecv: data.server.netBytesRecv ?? null,
        },
      ]);
    };
    socket.on("serverMetrics", onMetrics);
    return () => { alive = false; socket.off("serverMetrics", onMetrics); };
  }, [s.id, range]);

  // Device event log (device_logs) for this server, kept live via deviceLog events.
  useEffect(() => {
    let alive = true;
    api.getServerLogs(Number(s.id)).then((r) => {
      if (alive && r.success && r.data) setLogs(r.data.logs ?? []);
    });
    const onLog = (e: any) => {
      if (String(e?.device_id) !== s.id) return;
      setLogs((prev) => [
        { log_level: e.log_level, message: e.message, recorded_at: e.recorded_at },
        ...prev,
      ].slice(0, 100));
    };
    socket.on("deviceLog", onLog);
    return () => { alive = false; socket.off("deviceLog", onLog); };
  }, [s.id]);

  const labels   = history.map((p) => fmtTime(p.time));
  const cpuData  = history.map((p) => p.cpu ?? 0);
  const memData  = history.map((p) => p.mem ?? 0);
  const diskData = history.map((p) => p.disk ?? 0);
  const netIn    = history.map((p, i) => {
    const prev = history[i - 1];
    return prev ? rateMBs(p.netRecv, prev.netRecv, p.time, prev.time) : 0;
  });
  const netOut   = history.map((p, i) => {
    const prev = history[i - 1];
    return prev ? rateMBs(p.netSent, prev.netSent, p.time, prev.time) : 0;
  });
  const netTotal = netIn.map((v, i) => +(v + (netOut[i] ?? 0)).toFixed(2));
  const lastNet  = netTotal.at(-1) ?? 0;

  const isLight = theme === "light";
  const AX = isLight ? "rgba(71,85,105,0.85)" : "rgba(160,170,190,0.5)";
  const GRID = isLight ? "rgba(15,23,42,0.08)" : "rgba(255,255,255,0.04)";

  const lineChartOpts = (color: string, data: number[]) => ({
    type: "line" as const,
    data: {
      labels,
      datasets: [{
        data, borderColor: color, borderWidth: 1.5, tension: 0.4,
        pointRadius: 0, fill: true, backgroundColor: color + "1a",
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: AX, font: { size: 9 }, maxTicksLimit: 6, autoSkip: true }, grid: { color: GRID }, border: { display: false } },
        y: { ticks: { color: AX, font: { size: 9 }, maxTicksLimit: 4 }, grid: { color: GRID }, border: { display: false } },
      },
    },
  });

  useChart(cpuRef, () => lineChartOpts("#378ADD", cpuData), [history, theme]);
  useChart(memRef, () => lineChartOpts("#7F77DD", memData), [history, theme]);

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
        x: { stacked: true, ticks: { color: AX, font: { size: 9 } }, grid: { color: GRID }, border: { display: false } },
        y: { stacked: true, ticks: { display: false }, grid: { display: false }, border: { display: false } },
      },
    },
  }), [s.id, diskUsedGB, diskFreeGB, theme]);

  useChart(netRef, () => ({
    type: "line" as const,
    data: {
      labels,
      datasets: [
        { label: "In",  data: netIn,  borderColor: "#5DCAA5", borderWidth: 1.5, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: "#5DCAA51a" },
        { label: "Out", data: netOut, borderColor: "#D85A30", borderWidth: 1.5, tension: 0.4, pointRadius: 0, fill: true, backgroundColor: "#D85A301a" },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: AX, font: { size: 9 }, maxTicksLimit: 6, autoSkip: true }, grid: { color: GRID }, border: { display: false } },
        y: { ticks: { color: AX, font: { size: 9 }, maxTicksLimit: 4 }, grid: { color: GRID }, border: { display: false } },
      },
    },
  }), [history, theme]);

  return (
    <div className="p-3 sm:p-4 lg:p-6 flex flex-col gap-4 bg-slate-50 dark:bg-[#0b0e14] min-h-full">

      {/* Header */}
      <div className="flex items-center gap-3 pb-3 border-b border-white/[0.07] dark:border-white/[0.07] border-slate-200">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          All servers
        </button>
        <div className="flex-1" />
        <span className="hidden sm:block truncate max-w-[45%] text-[10px] font-mono text-slate-500 dark:text-slate-400">{s.ip} · {s.region} · {s.role}</span>
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
        <div className="min-w-0">
          <div className="text-base font-semibold text-slate-900 dark:text-white font-mono truncate">{s.name}</div>
          {s.displayName && s.hostname && s.hostname !== s.name && (
            <div className="text-[10px] text-slate-500 font-mono mt-0.5 truncate">host: {s.hostname}</div>
          )}
          <div className="text-[10px] text-slate-500 font-mono mt-0.5 truncate">{s.os} · {s.kernel} · {s.cores} cores</div>
        </div>
        <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
          <span className="text-[10px] text-slate-500 font-mono">uptime</span>
          <span className="text-[11px] font-mono font-medium text-green-400">{s.uptime}</span>
        </div>
      </div>

      {/* Top row — 2 gauge panels + 2 spark-stat panels (like Grafana top row) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:h-40">
        <GaugePanel
          title="CPU load"
          value={`${s.cpu}`}
          unit="%"
          pct={s.cpu / 100}
          color={barColor(s.cpu)}
          theme={theme}
        />
        <GaugePanel
          title="Memory"
          value={`${memUsedGB}`}
          unit={`of ${s.memoryTotalGB} GB`}
          pct={s.memory / 100}
          color={barColor(s.memory)}
          theme={theme}
        />
        <SparkStatPanel
          title="Disk used"
          value={`${s.diskUsed}`}
          unit="%"
          data={diskData.length ? diskData : [0]}
          color={barColor(s.diskUsed)}
        />
        <SparkStatPanel
          title="Network I/O"
          value={`${lastNet}`}
          unit="MB/s"
          data={netTotal.length ? netTotal : [0]}
          color="#5DCAA5"
        />
      </div>

      {/* Range selector */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
          Performance {history.length === 0 ? "· no data for this range" : `· last ${RANGES.find((r) => r.key === range)?.label}`}
        </span>
        <div className="flex gap-1 bg-slate-100 dark:bg-white/[0.05] rounded-md p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                range === r.key
                  ? "bg-white dark:bg-white/[0.12] text-slate-900 dark:text-white shadow-sm"
                  : "text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Chart panels — 2 columns like Grafana */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ChartCard
          title="CPU usage"
          legend={[{ color: "#378ADD", label: "cpu %" }]}
          canvasRef={cpuRef}
          height={150}
        />
        <ChartCard
          title="Memory usage"
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

      {/* Recent events (device_logs) */}
      <div className="bg-white dark:bg-[#111217] border border-slate-200 dark:border-white/[0.07] rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Recent events</span>
          {logs.length > 0 && <span className="text-[10px] text-slate-400">{logs.length}</span>}
        </div>
        {logs.length === 0 ? (
          <div className="text-xs text-slate-400 py-5 text-center">No events logged yet.</div>
        ) : (
          <div className="flex flex-col divide-y divide-slate-100 dark:divide-white/[0.05] max-h-72 overflow-y-auto">
            {logs.map((l, i) => (
              <div key={i} className="flex items-start gap-2.5 py-2">
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: logColor(l.log_level) }} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-slate-700 dark:text-slate-200 break-words">{l.message}</div>
                  <div className="text-[10px] text-slate-400 mt-0.5">{fmtDateTime(l.recorded_at)}</div>
                </div>
                <span
                  className="text-[9px] uppercase font-semibold tracking-wider flex-shrink-0 mt-0.5"
                  style={{ color: logColor(l.log_level) }}
                >
                  {l.log_level}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

    </div>
  );
}