import { useState, useEffect, useRef, useCallback } from "react";
import type { ChartOptions, ChartData, ScriptableContext } from "chart.js";
import { Chart, registerables } from "chart.js";
import "../chart/ChartConfig";
import { Line } from "react-chartjs-2";
import StatusBadge from "../components/ui/StatusBadge";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import { useNotifications } from "../context/NotificationContext";
import { relativeTime } from "../components/notifications/notificationUtils";

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

// ─── Grafana design tokens ──────────────────────────────────────────────────────

const gf = {
  bg:          "var(--gf-bg)",
  panel:       "var(--gf-panel)",
  border:      "var(--gf-panel-border)",
  divider:     "var(--gf-divider)",
  header:      "var(--gf-header)",
  textPrimary: "var(--gf-text-primary)",
  textMuted:   "var(--gf-text-muted)",
  textDim:     "var(--gf-text-dim)",
  accent:      "#5794F2",
  hover:       "var(--gf-hover)",
} as const;

const GREEN = "#73BF69";
const ORANGE = "#FF780A";
const RED = "#F2495C";
const BLUE = "#5794F2";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadColor(v: number) {
  if (v >= 85) return RED;
  if (v >= 65) return ORANGE;
  return GREEN;
}

// Maps room temperature to the CLAUDE.md IR comfort zones.
function tempColor(t: number) {
  if (t < 22) return BLUE; // TOO_COLD
  if (t <= 27) return GREEN; // NORMAL / ACCEPTABLE
  if (t <= 29) return ORANGE; // NEAR_CRIT
  return RED; // CRITICAL
}

function humColor(h: number) {
  if (h < 30 || h > 70) return ORANGE;
  return GREEN;
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

// Light moving-average so the live raw readings render as a smooth, flowing curve
// (matching the aggregated Server Detail charts). Window of 5 ≈ ~15s of samples.
function smooth(data: number[], window = 5): number[] {
  if (data.length <= 2) return data;
  return data.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = data.slice(start, i + 1);
    return +(slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(2);
  });
}

// ─── Panel (Grafana panel chrome) ───────────────────────────────────────────────

function Panel({
  title,
  right,
  children,
  className = "",
  bodyStyle,
  noPad,
}: {
  title?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyStyle?: React.CSSProperties;
  noPad?: boolean;
}) {
  return (
    <div
      className={`flex flex-col rounded-[2px] ${className}`}
      style={{ background: gf.panel, border: `1px solid ${gf.border}` }}
    >
      {title !== undefined && (
        <div
          className="flex items-center justify-between px-3 shrink-0"
          style={{ height: 32, borderBottom: `1px solid ${gf.divider}` }}
        >
          <span
            className="text-[11px] font-medium tracking-wide truncate"
            style={{ color: gf.textPrimary, opacity: 0.85 }}
          >
            {title}
          </span>
          {right && <div className="flex items-center gap-2">{right}</div>}
        </div>
      )}
      <div
        className="flex-1 min-h-0"
        style={{ padding: noPad ? 0 : 12, ...bodyStyle }}
      >
        {children}
      </div>
    </div>
  );
}

// ─── Sparkline (area, for stat panels) ──────────────────────────────────────────

function Sparkline({
  data,
  color,
  height = 42,
}: {
  data: number[];
  color: string;
  height?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const W = (c.width = 280);
    const H = (c.height = height);
    ctx.clearRect(0, 0, W, H);
    const pts = data.slice(-48);
    if (pts.length < 2) return;

    const min = Math.min(...pts);
    const max = Math.max(...pts);
    const span = max - min || 1;
    const x = (i: number) => (i / (pts.length - 1)) * W;
    const y = (v: number) => H - 4 - ((v - min) / span) * (H - 10);

    // area fill
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, color + "44");
    grad.addColorStop(1, color + "00");
    ctx.beginPath();
    ctx.moveTo(0, H);
    pts.forEach((v, i) => ctx.lineTo(x(i), y(v)));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // line
    ctx.beginPath();
    pts.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.stroke();
  }, [data, color, height]);

  return (
    <canvas
      ref={ref}
      style={{ width: "100%", height, display: "block" }}
    />
  );
}

// ─── StatPanel (Grafana stat with sparkline background) ─────────────────────────

function StatPanel({
  label,
  value,
  unit,
  color,
  sub,
  spark,
}: {
  label: string;
  value: string;
  unit?: string;
  color: string;
  sub?: string;
  spark?: number[];
}) {
  return (
    <div
      className="relative overflow-hidden rounded-[2px] flex flex-col"
      style={{ background: gf.panel, border: `1px solid ${gf.border}`, minHeight: 104 }}
    >
      <div className="flex items-center justify-between px-3 pt-2.5 z-10">
        <span
          className="text-[10px] tracking-widest uppercase"
          style={{ color: gf.textMuted }}
        >
          {label}
        </span>
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: color, boxShadow: `0 0 6px ${color}` }}
        />
      </div>
      <div className="px-3 pt-1.5 z-10">
        <span
          className="text-[30px] font-bold leading-none"
          style={{ color }}
        >
          {value}
        </span>
        {unit && (
          <span className="text-[13px] ml-1" style={{ color: color + "AA" }}>
            {unit}
          </span>
        )}
        {sub && (
          <div className="text-[9px] mt-1 tracking-widest" style={{ color: gf.textDim }}>
            {sub}
          </div>
        )}
      </div>
      {spark && spark.length > 1 && (
        <div className="absolute inset-x-0 bottom-0 opacity-70 pointer-events-none">
          <Sparkline data={spark} color={color} height={38} />
        </div>
      )}
    </div>
  );
}

// ─── RadialGauge ────────────────────────────────────────────────────────────────

function GaugeCanvas({
  value,
  label,
  pct,
  color,
  size = 120,
  isDark,
}: {
  value: string | number;
  label: string;
  pct: number;
  color: string;
  size?: number;
  isDark: boolean;
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
    ctx.strokeStyle = isDark ? "rgba(128,128,128,0.15)" : "rgba(0,0,0,0.10)";
    ctx.lineWidth = size * 0.07;
    ctx.lineCap = "round";
    ctx.stroke();

    let prev = s;
    for (const [end, col] of [
      [0.65, "rgba(115,191,105,0.16)"],
      [0.85, "rgba(255,120,10,0.16)"],
      [1.0, "rgba(242,73,92,0.16)"],
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
    ctx.font = `bold ${Math.round(size * 0.18)}px 'JetBrains Mono', monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(value), cx, cy - r * 0.08);

    ctx.fillStyle = isDark ? "rgba(148,163,184,0.55)" : "rgba(71,85,105,0.8)";
    ctx.font = `${Math.round(size * 0.1)}px 'JetBrains Mono', monospace`;
    ctx.fillText(label, cx, cy + r * 0.35);
  }, [pct, color, value, label, size, isDark]);

  return (
    <canvas
      ref={ref}
      width={size}
      height={size * 0.92}
      style={{ width: "100%", maxWidth: size, height: "auto" }}
    />
  );
}

// ─── BarGauge (Grafana gradient horizontal bar) ─────────────────────────────────

function BarGauge({
  label,
  value,
  status,
}: {
  label: string;
  value: number;
  status?: string;
}) {
  const v = Math.min(Math.max(value, 0), 100);
  return (
    <div className="flex items-center gap-3 px-3 py-1.5">
      <div className="flex items-center gap-2 w-28 shrink-0">
        {status && (
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{
              background: status === "Online" ? GREEN : RED,
              boxShadow: `0 0 5px ${status === "Online" ? GREEN : RED}`,
            }}
          />
        )}
        <span
          className="text-[11px] truncate"
          style={{ color: gf.textPrimary }}
        >
          {label}
        </span>
      </div>
      <div
        className="flex-1 h-3.5 rounded-[2px] overflow-hidden"
        style={{ background: "var(--gf-seg-empty)" }}
      >
        <div
          className="h-full rounded-[2px] transition-all duration-500"
          style={{
            width: `${v}%`,
            // Absolute 0–100 gradient revealed up to the value (Grafana "gradient" mode).
            background:
              "linear-gradient(90deg, #73BF69 0%, #73BF69 55%, #FF780A 78%, #F2495C 95%)",
            backgroundSize: `${v > 0 ? (100 / v) * 100 : 100}% 100%`,
          }}
        />
      </div>
      <span
        className="text-[11px] font-bold w-10 text-right shrink-0"
        style={{ color: loadColor(v) }}
      >
        {v}%
      </span>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [servers, setServers] = useState<Server[]>([]);
  // Real notification feed (replaces the old mock /api/alerts panel).
  const { items: notifications, unreadCount } = useNotifications();
  const [aircons, setAircons] = useState<Aircon[]>([]);
  // Routers + UPS (SNMP poller). The Dashboard summarised servers, environment and
  // aircon but not these two, so a router or UPS incident was invisible on the page
  // people actually leave open. Only the counts are needed here — the Network / UPS
  // pages own the detail.
  const [netDevices, setNetDevices] = useState<{ id: number | string; status: string }[]>([]);
  const [upsDevices, setUpsDevices] = useState<
    { id: number | string; status: string; batteryChargePct: number | null; onBattery: boolean | null }[]
  >([]);
  const [liveTemp, setLiveTemp] = useState<number | string>("--");
  const [liveHum, setLiveHum] = useState<number | string>("--");
  const [chartTemps, setChartTemps] = useState<number[]>([]);
  const [chartHums, setChartHums] = useState<number[]>([]);
  const [chartLabels, setChartLabels] = useState<string[]>([]);
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );
  const [paused, setPaused] = useState(false);
  const [clock, setClock] = useState(() => new Date());
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartRef = useRef<any>(null);
  const resetZoom = useCallback(() => {
    chartRef.current?.resetZoom?.();
  }, []);

  // Live toolbar clock
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
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

  // Routers + UPS: initial load, then keep the counts live off the poller's
  // broadcasts (same events the Network/UPS pages use, ~60s cadence).
  useEffect(() => {
    api.getNetworkDevices().then((r) => {
      if (r.success && r.data) setNetDevices(r.data.devices ?? []);
    });
    api.getUpsDevices().then((r) => {
      if (r.success && r.data) setUpsDevices(r.data.devices ?? []);
    });

    const upsertBy = <T extends { id: number | string }>(list: T[], row: T): T[] => {
      const i = list.findIndex((x) => String(x.id) === String(row.id));
      if (i === -1) return [...list, row];
      const next = [...list];
      next[i] = { ...next[i], ...row };
      return next;
    };
    const onNet = (d: any) => d?.device && setNetDevices((p) => upsertBy(p, d.device));
    const onUps = (d: any) => d?.ups && setUpsDevices((p) => upsertBy(p, d.ups));
    const onNetStatus = (d: any) =>
      setNetDevices((p) => p.map((x) => (String(x.id) === String(d?.id) ? { ...x, status: d.status } : x)));
    const onUpsStatus = (d: any) =>
      setUpsDevices((p) => p.map((x) => (String(x.id) === String(d?.id) ? { ...x, status: d.status } : x)));
    const onNetRemoved = (d: any) => setNetDevices((p) => p.filter((x) => String(x.id) !== String(d?.id)));
    const onUpsRemoved = (d: any) => setUpsDevices((p) => p.filter((x) => String(x.id) !== String(d?.id)));

    socket.on("networkMetrics", onNet);
    socket.on("upsMetrics", onUps);
    socket.on("networkStatus", onNetStatus);
    socket.on("upsStatus", onUpsStatus);
    socket.on("networkRemoved", onNetRemoved);
    socket.on("upsRemoved", onUpsRemoved);
    return () => {
      socket.off("networkMetrics", onNet);
      socket.off("upsMetrics", onUps);
      socket.off("networkStatus", onNetStatus);
      socket.off("upsStatus", onUpsStatus);
      socket.off("networkRemoved", onNetRemoved);
      socket.off("upsRemoved", onUpsRemoved);
    };
  }, []);

  useEffect(() => {
    api.getServers().then((result) => {
      if (result.success && result.data) setServers(result.data.servers ?? []);
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
      if (pausedRef.current) return;
      setLiveTemp(data.temperature);
      setLiveHum(data.humidity);
      setLastUpdate(new Date());
      const time = new Date(data.timestamp).toLocaleTimeString("en-PH", {
        timeZone: "Asia/Manila",
        hour: "2-digit",
        minute: "2-digit",
      });
      setChartLabels((p) => [...p.slice(-300), time]);
      setChartTemps((p) => [...p.slice(-300), data.temperature]);
      setChartHums((p) => [...p.slice(-300), data.humidity]);
    };

    // serverMetrics now arrives as a single-server update: { server: {...} }.
    // Merge it into the list by id (don't overwrite the whole array).
    const handleMetrics = (data: { server?: any }) => {
      if (pausedRef.current) return;
      const sv = data?.server;
      if (!sv) return;
      const incoming: Server = {
        id: Number(sv.id),
        name: sv.name ?? "—",
        status: sv.status ?? "Online",
        cpu: Math.round(sv.cpuPercent ?? 0),
        memory: Math.round(sv.memPercent ?? 0),
        uptime: sv.uptimeLabel ?? "—",
      };
      setServers((prev) => {
        const idx = prev.findIndex((s) => s.id === incoming.id);
        if (idx === -1) return [...prev, incoming];
        const next = [...prev];
        next[idx] = { ...next[idx], ...incoming };
        return next;
      });
    };

    const handleAircon = (data: { aircon: Aircon }) => {
      setAircons((prev) =>
        prev.some((a) => a.id === data.aircon.id)
          ? prev.map((a) =>
              a.id === data.aircon.id ? { ...a, ...data.aircon } : a,
            )
          : [...prev, data.aircon],
      );
    };

    const handleRemoved = (data: { id: number }) => {
      setServers((prev) => prev.filter((s) => s.id !== Number(data?.id)));
    };

    // Live status flip from the backend offline sweep. A stopped agent sends no
    // metrics, so this is the only event that can turn a server Offline here.
    const handleStatus = (data: { id: number | string; status: string }) => {
      setServers((prev) =>
        prev.map((s) =>
          s.id === Number(data?.id)
            ? data.status === "Offline"
              ? { ...s, status: "Offline", cpu: 0, memory: 0, uptime: "—" }
              : { ...s, status: data.status }
            : s,
        ),
      );
    };

    socket.on("sensorData", handleSensor);
    socket.on("serverMetrics", handleMetrics);
    socket.on("airconStatus", handleAircon);
    socket.on("serverRemoved", handleRemoved);
    socket.on("serverStatus", handleStatus);

    return () => {
      socket.off("sensorData", handleSensor);
      socket.off("serverMetrics", handleMetrics);
      socket.off("airconStatus", handleAircon);
      socket.off("serverRemoved", handleRemoved);
      socket.off("serverStatus", handleStatus);
    };
  }, []);

  const cpuAvg = servers.length
    ? Math.round(servers.reduce((a, s) => a + s.cpu, 0) / servers.length)
    : 0;
  const memAvg = servers.length
    ? Math.round(servers.reduce((a, s) => a + s.memory, 0) / servers.length)
    : 0;
  const online = servers.filter((s) => s.status === "Online").length;
  const acOnline = aircons.filter((a) => a.enabled).length;
  const netOnline = netDevices.filter((d) => d.status === "Online").length;
  const upsOnline = upsDevices.filter((d) => d.status === "Online").length;
  // The UPS tile leads with the WORST unit, not an average — one UPS on battery or
  // near-flat is the whole story, and averaging would bury it behind healthy units.
  const upsOnBattery = upsDevices.filter((d) => d.onBattery === true).length;
  const upsCharges = upsDevices
    .map((d) => d.batteryChargePct)
    .filter((c): c is number => typeof c === "number");
  const worstCharge = upsCharges.length ? Math.min(...upsCharges) : null;

  const maxTempY = chartTemps.length
    ? Math.ceil(Math.max(...chartTemps)) + 3
    : 40;
  const minTempY = chartTemps.length
    ? Math.floor(Math.min(...chartTemps)) - 2
    : 15;
  const maxHumY = chartHums.length ? Math.ceil(Math.max(...chartHums)) + 3 : 100;
  const minHumY = chartHums.length ? Math.floor(Math.min(...chartHums)) - 3 : 30;
  const gridColor = isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.05)";
  const tickColor = isDark ? "rgba(140,160,200,0.4)" : "rgba(80,100,130,0.5)";

  // ── Combined temp + humidity chart ────────────────────────────────────────
  const combinedData: ChartData<"line"> = {
    labels: chartLabels,
    datasets: [
      {
        label: "Temperature",
        data: smooth(chartTemps),
        borderColor: ORANGE,
        backgroundColor: (ctx: ScriptableContext<"line">) =>
          gradientFill(ctx, "rgba(255,120,10,0.18)", "rgba(255,120,10,0.01)"),
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: ORANGE,
        fill: true,
        tension: 0.4,
        yAxisID: "yTemp",
      },
      {
        label: "Humidity",
        data: smooth(chartHums),
        borderColor: BLUE,
        backgroundColor: (ctx: ScriptableContext<"line">) =>
          gradientFill(ctx, "rgba(87,148,242,0.14)", "rgba(87,148,242,0.01)"),
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: BLUE,
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
          color: ORANGE,
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
          color: BLUE,
          font: { size: 9, family: "monospace" },
          padding: 6,
          callback: (v) => `${v}%`,
        },
        min: minHumY,
        max: maxHumY,
      },
    },
  };

  const pill =
    "flex items-center gap-1.5 h-7 px-2.5 rounded-[2px] text-[11px] transition-colors";
  const pillStyle: React.CSSProperties = {
    color: gf.textMuted,
    border: `1px solid ${gf.divider}`,
    background: gf.panel,
  };

  return (
    <div
      className="flex flex-col gap-3 p-3"
      style={{
        background: gf.bg,
        minHeight: "100%",
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      {/* ── Dashboard toolbar ── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2.5">
          <span
            className="text-[13px] font-semibold"
            style={{ color: gf.textPrimary }}
          >
            Server Room — Overview
          </span>
          <span
            className="text-[9px] px-1.5 py-0.5 rounded-[2px] tracking-widest uppercase"
            style={{ color: gf.accent, background: "rgba(87,148,242,0.12)" }}
          >
            CSPC · ICTU
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* live / pause */}
          <button
            onClick={() => setPaused((p) => !p)}
            className={pill}
            style={{
              ...pillStyle,
              color: paused ? ORANGE : GREEN,
              borderColor: paused ? "rgba(255,120,10,0.3)" : "rgba(115,191,105,0.3)",
            }}
            title={paused ? "Resume live updates" : "Pause live updates"}
          >
            {paused ? (
              <>
                <svg width="9" height="9" viewBox="0 0 12 12" fill="currentColor">
                  <path d="M3 2l7 4-7 4z" />
                </svg>
                PAUSED
              </>
            ) : (
              <>
                <span className="relative flex h-2 w-2">
                  <span
                    className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60"
                    style={{ background: GREEN }}
                  />
                  <span
                    className="relative inline-flex rounded-full h-2 w-2"
                    style={{ background: GREEN }}
                  />
                </span>
                LIVE
              </>
            )}
          </button>

        </div>
      </div>

      {/* ── Row 1: Stat panels ── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatPanel
          label="Room Temp"
          value={typeof liveTemp === "number" ? liveTemp.toFixed(1) : "--"}
          unit="°C"
          color={typeof liveTemp === "number" ? tempColor(liveTemp) : gf.textMuted}
          sub="DHT11 · LIVE"
          spark={chartTemps}
        />
        <StatPanel
          label="Humidity"
          value={typeof liveHum === "number" ? liveHum.toFixed(1) : "--"}
          unit="%"
          color={typeof liveHum === "number" ? humColor(liveHum) : gf.textMuted}
          sub="DHT11 · LIVE"
          spark={chartHums}
        />
        <StatPanel
          label="Servers Online"
          value={`${online}/${servers.length}`}
          color={online === servers.length && servers.length > 0 ? GREEN : ORANGE}
          sub={`${servers.length - online} offline`}
        />
        <StatPanel
          label="Routers Online"
          value={netDevices.length ? `${netOnline}/${netDevices.length}` : "--"}
          color={
            !netDevices.length ? gf.textMuted : netOnline === netDevices.length ? GREEN : RED
          }
          sub={netDevices.length ? `${netDevices.length - netOnline} unreachable` : "none registered"}
        />
        <StatPanel
          label="UPS Battery"
          value={worstCharge == null ? "--" : String(Math.round(worstCharge))}
          {...(worstCharge != null ? { unit: "%" } : {})}
          color={
            !upsDevices.length ? gf.textMuted
              : upsOnBattery > 0 ? RED
                : worstCharge != null && worstCharge <= 20 ? RED
                  : worstCharge != null && worstCharge <= 50 ? ORANGE
                    : GREEN
          }
          sub={
            !upsDevices.length ? "none registered"
              : upsOnBattery > 0 ? `${upsOnBattery} ON BATTERY`
                : `${upsOnline}/${upsDevices.length} online${upsCharges.length > 1 ? " · lowest" : ""}`
          }
        />
        <StatPanel
          label="Active Alerts"
          value={String(unreadCount)}
          color={unreadCount === 0 ? GREEN : unreadCount > 2 ? RED : ORANGE}
          sub={`${acOnline}/${aircons.length} AC running`}
        />
      </div>

      {/* ── Row 2: Time series + gauges ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Panel
          className="lg:col-span-2"
          title="Temperature & Humidity"
          right={
            <>
              {([
                [ORANGE, typeof liveTemp === "number" ? `${liveTemp.toFixed(1)}°C` : "--", "Temp"],
                [BLUE, typeof liveHum === "number" ? `${liveHum.toFixed(1)}%` : "--", "Hum"],
              ] as [string, string, string][]).map(([color, val, label]) => (
                <span key={label} className="flex items-center gap-1.5 text-[11px]">
                  <span
                    className="w-3 h-0.5 rounded-full"
                    style={{ background: color }}
                  />
                  <span style={{ color: gf.textMuted }}>{label}</span>
                  <span className="font-semibold" style={{ color }}>
                    {val}
                  </span>
                </span>
              ))}
              <button
                onClick={resetZoom}
                className="flex items-center gap-1 text-[10px] px-2 h-6 rounded-[2px]"
                style={{ color: gf.textMuted, border: `1px solid ${gf.divider}` }}
              >
                <svg width="10" height="10" viewBox="0 0 14 14" fill="none">
                  <path d="M12 7A5 5 0 1 1 7 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <path d="M12 2v5h-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Reset
              </button>
            </>
          }
          bodyStyle={{ height: 248, padding: "10px 12px 14px" }}
        >
          <Line ref={chartRef} data={combinedData} options={combinedOpts} />
        </Panel>

        <div className="grid grid-cols-2 gap-3">
          <Panel title="Avg CPU">
            <div className="flex items-center justify-center h-full">
              <GaugeCanvas
                value={`${cpuAvg}%`}
                label="load"
                pct={cpuAvg / 100}
                color={loadColor(cpuAvg)}
                size={120}
                isDark={isDark}
              />
            </div>
          </Panel>
          <Panel title="Avg Memory">
            <div className="flex items-center justify-center h-full">
              <GaugeCanvas
                value={`${memAvg}%`}
                label="used"
                pct={memAvg / 100}
                color={loadColor(memAvg)}
                size={120}
                isDark={isDark}
              />
            </div>
          </Panel>
        </div>
      </div>

      {/* ── Row 3: Bar gauges per host ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Panel title="Host CPU" noPad bodyStyle={{ padding: "8px 0" }}>
          {servers.length === 0 ? (
            <div className="text-[10px] text-center py-6" style={{ color: gf.textDim }}>
              No hosts
            </div>
          ) : (
            servers.map((s) => (
              <BarGauge key={s.id} label={s.name} value={s.cpu} status={s.status} />
            ))
          )}
        </Panel>
        <Panel title="Host Memory" noPad bodyStyle={{ padding: "8px 0" }}>
          {servers.length === 0 ? (
            <div className="text-[10px] text-center py-6" style={{ color: gf.textDim }}>
              No hosts
            </div>
          ) : (
            servers.map((s) => (
              <BarGauge key={s.id} label={s.name} value={s.memory} status={s.status} />
            ))
          )}
        </Panel>
      </div>

      {/* ── Row 4: Server table + alerts ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Panel
          className="lg:col-span-2"
          title="Server Metrics"
          noPad
          right={
            <span
              className="flex items-center gap-1.5 text-[10px]"
              style={{ color: gf.textMuted }}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: GREEN }} />
              {online}/{servers.length} online
            </span>
          }
        >
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr style={{ borderBottom: `1px solid ${gf.divider}` }}>
                  {["Server", "Status", "CPU", "Memory", "Uptime"].map((h) => (
                    <th
                      key={h}
                      className="text-left px-3 py-2 text-[9px] tracking-widest uppercase"
                      style={{ color: gf.textDim }}
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
                    style={{
                      background: i % 2 === 0 ? "transparent" : gf.hover,
                      borderBottom: `1px solid ${gf.divider}`,
                    }}
                  >
                    <td
                      className="px-3 py-2.5 text-[11px] font-semibold"
                      style={{ color: gf.textPrimary }}
                    >
                      {s.name}
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className="text-[11px] font-bold"
                        style={{ color: loadColor(s.cpu) }}
                      >
                        {s.cpu}%
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span
                        className="text-[11px] font-bold"
                        style={{ color: loadColor(s.memory) }}
                      >
                        {s.memory}%
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-[10px]" style={{ color: gf.textMuted }}>
                      {s.uptime}
                    </td>
                  </tr>
                ))}
                {servers.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center py-6 text-[10px]" style={{ color: gf.textDim }}>
                      No data
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel
          title="Alerts"
          noPad
          right={
            lastUpdate && (
              <span className="text-[9px]" style={{ color: gf.textDim }}>
                upd {lastUpdate.toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour12: false })}
              </span>
            )
          }
        >
          <div className="flex flex-col gap-1.5 p-3 overflow-y-auto" style={{ maxHeight: 300 }}>
            {notifications.map((a) => {
              const c = a.severity === "critical" ? RED : a.severity === "warning" ? ORANGE : BLUE;
              return (
                <div
                  key={a.id}
                  className="flex items-start gap-2.5 px-2.5 py-2 rounded-[2px]"
                  style={{
                    background: `${c}12`,
                    borderLeft: `2px solid ${c}`,
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-semibold" style={{ color: gf.textPrimary }}>
                      {a.title}
                    </div>
                    <div className="text-[9px] mt-0.5" style={{ color: gf.textMuted }}>
                      {a.message}
                    </div>
                  </div>
                  <span className="text-[9px] shrink-0" style={{ color: gf.textDim }}>
                    {relativeTime(a.sentAt || a.createdAt)}
                  </span>
                </div>
              );
            })}
            {notifications.length === 0 && (
              <div className="flex flex-col items-center gap-1 py-8">
                <span style={{ color: GREEN }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <div className="text-[10px]" style={{ color: gf.textDim }}>
                  No active alerts
                </div>
              </div>
            )}
          </div>
        </Panel>
      </div>

      {/* ── Row 5: Air conditioner units ── */}
      <Panel title="Air Conditioner Units" noPad bodyStyle={{ padding: 12 }}>
        {aircons.length === 0 ? (
          <div className="text-[10px] text-center py-4" style={{ color: gf.textDim }}>
            No AC units registered
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {aircons.map((ac) => (
              <div
                key={ac.id}
                className="flex flex-col rounded-[2px]"
                style={{ background: gf.bg, border: `1px solid ${gf.border}` }}
              >
                <div
                  className="flex items-center justify-between px-3 py-2"
                  style={{ borderBottom: `1px solid ${gf.divider}` }}
                >
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-1.5 w-1.5">
                      {ac.enabled && (
                        <span
                          className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60"
                          style={{ background: GREEN }}
                        />
                      )}
                      <span
                        className="relative inline-flex rounded-full h-1.5 w-1.5"
                        style={{ background: ac.enabled ? GREEN : gf.textMuted }}
                      />
                    </span>
                    <span className="text-[11px] font-semibold" style={{ color: gf.textPrimary }}>
                      {ac.name}
                    </span>
                  </div>
                  <span
                    className="text-[9px] font-bold px-2 py-0.5 rounded-[2px] tracking-widest"
                    style={{
                      color: ac.enabled ? GREEN : gf.textMuted,
                      background: ac.enabled ? "rgba(115,191,105,0.12)" : gf.hover,
                    }}
                  >
                    {ac.enabled ? "ONLINE" : "OFFLINE"}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-px" style={{ background: gf.divider }}>
                  {[
                    ["Mode", ac.mode],
                    ["Set", `${ac.setTemp}°`],
                    ["Room", ac.roomTemp != null ? `${ac.roomTemp}°` : "--"],
                  ].map(([lbl, val]) => (
                    <div
                      key={lbl}
                      className="flex flex-col px-2 py-2 gap-0.5"
                      style={{ background: gf.panel }}
                    >
                      <span className="text-[8px] tracking-widest uppercase" style={{ color: gf.textDim }}>
                        {lbl}
                      </span>
                      <span className="text-[11px] font-bold" style={{ color: gf.textPrimary }}>
                        {val}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
