import { useState, useEffect, useRef, useCallback } from "react";
import type { ChartOptions, ChartData, ScriptableContext } from "chart.js";
import { Chart, registerables } from "chart.js";
import "../chart/ChartConfig";
import { Line } from "react-chartjs-2";
import StatusBadge from "../components/ui/StatusBadge";
import { api } from "../api/api";
import { socket } from "../socket/socket";

Chart.register(...registerables);

// ─── Types ────────────────────────────────────────────────────────────────────

interface Server {
  id: number;
  name: string;
  status: string;
  cpu: number;
  memory: number;
  uptime: string;
}

interface Alert {
  id: number;
  type: string;
  title: string;
  desc: string;
  time: string;
}

interface SensorData {
  temperature: number;
  humidity: number;
  timestamp: string;
}

interface Aircon {
  id: number;
  name: string;
  enabled: boolean;
  mode: string;
  fanMode: string;
  setTemp: number;
  roomTemp: number;
  humidity: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function barColor(v: number) {
  if (v > 70) return "#E24B4A";
  if (v > 50) return "#EF9F27";
  return "#73BF69";
}

function tempColor(t: number) {
  if (t >= 28) return "#E24B4A";
  if (t >= 25) return "#EF9F27";
  return "#73BF69";
}

function gradientFill(
  ctx: ScriptableContext<"line">,
  colorTop: string,
  colorBot: string,
): CanvasGradient | string {
  const canvas = ctx.chart.canvas as HTMLCanvasElement | null;
  if (!canvas) return colorTop;
  const context = canvas.getContext("2d");
  if (!context) return colorTop;
  const g = context.createLinearGradient(0, 0, 0, 180);
  g.addColorStop(0, colorTop);
  g.addColorStop(1, colorBot);
  return g;
}

// ─── GaugeCanvas ──────────────────────────────────────────────────────────────

function GaugeCanvas({
  value,
  label,
  pct,
  color,
  size = 110,
}: {
  value: string | number;
  label: string;
  pct: number;
  color: string;
  size?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const cx = size / 2,
      cy = size * 0.65,
      r = size * 0.36;
    const s = Math.PI * 0.8,
      e = Math.PI * 2.2;
    const f = s + (e - s) * Math.min(Math.max(pct, 0), 1);
    const sw = e - s;

    ctx.clearRect(0, 0, size, size);

    ctx.beginPath();
    ctx.arc(cx, cy, r, s, e);
    ctx.strokeStyle = "rgba(128,128,128,0.15)";
    ctx.lineWidth = size * 0.07;
    ctx.lineCap = "round";
    ctx.stroke();

    let prev = s;
    for (const [end, col] of [
      [0.5, "rgba(115,191,105,0.15)"],
      [0.75, "rgba(239,159,39,0.15)"],
      [1.0, "rgba(226,75,74,0.15)"],
    ] as [number, string][]) {
      const be = s + sw * end;
      ctx.beginPath();
      ctx.arc(cx, cy, r, prev, be);
      ctx.strokeStyle = col;
      ctx.lineWidth = size * 0.07;
      ctx.lineCap = "butt";
      ctx.stroke();
      prev = be;
    }

    if (pct > 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, s, f);
      ctx.strokeStyle = color;
      ctx.lineWidth = size * 0.07;
      ctx.lineCap = "round";
      ctx.stroke();
    }

    ctx.fillStyle = color;
    ctx.font = `bold ${Math.round(size * 0.18)}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(value), cx, cy - r * 0.08);

    ctx.fillStyle = "rgba(148,163,184,0.55)";
    ctx.font = `${Math.round(size * 0.1)}px monospace`;
    ctx.fillText(label, cx, cy + r * 0.35);
  }, [pct, color, value, label, size]);

  return (
    <canvas
      ref={ref}
      width={size}
      height={size * 0.78}
      style={{ width: "100%", maxWidth: size, height: "auto" }}
    />
  );
}

// ─── StatPanel ────────────────────────────────────────────────────────────────

function StatPanel({
  title,
  value,
  sub,
  color,
  accent,
}: {
  title: string;
  value: string | number;
  sub?: string;
  color?: string;
  accent: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl bg-slate-100 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08] p-4 flex flex-col gap-1">
      <div className={`absolute top-0 left-0 right-0 h-0.5 ${accent}`} />
      <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 tracking-widest uppercase">
        {title}
      </div>
      <div
        className="text-[28px] font-bold font-mono leading-none"
        style={{ color: color ?? undefined }}
      >
        {value}
      </div>
      {sub && (
        <div className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
          {sub}
        </div>
      )}
    </div>
  );
}

// ─── GaugeStatPanel ───────────────────────────────────────────────────────────

function GaugeStatPanel({
  title,
  value,
  pct,
  color,
  accent,
  sub,
}: {
  title: string;
  value: string | number;
  pct: number;
  color: string;
  accent: string;
  sub?: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl bg-slate-100 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08] px-3 pt-3 pb-2 flex flex-col">
      <div className={`absolute top-0 left-0 right-0 h-0.5 ${accent}`} />
      <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 tracking-widest uppercase mb-1">
        {title}
      </div>
      <div className="flex-1 flex items-center justify-center">
        <GaugeCanvas
          value={value}
          label={sub ?? ""}
          pct={pct}
          color={color}
          size={100}
        />
      </div>
    </div>
  );
}

// ─── MiniBar ──────────────────────────────────────────────────────────────────

function MiniBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="w-12 sm:w-16 h-1.5 bg-slate-200 dark:bg-white/10 rounded-full overflow-hidden">
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${value}%`, background: color }}
      />
    </div>
  );
}

// ─── LiveDot ──────────────────────────────────────────────────────────────────

function LiveDot() {
  return (
    <span className="flex items-center gap-1.5">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
      </span>
      <span className="text-[9px] font-mono text-green-400/70 tracking-widest">
        LIVE
      </span>
    </span>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [servers, setServers] = useState<Server[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [aircons, setAircons] = useState<Aircon[]>([]);
  const [liveTemp, setLiveTemp] = useState<number | string>("--");
  const [liveHum, setLiveHum] = useState<number | string>("--");
  const [chartTemps, setChartTemps] = useState<number[]>([]);
  const [chartHums, setChartHums] = useState<number[]>([]);
  const [chartLabels, setChartLabels] = useState<string[]>([]);
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartRef = useRef<any>(null);
  const resetZoom = useCallback(() => {
    chartRef.current?.resetZoom?.();
  }, []);

  // Track dark mode
  useEffect(() => {
    const obs = new MutationObserver(() =>
      setIsDark(document.documentElement.classList.contains("dark")),
    );
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    api.getServers().then((result) => {
      if (result.success && result.data) setServers(result.data.servers);
    });

    api.getAlerts().then((result) => {
      if (result.success && result.data) setAlerts(result.data.alerts);
    });

    api.getAircon().then((result) => {
      if (result.success && result.data) {
        const units: Aircon[] = Array.isArray(result.data.aircons)
          ? result.data.aircons
          : result.data.aircon
            ? [result.data.aircon]
            : [];
        setAircons(units);
      }
    });

    const handleSensor = (data: SensorData) => {
      setLiveTemp(data.temperature);
      setLiveHum(data.humidity);
      const time = new Date(data.timestamp).toLocaleTimeString("en-PH", {
        hour: "2-digit",
        minute: "2-digit",
      });
      setChartLabels((p) => [...p.slice(-300), time]);
      setChartTemps((p) => [...p.slice(-300), data.temperature]);
      setChartHums((p) => [...p.slice(-300), data.humidity]);
    };

    const handleMetrics = (data: { servers: Server[] }) =>
      setServers(data.servers);

    const handleAircon = (data: { aircon: Aircon }) => {
      setAircons((prev) =>
        prev.some((a) => a.id === data.aircon.id)
          ? prev.map((a) =>
              a.id === data.aircon.id ? { ...a, ...data.aircon } : a,
            )
          : [...prev, data.aircon],
      );
    };

    socket.on("sensorData", handleSensor);
    socket.on("serverMetrics", handleMetrics);
    socket.on("airconStatus", handleAircon);

    return () => {
      socket.off("sensorData", handleSensor);
      socket.off("serverMetrics", handleMetrics);
      socket.off("airconStatus", handleAircon);
    };
  }, []);

  const cpuAvg = servers.length
    ? Math.round(servers.reduce((a, s) => a + s.cpu, 0) / servers.length)
    : 0;
  const memAvg = servers.length
    ? Math.round(servers.reduce((a, s) => a + s.memory, 0) / servers.length)
    : 0;
  const online = servers.filter((s) => s.status === "Online").length;
  const maxTempY = chartTemps.length
    ? Math.ceil(Math.max(...chartTemps)) + 3
    : 40;
  const minTempY = chartTemps.length
    ? Math.floor(Math.min(...chartTemps)) - 2
    : 15;
  const maxHumY = chartHums.length
    ? Math.ceil(Math.max(...chartHums)) + 3
    : 100;
  const minHumY = chartHums.length
    ? Math.floor(Math.min(...chartHums)) - 3
    : 30;
  const gridColor = isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.05)";
  const tickColor = isDark ? "rgba(140,160,200,0.4)" : "rgba(80,100,130,0.5)";

  // ── Combined temp + humidity chart ────────────────────────────────────────
  const combinedData: ChartData<"line"> = {
    labels: chartLabels,
    datasets: [
      {
        label: "Temperature",
        data: chartTemps,
        borderColor: "#f59e0b",
        backgroundColor: (ctx: ScriptableContext<"line">) =>
          gradientFill(ctx, "rgba(245,158,11,0.18)", "rgba(245,158,11,0.01)"),
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: "#f59e0b",
        fill: true,
        tension: 0.4,
        yAxisID: "yTemp",
      },
      {
        label: "Humidity",
        data: chartHums,
        borderColor: "#38bdf8",
        backgroundColor: (ctx: ScriptableContext<"line">) =>
          gradientFill(ctx, "rgba(56,189,248,0.12)", "rgba(56,189,248,0.01)"),
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: "#38bdf8",
        fill: true,
        tension: 0.4,
        yAxisID: "yHum",
      },
    ],
  };

  const combinedOpts: ChartOptions<"line"> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: isDark
          ? "rgba(10,14,26,0.97)"
          : "rgba(255,255,255,0.97)",
        borderColor: "rgba(255,255,255,0.08)",
        borderWidth: 1,
        titleColor: isDark ? "rgba(150,170,210,0.6)" : "rgba(80,100,130,0.7)",
        bodyColor: isDark ? "#e8eef8" : "#1e293b",
        padding: 10,
        titleFont: { family: "monospace", size: 10 },
        bodyFont: { family: "monospace", size: 12 },
        callbacks: {
          label: (ctx) => {
            const y = ctx.parsed.y as number | null;
            if (y === null || y === undefined) return "";
            return ctx.datasetIndex === 0
              ? ` ${y.toFixed(1)} °C`
              : ` ${y.toFixed(1)} %`;
          },
        },
      },
      ...({
        zoom: {
          pan: { enabled: true, mode: "x" },
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            mode: "x",
          },
        },
      } as unknown as ChartOptions<"line">["plugins"]),
    },
    scales: {
      x: {
        grid: { color: gridColor, drawTicks: false },
        border: { display: false },
        ticks: {
          color: tickColor,
          font: { size: 9, family: "monospace" },
          maxTicksLimit: 6,
          maxRotation: 0,
        },
      },
      yTemp: {
        type: "linear",
        position: "left",
        grid: { color: gridColor, drawTicks: false },
        border: { display: false },
        ticks: {
          color: "#f59e0b",
          font: { size: 9, family: "monospace" },
          padding: 6,
          callback: (v) => `${v}°`,
        },
        min: minTempY,
        max: maxTempY,
      },
      yHum: {
        type: "linear",
        position: "right",
        grid: { display: false },
        border: { display: false },
        ticks: {
          color: "#38bdf8",
          font: { size: 9, family: "monospace" },
          padding: 6,
          callback: (v) => `${v}%`,
        },
        min: minHumY,
        max: maxHumY,
      },
    },
  };

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4 bg-white dark:bg-transparent">
      {/* ── KPI Row ── */}
      <div
        className="grid grid-cols-2 lg:grid-cols-4 gap-3"
        style={{ minHeight: 130 }}
      >
        <StatPanel
          title="Room Temperature"
          value={
            typeof liveTemp === "number" ? `${liveTemp.toFixed(1)} °C` : "--"
          }
          sub="DHT Sensor · Live"
          accent="bg-gradient-to-r from-amber-400 to-orange-500"
          {...(typeof liveTemp === "number"
            ? { color: tempColor(liveTemp) }
            : {})}
        />
        <StatPanel
          title="Room Humidity"
          value={typeof liveHum === "number" ? `${liveHum.toFixed(1)} %` : "--"}
          sub="DHT Sensor · Live"
          color="#38bdf8"
          accent="bg-gradient-to-r from-sky-400 to-blue-500"
        />
        <GaugeStatPanel
          title="Avg CPU Load"
          value={`${cpuAvg}%`}
          pct={cpuAvg / 100}
          color={barColor(cpuAvg)}
          accent="bg-gradient-to-r from-blue-400 to-blue-600"
          sub="across servers"
        />
        <GaugeStatPanel
          title="Avg Memory"
          value={`${memAvg}%`}
          pct={memAvg / 100}
          color={barColor(memAvg)}
          accent="bg-gradient-to-r from-yellow-400 to-yellow-600"
          sub="across servers"
        />
      </div>

      {/* ── Combined Env Chart + Aircon status ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Chart */}
        <div className="lg:col-span-2 rounded-xl bg-slate-100 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08] overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-white/[0.06]">
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1.5 text-[11px] font-mono">
                <span
                  className="w-2.5 h-2.5 rounded-sm"
                  style={{ background: "#f59e0b" }}
                />
                <span className="text-slate-600 dark:text-slate-300">
                  Temperature
                </span>
                <span className="font-semibold" style={{ color: "#f59e0b" }}>
                  {typeof liveTemp === "number"
                    ? `${liveTemp.toFixed(1)} °C`
                    : "--"}
                </span>
              </span>
              <span className="flex items-center gap-1.5 text-[11px] font-mono">
                <span
                  className="w-2.5 h-2.5 rounded-sm"
                  style={{ background: "#38bdf8" }}
                />
                <span className="text-slate-600 dark:text-slate-300">
                  Humidity
                </span>
                <span className="font-semibold" style={{ color: "#38bdf8" }}>
                  {typeof liveHum === "number"
                    ? `${liveHum.toFixed(1)} %`
                    : "--"}
                </span>
              </span>
            </div>
            <div className="flex items-center gap-3">
              <LiveDot />
              <button
                onClick={resetZoom}
                className="text-[9px] font-mono text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 border border-slate-300 dark:border-white/10 px-2 py-0.5 rounded transition-colors"
              >
                ⟳ Reset
              </button>
            </div>
          </div>
          <div className="px-3 pt-3 pb-4" style={{ height: 220 }}>
            <Line ref={chartRef} data={combinedData} options={combinedOpts} />
          </div>
        </div>

        {/* Aircon status cards */}
        <div className="flex flex-col gap-3">
          <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 px-1">
            Air Conditioner
          </div>
          {aircons.length === 0 ? (
            <div className="text-xs text-slate-400 font-mono px-1">
              Loading...
            </div>
          ) : (
            aircons.map((ac) => (
              <div
                key={ac.id}
                className="rounded-xl bg-slate-100 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08] overflow-hidden"
              >
                <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-white/[0.06]">
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-1.5 w-1.5">
                      {ac.enabled && (
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60" />
                      )}
                      <span
                        className="relative inline-flex rounded-full h-1.5 w-1.5"
                        style={{
                          background: ac.enabled ? "#4ade80" : "#6b7280",
                        }}
                      />
                    </span>
                    <span className="text-[11px] font-mono font-semibold text-slate-700 dark:text-slate-200">
                      {ac.name}
                    </span>
                  </div>
                  <span
                    className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded-sm border ${
                      ac.enabled
                        ? "bg-green-500/10 border-green-500/20 text-green-600 dark:text-green-400"
                        : "bg-slate-200 dark:bg-white/[0.04] border-slate-300 dark:border-white/[0.08] text-slate-500"
                    }`}
                  >
                    {ac.enabled ? "ONLINE" : "OFFLINE"}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-px bg-slate-200 dark:bg-white/[0.06]">
                  {[
                    { label: "State", value: ac.enabled ? "on" : "off" },
                    { label: "Mode", value: ac.mode },
                    { label: "Set Temp", value: `${ac.setTemp}°C` },
                  ].map(({ label, value }, index) => (
                    <div
                      key={`${ac.id}-${label}-${index}`}
                      className="flex flex-col bg-slate-50 dark:bg-[#0d1117] px-2 py-2 gap-0.5"
                    >
                      <span className="text-[8px] font-mono text-slate-400 dark:text-slate-500 uppercase tracking-widest">
                        {label}
                      </span>
                      <span className="text-xs font-bold font-mono text-slate-700 dark:text-slate-200">
                        {value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Servers + Alerts ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Server table */}
        <div className="lg:col-span-2 rounded-xl bg-slate-100 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08] p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-bold text-slate-900 dark:text-white">
              Server Metrics
            </div>
            <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-500 dark:text-slate-400">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
              {online}/{servers.length} online
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr>
                  {["Server", "Status", "CPU", "Memory", "Uptime"].map((h) => (
                    <th
                      key={h}
                      className="text-left px-3 py-2 text-[10px] text-slate-500 font-semibold tracking-widest border-b border-slate-200 dark:border-white/[0.07]"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {servers.map((s, i) => (
                  <tr
                    key={s.id}
                    className={
                      i % 2 === 0 ? "bg-slate-50 dark:bg-white/[0.015]" : ""
                    }
                  >
                    <td className="px-3 py-2.5 text-slate-900 dark:text-white font-semibold text-xs">
                      {s.name}
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span
                          className="font-mono font-bold text-xs"
                          style={{ color: barColor(s.cpu) }}
                        >
                          {s.cpu}%
                        </span>
                        <MiniBar value={s.cpu} color={barColor(s.cpu)} />
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span
                          className="font-mono font-bold text-xs"
                          style={{ color: barColor(s.memory) }}
                        >
                          {s.memory}%
                        </span>
                        <MiniBar value={s.memory} color={barColor(s.memory)} />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-slate-500 dark:text-slate-400 text-xs">
                      {s.uptime}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Alerts */}
        <div className="rounded-xl bg-slate-100 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08] p-4">
          <div className="text-sm font-bold text-slate-900 dark:text-white mb-3">
            Alerts
          </div>
          <div className="flex flex-col gap-2">
            {alerts.map((a) => (
              <div
                key={a.id}
                className={`flex items-start gap-2.5 p-2.5 rounded-lg border ${
                  a.type === "warning"
                    ? "bg-amber-50 dark:bg-amber-500/5 border-amber-200 dark:border-amber-500/15"
                    : "bg-blue-50 dark:bg-blue-500/5 border-blue-200 dark:border-blue-500/15"
                }`}
              >
                <span className="text-base flex-shrink-0">
                  {a.type === "warning" ? "⚠️" : "ℹ️"}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-slate-900 dark:text-white">
                    {a.title}
                  </div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400 mt-0.5">
                    {a.desc}
                  </div>
                </div>
                <div className="text-[10px] text-slate-500 font-mono flex-shrink-0">
                  {a.time}
                </div>
              </div>
            ))}
            {alerts.length === 0 && (
              <div className="text-xs text-slate-400 dark:text-slate-600 font-mono text-center py-4">
                No alerts
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
