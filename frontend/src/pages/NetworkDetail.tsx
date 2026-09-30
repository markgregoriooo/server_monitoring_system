import { useState, useEffect, useRef } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import Chart from "../chart/ChartConfig";
import RangePicker, { DEFAULT_RANGE } from "../components/ui/RangePicker";
import type { RangeValue } from "../components/ui/RangePicker";
import { withGaps } from "../utils/seriesGaps";
import { formatBps } from "../utils/format";
import { GF as gf, STATUS } from "../theme/gf";
import { formatUptime, fmtDateTime, formatSpeed } from "../utils/format";
import { Stat, Th } from "../components/ui/primitives";
const { green: GREEN, orange: ORANGE, red: RED, blue: BLUE } = STATUS;

// ─── Router detail view (throughput, ports, log) ────────────────────────
// Opened from NetworkMonitoring via "View" and replaces the list in place (Back
// button), like ServerMetrics ↔ ServerDetail and MikrotikMonitoring ↔ MikrotikDetail.
// Ports and uptime update live from `networkMetrics`; throughput history is fetched per
// range. Types are defined here so the list can import them without a circular import.
// Laid out like MikrotikDetail so both pages feel the same.

export interface NetIface {
  name: string;
  locationLabel: string; // friendly label from network_interfaces
  linkUp: boolean;
  utilizationPct: number | null;
  rxBytes: string | null;
  txBytes: string | null;
  speedMbps?: number | null;
  rxErrors?: number | null;
  txErrors?: number | null;
}
// Per-port throughput worked out here from the byte counters between two polls. The API
// only gives totals, so otherwise a port would only show a utilization %, which reads 0%
// when the link speed is unknown.
export interface PortRate { rxBps: number; txBps: number }
export interface NetDevice {
  id: string;
  name: string;
  ip: string;
  location: string;
  status: string;
  reachable: boolean | null;
  uptimeSeconds: number | null;
  cpuPercent?: number | null;
  memPercent?: number | null;
  interfaces: NetIface[];
  monitored: boolean;
  // How this device is monitored. 'snmp' = full read (interfaces, traffic, uptime).
  // 'ping' = ICMP only, for a router with no community (usually ISP equipment). A ping
  // device never reports interfaces, so the UI says so instead of showing an empty port list.
  mode?: "snmp" | "ping";
  // ICMP, present in both modes. The only live numbers a ping device has.
  latencyMs?: number | null;
  packetLossPct?: number | null;
  descr?: string | null; // sysDescr — vendor/model string reported by the device
  sysName?: string | null; // sysName — the hostname the device calls itself
}
interface HistPoint { time: string; rxBytesPerSec: number | null; txBytesPerSec: number | null; }
// The ICMP part of the same response: its own array and timestamps, never merged into
// HistPoint, since the two land in different windows and merging would put nulls in
// every other row. See backend/handlers/networkHistoryHandler.js.
interface IcmpPoint { time: string; latencyMs: number | null; packetLossPct: number | null; }
interface DeviceLog { log_level: "info" | "warning" | "critical" | "error"; message: string; recorded_at: string; }



function loadColor(v: number) { if (v >= 85) return RED; if (v >= 65) return ORANGE; return GREEN; }
function statusColor(s: string) { if (s === "Online") return GREEN; if (s === "Warning") return ORANGE; return RED; }
function logColor(level: string) { if (level === "critical" || level === "error") return RED; if (level === "warning") return ORANGE; return BLUE; }
// formatBps is in utils/format.ts (the Dashboard uses it too).
// Chart.js line chart, same config as MikrotikDetail.
function ThroughputChart({ history }: { history: HistPoint[] }) {
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
      history.map((p) =>
        new Date(p.time).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", hour12: false }),
      ),
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
  }, [history]);
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

// ICMP colours, the same as the Dashboard's network panel: latency cyan, loss red (any
// loss is a fault; the seeded router_loss rule alerts above 0%).
const LATENCY = "#3CC8E8";
const LOSS = RED;

// ─── ICMP history (latency + packet loss) ─────────────────────────────────────
// Shown in both modes: ping runs alongside the SNMP walk on every router, and latency and
// loss are what SNMP cannot report. Two axes (latency left, loss right), since ms and %
// are different units.
function IcmpChart({ history }: { history: IcmpPoint[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  useEffect(() => {
    if (!ref.current || history.length < 2) {
      chartRef.current?.destroy();
      chartRef.current = null;
      return;
    }
    chartRef.current?.destroy();
    // Same gap treatment as the throughput chart: a poller that stopped reads as a hole
    // with a start and an end, not as a straight line drawn across the outage.
    const gapped = withGaps(
      history.map((p) => Date.parse(p.time)),
      history.map((p) =>
        new Date(p.time).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", hour12: false }),
      ),
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
          // The unit has to follow the SERIES, not the panel — the two lines are on
          // different axes, so one shared suffix would be wrong for one of them.
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
          // line does not look like big swings. suggestedMax is a minimum for the axis top, so a
          // 40 ms ISP link still fits.
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
            // No second set of gridlines over the plot — one grid, from the left axis.
            grid: { drawOnChartArea: false },
          },
        },
      },
    });
    return () => { chartRef.current?.destroy(); };
  }, [history]);
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
    // `overflow-visible` so the range dropdown in the header is not clipped.
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
// Numbers rather than progress bars, as in MikrotikDetail: an idle port is normal and an
// empty bar looks like a loading placeholder, and it matches the WinBox view operators
// know. Colours use --gf-* tokens and status colours.

function PortRow({ i, rate, errDelta }: { i: NetIface; rate?: PortRate | undefined; errDelta?: number | undefined }) {
  const hasUtil = i.utilizationPct != null && Number.isFinite(i.utilizationPct);
  const util = Math.round(i.utilizationPct ?? 0);
  const speed = formatSpeed(i.speedMbps);
  const down = !i.linkUp;
  const td = "px-2 py-1.5 text-[13px] tabular-nums whitespace-nowrap";
  const dim = { color: gf.textDim } as const;

  return (
    <tr style={{ borderTop: `1px solid ${gf.divider}` }}>
      {/* WinBox's flags column: R = running */}
      <td className={`${td} text-center font-bold`} style={{ color: down ? gf.textDim : GREEN }}>
        {down ? "" : "R"}
      </td>
      <td className={td} style={{ color: down ? gf.textMuted : gf.textPrimary }}>{i.name}</td>
      <td className={`${td} truncate`} style={{ ...dim, maxWidth: 180 }}>{i.locationLabel || "—"}</td>
      <td className={`${td} text-right`} style={dim}>{speed ?? "—"}</td>
      <td className={`${td} text-right`} style={{ color: down ? gf.textDim : GREEN }}>
        {down ? "—" : formatBps(rate?.txBps ?? null)}
      </td>
      <td className={`${td} text-right`} style={{ color: down ? gf.textDim : BLUE }}>
        {down ? "—" : formatBps(rate?.rxBps ?? null)}
      </td>
      {/* Errors since the last poll, not the lifetime total: new errors point to a bad cable,
         dying SFP or duplex mismatch. */}
      <td className={`${td} text-right`} style={{ color: errDelta ? ORANGE : gf.textDim }}>
        {errDelta ? `+${errDelta}` : "0"}
      </td>
      <td className={`${td} text-right font-bold`} style={{ color: down ? RED : hasUtil ? loadColor(util) : gf.textDim }}>
        {down ? "down" : hasUtil ? `${util}%` : "—"}
      </td>
    </tr>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function NetworkDetail({
  device, onBack, isAdmin = false,
}: {
  device: NetDevice;
  onBack: () => void;
  isAdmin?: boolean;
}) {
  const [d, setD] = useState<NetDevice>(device);
  const [range, setRange] = useState<RangeValue>(DEFAULT_RANGE);
  const [rangeError, setRangeError] = useState("");
  const [history, setHistory] = useState<HistPoint[]>([]);
  // Kept separately from `history` for the reason given on IcmpPoint: one request,
  // two series, two sets of timestamps.
  const [icmp, setIcmp] = useState<IcmpPoint[]>([]);
  const [logs, setLogs] = useState<DeviceLog[]>([]);
  // Bumped on every poll for this device — a history-refetch trigger so the chart
  // tracks live data instead of freezing at whatever was loaded on mount.
  const [poll, setPoll] = useState(0);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  // "" = all ports summed (device total); otherwise a single port name.
  const [chartPort, setChartPort] = useState("");
  const [rates, setRates] = useState<Record<string, PortRate>>({});
  const [errDeltas, setErrDeltas] = useState<Record<string, number>>({});
  // Port-label editing (network_interfaces.location_label). `draft` holds in-progress
  // edits keyed by port name; only populated while the editor is open.
  const [editLabels, setEditLabels] = useState(false);
  const [labelDraft, setLabelDraft] = useState<Record<string, string>>({});
  const [savingLabels, setSavingLabels] = useState(false);
  const [labelError, setLabelError] = useState("");
  // Previous cumulative counters per port, to derive per-port bytes/sec on the next
  // poll. BigInt because these are Counter64 values beyond Number's safe range.
  const prevCounters = useRef<Record<string, { rx: bigint; tx: bigint; err: number; t: number }>>({});

  const toBig = (v: string | null | undefined): bigint | null => {
    if (v == null) return null;
    try { return BigInt(v); } catch { return null; }
  };

  // Keep the open device in sync when the parent list refreshes.
  useEffect(() => { setD(device); }, [device]);

  useEffect(() => {
    const onMetrics = (data: { device: any }) => {
      // `networkMetrics` is SHARED with the MikroTik page — take only ours.
      if (!data?.device || String(data.device.id) !== String(d.id)) return;
      setD((prev) => ({
        ...prev,
        status: data.device.status ?? prev.status,
        reachable: data.device.reachable ?? prev.reachable,
        descr: data.device.descr ?? prev.descr,
        sysName: data.device.sysName ?? prev.sysName,
        uptimeSeconds: data.device.uptimeSeconds ?? prev.uptimeSeconds,
        interfaces: data.device.interfaces ?? prev.interfaces,
      }));

      // Per-port throughput and error change since the last poll. A negative change (counter
      // wrap or reboot) is dropped, as the poller does.
      const now = Date.now();
      const nextRates: Record<string, PortRate> = {};
      const nextErrs: Record<string, number> = {};
      for (const iface of (data.device.interfaces ?? []) as NetIface[]) {
        const rx = toBig(iface.rxBytes);
        const tx = toBig(iface.txBytes);
        const err = Number(iface.rxErrors ?? 0) + Number(iface.txErrors ?? 0);
        if (rx == null || tx == null) continue;
        const prev = prevCounters.current[iface.name];
        if (prev) {
          const dt = (now - prev.t) / 1000;
          if (dt > 0) {
            nextRates[iface.name] = {
              rxBps: rx >= prev.rx ? Number(rx - prev.rx) / dt : 0,
              txBps: tx >= prev.tx ? Number(tx - prev.tx) / dt : 0,
            };
          }
          nextErrs[iface.name] = err >= prev.err ? err - prev.err : 0;
        }
        prevCounters.current[iface.name] = { rx, tx, err, t: now };
      }
      if (Object.keys(nextRates).length) setRates((p) => ({ ...p, ...nextRates }));
      if (Object.keys(nextErrs).length) setErrDeltas((p) => ({ ...p, ...nextErrs }));

      setLastUpdate(now);
      setPoll((n) => n + 1);
    };
    const onStatus = (data: { id: number | string; status: string }) => {
      if (String(data?.id) !== String(d.id)) return;
      // Keep the last-known ports when the router drops — they're the context for
      // WHAT went down, and the poller's cache preserves them too.
      setD((prev) => (data.status === "Offline" ? { ...prev, status: "Offline", reachable: false } : { ...prev, status: data.status }));
      setLastUpdate(Date.now());
    };
    // New device_logs entries are broadcast; add ours to the top so the log stays live.
    const onLog = (l: any) => {
      if (!l || String(l.device_id) !== String(d.id)) return;
      setLogs((prev) => [{ log_level: l.log_level, message: l.message, recorded_at: l.recorded_at }, ...prev].slice(0, 50));
    };
    // Another admin renamed a port — mirror it live.
    const onLabel = (p: { id: number | string; interfaceName: string; locationLabel: string }) => {
      if (String(p?.id) !== String(d.id)) return;
      setD((prev) => ({
        ...prev,
        interfaces: prev.interfaces.map((i) => (i.name === p.interfaceName ? { ...i, locationLabel: p.locationLabel } : i)),
      }));
    };
    socket.on("networkMetrics", onMetrics);
    socket.on("networkStatus", onStatus);
    socket.on("deviceLog", onLog);
    socket.on("networkInterfaceLabel", onLabel);
    return () => {
      socket.off("networkMetrics", onMetrics);
      socket.off("networkStatus", onStatus);
      socket.off("deviceLog", onLog);
      socket.off("networkInterfaceLabel", onLabel);
    };
  }, [d.id]);

  // Re-fetch on each poll (~60s) so the chart stays current, using the server's own
  // derivative. A custom window is a fixed past period, so it is not re-fetched.
  useEffect(() => {
    const custom = range.kind === "custom" ? { start: range.start, stop: range.stop } : undefined;
    api
      .getNetworkHistory(Number(d.id), range.kind === "preset" ? range.preset : "", chartPort || undefined, custom)
      .then((r) => {
        if (r.success && r.data) {
          setHistory(r.data.history ?? []);
          // Already in the response — the endpoint has always returned both halves for
          // every router; this page simply never read the second one.
          setIcmp(r.data.icmp ?? []);
          setRangeError("");
        } else {
          setRangeError(r.error || "Could not load history.");
        }
      });
  }, [d.id, range, chartPort, range.kind === "custom" ? 0 : poll]);

  useEffect(() => {
    api.getNetworkLogs(Number(d.id)).then((r) => {
      if (r.success && r.data) setLogs(r.data.logs ?? []);
    });
  }, [d.id]);

  const ifaces = d.interfaces ?? [];
  // ICMP-only device (no SNMP community). It reports reachability, latency and loss
  // and nothing else — so several panels below are not "empty", they are inapplicable.
  const pingMode = d.mode === "ping";
  const portsUp = ifaces.filter((i) => i.linkUp).length;
  const upUtil = ifaces.filter((i) => i.linkUp && i.utilizationPct != null).map((i) => i.utilizationPct as number);
  // Worst port, not the average: one saturated uplink is the whole story, and
  // averaging it against idle ports hides exactly the link that needs attention.
  const worstUtil = upUtil.length ? Math.round(Math.max(...upUtil)) : 0;
  const totalErrs = Object.values(errDeltas).reduce((a, b) => a + b, 0);
  const latest = history.length ? history[history.length - 1] : undefined;
  // Headline uses the last non-null ICMP sample, since the series can end on an empty
  // window.
  const lastReal = (a: (number | null)[]) => {
    for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i] as number;
    return null;
  };
  const latencyNow = lastReal(icmp.map((p) => p.latencyMs));
  const lossNow = lastReal(icmp.map((p) => p.packetLossPct));

  const startLabelEdit = () => {
    const draft: Record<string, string> = {};
    for (const i of ifaces) draft[i.name] = i.locationLabel ?? "";
    setLabelDraft(draft);
    setLabelError("");
    setEditLabels(true);
  };

  // Save only the ports whose label actually changed — one PATCH each (the endpoint
  // is per-interface). Reports the first failure rather than pretending it worked.
  const saveLabels = async () => {
    setSavingLabels(true);
    setLabelError("");
    const changed = ifaces.filter((i) => (labelDraft[i.name] ?? "").trim() !== (i.locationLabel ?? ""));
    let failure = "";
    for (const i of changed) {
      const r = await api.setNetworkInterfaceLabel(Number(d.id), i.name, (labelDraft[i.name] ?? "").trim());
      if (!r.success) { failure = r.error || `Could not save ${i.name}.`; break; }
    }
    setSavingLabels(false);
    if (failure) { setLabelError(failure); return; }
    setD((prev) => ({
      ...prev,
      interfaces: prev.interfaces.map((i) => ({ ...i, locationLabel: (labelDraft[i.name] ?? i.locationLabel ?? "").trim() })),
    }));
    setEditLabels(false);
  };

  return (
    <div className="flex flex-col gap-2.5" style={{ background: gf.bg, minHeight: "100%", padding: 12 }}>
      {/* Header — wraps so the status + "updated" cluster drops to its own line on a
          phone rather than crushing the device name into a couple of characters. */}
      <div className="flex items-center gap-x-3 gap-y-1 px-0.5 flex-wrap">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-[15px] transition-colors text-[var(--gf-text-muted)] hover:text-[var(--gf-text-primary)]"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          All routers
        </button>
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold truncate" style={{ color: gf.textPrimary }}>{d.name}</h1>
          <div className="text-[13px] truncate" style={{ color: gf.textDim }}>
            {d.location} · {d.ip}
            {d.sysName ? ` · ${d.sysName}` : ""}
          </div>
          {/* sysDescr: the vendor/model string straight off the device (MIB-II). */}
          {d.descr && (
            <div className="text-[12px] truncate" style={{ color: gf.textDim }} title={d.descr}>{d.descr}</div>
          )}
        </div>
        <span className="ml-auto flex items-center gap-2 shrink-0">
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

      {/* A ping device is working as intended, so say what it covers rather than what is missing. */}
      {pingMode && (
        <div className="text-[13px] px-3 py-2 rounded-[2px]" style={{ color: gf.textMuted, background: gf.hover, border: `1px solid ${gf.border}` }}>
          <span style={{ color: gf.textPrimary }}>Ping-only monitoring.</span> No SNMP community is
          set for this device, so it is polled by ICMP: reachability, latency and packet loss.
          Per-port traffic, link status and uptime need SNMP enabled on the device — usually not
          possible on ISP-owned equipment.
        </div>
      )}

      {/* A ping device gets its own set of tiles instead of zeros ("Ports Up 0/0", "Peak Util
         0%") that would make it look broken. */}
      {/* Latency and loss are shown for every router, since ping runs alongside the SNMP walk. */}
      {/* auto-fit instead of a fixed column count: the number of tiles varies (4 for a ping-only
         router, 7 for SNMP and MikroTik), and a fixed grid leaves an uneven last row. */}
      <div
        className="grid gap-2.5"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}
      >
        <Stat label="Status" value={d.status} color={statusColor(d.status)} sub={d.reachable ? "reachable" : "—"} />
        {pingMode ? (
          <>
            <Stat
              label="Latency"
              value={d.latencyMs == null ? "—" : String(d.latencyMs)}
              {...(d.latencyMs == null ? {} : { unit: "ms" })}
              color={d.latencyMs == null ? gf.textMuted : d.latencyMs > 150 ? ORANGE : GREEN}
              sub="round trip"
            />
            <Stat
              label="Packet Loss"
              value={d.packetLossPct == null ? "—" : String(d.packetLossPct)}
              {...(d.packetLossPct == null ? {} : { unit: "%" })}
              color={
                d.packetLossPct == null ? gf.textMuted
                  : d.packetLossPct >= 50 ? RED
                  : d.packetLossPct > 0 ? ORANGE
                  : GREEN
              }
              sub="of echoes sent"
            />
            <Stat label="Mode" value="ICMP" color={BLUE} sub="no SNMP community" />
          </>
        ) : (
          <>
            <Stat label="Ports Up" value={`${portsUp}/${ifaces.length}`} color={ifaces.length > 0 && portsUp === ifaces.length ? GREEN : portsUp === 0 ? RED : ORANGE} sub="links online" />
            <Stat label="Peak Util" value={String(worstUtil)} unit="%" color={loadColor(worstUtil)} sub={upUtil.length > 1 ? `busiest of ${upUtil.length}` : "of link speed"} />
            <Stat label="Errors" value={String(totalErrs)} color={totalErrs > 0 ? ORANGE : GREEN} sub="since last poll" />
            <Stat label="Uptime" value={formatUptime(d.uptimeSeconds)} color={BLUE} sub="since boot" />
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
          </>
        )}
      </div>

      {/* Throughput history, hidden for a ping device (it has no byte counters, so "No data in
         range" would show forever). */}
      {!pingMode && (
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
        <ThroughputChart history={history} />
      </Panel>
      )}

      {/* ICMP history in both modes (see IcmpChart). For a ping device it is the only chart, so
         it has the range picker; in SNMP mode the Throughput panel has it and both charts follow. */}
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
            {pingMode && <RangePicker value={range} onChange={setRange} error={rangeError || undefined} />}
          </div>
        }
      >
        <IcmpChart history={icmp} />
      </Panel>

      {/* Physical ports */}
      <Panel
        title={pingMode ? "Physical ports" : `Ports · ${portsUp}/${ifaces.length} up`}
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
            {pingMode
              ? "Ping-only device — ICMP cannot see interfaces. This is expected, not a fault."
              : d.status === "Online"
                ? "No interfaces reported."
                : "Offline — awaiting next poll."}
          </div>
        ) : editLabels ? (
          <div className="flex flex-col">
            <div className="px-3 py-2 text-[12px]" style={{ color: gf.textDim, borderBottom: `1px solid ${gf.divider}` }}>
              Name each port by what it connects to. Leave blank to show the raw interface name.
            </div>
            {ifaces.map((i) => (
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
              </div>
            ))}
            {labelError && <div className="px-3 py-2 text-[12px]" style={{ color: RED }}>{labelError}</div>}
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
                  <Th right>Util</Th>
                </tr>
              </thead>
              <tbody>
                {ifaces.map((i) => <PortRow key={i.name} i={i} rate={rates[i.name]} errDelta={errDeltas[i.name]} />)}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* SNMP connection facts (read-only) */}
      <Panel title="SNMP Connection">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[13px]" style={{ color: gf.textMuted }}>
          <span>Host <span style={{ color: gf.textPrimary }}>{d.ip}</span></span>
          <span>Version <span style={{ color: gf.textPrimary }}>v2c</span></span>
          <span>Hostname <span style={{ color: gf.textPrimary }}>{d.sysName || "—"}</span></span>
          <span>Uptime <span style={{ color: gf.textPrimary }}>{formatUptime(d.uptimeSeconds)}</span></span>
        </div>
        <p className="text-[11px] mt-2" style={{ color: gf.textDim }}>
          Read via the standard MIB-II / IF-MIB objects, so no vendor-specific setup is needed.
          CPU and memory aren't shown: those OIDs are vendor-specific and not part of the standard MIBs.
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
