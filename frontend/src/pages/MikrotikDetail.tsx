import { useState, useEffect, useRef } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import Chart from "../chart/ChartConfig";
import RangePicker, { DEFAULT_RANGE, rangeSpanSec } from "../components/ui/RangePicker";
import type { RangeValue } from "../components/ui/RangePicker";
import { withGaps } from "../utils/seriesGaps";
import { formatBps } from "../utils/format";
import { GF as gf, STATUS } from "../theme/gf";
import { formatUptime, fmtDateTime, formatSpeed, fmtAxisTime, MULTI_DAY_SEC } from "../utils/format";
import { Stat, Th } from "../components/ui/primitives";
const { green: GREEN, orange: ORANGE, red: RED, blue: BLUE } = STATUS;

// ─── MikroTik detail view (throughput, ports, log) ──────────────────────
// Opened from MikrotikMonitoring via "View" and replaces the list in place (Back
// button), like ServerMetrics ↔ ServerDetail. Ports/CPU/mem update live from
// `networkMetrics`; throughput history is fetched per range. Types are defined here so
// the list can import them without a circular import.

export interface MkIface {
  name: string;
  locationLabel: string; // optional friendly label from network_interfaces
  linkUp: boolean; // carrier present right now
  adminUp?: boolean; // false = switched off in RouterOS (`disabled=yes`), not a fault
  utilizationPct: number | null;
  rxBytes: string | null;
  txBytes: string | null;
  rxErrors?: number | null;
  txErrors?: number | null;
  speedMbps?: number | null;
  clients?: number | null; // DHCP clients on this port; null = not attributable
}
// Per-port alerting state from network_interfaces — fetched only when the port editor
// opens, since it isn't part of the live poll payload.
export interface PortGate {
  monitored: boolean; // admin's own switch: false = never raise interface-down here
  everUp: boolean; // observed by the poller; a port that never came up isn't a fault
}

// Same rules and order as backend/services/linkAlertPolicy.js (copied, since the
// backend is Node): muted, then disabled in RouterOS, then never connected.
function portAlertState(i: MkIface, gate?: PortGate): { text: string; alerting: boolean } {
  if (gate && !gate.monitored) return { text: "Alerts off", alerting: false };
  if (i.adminUp === false) return { text: "Disabled in RouterOS", alerting: false };
  if (i.linkUp) return { text: "Link up", alerting: false };
  if (!gate?.everUp) return { text: "Never connected", alerting: false };
  return { text: "Down — alerting", alerting: true };
}

// Per-port throughput worked out here from the byte counters between two polls. The API
// only gives totals, so otherwise a port would only show a utilization %, which reads 0%
// when the link speed is unknown.
export interface PortRate { rxBps: number; txBps: number }
export interface MkDevice {
  id: string;
  name: string;
  ip: string;
  location: string;
  status: string;
  reachable: boolean | null;
  uptimeSeconds: number | null;
  cpuPercent: number | null;
  memPercent: number | null;
  connectedClients: number | null;
  // ICMP, measured with each API poll. The API shows whether the router answers; ping
  // shows how well the path to it carries traffic.
  latencyMs?: number | null;
  packetLossPct?: number | null;
  routerosVersion: string | null;
  boardModel: string | null;
  apiPort: number | null;
  useTls: boolean;
  apiUsername: string | null;
  interfaces: MkIface[];
  monitored: boolean;
}
interface HistPoint { time: string; rxBytesPerSec: number | null; txBytesPerSec: number | null; }
// The ICMP part of the same response: its own array and timestamps, never merged into
// HistPoint (merging would put nulls in every other row). See
// backend/handlers/networkHistoryHandler.js.
interface IcmpPoint { time: string; latencyMs: number | null; packetLossPct: number | null; }
interface DeviceLog { log_level: "info" | "warning" | "critical" | "error"; message: string; recorded_at: string; }



// Windows longer than a day show the date on the axis. Based on the window's span, so a
// custom 5-day window gets dates too. Same rule as ServerDetail.

function loadColor(v: number) { if (v >= 85) return RED; if (v >= 65) return ORANGE; return GREEN; }
function statusColor(s: string) { if (s === "Online") return GREEN; if (s === "Warning") return ORANGE; return RED; }
function logColor(level: string) { if (level === "critical" || level === "error") return RED; if (level === "warning") return ORANGE; return BLUE; }
// formatBps is in utils/format.ts (the Dashboard uses it too).
// Chart.js line chart, same config as NetworkDetail.
function ThroughputChart({ history, spanSec }: { history: HistPoint[]; spanSec: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  useEffect(() => {
    if (!ref.current || history.length < 2) {
      chartRef.current?.destroy();
      chartRef.current = null;
      return;
    }
    chartRef.current?.destroy();
    // Break the line where the poller stopped, so an outage shows as a gap. `?? null`, not
    // `?? 0`: no reading is not zero traffic.
    const gapped = withGaps(
      history.map((p) => Date.parse(p.time)),
      history.map((p) => fmtAxisTime(p.time, spanSec)),
      [
        history.map((p) => p.rxBytesPerSec ?? null),
        history.map((p) => p.txBytesPerSec ?? null),
      ],
    );
    chartRef.current = new Chart(ref.current, {
      type: "line",
      data: {
        labels: gapped.labels,
        datasets: [
          { label: "In (Rx)", data: gapped.series[0]!, borderColor: BLUE, backgroundColor: BLUE + "22", borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3 },
          { label: "Out (Tx)", data: gapped.series[1]!, borderColor: GREEN, backgroundColor: GREEN + "22", borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: true, labels: { color: "#8E9297", boxWidth: 10, boxHeight: 10, font: { size: 10 } } },
          tooltip: { callbacks: { label: (ctx: any) => `${ctx.dataset.label}: ${formatBps(ctx.parsed.y)}` } },
        },
        scales: {
          x: { ticks: { color: "#6B7280", maxTicksLimit: 6, font: { size: 9 } }, grid: { color: "rgba(127,127,127,0.10)" } },
          y: { beginAtZero: true, ticks: { color: "#6B7280", font: { size: 9 }, callback: (v: any) => formatBps(Number(v)) }, grid: { color: "rgba(127,127,127,0.10)" } },
        },
      },
    });
    return () => { chartRef.current?.destroy(); };
  }, [history, spanSec]);
  return (
    <div style={{ height: 200 }}>
      {history.length < 2 ? (
        <div className="flex items-center justify-center h-full text-[13px]" style={{ color: gf.textDim }}>No data in range</div>
      ) : (
        <canvas ref={ref} />
      )}
    </div>
  );
}

// ICMP colours, the same as NetworkDetail and the Dashboard: latency cyan, loss red.
const LATENCY = "#3CC8E8";
const LOSS = RED;

// ─── ICMP history (latency + packet loss) ─────────────────────────────────────
// Ping runs with every MikroTik poll. The API shows whether the router answers; ping
// shows whether the link is healthy, and catches packet loss the API cannot see.
//
// Two axes, since milliseconds and percent are different units.
function IcmpChart({ history, spanSec }: { history: IcmpPoint[]; spanSec: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  useEffect(() => {
    if (!ref.current || history.length < 2) {
      chartRef.current?.destroy();
      chartRef.current = null;
      return;
    }
    chartRef.current?.destroy();
    // Same gap treatment as the throughput chart above: a poller that stopped reads as
    // a hole with a start and an end, not a straight line drawn across the outage.
    const gapped = withGaps(
      history.map((p) => Date.parse(p.time)),
      history.map((p) => fmtAxisTime(p.time, spanSec)),
      [
        history.map((p) => p.latencyMs ?? null),
        history.map((p) => p.packetLossPct ?? null),
      ],
    );
    chartRef.current = new Chart(ref.current, {
      type: "line",
      data: {
        labels: gapped.labels,
        datasets: [
          { label: "Latency", data: gapped.series[0]!, borderColor: LATENCY, backgroundColor: LATENCY + "22", borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3, yAxisID: "y" },
          { label: "Loss", data: gapped.series[1]!, borderColor: LOSS, backgroundColor: LOSS + "22", borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3, yAxisID: "y1" },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: true, labels: { color: "#8E9297", boxWidth: 10, boxHeight: 10, font: { size: 10 } } },
          // The unit follows the SERIES, not the panel — the two lines sit on different
          // axes, so one shared suffix would be wrong for one of them.
          tooltip: {
            callbacks: {
              label: (ctx: any) =>
                ctx.dataset.yAxisID === "y1"
                  ? `${ctx.dataset.label}: ${Number(ctx.parsed.y).toFixed(1)}%`
                  : `${ctx.dataset.label}: ${Number(ctx.parsed.y).toFixed(1)} ms`,
            },
          },
        },
        scales: {
          x: { ticks: { color: "#6B7280", maxTicksLimit: 6, font: { size: 9 } }, grid: { color: "rgba(127,127,127,0.10)" } },
          // beginAtZero + suggestedMax instead of pure auto-scale, so a healthy sub-millisecond
          // line does not look like big swings. suggestedMax is a minimum for the axis top, not a
          // cap.
          y: {
            type: "linear",
            position: "left",
            beginAtZero: true,
            suggestedMax: 20,
            ticks: { color: LATENCY, font: { size: 9 }, callback: (v: any) => `${v} ms` },
            grid: { color: "rgba(127,127,127,0.10)" },
          },
          // Loss is not fixed to 0-100: any loss is a fault, and 2% on a 0-100 axis would look
          // like zero.
          y1: {
            type: "linear",
            position: "right",
            beginAtZero: true,
            suggestedMax: 10,
            ticks: { color: LOSS, font: { size: 9 }, callback: (v: any) => `${v}%` },
            grid: { drawOnChartArea: false },
          },
        },
      },
    });
    return () => { chartRef.current?.destroy(); };
  }, [history, spanSec]);
  return (
    <div style={{ height: 200 }}>
      {history.length < 2 ? (
        <div className="flex items-center justify-center h-full text-[13px]" style={{ color: gf.textDim }}>No data in range</div>
      ) : (
        <canvas ref={ref} />
      )}
    </div>
  );
}

function Panel({ title, right, children, noPad }: { title: string; right?: React.ReactNode; children: React.ReactNode; noPad?: boolean }) {
  return (
    // `overflow-visible` so the range picker's Custom dropdown in the header is not clipped.
    <div className="flex flex-col rounded-lg overflow-visible" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
      {/* The header wraps on a phone so the last control (Custom) stays reachable. min-height
         keeps the desktop layout the same. */}
      <div
        className="flex items-center justify-between gap-x-3 gap-y-1.5 flex-wrap px-3 py-1.5 sm:py-0 shrink-0"
        style={{ minHeight: 32, borderBottom: `1px solid ${gf.divider}` }}
      >
        <span className="text-[13px] font-medium tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>{title}</span>
        {right && <div className="flex items-center gap-2 flex-wrap">{right}</div>}
      </div>
      <div className="flex-1 min-h-0" style={{ padding: noPad ? 0 : 12 }}>{children}</div>
    </div>
  );
}

// ─── Interface table (like WinBox's Interface List) ──────────────────────────
// Numbers rather than progress bars: an idle port is normal and an empty bar looks like
// a loading placeholder, and it matches the WinBox view operators know (R flag, Tx/Rx
// columns, right-aligned figures). Colours use --gf-* tokens and status colours, so it
// works in light and dark mode.

function PortRow({ i, rate }: { i: MkIface; rate?: PortRate | undefined }) {
  const hasUtil = i.utilizationPct != null && Number.isFinite(i.utilizationPct);
  const util = Math.round(i.utilizationPct ?? 0);
  const speed = formatSpeed(i.speedMbps);
  const errors = (i.rxErrors ?? 0) + (i.txErrors ?? 0);
  const down = !i.linkUp;
  const disabled = i.adminUp === false;
  const td = "px-2 py-1.5 text-[13px] tabular-nums whitespace-nowrap";
  const dim = { color: gf.textDim } as const;

  return (
    <tr style={{ borderTop: `1px solid ${gf.divider}` }}>
      {/* WinBox flags: R = running, X = disabled. A disabled port is off on purpose and never
         alerts. */}
      <td className={`${td} text-center font-bold`}
        style={{ color: disabled ? gf.textDim : down ? gf.textDim : GREEN }}
        title={disabled ? "Disabled in RouterOS" : down ? "No link" : "Running"}>
        {disabled ? "X" : down ? "" : "R"}
      </td>
      <td className={td} style={{ color: down ? gf.textMuted : gf.textPrimary }}>{i.name}</td>
      <td className={`${td} truncate`} style={{ ...dim, maxWidth: 160 }}>{i.locationLabel || "—"}</td>
      <td className={`${td} text-right`} style={dim}>{speed ?? "—"}</td>
      <td className={`${td} text-right`} style={{ color: down ? gf.textDim : GREEN }}>
        {down ? "—" : formatBps(rate?.txBps ?? null)}
      </td>
      <td className={`${td} text-right`} style={{ color: down ? gf.textDim : BLUE }}>
        {down ? "—" : formatBps(rate?.rxBps ?? null)}
      </td>
      <td className={`${td} text-right`} style={{ color: errors > 0 ? ORANGE : gf.textDim }}>
        {errors > 0 ? errors : "0"}
      </td>
      <td className={`${td} text-right`} style={dim}>
        {i.clients != null ? i.clients : "—"}
      </td>
      <td className={`${td} text-right font-bold`} style={{ color: down ? RED : hasUtil ? loadColor(util) : gf.textDim }}>
        {down ? "down" : hasUtil ? `${util}%` : "—"}
      </td>
    </tr>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function MikrotikDetail({
  device, onBack, onConfigure, isAdmin = false,
}: {
  device: MkDevice;
  onBack: () => void;
  onConfigure?: (() => void) | undefined;
  isAdmin?: boolean;
}) {
  const [d, setD] = useState<MkDevice>(device);
  const [range, setRange] = useState<RangeValue>(DEFAULT_RANGE);
  const [rangeError, setRangeError] = useState("");
  const [history, setHistory] = useState<HistPoint[]>([]);
  // Kept separately from `history` for the reason given on IcmpPoint: one request,
  // two series, two sets of timestamps.
  const [icmp, setIcmp] = useState<IcmpPoint[]>([]);
  const [logs, setLogs] = useState<DeviceLog[]>([]);
  // Bumped on every poll for this device. Used as a history-refetch trigger so the
  // chart tracks live data instead of freezing at whatever was loaded on mount.
  const [poll, setPoll] = useState(0);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  // "" = all ports summed (device total); otherwise a single port name.
  const [chartPort, setChartPort] = useState("");
  const [rates, setRates] = useState<Record<string, PortRate>>({});
  // Port-label editing (network_interfaces.location_label). `draft` holds the in-progress
  // edits keyed by port name; it is only populated while the editor is open.
  const [editLabels, setEditLabels] = useState(false);
  const [labelDraft, setLabelDraft] = useState<Record<string, string>>({});
  const [gateDraft, setGateDraft] = useState<Record<string, PortGate>>({});
  const [savingLabels, setSavingLabels] = useState(false);
  // Previous cumulative counters per port, to derive per-port bytes/sec on the next
  // poll. BigInt because these are Counter64 values that can exceed Number's safe range.
  const prevCounters = useRef<Record<string, { rx: bigint; tx: bigint; t: number }>>({});

  const toBig = (v: string | null | undefined): bigint | null => {
    if (v == null) return null;
    try { return BigInt(v); } catch { return null; }
  };

  // Keep the open device in sync when the parent list refreshes (e.g. after Save).
  useEffect(() => { setD(device); }, [device]);

  useEffect(() => {
    const onMetrics = (data: { device: any }) => {
      // `networkMetrics` is SHARED with the SNMP Network page — take only ours.
      if (!data?.device || data.device.type !== "mikrotik") return;
      if (String(data.device.id) !== String(d.id)) return;
      setD((prev) => ({
        ...prev,
        status: data.device.status ?? prev.status,
        reachable: data.device.reachable ?? prev.reachable,
        uptimeSeconds: data.device.uptimeSeconds ?? prev.uptimeSeconds,
        cpuPercent: data.device.cpuPercent ?? prev.cpuPercent,
        memPercent: data.device.memPercent ?? prev.memPercent,
        connectedClients: data.device.connectedClients ?? prev.connectedClients,
        interfaces: data.device.interfaces ?? prev.interfaces,
      }));
      // Per-port throughput from the counter change since the last poll. A negative change
      // (counter wrap or reboot) is dropped, as the pollers do.
      const now = Date.now();
      const next: Record<string, PortRate> = {};
      for (const iface of (data.device.interfaces ?? []) as MkIface[]) {
        const rx = toBig(iface.rxBytes);
        const tx = toBig(iface.txBytes);
        if (rx == null || tx == null) continue;
        const prev = prevCounters.current[iface.name];
        if (prev) {
          const dt = (now - prev.t) / 1000;
          if (dt > 0) {
            next[iface.name] = {
              rxBps: rx >= prev.rx ? Number(rx - prev.rx) / dt : 0,
              txBps: tx >= prev.tx ? Number(tx - prev.tx) / dt : 0,
            };
          }
        }
        prevCounters.current[iface.name] = { rx, tx, t: now };
      }
      if (Object.keys(next).length) setRates((prevRates) => ({ ...prevRates, ...next }));

      setLastUpdate(now);
      setPoll((n) => n + 1);
    };
    const onStatus = (data: { id: number | string; status: string }) => {
      if (String(data?.id) !== String(d.id)) return;
      setD((prev) => (data.status === "Offline"
        ? { ...prev, status: "Offline", reachable: false, interfaces: [] }
        : { ...prev, status: data.status }));
      setLastUpdate(Date.now());
    };
    // New device_logs entries are broadcast; add ours to the top so the log stays live.
    const onLog = (l: any) => {
      if (!l || String(l.device_id) !== String(d.id)) return;
      setLogs((prev) => [
        { log_level: l.log_level, message: l.message, recorded_at: l.recorded_at },
        ...prev,
      ].slice(0, 50));
    };
    socket.on("networkMetrics", onMetrics);
    socket.on("networkStatus", onStatus);
    socket.on("deviceLog", onLog);
    return () => {
      socket.off("networkMetrics", onMetrics);
      socket.off("networkStatus", onStatus);
      socket.off("deviceLog", onLog);
    };
  }, [d.id]);

  // Re-fetch on each poll (~30s) so the chart stays current, using the server's own
  // derivative. A custom window is a fixed past period, so it is not re-fetched.
  useEffect(() => {
    const custom = range.kind === "custom" ? { start: range.start, stop: range.stop } : undefined;
    api
      .getMikrotikHistory(Number(d.id), range.kind === "preset" ? range.preset : "", chartPort || undefined, custom)
      .then((r) => {
        if (r.success && r.data) {
          setHistory(r.data.history ?? []);
          // Already in the response — networkHistoryHandler serves this route too and
          // has always returned both halves; this page simply never read the second one.
          setIcmp(r.data.icmp ?? []);
          setRangeError("");
        } else {
          setRangeError(r.error || "Could not load history.");
        }
      });
  }, [d.id, range, chartPort, range.kind === "custom" ? 0 : poll]);

  useEffect(() => {
    api.getMikrotikLogs(Number(d.id)).then((r) => {
      if (r.success && r.data) setLogs(r.data.logs ?? []);
    });
  }, [d.id]);

  const ifaces = d.interfaces ?? [];
  const portsUp = ifaces.filter((i) => i.linkUp).length;

  // `monitored` and `everUp` are in network_interfaces, not in the poll data, so opening
  // the editor fetches them. A port with no row gets the backend defaults: never
  // connected, monitoring on.
  const startLabelEdit = async () => {
    const draft: Record<string, string> = {};
    for (const i of ifaces) draft[i.name] = i.locationLabel ?? "";
    setLabelDraft(draft);
    setEditLabels(true);

    const r = await api.getMikrotikInterfaces(Number(d.id));
    const rows: any[] = (r.success && r.data?.interfaces) || [];
    const gate: Record<string, PortGate> = {};
    for (const i of ifaces) gate[i.name] = { monitored: true, everUp: false };
    for (const row of rows) {
      if (!gate[row.name]) continue;
      gate[row.name] = { monitored: row.monitored !== false, everUp: Boolean(row.everUp) };
    }
    setGateDraft(gate);
  };

  const saveLabels = async () => {
    setSavingLabels(true);
    const labels = Object.entries(labelDraft).map(([name, label]) => ({
      name,
      label,
      monitored: gateDraft[name]?.monitored !== false,
    }));
    const r = await api.saveMikrotikInterfaces(Number(d.id), labels);
    setSavingLabels(false);
    if (!r.success) {
      alert(r.error ?? "Failed to save port labels.");
      return;
    }
    // Apply locally too — the server also broadcasts, but this makes it instant.
    setD((prev) => ({
      ...prev,
      interfaces: prev.interfaces.map((i) => ({ ...i, locationLabel: (labelDraft[i.name] ?? "").trim() })),
    }));
    setEditLabels(false);
  };
  const cpu = Math.round(d.cpuPercent ?? 0);
  const mem = Math.round(d.memPercent ?? 0);
  const latest = history.length ? history[history.length - 1] : undefined;
  // Headline uses the last non-null ICMP sample, since the series can end on an empty
  // window.
  const lastReal = (a: (number | null)[]) => {
    for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i] as number;
    return null;
  };
  const latencyNow = lastReal(icmp.map((p) => p.latencyMs));
  const lossNow = lastReal(icmp.map((p) => p.packetLossPct));

  return (
    <div className="flex flex-col gap-2.5" style={{ background: gf.bg, minHeight: "100%", padding: 12 }}>
      {/* Header wraps on a phone, so the router name and subtitle are not squeezed to ~70px by
         the back button and the status block. */}
      <div className="flex items-center gap-3 px-0.5 flex-wrap">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-[15px] transition-colors text-[var(--gf-text-muted)] hover:text-[var(--gf-text-primary)]"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          All MikroTiks
        </button>
        {/* Takes the full width on its own line below `sm`, so nothing else competes. */}
        <div className="min-w-0 w-full sm:w-auto order-last sm:order-none">
          <h1 className="text-[16px] sm:text-[15px] font-semibold sm:truncate" style={{ color: gf.textPrimary }}>{d.name}</h1>
          {/* Wraps on a phone instead of truncating, so the IP and model stay visible. textMuted
             instead of textDim for enough contrast at this size. */}
          <div className="text-[13px] sm:truncate leading-relaxed" style={{ color: gf.textMuted }}>
            {d.location} · <span className="whitespace-nowrap">{d.ip}</span>
            {d.routerosVersion ? <> · <span className="whitespace-nowrap">RouterOS {d.routerosVersion}</span></> : null}
            {d.boardModel ? <> · <span className="whitespace-nowrap">{d.boardModel}</span></> : null}
          </div>
        </div>
        <span className="ml-auto flex items-center gap-2 shrink-0 flex-wrap justify-end">
          {onConfigure && (
            <button
              onClick={onConfigure}
              className="text-[13px] font-medium px-2.5 py-1 rounded-md transition-colors active:scale-95"
              style={{ color: gf.textMuted, border: `1px solid ${gf.border}`, background: "transparent" }}
            >
              Configure
            </button>
          )}
          <span className="inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor(d.status), boxShadow: `0 0 5px ${statusColor(d.status)}` }} />
            <span className="text-[13px]" style={{ color: gf.textMuted }}>{d.status}</span>
          </span>
          {/* Makes "live" verifiable — you can see the poll landing. */}
          <span className="text-[12px] hidden sm:inline" style={{ color: gf.textDim }}>
            {lastUpdate
              ? `updated ${new Date(lastUpdate).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour12: false })}`
              : "awaiting poll…"}
          </span>
        </span>
      </div>

      {!d.monitored && (
        <div className="text-[13px] px-3 py-2 rounded-[2px]" style={{ color: ORANGE, background: ORANGE + "14", border: `1px solid ${ORANGE}40` }}>
          API not configured — set the read-only RouterOS login (admin) before this router can be polled.
        </div>
      )}

      {/* Stats */}
      {/* Latency and loss are measured on every poll and were already driving alerts
          and Analytics — the router's own page was the one place they weren't visible. */}
      {/* auto-fit instead of a fixed column count: the number of tiles varies (4 for a ping-only
         router, 7 for SNMP and MikroTik), and a fixed grid leaves an uneven last row. */}
      <div
        className="grid gap-2.5"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}
      >
        <Stat label="Status" value={d.status} color={statusColor(d.status)} sub={d.reachable ? "reachable" : "—"} />
        <Stat label="CPU" value={d.cpuPercent != null ? String(cpu) : "—"} unit={d.cpuPercent != null ? "%" : undefined} color={loadColor(cpu)} sub="router load" />
        <Stat label="Memory" value={d.memPercent != null ? String(mem) : "—"} unit={d.memPercent != null ? "%" : undefined} color={loadColor(mem)} sub="router RAM" />
        <Stat label="Ports Up" value={`${portsUp}/${ifaces.length}`} color={ifaces.length > 0 && portsUp === ifaces.length ? GREEN : portsUp === 0 ? RED : ORANGE} sub="links online" />
        {/* Counts bound DHCP leases, not live connections; a lease lasts until it expires. */}
        <Stat label="DHCP Leases" value={d.connectedClients != null ? String(d.connectedClients) : "—"} color={BLUE} sub="bound" />
        <Stat
          label="Latency"
          value={d.latencyMs == null ? "—" : String(Math.round(d.latencyMs))}
          {...(d.latencyMs == null ? {} : { unit: "ms" })}
          color={d.latencyMs == null ? gf.textMuted : d.latencyMs > 150 ? ORANGE : GREEN}
          sub="round trip"
        />
        <Stat
          label="Packet Loss"
          value={d.packetLossPct == null ? "—" : String(Math.round(d.packetLossPct))}
          {...(d.packetLossPct == null ? {} : { unit: "%" })}
          color={
            d.packetLossPct == null ? gf.textMuted
              : d.packetLossPct >= 20 ? RED
              : d.packetLossPct > 0 ? ORANGE
              : GREEN
          }
          sub="of echoes sent"
        />
      </div>

      {/* Throughput history */}
      <Panel
        title={chartPort ? `Throughput · ${chartPort}` : "Total Throughput"}
        right={
          <div className="flex items-center gap-2 flex-wrap">
            {/* Per-port history. `max-w` + `truncate` so a long option does not push the range
               buttons off the row on a phone. */}
            <select name="chartPort"
              value={chartPort}
              onChange={(e) => setChartPort(e.target.value)}
              className="text-[12px] px-1.5 py-0.5 rounded-[2px] outline-none max-w-[45vw] sm:max-w-none truncate"
              style={{ background: gf.bg, border: `1px solid ${gf.border}`, color: gf.textPrimary }}
            >
              <option value="">All ports</option>
              {ifaces.map((i) => (
                <option key={i.name} value={i.name}>
                  {i.locationLabel ? `${i.name} — ${i.locationLabel}` : i.name}
                </option>
              ))}
            </select>
            <span className="text-[12px]" style={{ color: BLUE }}>In {formatBps(latest?.rxBytesPerSec ?? null)}</span>
            <span className="text-[12px]" style={{ color: GREEN }}>Out {formatBps(latest?.txBytesPerSec ?? null)}</span>
            <RangePicker value={range} onChange={setRange} error={rangeError || undefined} />
          </div>
        }
      >
        <ThroughputChart history={history} spanSec={rangeSpanSec(range)} />
      </Panel>

      {/* ICMP history (see IcmpChart). The Throughput panel above has the range picker, and both
         charts follow it. */}
      <Panel
        title="ICMP · Latency & Packet Loss"
        right={
          <div className="flex items-center gap-2 flex-wrap">
            {/* Same colour ladder as the Latency / Packet Loss tiles further up the
                page, so one reading is never green in one place and orange in another. */}
            <span className="text-[12px]" style={{ color: LATENCY }}>
              Latency{" "}
              <span style={{ color: latencyNow == null ? gf.textMuted : latencyNow > 150 ? ORANGE : gf.textPrimary }}>
                {latencyNow == null ? "—" : `${Math.round(latencyNow)} ms`}
              </span>
            </span>
            <span className="text-[12px]" style={{ color: LOSS }}>
              Loss{" "}
              <span
                style={{
                  color:
                    lossNow == null ? gf.textMuted
                      : lossNow >= 20 ? RED
                      : lossNow > 0 ? ORANGE
                      : GREEN,
                }}
              >
                {lossNow == null ? "—" : `${Math.round(lossNow)}%`}
              </span>
            </span>
          </div>
        }
      >
        <IcmpChart history={icmp} spanSec={rangeSpanSec(range)} />
      </Panel>

      {/* Physical ports */}
      <Panel
        title={`Ports · ${portsUp}/${ifaces.length} up`}
        right={
          isAdmin && ifaces.length > 0 ? (
            editLabels ? (
              <span className="flex items-center gap-2">
                <button onClick={() => setEditLabels(false)} disabled={savingLabels}
                  className="text-[12px] px-2 py-0.5 rounded-[2px]"
                  style={{ color: gf.textMuted, border: `1px solid ${gf.border}` }}>Cancel</button>
                <button onClick={saveLabels} disabled={savingLabels}
                  className="gf-raise text-[12px] px-2 py-0.5 rounded-[2px] font-semibold"
                  style={{ background: BLUE, color: "#fff", opacity: savingLabels ? 0.6 : 1 }}>
                  {savingLabels ? "Saving…" : "Save labels"}
                </button>
              </span>
            ) : (
              <button onClick={startLabelEdit}
                className="text-[12px] px-2 py-0.5 rounded-[2px]"
                style={{ color: gf.textMuted, border: `1px solid ${gf.border}` }}>
                Edit labels
              </button>
            )
          ) : undefined
        }
        noPad
      >
        {ifaces.length === 0 ? (
          <div className="px-3 py-4 text-[13px]" style={{ color: gf.textDim }}>
            {d.status === "Online" ? "No ports reported." : "Offline — awaiting next poll."}
          </div>
        ) : editLabels ? (
          <div className="flex flex-col">
            <div className="px-3 py-2 text-[12px]" style={{ color: gf.textDim, borderBottom: `1px solid ${gf.divider}` }}>
              Name each port by what it connects to. Leave blank to show the raw RouterOS name.
              Only a port that is enabled and has carried a link before can raise an
              interface-down alert — empty sockets stay quiet on their own.
            </div>
            {ifaces.map((i) => {
              const gate = gateDraft[i.name];
              const state = portAlertState(i, gate);
              const muted = gate ? !gate.monitored : false;
              return (
                <div key={i.name} className="flex items-center gap-3 px-3 py-2" style={{ borderBottom: `1px solid ${gf.divider}` }}>
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: i.linkUp ? GREEN : RED }} />
                  <span className="w-28 shrink-0 text-[14px] font-medium truncate" style={{ color: gf.textPrimary }}>{i.name}</span>
                  <input name="labelDraft"
                    value={labelDraft[i.name] ?? ""}
                    maxLength={100}
                    onChange={(e) => setLabelDraft((p) => ({ ...p, [i.name]: e.target.value }))}
                    placeholder="e.g. ISP uplink, Admin building"
                    className="flex-1 min-w-0 px-2 py-1 text-[14px] rounded-[2px] outline-none"
                    style={{ background: gf.bg, border: `1px solid ${gf.border}`, color: gf.textPrimary }}
                  />
                  {/* Why this port is or is not alerting, e.g. quiet because nothing was ever plugged in. */}
                  <span className="w-40 shrink-0 text-[11px] text-right truncate"
                    title={state.text}
                    style={{ color: state.alerting ? RED : gf.textDim }}>
                    {state.text}
                  </span>
                  <label className="flex items-center gap-1.5 shrink-0 text-[11px] cursor-pointer select-none"
                    title="Uncheck to never raise interface-down alerts for this port">
                    <input name="muteLinkAlerts"
                      type="checkbox"
                      checked={!muted}
                      disabled={!gate}
                      onChange={(e) =>
                        setGateDraft((p) => ({
                          ...p,
                          [i.name]: { ...(p[i.name] ?? { everUp: false }), monitored: e.target.checked },
                        }))
                      }
                      style={{ accentColor: BLUE }}
                    />
                    <span style={{ color: gf.textMuted }}>Alerts</span>
                  </label>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <Th w={34}>{" "}</Th>
                  <Th>Name</Th>
                  <Th>Label</Th>
                  <Th right>Speed</Th>
                  <Th right>Tx</Th>
                  <Th right>Rx</Th>
                  <Th right>Errors</Th>
                  <Th right>Leases</Th>
                  <Th right>Util</Th>
                </tr>
              </thead>
              <tbody>
                {ifaces.map((i) => <PortRow key={i.name} i={i} rate={rates[i.name]} />)}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* Connection (read-only; edit via Configure) */}
      <Panel title="RouterOS Connection">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[13px]" style={{ color: gf.textMuted }}>
          <span>Host <span style={{ color: gf.textPrimary }}>{d.ip}</span></span>
          <span>Port <span style={{ color: gf.textPrimary }}>{d.apiPort ?? "—"}</span></span>
          <span>TLS <span style={{ color: d.useTls ? GREEN : gf.textDim }}>{d.useTls ? "on (API-SSL)" : "off"}</span></span>
          <span>User <span style={{ color: gf.textPrimary }}>{d.apiUsername || "—"}</span></span>
          <span>Uptime <span style={{ color: gf.textPrimary }}>{formatUptime(d.uptimeSeconds)}</span></span>
        </div>
        <p className="text-[11px] mt-2" style={{ color: gf.textDim }}>
          The API password is stored encrypted (AES-256-GCM) and is never returned to the dashboard.
        </p>
      </Panel>

      {/* Recent events (device_logs), like ServerDetail's panel: the message comes first and
         wraps, with the time below, so the message is never cut off. */}
      <Panel
        title="Recent Events"
        right={logs.length > 0 ? <span className="text-[12px]" style={{ color: gf.textDim }}>{logs.length}</span> : undefined}
      >
        {logs.length === 0 ? (
          <div className="text-[13px] py-5 text-center" style={{ color: gf.textDim }}>No events logged yet.</div>
        ) : (
          // Scrolls rather than hard-capping the render at 30. The API returns up to 50
          // and the live socket feed keeps 50, so the whole list stays reachable.
          <div className="flex flex-col max-h-72 overflow-y-auto">
            {logs.map((l, i) => (
              <div key={i} className="flex items-start gap-2.5 py-2" style={{ borderTop: i > 0 ? `1px solid ${gf.divider}` : "none" }}>
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: logColor(l.log_level) }} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] break-words" style={{ color: gf.textPrimary }}>{l.message}</div>
                  <div className="text-[12px] mt-0.5" style={{ color: gf.textDim }}>{fmtDateTime(l.recorded_at)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
