import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { ChartOptions, ChartData, ScriptableContext } from "chart.js";
import { Chart, registerables } from "chart.js";
import "../chart/ChartConfig";
import { Line } from "react-chartjs-2";
import ServerFocus from "../components/dashboard/ServerFocus";
import NetworkFocus from "../components/dashboard/NetworkFocus";
import UpsFocus from "../components/dashboard/UpsFocus";
import RangePicker, { DEFAULT_RANGE, rangeSpanSec } from "../components/ui/RangePicker";
import { withGaps } from "../utils/seriesGaps";
import { resolveColor, alphaColor } from "../utils/canvasColor";
import type { RangeValue } from "../components/ui/RangePicker";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import { useRoomThresholds } from "../hooks/useRoomThresholds";
import {
  gasColor, gasLabel, temperatureColor, temperatureLabel, alertTint, withAlpha,
} from "../utils/envThresholds";

Chart.register(...registerables);

// ─── Types ────────────────────────────────────────────────────────────────────

interface Server {
  id: number;
  name: string;
  status: string;
  cpu: number;
  memory: number;
  // Carried for the focus panel's tiles. GET /api/servers already returns both; they
  // were simply not declared here while the table only showed CPU and memory.
  diskUsed: number;
  ip?: string;
  uptime: string;
}

interface SensorData {
  temperature: number;
  humidity: number;
  // The tile shows the HIGHER of the two MQ-2 readings, not their average. Averaging a
  // sensor beside a smoking PSU (400ppm) against one across the room (20ppm) reports 210
  // and makes a real fire look borderline — a dangerous reading anywhere in the room is
  // dangerous. Same rule sensorHandler and the analytics engine use.
  mq2_1_ppm?: number;
  mq2_2_ppm?: number;
  timestamp: string;
}

// One stored reading, as the `sensorHistory` socket reply sends it.
interface SensorHistoryRow {
  time: string;
  temperature: number | null;
  humidity: number | null;
  mq2_1_ppm: number | null;
  mq2_2_ppm: number | null;
}

// Shared by the seeded history and the live tail, so a point does not change format
// halfway along the x-axis.
const fmtClock = (t: string | Date) =>
  new Date(t).toLocaleTimeString("en-PH", {
    timeZone: "Asia/Manila",
    hour: "2-digit",
    minute: "2-digit",
  });

// Environment x-axis label. Once this chart follows the shared range it can be asked for
// 30 days, and "14:00" repeated across a month says nothing about WHEN — so anything
// past two days carries the date. Same threshold the focus charts use, so the two never
// disagree about what a long range looks like.
const MULTI_DAY_SEC = 48 * 3600;
const fmtEnvLabel = (t: string | Date, spanSec: number) =>
  spanSec >= MULTI_DAY_SEC
    ? new Date(t).toLocaleString("en-PH", {
        timeZone: "Asia/Manila", month: "short", day: "2-digit", hour: "2-digit", hour12: false,
      })
    : fmtClock(t);

// One open incident, as GET /api/alerts returns it (alertsService.toClient).
interface DashAlert {
  id: number;
  deviceName: string | null;
  type: string;
  title: string;
  severity: "info" | "warning" | "critical";
  status: "active" | "acknowledged" | "resolved";
  createdAt: string;
}

// Severity → the palette in CLAUDE.md. CRITICAL is #E02F44, NOT #F2495C (that is DANGER).
const SEV_COLOR: Record<DashAlert["severity"], string> = {
  critical: "#E02F44",
  warning: "#FF780A",
  info: "#5794F2",
};

// "just now" / "4m" / "3h" / "2d". An alert's age is most of its meaning — a critical
// from 30 seconds ago and one from last Tuesday demand very different reactions, and an
// absolute timestamp makes the reader do that subtraction themselves.
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Router / MikroTik, as returned by GET /network and pushed on `networkMetrics`.
interface NetIface {
  name: string;
  locationLabel?: string;
  linkUp?: boolean;
  utilizationPct?: number | null;
}
interface NetDevice {
  id: number | string;
  name?: string;
  type?: string;              // "router" | "mikrotik"
  status: string;
  cpuPercent?: number | null;    // MikroTik only — SNMP leaves these null
  memPercent?: number | null;
  connectedClients?: number | null;
  interfaces?: NetIface[];
  // "ping" = registered with no SNMP community (ISP-owned CPE). Passed through to
  // NetworkFocus, which draws latency/loss instead of throughput for these — a ping
  // device has no byte counters, so the traffic chart would never have a point.
  mode?: "snmp" | "ping";
  latencyMs?: number | null;
  packetLossPct?: number | null;
}

// UPS, as returned by GET /ups and pushed on `upsMetrics`.
interface UpsDevice {
  id: number | string;
  name?: string;
  status: string;
  batteryChargePct: number | null;
  runtimeRemainingMin?: number | null;
  loadPct?: number | null;
  onBattery: boolean | null;
}

interface Aircon {
  id: number;
  name: string;
  enabled: boolean;
  mode: string;
  fanMode: string;
  setTemp: number;
  // `last_trigger` from aircon_state: "manual" (a person), "auto" (the ESP32's IR zone
  // logic) or null (registered, never triggered). NOT camelCase on the wire.
  last_trigger?: string | null;
  uptime?: string;
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
// Environment series palette — deliberately the SAME hexes as pages/Environment.tsx, so a
// series means the same thing on both pages. Reading one chart should not require
// re-learning the colours on the other.
//
// ENV_TEMP is now only a FALLBACK: the temperature line, its fill, its axis and the Room
// Temp tile are all coloured by the `temperature` ALERT RULES (utils/envThresholds.ts),
// and this amber shows only until the first reading arrives.
//
// ENV_HUM is humidity's IDENTITY colour — the humidity line holds it while the room is
// within the rules and switches to orange/red when it is not (`alertTint`), because it
// shares this chart with temperature and two green lines would be unreadable. The
// humidity TILE has no such neighbour and goes full green/orange/red.
// ⚠️ ENV_HUM is a near neighbour of the TOO COLD blue (#5794F2), so on an over-cooled room
// the two lines are told apart by the legend labels rather than by hue.
const ENV_TEMP = "#F59E0B";
const ENV_HUM  = "#38BDF8";

// The gas thresholds used to be copied here as `GAS_WARN = 150` / `GAS_CRIT = 300` under a
// comment asking whoever retuned `alert_rules` to retune them too. They now come from the
// rules themselves via useRoomThresholds(), so an admin editing Alert Rules moves this
// tile with them and no one has to remember.

// ─── Helpers ──────────────────────────────────────────────────────────────────
// `loadColor`, `StatusBadge` and `BLUE` lived here for the fleet table's CPU/Memory
// cells and its selected-row highlight. The table is gone; the focus panels colour
// their own values through focusShared.loadColor.

// Body height of EVERY panel in the 2-column stack below the stat tiles — Environment,
// Active Alerts, Servers, Network, MikroTik, UPS. One number so the page reads as a
// single grid rather than as rows that each found their own height.
//
// It has to be explicit: CSS grid equalises items within a ROW, not across rows, so
// leaving it to `stretch` would let each row settle wherever its own tallest panel
// landed — which is exactly how six panels end up in four different sizes.
//
// Sized to fit a picker + status line + chart + legend without scrolling. Two panels
// carry more than that and absorb it internally rather than growing: the Servers TABLE
// scrolls (never the chart — that is what the panel is for), and the Active Alerts list
// scrolls past about six incidents.
const PANEL_H = 300;
const PANEL_BODY: React.CSSProperties = {
  height: PANEL_H,
  padding: 0,
  display: "flex",
  flexDirection: "column",
};

// Device selector for the chart panels. A dropdown rather than a clickable list: once a
// panel is "chart only" the list was spending most of the panel's height restating names
// that the chart's own header can hold in one row.
function DevicePicker({
  devices, value, onChange, label,
}: {
  devices: { id: number | string; name?: string | undefined }[];
  value: string | null;
  onChange: (id: string) => void;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="text-[10px] tracking-widest uppercase shrink-0" style={{ color: gf.textDim }}>
        {label}
      </span>
      <select name="value"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 min-w-0 text-[12px] px-2 py-1 rounded-[2px] outline-none"
        style={{
          background: gf.bg,
          border: `1px solid ${gf.border}`,
          color: gf.textPrimary,
          fontFamily: "'JetBrains Mono', monospace",
        }}
        aria-label={label}
      >
        {devices.map((d) => (
          <option key={String(d.id)} value={String(d.id)}>
            {d.name ?? `Device ${d.id}`}
          </option>
        ))}
      </select>
    </div>
  );
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
            className="text-[13px] font-medium tracking-wide truncate"
            style={{ color: gf.textPrimary, opacity: 0.85 }}
          >
            {title}
          </span>
          {right && <div className="flex items-center gap-2">{right}</div>}
        </div>
      )}
      <div
        className="min-h-0"
        style={{
          // ⚠️ A body with an explicit height must NOT also be `flex: 1 1 0%`. This div
          // used to carry Tailwind's `flex-1`, and in a COLUMN flex container flex-basis:0
          // wins over height — so `bodyStyle.height` was silently ignored and the panel
          // sized to its CONTENT instead. A chart hid it (it fills whatever it is given),
          // but the Active Alerts list has a real intrinsic height, so a run of incidents
          // grew the panel without ever scrolling. It then dragged the whole grid ROW with
          // it, because grid items stretch to the tallest in the row — which is why the
          // Environment (temp/humidity) panel beside it grew too.
          flex: bodyStyle?.height != null ? "0 0 auto" : "1 1 0%",
          padding: noPad ? 0 : 12,
          ...bodyStyle,
        }}
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

    // A tile's colour may be a CSS custom property — `var(--gf-text-muted)` is the
    // fallback whenever a metric has no reading — which canvas cannot resolve. See
    // utils/canvasColor: appending hex to it produced `var(--gf-text-muted)44`, and
    // addColorStop THREW, unmounting the page from inside this effect.
    const stroke = resolveColor(color);

    // area fill
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, alphaColor(stroke, 0.27)); // was the 0x44 suffix
    grad.addColorStop(1, alphaColor(stroke, 0));
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
    ctx.strokeStyle = stroke;
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

// ── Small helper for the Network / UPS panels ───────────────────────────────
// StatusDot and MiniStat lived here too, for the per-device rows those panels used to
// list. Both panels are now a picker plus a chart, so the rows — and the two components
// that drew them — are gone. They are in git history if a list is ever wanted back.
function EmptyRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="py-6 text-center text-[12px]" style={{ color: gf.textDim }}>
      {children}
    </div>
  );
}

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
          className="text-[12px] tracking-widest uppercase"
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
          <span className="text-[15px] ml-1" style={{ color: color + "AA" }}>
            {unit}
          </span>
        )}
        {sub && (
          <div className="text-[11px] mt-1 tracking-widest" style={{ color: gf.textDim }}>
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

// ─── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const navigate = useNavigate();
  const [servers, setServers] = useState<Server[]>([]);
  const [aircons, setAircons] = useState<Aircon[]>([]);

  // Open incidents (active OR acknowledged) — the shared lifecycle view, the same set the
  // sidebar badge counts. Until now the Dashboard showed NO alerts at all: after an
  // incident it read as six green tiles, and the only trace was a number on the sidebar
  // that could not say what had happened.
  const [openAlerts, setOpenAlerts] = useState<DashAlert[]>([]);

  // Is the ESP32 actually reporting? Without this the three sensor tiles show the LAST
  // reading received, labelled "LIVE", with nothing to say how old it is — so a dead
  // sensor renders exactly like a calm room. That is the specific failure esp32Monitor
  // exists to prevent, and it was going unshown on the page most likely to be left open.
  const [sensorOnline, setSensorOnline] = useState<boolean | null>(null);
  const [sensorLastSeen, setSensorLastSeen] = useState<string | null>(null);
  // Routers + UPS (SNMP poller). The Dashboard summarised servers, environment and
  // aircon but not these two, so a router or UPS incident was invisible on the page
  // people actually leave open. Only the counts are needed here — the Network / UPS
  // pages own the detail.
  // Both the initial GET and the poller's socket payload carry far more than id+status —
  // the narrow types here were why the dashboard could only ever count these devices
  // instead of showing them. Everything below is optional because the SNMP path leaves
  // CPU/mem/clients null (only MikroTik reports them) and a device may be unreachable.
  const [netDevices, setNetDevices] = useState<NetDevice[]>([]);
  const [upsDevices, setUpsDevices] = useState<UpsDevice[]>([]);
  const [liveTemp, setLiveTemp] = useState<number | string>("--");
  const [liveHum, setLiveHum] = useState<number | string>("--");
  const [chartTemps, setChartTemps] = useState<number[]>([]);
  const [chartHums, setChartHums] = useState<number[]>([]);
  const [chartGas, setChartGas] = useState<number[]>([]);
  const [liveGas, setLiveGas] = useState<number | string>("--");
  const [chartLabels, setChartLabels] = useState<string[]>([]);
  // The same points' timestamps. The labels are formatted for the axis and cannot be
  // parsed back into instants ("14:20" has no date), but detecting a gap needs the real
  // times — so they are kept alongside rather than re-derived.
  const [chartTimes, setChartTimes] = useState<number[]>([]);
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );

  const [clock, setClock] = useState(() => new Date());
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  // Room-level alert thresholds (`alert_rules`) — temperature, humidity and gas all colour
  // against these, so a reading changes colour at exactly the point the system raises an
  // alert. Follows an admin's Alert Rules edits live.
  const thresholds = useRoomThresholds();
  // Each series' colour right now, for the places where ONE colour has to stand for the
  // whole line: the area fill, the axis, the legend.
  const liveTempColor = temperatureColor(liveTemp, thresholds, ENV_TEMP);
  const liveHumColor = alertTint(liveHum, thresholds.humWarn, thresholds.humCrit, ENV_HUM, ENV_HUM);


  // eslint-disable-next-line @typescript-eslint/no-explicit-any

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
    // BOTH sources, because GET /network filters `device_type = 'router'` — the MikroTik
    // lives behind GET /mikrotik. Fetching only the first meant the MikroTik was missing
    // from the panel until its poller happened to push a `networkMetrics` frame, up to a
    // full poll interval (~30s) after the page loaded. It looked like the device was slow
    // to come up; it was simply never asked for.
    //
    // The two payloads share their field names (the MikroTik poller reuses
    // writeNetworkSample), so they merge without translation.
    Promise.all([api.getNetworkDevices(), api.getMikrotikDevices()]).then(([net, mt]) => {
      const rows: NetDevice[] = [
        ...(net.success ? net.data?.devices ?? [] : []),
        ...(mt.success ? mt.data?.devices ?? [] : []),
      ];
      // De-dup by id: the same device must never appear twice if the two endpoints ever
      // start overlapping.
      const byId = new Map<string, NetDevice>();
      for (const d of rows) byId.set(String(d.id), d);
      setNetDevices([...byId.values()]);
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
      setLiveTemp(data.temperature);
      setLiveHum(data.humidity);
      setLastUpdate(new Date());
      setChartLabels((p) => [...p.slice(-300), fmtEnvLabel(data.timestamp, envSpanRef.current)]);
      setChartTimes((p) => [...p.slice(-300), Date.parse(data.timestamp)]);
      setChartTemps((p) => [...p.slice(-300), data.temperature]);
      setChartHums((p) => [...p.slice(-300), data.humidity]);
      const gas = Math.max(Number(data.mq2_1_ppm ?? 0), Number(data.mq2_2_ppm ?? 0));
      setLiveGas(gas);
      setChartGas((p) => [...p.slice(-300), gas]);
    };

    // serverMetrics now arrives as a single-server update: { server: {...} }.
    // Merge it into the list by id (don't overwrite the whole array).
    const handleMetrics = (data: { server?: any }) => {
      const sv = data?.server;
      if (!sv) return;
      const incoming: Server = {
        id: Number(sv.id),
        name: sv.name ?? "—",
        status: sv.status ?? "Online",
        cpu: Math.round(sv.cpuPercent ?? 0),
        memory: Math.round(sv.memPercent ?? 0),
        diskUsed: Math.round(sv.diskPercent ?? 0),
        ip: sv.ip ?? undefined,
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

    // Admin renamed a server → update its label here too (live, no refresh).
    const handleRenamed = (data: { id: number | string; name: string }) => {
      setServers((prev) =>
        prev.map((s) => (s.id === Number(data?.id) ? { ...s, name: data.name } : s)),
      );
    };

    // Live status flip from the backend offline sweep. A stopped agent sends no
    // metrics, so this is the only event that can turn a server Offline here.
    const handleStatus = (data: { id: number | string; status: string }) => {
      setServers((prev) =>
        prev.map((s) =>
          s.id === Number(data?.id)
            ? data.status === "Offline"
              ? { ...s, status: "Offline", cpu: 0, memory: 0, diskUsed: 0, uptime: "—" }
              : { ...s, status: data.status }
            : s,
        ),
      );
    };

    // The chart used to start EMPTY on every mount and refill from live pushes at ~3s
    // intervals, so leaving the dashboard and coming back looked like the system had
    // just booted. Seed it from stored history instead: the same changeRange →
    // sensorHistory round-trip the Environment page uses. Live readings then append to
    // that tail rather than starting from nothing. WHICH range is requested lives in its
    // own effect below, so changing the picker re-seeds without re-binding every listener.
    const handleHistory = (history: SensorHistoryRow[]) => {
      if (!history?.length) return;
      const rows = history.slice(-300);
      setChartLabels(rows.map((r) => fmtEnvLabel(r.time, envSpanRef.current)));
      setChartTimes(rows.map((r) => Date.parse(r.time)));
      setChartTemps(rows.map((r) => r.temperature ?? 0));
      setChartHums(rows.map((r) => r.humidity ?? 0));
      setChartGas(rows.map((r) => Math.max(r.mq2_1_ppm ?? 0, r.mq2_2_ppm ?? 0)));
      const last = rows[rows.length - 1];
      if (last) {
        if (typeof last.temperature === "number") setLiveTemp(last.temperature);
        if (typeof last.humidity === "number") setLiveHum(last.humidity);
        setLiveGas(Math.max(last.mq2_1_ppm ?? 0, last.mq2_2_ppm ?? 0));
      }
    };

    socket.on("sensorHistory", handleHistory);
    socket.on("sensorData", handleSensor);
    socket.on("serverMetrics", handleMetrics);
    socket.on("airconStatus", handleAircon);
    socket.on("serverRemoved", handleRemoved);
    socket.on("serverStatus", handleStatus);
    socket.on("serverRenamed", handleRenamed);

    return () => {
      socket.off("sensorHistory", handleHistory);
      socket.off("sensorData", handleSensor);
      socket.off("serverMetrics", handleMetrics);
      socket.off("airconStatus", handleAircon);
      socket.off("serverRemoved", handleRemoved);
      socket.off("serverStatus", handleStatus);
      socket.off("serverRenamed", handleRenamed);
    };
  }, []);

  // Which server the focus panel is charting, and over what window. Kept here rather
  // than inside ServerFocus so the table's selected-row highlight and the panel agree.
  const [focusId, setFocusId] = useState<number | null>(null);
  const [focusRange, setFocusRange] = useState<RangeValue>(DEFAULT_RANGE);

  // Land on a server without a click, and never keep pointing at one that has been
  // removed — a stale id would leave the panel empty with no clue why.
  useEffect(() => {
    if (!servers.length) {
      if (focusId !== null) setFocusId(null);
      return;
    }
    if (focusId === null || !servers.some((s) => s.id === focusId)) {
      setFocusId(servers[0]!.id);
    }
  }, [servers, focusId]);

  const focusServer = servers.find((s) => s.id === focusId) ?? null;

  // The network and UPS panels follow the same select-then-chart pattern. One range is
  // shared by all three: an incident is read ACROSS them — a CPU spike, the traffic that
  // caused it and the UPS load at the same moment — and separate pickers would silently
  // let two panels show different hours while looking directly comparable.
  // The Network panel is split in two because the two device classes are not comparable:
  // a MikroTik is polled over the RouterOS API and reports CPU, memory and client count,
  // while an SNMP router reports none of those. One combined picker would silently change
  // WHICH metrics are available depending on what you happened to select.
  const routers = netDevices.filter((d) => d.type !== "mikrotik");
  const mikrotiks = netDevices.filter((d) => d.type === "mikrotik");

  const [routerFocusId, setRouterFocusId] = useState<string | null>(null);
  const [mtFocusId, setMtFocusId] = useState<string | null>(null);
  const [upsFocusId, setUpsFocusId] = useState<string | null>(null);

  // Land on a device without a click, and never keep pointing at one that has been
  // removed — a stale id leaves the chart empty with no clue why.
  const useAutoPick = (
    list: { id: number | string }[],
    id: string | null,
    set: (v: string | null) => void,
  ) => {
    useEffect(() => {
      if (!list.length) { if (id !== null) set(null); return; }
      if (id === null || !list.some((d) => String(d.id) === id)) set(String(list[0]!.id));
    }, [list, id, set]);
  };
  useAutoPick(routers, routerFocusId, setRouterFocusId);
  useAutoPick(mikrotiks, mtFocusId, setMtFocusId);
  useAutoPick(upsDevices, upsFocusId, setUpsFocusId);

  // The environment chart follows the shared range too, so the whole page is showing one
  // period. Previously it was pinned to "-1h" while every other chart moved, which is the
  // worst of both: the panels look directly comparable and silently are not.
  //
  // Requested in its OWN effect rather than by adding focusRange to the big socket effect
  // below — that one binds seven listeners, and re-binding all of them on every range
  // click would drop live readings during the swap.
  useEffect(() => {
    const ask = () =>
      socket.emit(
        "changeRange",
        focusRange.kind === "custom"
          ? { start: focusRange.start, stop: focusRange.stop }
          : focusRange.preset,
      );
    ask();
    // The reply is a one-shot answer to this emit, so a dropped connection loses it for
    // good — after a backend restart the chart would sit on whatever it last received,
    // with the live tail resuming on top of stale history. Re-ask on reconnect.
    socket.on("connect", ask);
    return () => { socket.off("connect", ask); };
  }, [focusRange]);

  // The span the labels should be formatted for, read by socket handlers that were bound
  // once at mount. A ref rather than a dep: those handlers must not be re-created — but
  // they must not format a 30-day point as a bare clock time either.
  const envSpanRef = useRef(rangeSpanSec(DEFAULT_RANGE));
  envSpanRef.current = rangeSpanSec(focusRange);

  const focusRouter = routers.find((d) => String(d.id) === routerFocusId) ?? null;
  const focusMt = mikrotiks.find((d) => String(d.id) === mtFocusId) ?? null;
  const focusUps = upsDevices.find((d) => String(d.id) === upsFocusId) ?? null;

  // ESP32 liveness: authoritative state over REST, then live transitions over the socket.
  // Mirrors pages/Environment.tsx — including the re-pull on reconnect and on regaining
  // focus, because `esp32Status` only fires on a TRANSITION. A tab that was backgrounded
  // when the sensor died never receives that event, and would sit showing a stale reading
  // as "LIVE" indefinitely.
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
    const onVisible = () => { if (document.visibilityState === "visible") resync(); };

    socket.on("esp32Status", onStatus);
    socket.on("connect", resync);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      socket.off("esp32Status", onStatus);
      socket.off("connect", resync);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Open incidents. Refetched rather than patched in place on each event: the panel shows
  // a short list and the lifecycle has several transitions (raise, acknowledge, resolve,
  // auto-resolve), so re-reading the authoritative list is both simpler and immune to a
  // missed event leaving a resolved alert on screen for ever.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api.getAlerts().then((res) => {
        if (cancelled || !res.success || !res.data) return;
        const rows: DashAlert[] = res.data.alerts ?? [];
        setOpenAlerts(rows.filter((a) => a.status !== "resolved"));
      });
    };
    load();

    socket.on("notification", load); // a new alert was raised
    socket.on("alertUpdated", load); // acknowledged / resolved / auto-resolved
    socket.on("connect", load);
    return () => {
      cancelled = true;
      socket.off("notification", load);
      socket.off("alertUpdated", load);
      socket.off("connect", load);
    };
  }, []);

  // The reading is only "LIVE" while the sensor is actually reporting. `null` means we
  // have not heard back yet — treated as live, so the tiles don't flash a false offline
  // warning on every page load.
  const sensorDead = sensorOnline === false;
  const sensorSub = sensorLastSeen
    ? `SENSOR OFFLINE · last ${fmtClock(sensorLastSeen)}`
    : "SENSOR OFFLINE";

  const online = servers.filter((s) => s.status === "Online").length;
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
  // Break the line wherever the ESP32 stopped reporting. Smoothing runs FIRST, on the
  // dense arrays — `smooth()` averages a sliding window and would spread a null across
  // its neighbours — and the breaks are inserted into the result.
  const envChart = useMemo(() => {
    const { labels, series } = withGaps(chartTimes, chartLabels, [
      smooth(chartTemps),
      smooth(chartHums),
    ]);
    return { labels, temps: series[0]!, hums: series[1]! };
  }, [chartTimes, chartLabels, chartTemps, chartHums]);

  const combinedData: ChartData<"line"> = {
    labels: envChart.labels,
    datasets: [
      {
        label: "Temperature",
        data: envChart.temps,
        // Each SEGMENT takes the alert band of the point it ends on, so the line is blue
        // where the room was too cold and red where it breached critical — the history
        // keeps its own colours instead of the whole line being repainted by the newest
        // reading, which would have claimed things about the past that were not true.
        // `borderColor` below is the fallback Chart.js uses before segments resolve.
        borderColor: ENV_TEMP,
        segment: {
          borderColor: (ctx) => temperatureColor(ctx.p1.parsed.y, thresholds, ENV_TEMP),
        },
        // The area fill is one region and cannot be split per band, so it follows the
        // CURRENT reading — it is decorative at this alpha, and tracking the live band
        // keeps it from fighting the newest part of the line.
        backgroundColor: (ctx: ScriptableContext<"line">) =>
          gradientFill(ctx, withAlpha(liveTempColor, 0.18), withAlpha(liveTempColor, 0.01)),
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: (ctx: ScriptableContext<"line">) =>
          temperatureColor(ctx.parsed?.y, thresholds, ENV_TEMP),
        fill: true,
        tension: 0.4,
        yAxisID: "yTemp",
      },
      {
        label: "Humidity",
        data: envChart.hums,
        // Keeps its own blue while the room is within the `humidity` rules, and turns
        // orange/red per segment where it was not. It shares this chart with temperature,
        // so it cannot go green when normal without becoming the same line.
        borderColor: ENV_HUM,
        segment: {
          borderColor: (ctx) =>
            alertTint(ctx.p1.parsed.y, thresholds.humWarn, thresholds.humCrit, ENV_HUM, ENV_HUM),
        },
        backgroundColor: (ctx: ScriptableContext<"line">) =>
          gradientFill(ctx, withAlpha(liveHumColor, 0.14), withAlpha(liveHumColor, 0.01)),
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: (ctx: ScriptableContext<"line">) =>
          alertTint(ctx.parsed?.y, thresholds.humWarn, thresholds.humCrit, ENV_HUM, ENV_HUM),
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
          // Chart.js's default swatch reads the dataset's static `borderColor`, which here
          // is only the pre-first-reading fallback — so the box stayed amber no matter
          // what the line under the cursor was doing. Resolve it from the HOVERED point
          // instead, the same way the segment beneath it is coloured.
          labelColor: (ctx) => {
            const y = ctx.parsed.y as number | null;
            const color = ctx.datasetIndex === 0
              ? temperatureColor(y, thresholds, ENV_TEMP)
              : alertTint(y, thresholds.humWarn, thresholds.humCrit, ENV_HUM, ENV_HUM);
            return { borderColor: color, backgroundColor: color, borderWidth: 0 };
          },
        },
      },
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
          // Follows the live zone, not a fixed amber: the axis is how you tell which line
          // belongs to which scale, and a multi-coloured line needs an axis that still
          // matches some part of it.
          color: liveTempColor,
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
          color: liveHumColor,
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
    "flex items-center gap-1.5 h-7 px-2.5 rounded-[2px] text-[13px] transition-colors";
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
            className="text-[15px] font-semibold"
            style={{ color: gf.textPrimary }}
          >
            Server Room — Overview
          </span>
          <span
            className="text-[11px] px-1.5 py-0.5 rounded-[2px] tracking-widest uppercase"
            style={{ color: gf.accent, background: "rgba(87,148,242,0.12)" }}
          >
            CSPC · ICTU
          </span>
        </div>

        {/* One range for every chart below, and it lives HERE rather than inside a panel
            for exactly that reason: a control that sits in the Server panel but silently
            redraws Network and UPS too is a trap. Shared because an incident is read
            ACROSS the three — a CPU spike, the traffic that caused it and the UPS load at
            the same moment — and per-panel pickers would let two of them show different
            hours while looking directly comparable. */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] tracking-widest uppercase hidden sm:inline" style={{ color: gf.textDim }}>
            Charts
          </span>
          <RangePicker value={focusRange} onChange={setFocusRange} />
        </div>
      </div>

      {/* ── Row 1: Stat panels ── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        {/* Coloured by the `temperature` ALERT RULES: blue below the firmware's cold
            constant, green while within the rules, orange at the warning rule and red at
            the critical one — so the tile changes at the same instant the system raises
            the alert. The band is named below the value; a colour alone cannot say which
            threshold was crossed. */}
        {/* When the ESP32 stops reporting, the value is GREYED rather than kept in its
            alarm colour. A red 35 °C tile asserts the room is hot right now; once the
            sensor is dead the only honest claim is "this was the last reading". The
            reading itself stays visible — it is still the best evidence of what the room
            was doing — and the `esp32_offline` alert appears in Active Alerts beside it. */}
        <StatPanel
          label="Room Temp"
          value={typeof liveTemp === "number" ? liveTemp.toFixed(1) : "--"}
          unit="°C"
          color={sensorDead ? gf.textMuted : temperatureColor(liveTemp, thresholds, gf.textMuted)}
          sub={sensorDead ? sensorSub : `${temperatureLabel(liveTemp, thresholds) ?? "DHT11"} · LIVE`}
          spark={chartTemps}
        />
        {/* Keeps its own blue while within the `humidity` rules, orange/red once past
            them — same rule as the line below it, and as the Environment page. */}
        <StatPanel
          label="Humidity"
          value={typeof liveHum === "number" ? liveHum.toFixed(1) : "--"}
          unit="%"
          color={sensorDead ? gf.textMuted : alertTint(liveHum, thresholds.humWarn, thresholds.humCrit, ENV_HUM, gf.textMuted)}
          sub={sensorDead ? sensorSub : "DHT11 · LIVE"}
          spark={chartHums}
        />
        <StatPanel
          label="Servers Online"
          value={`${online}/${servers.length}`}
          color={online === servers.length && servers.length > 0 ? GREEN : ORANGE}
          sub={`${servers.length - online} offline`}
        />
        <StatPanel
          // "Network", not "Routers": this now counts the MikroTik alongside the SNMP
          // routers, and calling that number "routers" would quietly misreport what it
          // covers.
          label="Network Online"
          value={netDevices.length ? `${netOnline}/${netDevices.length}` : "--"}
          color={
            !netDevices.length ? gf.textMuted : netOnline === netDevices.length ? GREEN : RED
          }
          sub={netDevices.length ? `${netDevices.length - netOnline} unreachable` : "none registered"}
        />
        {/* Replaces the old "Active Alerts" count, which only repeated the sidebar badge
            and the bell. Air quality is the one safety-critical reading with nowhere else
            on this page to appear once gas came off the chart. */}
        <StatPanel
          label="Air Quality"
          value={typeof liveGas === "number" ? String(Math.round(liveGas)) : "--"}
          unit="ppm"
          color={sensorDead ? gf.textMuted : gasColor(liveGas, thresholds, gf.textMuted)}
          // The advice, like the colour, is keyed off the live `gas` rules rather than off
          // numbers repeated here — so retuning a rule cannot leave the tile saying
          // "clean" in orange. A dead sensor overrides all of it: "clean" is a claim about
          // the room, and with nothing reporting there is no basis for making it.
          sub={
            sensorDead ? sensorSub
              : gasLabel(liveGas, thresholds) === "CRITICAL" ? "SMOKE / GAS — critical"
                : gasLabel(liveGas, thresholds) === "WARNING" ? "elevated — ventilate"
                  : typeof liveGas === "number" ? "clean · higher of 2 sensors"
                    : "MQ-2 · LIVE"
          }
          spark={chartGas}
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
      </div>

      {/* ── Row 2: Environment trend + open incidents ── */}
      {/* Two columns, matching the device rows below. The Environment chart used to span
          two of three columns, which made it the one panel on the page at its own width —
          and a chart that is wider than everything else quietly reads as more important
          than everything else. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Panel
          title="Environment"
          right={
            <>
              {([
                // Muted fallback, not the chart's amber: with no reading this shows "--",
                // and a live-looking colour beside it would suggest one.
                [temperatureColor(liveTemp, thresholds, gf.textMuted), typeof liveTemp === "number" ? `${liveTemp.toFixed(1)}°C` : "--", "Temp"],
                [alertTint(liveHum, thresholds.humWarn, thresholds.humCrit, ENV_HUM, gf.textMuted),
                  typeof liveHum === "number" ? `${liveHum.toFixed(1)}%` : "--", "Hum"],
              ] as [string, string, string][]).map(([color, val, label]) => (
                <span key={label} className="flex items-center gap-1.5 text-[13px]">
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
            </>
          }
          // Row 2 is a GLANCE row — "is the room OK" and "is anything wrong" — so it is
          // deliberately shorter than the server panel below it, which is the one you
          // PANEL_H is shared with every other panel on the page, so changing one alone
          // cannot leave a ragged row.
          bodyStyle={{ height: PANEL_H, padding: "8px 12px 12px" }}
        >
          <Line data={combinedData} options={combinedOpts} />
        </Panel>

        {/* Replaces the Avg CPU / Avg Memory gauges that used to sit here.
            A mean across servers describes nothing real — two hosts at 10% and 90%
            average to 50%, which is neither of them — and Row 3 now shows each server's
            actual load with history. The space buys the thing the Dashboard genuinely
            lacked: what is currently WRONG. */}
        <Panel
          title="Active Alerts"
          noPad
          right={
            <div className="flex items-center gap-2">
              <span
                className="text-[11px] font-bold px-1.5 py-0.5 rounded-[2px]"
                style={{
                  color: openAlerts.length ? "#E02F44" : GREEN,
                  background: openAlerts.length ? "rgba(224,47,68,0.12)" : "rgba(115,191,105,0.12)",
                }}
              >
                {openAlerts.length}
              </span>
              <button
                type="button"
                onClick={() => navigate("/alerts")}
                className="text-[11px] tracking-wide"
                style={{ color: gf.accent }}
              >
                View all →
              </button>
            </div>
          }
          bodyStyle={{ height: PANEL_H, overflowY: "auto", padding: 0 }}
        >
          {openAlerts.length === 0 ? (
            // Good news should read as good, not as an empty container.
            <div className="flex flex-col items-center justify-center h-full gap-1.5 px-4 text-center">
              <span className="text-[20px]" style={{ color: GREEN }}>✓</span>
              <span className="text-[13px]" style={{ color: gf.textMuted }}>
                No active alerts
              </span>
              <span className="text-[11px]" style={{ color: gf.textDim }}>
                Everything is within its thresholds.
              </span>
            </div>
          ) : (
            <div className="flex flex-col">
              {openAlerts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => navigate("/alerts")}
                  className="flex items-start gap-2 px-3 py-2 text-left transition-colors"
                  style={{ borderBottom: `1px solid ${gf.divider}` }}
                >
                  {/* Severity as a bar rather than a dot: it survives being scanned
                      quickly down a list, and doesn't rely on colour alone at a glance. */}
                  <span
                    className="w-1 self-stretch rounded-full shrink-0"
                    style={{ background: SEV_COLOR[a.severity] }}
                  />
                  <span className="flex flex-col min-w-0 flex-1 gap-0.5">
                    <span className="text-[13px] font-medium truncate" style={{ color: gf.textPrimary }}>
                      {a.title}
                    </span>
                    <span className="text-[11px] truncate" style={{ color: gf.textDim }}>
                      {a.deviceName ?? "Server room"} · {ago(a.createdAt)}
                      {a.status === "acknowledged" ? " · acknowledged" : ""}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* ── Rows 3-4: the four monitored device classes, as one 2x2 grid ──
          Servers | Network        (row 3)
          MikroTik | UPS Power     (row 4)
          Every panel is the same shape — pick a device, read its chart — and the same
          size (PANEL_H), so the block reads as a grid rather than four boxes that
          happen to sit near each other. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Same shape as the other three: pick a device, read its chart. The fleet TABLE
            that used to sit here is gone — with a dropdown above it and per-metric values
            on the legend below, it was presenting the same CPU and memory figures a third
            time, and it was the only thing forcing this panel to scroll internally. The
            full fleet view lives on the Server Metrics page. */}
        <Panel
          title="Server Metrics"
          noPad
          bodyStyle={PANEL_BODY}
          right={
            <span className="text-[12px]" style={{ color: gf.textMuted }}>
              {servers.length ? `${online}/${servers.length} online` : "none registered"}
            </span>
          }
        >
          {servers.length === 0 ? (
            <div style={{ padding: 12 }}>
              <EmptyRow>No servers monitored yet.</EmptyRow>
            </div>
          ) : (
            <>
              <DevicePicker
                devices={servers}
                value={focusId == null ? null : String(focusId)}
                onChange={(id) => setFocusId(Number(id))}
                label="Server"
              />
              <ServerFocus server={focusServer} range={focusRange} isDark={isDark} />
            </>
          )}
        </Panel>

        {/* SNMP routers only. Separate from MikroTik rather than two halves of one panel:
            the two are polled by different services and expose different metrics (a
            MikroTik reports CPU, memory and client count; an SNMP router reports none of
            them), so one picker spanning both would silently change which numbers exist
            depending on what you selected. */}
        <Panel title="Network" noPad bodyStyle={PANEL_BODY} right={
          <span className="text-[12px]" style={{ color: gf.textMuted }}>
            {routers.length ? `${routers.filter((d) => d.status === "Online").length}/${routers.length} online` : "none registered"}
          </span>
        }>
          {routers.length === 0 ? (
            <div style={{ padding: 12 }}>
              <EmptyRow>No SNMP routers registered yet.</EmptyRow>
            </div>
          ) : (
            <>
              <DevicePicker devices={routers} value={routerFocusId} onChange={setRouterFocusId} label="Router" />
              <NetworkFocus device={focusRouter} range={focusRange} isDark={isDark} />
            </>
          )}
        </Panel>
      </div>

      {/* ── Row 4: MikroTik + UPS ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Panel title="MikroTik" noPad bodyStyle={PANEL_BODY} right={
          <span className="text-[12px]" style={{ color: gf.textMuted }}>
            {mikrotiks.length ? `${mikrotiks.filter((d) => d.status === "Online").length}/${mikrotiks.length} online` : "none registered"}
          </span>
        }>
          {mikrotiks.length === 0 ? (
            <div style={{ padding: 12 }}>
              <EmptyRow>No MikroTik registered yet.</EmptyRow>
            </div>
          ) : (
            <>
              <DevicePicker devices={mikrotiks} value={mtFocusId} onChange={setMtFocusId} label="MikroTik" />
              <NetworkFocus device={focusMt} range={focusRange} isDark={isDark} />
            </>
          )}
        </Panel>

        <Panel title="UPS Power" noPad bodyStyle={PANEL_BODY} right={
          <span className="text-[12px]" style={{ color: upsOnBattery > 0 ? RED : gf.textMuted }}>
            {upsDevices.length ? (upsOnBattery > 0 ? `${upsOnBattery} on battery` : `${upsOnline}/${upsDevices.length} online`) : "none registered"}
          </span>
        }>
          {upsDevices.length === 0 ? (
            <div style={{ padding: 12 }}>
              <EmptyRow>No UPS registered yet.</EmptyRow>
            </div>
          ) : (
            <>
              <DevicePicker devices={upsDevices} value={upsFocusId} onChange={setUpsFocusId} label="UPS" />
              <UpsFocus device={focusUps} range={focusRange} isDark={isDark} />
            </>
          )}
        </Panel>
      </div>

      {/* ── Row 5: Air conditioner units ──
          Full width, below the 2x2. They are what ACTS on the room temperature plotted in
          Row 2, and their cards size themselves to the number of registered units — which
          is why they don't join the fixed-height grid above. */}
      <div className="grid grid-cols-1 gap-3">
        <Panel title="Air Conditioner Units" noPad bodyStyle={{ padding: 12 }}>
          {aircons.length === 0 ? (
            <div className="text-[12px] text-center py-4" style={{ color: gf.textDim }}>
              No AC units registered
            </div>
          ) : (
            // auto-FIT, not auto-fill, and not a fixed xl:grid-cols-4. The fixed grid always
            // reserved four tracks, so two registered units sat beside two empty columns of
            // dead space. auto-fit COLLAPSES the tracks it doesn't need, so two cards share
            // the row; register two more and it becomes four columns on its own, with no
            // breakpoint to keep in sync with the unit count.
            //
            // (auto-fill would keep the empty tracks — the exact behaviour being fixed.)
            <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(260px,1fr))]">
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
                      <span className="text-[13px] font-semibold" style={{ color: gf.textPrimary }}>
                        {ac.name}
                      </span>
                    </div>
                    <span
                      className="text-[11px] font-bold px-2 py-0.5 rounded-[2px] tracking-widest"
                      style={{
                        color: ac.enabled ? GREEN : gf.textMuted,
                        background: ac.enabled ? "rgba(115,191,105,0.12)" : gf.hover,
                      }}
                    >
                      {ac.enabled ? "ONLINE" : "OFFLINE"}
                    </span>
                  </div>
                  <div className="px-3 pb-1.5 -mt-1">
                    <span className="text-[10px]" style={{ color: gf.textDim }}>
                      {ac.last_trigger === "manual" ? "set manually"
                        : ac.last_trigger === "auto" ? "set by auto-cooling"
                          : "not yet triggered"}
                      {ac.enabled && ac.uptime && ac.uptime !== "offline" ? ` · on for ${ac.uptime}` : ""}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-px" style={{ background: gf.divider }}>
                    {[
                      ["Mode", ac.mode],
                      ["Set", `${ac.setTemp}°`],
                      ["Fan", ac.fanMode || "--"],
                    ].map(([lbl, val]) => (
                      <div
                        key={lbl}
                        className="flex flex-col px-2 py-2 gap-0.5"
                        style={{ background: gf.panel }}
                      >
                        <span className="text-[10px] tracking-widest uppercase" style={{ color: gf.textDim }}>
                          {lbl}
                        </span>
                        <span className="text-[13px] font-bold" style={{ color: gf.textPrimary }}>
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

    </div>
  );
}
