import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import "../chart/ChartConfig";
import Chart from "../chart/ChartConfig";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import { useTheme } from "../context/ThemeContext";
import RangePicker, { DEFAULT_RANGE, rangeSpanSec, presetLabel } from "../components/ui/RangePicker";
import { withGaps, gapIndices } from "../utils/seriesGaps";
import { fitCanvas } from "../utils/hidpiCanvas";
import { useCanvasRedraw } from "../hooks/useCanvasRedraw";

// The size each gauge OCCUPIES, in CSS pixels — see utils/hidpiCanvas.
const GAUGE_W = 180;
const GAUGE_H = 110;
import type { RangeValue } from "../components/ui/RangePicker";
import type { Volume } from "../types/server";
import { fmtAxisTime as fmtTime, fmtDateTime, rateMBs, MULTI_DAY_SEC } from "../utils/format";

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
  volumes: Volume[];
  processCount: number | null;
  agentVersion: string;
  lastSeen: string | null;
  metricIntervalSec: number | null;
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

// Windows longer than a day show the date on the axis. Based on the window's span, so a
// custom 5-day window gets dates too.

// Throughput in MB/s between two cumulative byte counters (clamps counter resets).
interface DeviceLog {
  log_level: "info" | "warning" | "critical" | "error";
  message: string;
  recorded_at: string;
}

// One open alert, as GET /api/alerts returns it (only the fields this page reads).
interface OpenAlert {
  id: number;
  title: string;
  message: string;
  severity: "info" | "warning" | "critical";
  status: "active" | "acknowledged" | "resolved";
  createdAt: string;
  acknowledgedByName: string | null;
}

// The alerts still open for this server (current state), separate from the Recent
// events log (history).
function ActiveAlerts({ alerts }: { alerts: OpenAlert[] | null }) {
  if (alerts === null) return null; // still loading — don't flash "no alerts"
  return (
    <div className="bg-white dark:bg-[#111217] border border-slate-200 dark:border-white/[0.07] rounded-lg px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-slate-500 dark:text-slate-400">Active alerts</span>
        {alerts.length > 0 && (
          <Link to="/alerts" className="text-[12px] text-blue-600 dark:text-blue-400 hover:underline">
            Open Alerts page
          </Link>
        )}
      </div>
      {alerts.length === 0 ? (
        <div className="flex items-center gap-2 mt-1.5 text-xs text-slate-500 dark:text-slate-400">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: "#73BF69" }} />
          No active alerts — every metric on this server is within its thresholds.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 mt-2 max-h-40 overflow-y-auto">
          {alerts.map((a) => (
            <div key={a.id} className="flex items-start gap-2.5">
              <span className="mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: logColor(a.severity) }} />
              <div className="min-w-0 flex-1">
                <div className="text-xs text-slate-700 dark:text-slate-200 break-words">{a.message}</div>
                <div className="text-[12px] text-slate-400 mt-0.5">
                  since {fmtDateTime(a.createdAt)}
                  {a.status === "acknowledged" && ` · acknowledged${a.acknowledgedByName ? ` by ${a.acknowledgedByName}` : ""}`}
                </div>
              </div>
              <span className="text-[11px] uppercase font-semibold tracking-wider flex-shrink-0 mt-0.5"
                    style={{ color: logColor(a.severity) }}>
                {a.severity}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function logColor(level: string) {
  if (level === "critical" || level === "error") return "#E24B4A";
  if (level === "warning") return "#EF9F27";
  return "#5794F2"; // info
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
  const redraw = useCanvasRedraw(canvasRef);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = fitCanvas(c, GAUGE_W, GAUGE_H);
    if (!ctx) return;
    const w = GAUGE_W, h = GAUGE_H;
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
  }, [pct, color, value, unit, isLight, redraw]);

  return (
    <div className="bg-slate-100 dark:bg-[#111217] border border-slate-200 dark:border-white/[0.07] rounded-lg overflow-hidden flex flex-col">
      <div className="px-3 pt-2.5 pb-1 border-b border-slate-200 dark:border-white/[0.06]">
        <span className="text-[13px] font-medium text-slate-500 dark:text-slate-400">{title}</span>
      </div>
      <div className="flex-1 flex items-center justify-center py-1">
        <canvas ref={canvasRef} width={GAUGE_W} height={GAUGE_H} style={{ width: "100%", maxWidth: GAUGE_W, height: "auto" }} />
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
        <span className="text-[13px] font-medium text-slate-500 dark:text-slate-400">{title}</span>
      </div>
      <div className="relative flex-1" style={{ minHeight: 80 }}>
        {/* Spark chart fills the whole panel */}
        <div className="absolute inset-0">
          <canvas ref={canvasRef} style={{ width: "100%", height: "100%" }} />
        </div>
        {/* Value overlaid bottom-left like Grafana */}
        <div className="absolute bottom-2 left-3 flex items-baseline gap-1">
          <span className="text-[22px] font-bold font-mono leading-none" style={{ color }}>{value}</span>
          <span className="text-[13px] font-mono text-slate-500 dark:text-slate-400">{unit}</span>
        </div>
      </div>
    </div>
  );
}

// ─── InfoCard ─────────────────────────────────────────────────────────────────
function InfoCard({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="bg-white dark:bg-[#111217] border border-slate-200 dark:border-white/[0.07] rounded-lg p-4">
      <div className="text-[13px] font-medium text-slate-500 dark:text-slate-400 mb-3">{title}</div>
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between items-start gap-3 py-1.5 border-b border-slate-100 dark:border-white/[0.05] last:border-none text-xs">
          <span className="text-slate-500 dark:text-slate-400 flex-shrink-0 whitespace-nowrap">{k}</span>
          <span className="font-mono font-medium text-slate-900 dark:text-white text-right break-words min-w-0">{v}</span>
        </div>
      ))}
    </div>
  );
}

// ─── VolumesCard ──────────────────────────────────────────────────────────────
// Every volume the agent reported; the disk gauge above only shows the root volume.
function VolumesCard({ volumes }: { volumes: Volume[] }) {
  return (
    <div className="bg-white dark:bg-[#111217] border border-slate-200 dark:border-white/[0.07] rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[13px] font-medium text-slate-500 dark:text-slate-400">Volumes</span>
        {volumes.length > 0 && <span className="text-[12px] text-slate-400">{volumes.length}</span>}
      </div>

      {volumes.length === 0 ? (
        <div className="text-xs text-slate-400 py-5 text-center">
          No volume data yet — arrives with the next agent report.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {volumes.map((v) => {
            const pct = Math.min(Math.max(v.percent, 0), 100);
            return (
              <div key={v.mount}>
                <div className="flex items-baseline justify-between gap-3 mb-1">
                  <span className="text-xs font-mono text-slate-700 dark:text-slate-200 truncate" title={v.mount}>
                    {v.mount}
                    {v.fstype && <span className="ml-1.5 text-[12px] text-slate-400">{v.fstype}</span>}
                  </span>
                  <span className="text-[13px] font-mono flex-shrink-0" style={{ color: barColor(pct) }}>
                    {v.used_gb} / {v.total_gb} GB · {Math.round(pct)}%
                  </span>
                </div>
                <div className="h-1.5 rounded-full overflow-hidden bg-slate-200 dark:bg-white/[0.08]">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${pct}%`, background: barColor(pct) }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
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
        <span className="text-[13px] font-medium text-slate-500 dark:text-slate-400">{title}</span>
        <div className="flex gap-3">
          {legend.map(l => (
            <span key={l.label} className="flex items-center gap-1 text-[12px] text-slate-500 dark:text-slate-400">
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

  const [range, setRange]     = useState<RangeValue>(DEFAULT_RANGE);
  const [rangeError, setRangeError] = useState("");
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [logs, setLogs]       = useState<DeviceLog[]>([]);
  const [openAlerts, setOpenAlerts] = useState<OpenAlert[] | null>(null);

  const memUsedGB  = +((s.memory  / 100) * s.memoryTotalGB).toFixed(1);
  const diskUsedGB = Math.round((s.diskUsed / 100) * s.diskTotalGB);
  const diskFreeGB = s.diskTotalGB - diskUsedGB;

  // Real history from InfluxDB for this server + range, then keep it live by
  // appending each incoming serverMetrics point for this server.
  useEffect(() => {
    let alive = true;
    const custom = range.kind === "custom" ? { start: range.start, stop: range.stop } : undefined;
    api.getServerHistory(Number(s.id), range.kind === "preset" ? range.preset : "", custom).then((r) => {
      if (!alive) return;
      if (!r.success || !r.data) { setRangeError(r.error || "Could not load history."); return; }
      setRangeError("");
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

  // Open alerts for this server — re-read whenever one is raised (notification) or
  // changes state (alertUpdated: acknowledged, resolved, auto-resolved) for this device.
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.getDeviceOpenAlerts(Number(s.id)).then((r) => {
        if (alive && r.success && r.data) setOpenAlerts(r.data.alerts ?? []);
      });
    load();
    const onChange = (a: any) => {
      if (String(a?.deviceId) === s.id) load();
    };
    socket.on("alertUpdated", onChange);
    socket.on("notification", onChange);
    return () => {
      alive = false;
      socket.off("alertUpdated", onChange);
      socket.off("notification", onChange);
    };
  }, [s.id]);

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

  const spanSec  = rangeSpanSec(range);
  const times    = history.map((p) => Date.parse(p.time));

  // Throughput between two cumulative counters. Across a gap, the difference is the
  // average over the whole outage, plotted as one point when service returns, which looks
  // like a spike. So the first sample after a gap is dropped. `gapPoints` uses the same
  // rule as the line breaks.
  const gapPoints = gapIndices(times);
  const rateAt = (i: number, field: "netRecv" | "netSent") => {
    if (gapPoints.has(i)) return null; // spans an outage — not a rate for this instant
    const p = history[i]!;
    const prev = history[i - 1];
    return prev ? rateMBs(p[field], prev[field], p.time, prev.time) : 0;
  };
  const rawNetIn  = history.map((_, i) => rateAt(i, "netRecv"));
  const rawNetOut = history.map((_, i) => rateAt(i, "netSent"));

  // Break every series where the agent stopped reporting. `?? null`, not `?? 0`: a
  // missing reading is not 0% CPU.
  const gapped = withGaps(
    times,
    history.map((p) => fmtTime(p.time, spanSec)),
    [
      history.map((p) => p.cpu ?? null),
      history.map((p) => p.mem ?? null),
      history.map((p) => p.disk ?? null),
      rawNetIn,
      rawNetOut,
    ],
  );
  const labels   = gapped.labels;
  const cpuData  = gapped.series[0]!;
  const memData  = gapped.series[1]!;
  const diskData = gapped.series[2]!;
  const netIn    = gapped.series[3]!;
  const netOut   = gapped.series[4]!;
  // The headline figure and sparkline use the original arrays, since a gapped series can
  // end on a null.
  const netTotal = rawNetIn.map((v, i) => +((v ?? 0) + (rawNetOut[i] ?? 0)).toFixed(2));
  const lastNet  = netTotal.at(-1) ?? 0;
  const diskSpark = history.map((p) => p.disk ?? 0);

  const isLight = theme === "light";
  const AX = isLight ? "rgba(71,85,105,0.85)" : "rgba(160,170,190,0.5)";
  const GRID = isLight ? "rgba(15,23,42,0.08)" : "rgba(255,255,255,0.04)";

  // `null` is meaningful here, not missing: Chart.js breaks the line at a null, which is
  // how an outage is drawn as a hole rather than as a straight segment across it.
  const lineChartOpts = (color: string, data: (number | null)[]) => ({
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
      {/* Light base border with a dark override, like the rest of the page. */}
      <div className="flex items-center gap-3 pb-3 border-b border-slate-200 dark:border-white/[0.07]">
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
        <span className="hidden sm:block truncate max-w-[45%] text-[12px] font-mono text-slate-500 dark:text-slate-400">{s.ip} · {s.region} · {s.role}</span>
        {/* Light values as the base, dark as `dark:` overrides, like the rest of this page. */}
        <span className={`text-xs font-medium px-2.5 py-1 rounded-sm border ${
          s.status === "Online"
            ? "bg-green-100 text-green-700 border-green-300 dark:bg-green-900/40 dark:text-green-400 dark:border-green-700/40"
            : s.status === "Maintenance"
              ? "bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900/40 dark:text-blue-400 dark:border-blue-700/40"
              : "bg-red-100 text-red-700 border-red-300 dark:bg-red-900/40 dark:text-red-400 dark:border-red-700/40"
        }`}>
          {s.status}
        </span>
      </div>

      {/* Server name */}
      <div className="flex items-center gap-3">
        <div className="w-1 h-5 rounded-full" style={{ background: barColor(s.cpu) }} />
        <div className="min-w-0">
          <div className="text-base font-semibold text-slate-900 dark:text-white font-mono truncate">{s.name}</div>
          {/* Real hostname, shown only when an admin display label is masking it. */}
          {s.displayName && s.hostname && s.hostname !== s.name && (
            <div className="text-[12px] text-slate-500 font-mono mt-0.5 truncate">host: {s.hostname}</div>
          )}
          <div className="text-[12px] text-slate-500 font-mono mt-0.5 truncate">{s.os} · {s.kernel} · {s.cores} cores</div>
        </div>
        <div className="ml-auto flex items-center gap-1.5 flex-shrink-0">
          <span className="text-[12px] text-slate-500 font-mono">uptime</span>
          <span className="text-[13px] font-mono font-medium text-green-400">{s.uptime}</span>
        </div>
      </div>

      <ActiveAlerts alerts={openAlerts} />

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
          data={diskSpark.length ? diskSpark : [0]}
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

      {/* Range selector wraps on a phone: the label goes above and the buttons stay on one line. */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[13px] font-medium text-slate-500 dark:text-slate-400">
          Performance {history.length === 0 ? "· no data for this range" : range.kind === "preset" ? `· last ${presetLabel[range.preset]}` : "· custom range"}
        </span>
        <RangePicker value={range} onChange={setRange} error={rangeError || undefined} />
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

      {/* Volumes — every fixed disk, not just the root one the gauge shows */}
      <VolumesCard volumes={s.volumes ?? []} />

      {/* Info rows */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <InfoCard title="System info" rows={[
          ["OS",        s.os],
          ["Kernel",    s.kernel],
          ["Cores",     String(s.cores)],
          ["Arch",      s.arch],
          ["Memory",    `${s.memoryTotalGB} GB`],
          ["Disk",      `${s.diskTotalGB} GB`],
          ["Processes", s.processCount != null ? String(s.processCount) : "—"],
        ]} />
        <InfoCard title="Network info" rows={[
          ["IP address", s.ip],
          ["Gateway",    s.gateway],
          ["DNS",        s.dns],
          ["Region",     s.region],
        ]} />
        {/* Agent health — until now you couldn't tell from the dashboard which
            agents were outdated or when one last checked in. */}
        <InfoCard title="Monitoring agent" rows={[
          ["Version",    s.agentVersion || "—"],
          ["Last report", s.lastSeen ? fmtDateTime(s.lastSeen) : "—"],
          ["Interval",   s.metricIntervalSec ? `${s.metricIntervalSec}s` : "—"],
        ]} />
      </div>

      {/* Recent events (device_logs) */}
      <div className="bg-white dark:bg-[#111217] border border-slate-200 dark:border-white/[0.07] rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[13px] font-medium text-slate-500 dark:text-slate-400">Recent events</span>
          {logs.length > 0 && <span className="text-[12px] text-slate-400">{logs.length}</span>}
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
                  <div className="text-[12px] text-slate-400 mt-0.5">{fmtDateTime(l.recorded_at)}</div>
                </div>
                <span
                  className="text-[11px] uppercase font-semibold tracking-wider flex-shrink-0 mt-0.5"
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
