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
import { useGasSensors } from "../hooks/useGasSensors";
import {
  gasColor, gasLabel, temperatureColor, temperatureLabel, alertTint, withAlpha,
} from "../utils/envThresholds";
import { GF as gf, STATUS } from "../theme/gf";
import { usePersistedState, usePersistedFocus } from "../hooks/usePersistedState";
const { green: GREEN, orange: ORANGE, red: RED } = STATUS;

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
  // The tile shows the higher of the MQ-2 readings, not the average: 400 ppm near a
  // smoking PSU averaged with 20 ppm across the room would read as borderline. Same rule
  // as sensorHandler and the analytics.
  mq2_1_ppm?: number;
  /** Aggregate across every fitted sensor, and the per-sensor breakdown with labels already
   *  resolved. Both added when gas went multi-sensor; absent on a pre-cutover payload. */
  gas_ppm?: number;
  gas?: { channel: number; ppm: number; label: string }[];
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

// Environment x-axis label: ranges over two days include the date, same threshold as
// the focus charts.
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

// "just now" / "4m" / "3h" / "2d". How old an alert is matters as much as what it is.
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
  // "ping" = registered with no SNMP community. NetworkFocus shows latency/loss for these
  // instead of throughput (they have no byte counters).
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


// Environment colours, the same as pages/Environment.tsx so a colour means the same
// thing on both pages.
//
// ENV_TEMP is only a fallback until the first reading; after that the temperature line,
// fill, axis and tile are coloured by the `temperature` alert rules
// (utils/envThresholds.ts).
//
// ENV_HUM is humidity's own colour: the line keeps it while humidity is within the
// rules and turns orange/red when not (`alertTint`), since two green lines on one chart
// would be unreadable. The humidity tile uses full green/orange/red. ENV_HUM is close to
// the too-cold blue (#5794F2); the legend labels tell them apart.
const ENV_TEMP = "#F59E0B";
const ENV_HUM  = "#38BDF8";

// Gas thresholds come from the alert rules via useRoomThresholds(), so editing a rule
// also moves this tile.

// ─── Helpers ──────────────────────────────────────────────────────────────────
// The focus panels colour their own values through focusShared.loadColor.

// Body height of every panel in the two-column stack below the tiles (Environment,
// Active Alerts, Servers, Network, MikroTik, UPS), so the page reads as one grid.
// Explicit because CSS grid only equalises items within a row. Fits a picker, status
// line, chart and legend; the Active Alerts list scrolls past about six incidents.
const PANEL_H = 300;
const PANEL_BODY: React.CSSProperties = {
  height: PANEL_H,
  padding: 0,
  display: "flex",
  flexDirection: "column",
};

// Device selector for the chart panels: a dropdown, so the chart gets the panel's height.
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
        /* minHeight (not a fixed height) so the title can take a second line on a phone
           instead of being cut to a word; `min-w-0` lets truncate work in a flex row. */
        <div
          className="flex items-center justify-between gap-2 px-3 shrink-0 flex-wrap sm:flex-nowrap py-1.5 sm:py-0"
          style={{ minHeight: 32, borderBottom: `1px solid ${gf.divider}` }}
        >
          <span
            className="text-[13px] font-medium tracking-wide truncate min-w-0"
            style={{ color: gf.textPrimary, opacity: 0.85 }}
            title={title}
          >
            {title}
          </span>
          {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}
        </div>
      )}
      <div
        className="min-h-0"
        style={{
          // A body with an explicit height must not also be `flex: 1 1 0%`: in a column flex
          // container flex-basis 0 overrides height, so the Active Alerts list grew the panel
          // (and its whole grid row) instead of scrolling.
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

    // A tile colour may be a CSS variable (`var(--gf-text-muted)` when there is no reading),
    // which canvas cannot use; see utils/canvasColor. Otherwise addColorStop throws and the
    // page crashes.
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
      <div className="flex items-center justify-between gap-1.5 px-3 pt-2.5 z-10">
        {/* `tracking-widest` is too wide for a two-column phone grid (~160px per tile), so normal
           tracking on a phone and wide from `sm`. Truncated so a long label never pushes the
           status dot off the tile. */}
        <span
          className="text-[12px] sm:tracking-widest uppercase truncate min-w-0"
          style={{ color: gf.textMuted }}
          title={label}
        >
          {label}
        </span>
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: color, boxShadow: `0 0 6px ${color}` }}
        />
      </div>
      <div className="px-3 pt-1.5 z-10">
        {/* 30px is a lot of a 160px tile once a three-digit reading and a unit are in it. */}
        <span
          className="text-[26px] sm:text-[30px] font-bold leading-none"
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
          /* Normal letter-spacing and higher contrast on the subtitle, capped at two lines, so a
             long one like "SMOKE / GAS — critical · Above UPS cabinet" fits on a phone. The full
             text is on hover/long-press. */
          <div
            className="text-[11px] mt-1 sm:tracking-widest pb-0.5"
            style={{
              color: gf.textMuted,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
              wordBreak: "break-word",
            }}
            title={sub}
          >
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

// One namespace for everything the Dashboard remembers, so a stale key is easy to spot
// in devtools and easy to clear.
const FOCUS_KEY = "cspc_dashboard_focus";

/** A stored range must still be a shape RangePicker understands — an old preset that has
 *  since been removed would otherwise be handed straight to the history endpoint. */
function isRangeValue(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const r = v as { kind?: unknown; preset?: unknown; start?: unknown; stop?: unknown };
  if (r.kind === "preset") return typeof r.preset === "string";
  if (r.kind === "custom") return typeof r.start === "string" && typeof r.stop === "string";
  return false;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [servers, setServers] = useState<Server[]>([]);
  const [aircons, setAircons] = useState<Aircon[]>([]);

  // Open alerts (active or acknowledged), the same set the sidebar badge counts.
  const [openAlerts, setOpenAlerts] = useState<DashAlert[]>([]);

  // Is the ESP32 reporting? Without this the sensor tiles would keep showing the last
  // reading as "LIVE", and a dead sensor would look like a calm room.
  const [sensorOnline, setSensorOnline] = useState<boolean | null>(null);
  const [sensorLastSeen, setSensorLastSeen] = useState<string | null>(null);
  // Routers and UPS (SNMP poller), so their incidents show on the dashboard. The initial
  // GET and the socket payload carry more than id and status; everything is optional
  // because SNMP leaves CPU/mem/clients null (only MikroTik reports them) and a device
  // may be unreachable.
  const [netDevices, setNetDevices] = useState<NetDevice[]>([]);
  const [upsDevices, setUpsDevices] = useState<UpsDevice[]>([]);
  const [liveTemp, setLiveTemp] = useState<number | string>("--");
  const [liveHum, setLiveHum] = useState<number | string>("--");
  const [chartTemps, setChartTemps] = useState<number[]>([]);
  const [chartHums, setChartHums] = useState<number[]>([]);
  const [chartGas, setChartGas] = useState<number[]>([]);
  // How many sensors the aggregate is actually over. "higher of 2" was hardcoded and would
  // have quietly lied the moment a third was fitted.
  const { enabled: gasFitted } = useGasSensors();
  const gasFittedCount = gasFitted.length;
  const [liveGas, setLiveGas] = useState<number | string>("--");
  // Where the worst reading comes from, e.g. "412 ppm at Above UPS cabinet".
  const [worstGasAt, setWorstGasAt] = useState<string | null>(null);
  const [chartLabels, setChartLabels] = useState<string[]>([]);
  // The points' timestamps, kept alongside the labels (which are formatted for the axis
  // and cannot be parsed back) for gap detection.
  const [chartTimes, setChartTimes] = useState<number[]>([]);
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );

  const [clock, setClock] = useState(() => new Date());
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  // Room alert thresholds (`alert_rules`); temperature, humidity and gas are coloured by
  // these and follow Alert Rules edits live.
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
    // Both sources: GET /network only returns `device_type = 'router'`, and the MikroTik is
    // behind GET /mikrotik. Both payloads use the same field names (the MikroTik poller
    // reuses writeNetworkSample), so they merge directly.
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
      // Prefer the server's aggregate: it spans EVERY fitted sensor, where the legacy pair
      // only ever covered channels 1-2 and would ignore a third or fourth entirely.
      const gas =
        typeof data.gas_ppm === "number"
          ? data.gas_ppm
          : Math.max(Number(data.mq2_1_ppm ?? 0), Number(data.mq2_2_ppm ?? 0));
      setLiveGas(gas);
      // The label is resolved server-side and travels with the reading, so the browser never
      // holds a second copy of a name an admin can change mid-session.
      const worst = (data.gas ?? []).reduce(
        (a, b) => (a && a.ppm >= b.ppm ? a : b),
        null as { channel: number; ppm: number; label: string } | null,
      );
      setWorstGasAt(worst?.label ?? null);
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

    // Seed the chart from stored history (the same changeRange → sensorHistory request as
    // the Environment page), so coming back to the dashboard does not start from empty.
    // Live readings append to it. The requested range is in its own effect below.
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

  // Which server the focus panel shows, and over what window, remembered across reloads.
  // usePersistedFocus falls back to the first device when the saved one is gone.
  const [focusId, setFocusId] = usePersistedFocus(`${FOCUS_KEY}.server`, servers);
  const [focusRange, setFocusRange] = usePersistedState<RangeValue>(
    `${FOCUS_KEY}.range`,
    DEFAULT_RANGE,
    isRangeValue,
  );

  const focusServer = servers.find((s) => String(s.id) === focusId) ?? null;

  // The network and UPS panels work the same way, and all three share one range so an
  // incident can be read across them. Network is split into SNMP routers and MikroTik,
  // since they report different metrics.
  const routers = netDevices.filter((d) => d.type !== "mikrotik");
  const mikrotiks = netDevices.filter((d) => d.type === "mikrotik");

  // Same treatment as the server panel: remembered across reloads, and still falls back
  // to the first device when the remembered one no longer exists.
  const [routerFocusId, setRouterFocusId] = usePersistedFocus(`${FOCUS_KEY}.router`, routers);
  const [mtFocusId, setMtFocusId] = usePersistedFocus(`${FOCUS_KEY}.mikrotik`, mikrotiks);
  const [upsFocusId, setUpsFocusId] = usePersistedFocus(`${FOCUS_KEY}.ups`, upsDevices);

  // The environment chart follows the shared range too. Requested in its own effect so
  // changing the range does not re-bind the socket listeners below (which would drop
  // live readings).
  useEffect(() => {
    const ask = () =>
      socket.emit(
        "changeRange",
        focusRange.kind === "custom"
          ? { start: focusRange.start, stop: focusRange.stop }
          : focusRange.preset,
      );
    ask();
    // The reply answers this one request, so ask again after a reconnect (e.g. a backend
    // restart).
    socket.on("connect", ask);
    return () => { socket.off("connect", ask); };
  }, [focusRange]);

  // The range span for formatting labels, as a ref, since the socket handlers are bound
  // once at mount.
  const envSpanRef = useRef(rangeSpanSec(DEFAULT_RANGE));
  envSpanRef.current = rangeSpanSec(focusRange);

  const focusRouter = routers.find((d) => String(d.id) === routerFocusId) ?? null;
  const focusMt = mikrotiks.find((d) => String(d.id) === mtFocusId) ?? null;
  const focusUps = upsDevices.find((d) => String(d.id) === upsFocusId) ?? null;

  // ESP32 liveness: current state over REST, then changes over the socket, like
  // pages/Environment.tsx. Also re-checked on reconnect and on focus, because
  // `esp32Status` only fires on a change and a background tab could miss it.
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

  // Open alerts: reload the list on each event instead of patching it, which is simpler
  // and cannot leave a resolved alert on screen.
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

  // "LIVE" only while the sensor is reporting. `null` (no answer yet) counts as live, so
  // the tiles do not flash offline on page load.
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
  // Break the line where the ESP32 stopped reporting. Smoothing runs first on the full
  // arrays (it would spread a null into its neighbours), then the breaks are inserted.
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
        // Each segment takes the alert band of the point it ends on, so the line keeps its
        // past colours instead of all being repainted by the latest reading. `borderColor`
        // below is only the fallback before segments resolve.
        borderColor: ENV_TEMP,
        segment: {
          borderColor: (ctx) => temperatureColor(ctx.p1.parsed.y, thresholds, ENV_TEMP),
        },
        // The fill cannot be split per band, so it follows the current reading.
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
        // Keeps its own blue while humidity is within the rules and turns orange/red where it
        // was not (it shares the chart with temperature).
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
          // Chart.js's default tooltip swatch uses the static `borderColor` (the fallback), so
          // colour it from the hovered point instead, like the segment.
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
          // The axis follows the live zone colour, so it still matches the line it belongs to.
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
            // accentText, not accent: --gf-accent is 2.76:1 on the LIGHT page background,
            // below WCAG AA for text. accentDim is the same rgba, minus the hardcoding.
            style={{ color: gf.accentText, background: gf.accentDim }}
          >
            CSPC · ICTU
          </span>
        </div>

        {/* One range for all the charts below, placed here rather than inside one panel, since
           it changes all of them. Shared so an incident can be compared across panels. */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] tracking-widest uppercase hidden sm:inline" style={{ color: gf.textDim }}>
            Charts
          </span>
          <RangePicker value={focusRange} onChange={setFocusRange} />
        </div>
      </div>

      {/* ── Row 1: Stat panels ── */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        {/* Coloured by the `temperature` alert rules: blue below the firmware's cold limit,
           green within the rules, orange at warning, red at critical. The band name is shown
           under the value. */}
        {/* When the ESP32 stops reporting, the value turns grey instead of staying in its alarm
           colour; it is only the last reading now. The `esp32_offline` alert shows in Active
           Alerts. */}
        <StatPanel
          label="Room Temp"
          value={typeof liveTemp === "number" ? liveTemp.toFixed(1) : "--"}
          unit="°C"
          color={sensorDead ? gf.textMuted : temperatureColor(liveTemp, thresholds, gf.textMuted)}
          sub={sensorDead ? sensorSub : `${temperatureLabel(liveTemp, thresholds) ?? "DHT22"} · LIVE`}
          spark={chartTemps}
        />
        {/* Keeps its own blue while within the `humidity` rules, orange/red once past
            them — same rule as the line below it, and as the Environment page. */}
        <StatPanel
          label="Humidity"
          value={typeof liveHum === "number" ? liveHum.toFixed(1) : "--"}
          unit="%"
          color={sensorDead ? gf.textMuted : alertTint(liveHum, thresholds.humWarn, thresholds.humCrit, ENV_HUM, gf.textMuted)}
          sub={sensorDead ? sensorSub : "DHT22 · LIVE"}
          spark={chartHums}
        />
        <StatPanel
          label="Servers Online"
          value={`${online}/${servers.length}`}
          color={online === servers.length && servers.length > 0 ? GREEN : ORANGE}
          sub={`${servers.length - online} offline`}
        />
        <StatPanel
          // "Network", not "Routers": this count includes the MikroTik.
          label="Network Online"
          value={netDevices.length ? `${netOnline}/${netDevices.length}` : "--"}
          color={
            !netDevices.length ? gf.textMuted : netOnline === netDevices.length ? GREEN : RED
          }
          sub={netDevices.length ? `${netDevices.length - netOnline} unreachable` : "none registered"}
        />
        {/* Air quality tile (replaced the old Active Alerts count, which repeated the sidebar badge). */}
        <StatPanel
          label="Air Quality"
          value={typeof liveGas === "number" ? String(Math.round(liveGas)) : "--"}
          unit="ppm"
          color={sensorDead ? gf.textMuted : gasColor(liveGas, thresholds, gf.textMuted)}
          // The advice and colour follow the live `gas` rules. A dead sensor overrides it (no
          // "clean" without readings). Named by location once sensors are labelled.
          sub={
            sensorDead ? sensorSub
              : gasLabel(liveGas, thresholds) === "CRITICAL"
                ? `SMOKE / GAS — critical${worstGasAt ? ` · ${worstGasAt}` : ""}`
                : gasLabel(liveGas, thresholds) === "WARNING"
                  ? `elevated — ventilate${worstGasAt ? ` · ${worstGasAt}` : ""}`
                  : typeof liveGas === "number"
                    ? `clean${gasFittedCount ? ` · highest of ${gasFittedCount}` : ""}`
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
      {/* Two columns, matching the device rows below, so no panel is wider than the rest. */}
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
          // Row 2 is a quick-check row: is the room OK, is anything wrong. PANEL_H is shared with
          // every other panel, so rows stay even.
          bodyStyle={{ height: PANEL_H, padding: "8px 12px 12px" }}
        >
          <Line data={combinedData} options={combinedOpts} />
        </Panel>

        {/* Replaces the old Avg CPU / Avg Memory gauges (an average across servers describes no
           real server). Shows what is currently wrong instead. */}
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
                style={{ color: gf.accentText }}
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

      {/* ── Rows 3-4: the four device types, as one 2x2 grid ──
         Servers | Network        (row 3)
         MikroTik | UPS Power     (row 4)
         All the same shape (pick a device, read its chart) and size (PANEL_H). */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {/* Same shape as the other three. The full server list is on the Server Metrics page. */}
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
                value={focusId}
                onChange={(id) => setFocusId(id)}
                label="Server"
              />
              <ServerFocus server={focusServer} range={focusRange} isDark={isDark} />
            </>
          )}
        </Panel>

        {/* SNMP routers only; MikroTik has its own panel since it reports different metrics. */}
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
         Full width, below the grid; their cards size to the number of units. */}
      <div className="grid grid-cols-1 gap-3">
        <Panel title="Air Conditioner Units" noPad bodyStyle={{ padding: 12 }}>
          {aircons.length === 0 ? (
            <div className="text-[12px] text-center py-4" style={{ color: gf.textDim }}>
              No AC units registered
            </div>
          ) : (
            // auto-fit (not auto-fill or a fixed 4 columns): unused tracks collapse, so two units
            // share the row and four fill four columns, with no breakpoint to maintain.
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
                        {/* No pulse while the ESP32 is gone — an animation asserts a live
                            reading, and this is a remembered value. */}
                        {ac.enabled && !sensorDead && (
                          <span
                            className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60"
                            style={{ background: GREEN }}
                          />
                        )}
                        <span
                          className="relative inline-flex rounded-full h-1.5 w-1.5"
                          style={{ background: sensorDead ? ORANGE : ac.enabled ? GREEN : gf.textMuted }}
                        />
                      </span>
                      <span className="text-[13px] font-semibold" style={{ color: gf.textPrimary }}>
                        {ac.name}
                      </span>
                    </div>
                    {/* ON / OFF (the unit's power, aircon_state.is_on), not ONLINE / OFFLINE (reachable).
                       UNKNOWN when the ESP32 is offline, since then it is only the last known setting. */}
                    <span
                      className="text-[11px] font-bold px-2 py-0.5 rounded-[2px] tracking-widest"
                      title={sensorDead
                        ? "The ESP32 is offline, so this unit's real state cannot be confirmed."
                        : undefined}
                      style={{
                        color: sensorDead ? ORANGE : ac.enabled ? GREEN : gf.textMuted,
                        background: sensorDead
                          ? "rgba(255,120,10,0.12)"
                          : ac.enabled ? "rgba(115,191,105,0.12)" : gf.hover,
                      }}
                    >
                      {sensorDead ? "UNKNOWN" : ac.enabled ? "ON" : "OFF"}
                    </span>
                  </div>
                  <div className="px-3 pb-1.5 -mt-1">
                    <span className="text-[10px]" style={{ color: gf.textDim }}>
                      {sensorDead ? "last known state — ESP32 offline"
                        : ac.last_trigger === "manual" ? "set manually"
                          : ac.last_trigger === "auto" ? "set by auto-cooling"
                            : "not yet triggered"}
                      {!sensorDead && ac.enabled && ac.uptime && ac.uptime !== "offline" ? ` · on for ${ac.uptime}` : ""}
                    </span>
                  </div>
                  {/* Three columns still fit at the card's 260px minimum, so "Mode / Set / Fan" stay in a row. */}
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
