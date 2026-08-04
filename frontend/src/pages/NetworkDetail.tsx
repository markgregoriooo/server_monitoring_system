import { useState, useEffect, useRef } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import Chart from "../chart/ChartConfig";
import RangePicker, { DEFAULT_RANGE } from "../components/ui/RangePicker";
import type { RangeValue } from "../components/ui/RangePicker";

// ─── Per-router detail view (throughput + ports + log) ────────────────────────
// Reached from NetworkMonitoring via "View". In-page swap (Back button), mirroring
// ServerMetrics ↔ ServerDetail and MikrotikMonitoring ↔ MikrotikDetail. Ports/uptime
// stay live via `networkMetrics`; throughput history is fetched per range.
//
// Types live HERE (not in NetworkMonitoring) so the list can import them without a
// circular import — the list imports this module, never the other way round. Same
// arrangement as MikrotikDetail, which this page is deliberately modelled on: an
// operator moving between the MikroTik and SNMP pages should not have to relearn
// the layout just because the collection protocol differs.

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
// Per-port throughput derived on the client from the cumulative byte counters between
// two polls. The API only reports totals, so without this a port shows a bare
// utilization % — which reads "0%" whenever link speed is unknown, even under load.
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
  descr?: string | null; // sysDescr — vendor/model string reported by the device
  sysName?: string | null; // sysName — the hostname the device calls itself
}
interface HistPoint { time: string; rxBytesPerSec: number | null; txBytesPerSec: number | null; }
interface DeviceLog { log_level: "info" | "warning" | "critical" | "error"; message: string; recorded_at: string; }

const gf = {
  bg: "var(--gf-bg)", panel: "var(--gf-panel)", border: "var(--gf-panel-border)", divider: "var(--gf-divider)",
  textPrimary: "var(--gf-text-primary)", textMuted: "var(--gf-text-muted)", textDim: "var(--gf-text-dim)", hover: "var(--gf-hover)",
} as const;

const GREEN = "#73BF69";
const ORANGE = "#FF780A";
const RED = "#F2495C";
const BLUE = "#5794F2";

function loadColor(v: number) { if (v >= 85) return RED; if (v >= 65) return ORANGE; return GREEN; }
function statusColor(s: string) { if (s === "Online") return GREEN; if (s === "Warning") return ORANGE; return RED; }
function logColor(level: string) { if (level === "critical" || level === "error") return RED; if (level === "warning") return ORANGE; return BLUE; }
function formatBps(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const bits = n * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gb/s`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(2)} Mb/s`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(1)} kb/s`;
  return `${Math.round(bits)} b/s`;
}
function formatUptime(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.floor(sec), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function formatSpeed(mbps: number | null | undefined): string | null {
  if (mbps == null || !Number.isFinite(mbps) || mbps <= 0) return null;
  return mbps >= 1000
    ? `${(mbps / 1000).toFixed(mbps % 1000 === 0 ? 0 : 1)} Gb/s`
    : `${Math.round(mbps)} Mb/s`;
}
function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-PH", {
    timeZone: "Asia/Manila", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

// Chart.js line chart — same config as MikrotikDetail so both network pages read alike.
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
    const labels = history.map((p) =>
      new Date(p.time).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", hour12: false }),
    );
    chartRef.current = new Chart(ref.current, {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "In (Rx)", data: history.map((p) => p.rxBytesPerSec ?? 0), borderColor: BLUE, backgroundColor: BLUE + "22", borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3 },
          { label: "Out (Tx)", data: history.map((p) => p.txBytesPerSec ?? 0), borderColor: GREEN, backgroundColor: GREEN + "22", borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3 },
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
        <div className="flex items-center justify-center h-full text-[11px]" style={{ color: gf.textDim }}>No data in range</div>
      ) : (
        <canvas ref={ref} />
      )}
    </div>
  );
}

function Panel({ title, right, children, noPad }: { title: string; right?: React.ReactNode; children: React.ReactNode; noPad?: boolean }) {
  return (
    // `overflow-visible` so an absolutely-positioned control in the header (the range
    // dropdown) isn't clipped by the panel box. The rounded corners still read fine
    // because every child that can reach an edge is itself rounded or padded.
    <div className="flex flex-col rounded-lg overflow-visible" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
      {/* Header WRAPS instead of overflowing. It used to be a fixed 32px row that
          could not wrap, so on a phone the port selector + In/Out readouts + range
          buttons ran past the panel edge and the right-most control (Custom) was
          simply unreachable. min-height keeps the desktop look identical. */}
      <div
        className="flex items-center justify-between gap-x-3 gap-y-1.5 flex-wrap px-3 py-1.5 sm:py-0 shrink-0"
        style={{ minHeight: 32, borderBottom: `1px solid ${gf.divider}` }}
      >
        <span className="text-[11px] font-medium tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>{title}</span>
        {right && <div className="flex items-center gap-2 flex-wrap">{right}</div>}
      </div>
      <div className="flex-1 min-h-0" style={{ padding: noPad ? 0 : 12 }}>{children}</div>
    </div>
  );
}

function Stat({ label, value, unit, color, sub }: { label: string; value: string; unit?: string | undefined; color: string; sub?: string | undefined }) {
  return (
    <div className="relative overflow-hidden rounded-lg flex flex-col" style={{ background: gf.panel, border: `1px solid ${gf.border}`, minHeight: 84 }}>
      <div className="flex items-center justify-between px-3 pt-2.5">
        <span className="text-[10px] tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>{label}</span>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      </div>
      <div className="px-3 pt-1.5">
        <span className="text-[24px] font-bold leading-none" style={{ color }}>{value}</span>
        {unit && <span className="text-[13px] ml-1" style={{ color: color + "AA" }}>{unit}</span>}
        {sub && <div className="text-[9px] mt-1 tracking-widest uppercase" style={{ color: gf.textDim }}>{sub}</div>}
      </div>
    </div>
  );
}

// ─── Interface table (WinBox "Interface List" style) ──────────────────────────
// Deliberately a dense table of NUMBERS rather than progress bars — the same call
// MikrotikDetail makes, for the same two reasons:
//  • an idle port is the normal state here, and a wide empty bar track reads as a
//    skeleton-loading placeholder rather than a real measurement;
//  • it matches the Interface List in WinBox, which is what an operator already
//    knows — the `R` running flag, Tx/Rx rate columns and right-aligned figures
//    all carry over.
// Every colour is a --gf-* token or a status colour, so it holds up in both themes.

function Th({ children, right, w }: { children: React.ReactNode; right?: boolean; w?: number }) {
  return (
    <th
      className={`text-[9px] tracking-widest uppercase font-medium px-2 py-1.5 ${right ? "text-right" : "text-left"}`}
      style={{ color: gf.textMuted, width: w, whiteSpace: "nowrap" }}
    >
      {children}
    </th>
  );
}

function PortRow({ i, rate, errDelta }: { i: NetIface; rate?: PortRate | undefined; errDelta?: number | undefined }) {
  const hasUtil = i.utilizationPct != null && Number.isFinite(i.utilizationPct);
  const util = Math.round(i.utilizationPct ?? 0);
  const speed = formatSpeed(i.speedMbps);
  const down = !i.linkUp;
  const td = "px-2 py-1.5 text-[11px] tabular-nums whitespace-nowrap";
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
      {/* Errors SINCE THE LAST POLL, not the lifetime total: a router up for a year
          carries a large total that says nothing about current health, whereas errors
          appearing now mean a failing cable, dying SFP or duplex mismatch. */}
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

      // Derive per-port throughput + the error delta from the counters since the last
      // poll. A negative delta means a counter wrap or a device reboot — drop it
      // rather than graph a spike, matching how the poller handles the same case.
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
    // device_logs inserts are broadcast as they happen (reachability flips +
    // deviceAlerts threshold/event alerts) — prepend ours so the log is live rather
    // than a snapshot from page load.
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

  // Re-fetch on each poll so the chart stays current. Naturally rate-limited by the
  // poll cadence (~60s), and it reuses the server's own derivative rather than
  // deriving throughput client-side from the cumulative counters.
  // A CUSTOM window is a fixed slice of the past, so it must NOT refetch on every
  // poll — the answer can't change, and re-querying a 30-day span every 60s is pure
  // load. Only a relative preset tracks live.
  useEffect(() => {
    const custom = range.kind === "custom" ? { start: range.start, stop: range.stop } : undefined;
    api
      .getNetworkHistory(Number(d.id), range.kind === "preset" ? range.preset : "", chartPort || undefined, custom)
      .then((r) => {
        if (r.success && r.data) {
          setHistory(r.data.history ?? []);
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
  const portsUp = ifaces.filter((i) => i.linkUp).length;
  const upUtil = ifaces.filter((i) => i.linkUp && i.utilizationPct != null).map((i) => i.utilizationPct as number);
  // Worst port, not the average: one saturated uplink is the whole story, and
  // averaging it against idle ports hides exactly the link that needs attention.
  const worstUtil = upUtil.length ? Math.round(Math.max(...upUtil)) : 0;
  const totalErrs = Object.values(errDeltas).reduce((a, b) => a + b, 0);
  const latest = history.length ? history[history.length - 1] : undefined;

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
          className="flex items-center gap-1.5 text-[13px] transition-colors text-[var(--gf-text-muted)] hover:text-[var(--gf-text-primary)]"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          All routers
        </button>
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold truncate" style={{ color: gf.textPrimary }}>{d.name}</h1>
          <div className="text-[11px] truncate" style={{ color: gf.textDim }}>
            {d.location} · {d.ip}
            {d.sysName ? ` · ${d.sysName}` : ""}
          </div>
          {/* sysDescr: the vendor/model string straight off the device (MIB-II). */}
          {d.descr && (
            <div className="text-[10px] truncate" style={{ color: gf.textDim }} title={d.descr}>{d.descr}</div>
          )}
        </div>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor(d.status), boxShadow: `0 0 5px ${statusColor(d.status)}` }} />
            <span className="text-[11px]" style={{ color: gf.textMuted }}>{d.status}</span>
          </span>
          {/* Makes "live" verifiable — you can see the poll landing. */}
          <span className="text-[10px] hidden sm:inline" style={{ color: gf.textDim }}>
            {lastUpdate
              ? `updated ${new Date(lastUpdate).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour12: false })}`
              : "awaiting poll…"}
          </span>
        </span>
      </div>

      {!d.monitored && (
        <div className="text-[11px] px-3 py-2 rounded-[2px]" style={{ color: ORANGE, background: ORANGE + "14", border: `1px solid ${ORANGE}40` }}>
          SNMP not configured — this device can't be polled until a read-only community string is set.
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
        <Stat label="Status" value={d.status} color={statusColor(d.status)} sub={d.reachable ? "reachable" : "—"} />
        <Stat label="Ports Up" value={`${portsUp}/${ifaces.length}`} color={ifaces.length > 0 && portsUp === ifaces.length ? GREEN : portsUp === 0 ? RED : ORANGE} sub="links online" />
        <Stat label="Peak Util" value={String(worstUtil)} unit="%" color={loadColor(worstUtil)} sub={upUtil.length > 1 ? `busiest of ${upUtil.length}` : "of link speed"} />
        <Stat label="Errors" value={String(totalErrs)} color={totalErrs > 0 ? ORANGE : GREEN} sub="since last poll" />
        <Stat label="Uptime" value={formatUptime(d.uptimeSeconds)} color={BLUE} sub="since boot" />
      </div>

      {/* Throughput history */}
      <Panel
        title={chartPort ? `Throughput · ${chartPort}` : "Total Throughput"}
        right={
          <div className="flex items-center gap-2 flex-wrap">
            {/* Per-port history: the data was always tagged by interface_name in
                InfluxDB, there was simply no way to ask for one port.
                `max-w` + `truncate`: a long "ether1 — Uplink to admin building" option
                would otherwise stretch the select past a phone's width and push the
                range buttons off the row. */}
            <select
              value={chartPort}
              onChange={(e) => setChartPort(e.target.value)}
              className="text-[10px] px-1.5 py-0.5 rounded-[2px] outline-none max-w-[45vw] sm:max-w-none truncate"
              style={{ background: gf.bg, border: `1px solid ${gf.border}`, color: gf.textPrimary }}
            >
              <option value="">All ports</option>
              {ifaces.map((i) => (
                <option key={i.name} value={i.name}>
                  {i.locationLabel ? `${i.name} — ${i.locationLabel}` : i.name}
                </option>
              ))}
            </select>
            <span className="text-[10px]" style={{ color: BLUE }}>In {formatBps(latest?.rxBytesPerSec ?? null)}</span>
            <span className="text-[10px]" style={{ color: GREEN }}>Out {formatBps(latest?.txBytesPerSec ?? null)}</span>
            <RangePicker value={range} onChange={setRange} error={rangeError || undefined} />
          </div>
        }
      >
        <ThroughputChart history={history} />
      </Panel>

      {/* Physical ports */}
      <Panel
        title={`Ports · ${portsUp}/${ifaces.length} up`}
        right={
          isAdmin && ifaces.length > 0 ? (
            editLabels ? (
              <span className="flex items-center gap-2">
                <button onClick={() => setEditLabels(false)} disabled={savingLabels}
                  className="text-[10px] px-2 py-0.5 rounded-[2px]"
                  style={{ color: gf.textMuted, border: `1px solid ${gf.border}` }}>Cancel</button>
                <button onClick={saveLabels} disabled={savingLabels}
                  className="text-[10px] px-2 py-0.5 rounded-[2px] font-semibold"
                  style={{ background: BLUE, color: "#fff", opacity: savingLabels ? 0.6 : 1 }}>
                  {savingLabels ? "Saving…" : "Save labels"}
                </button>
              </span>
            ) : (
              <button onClick={startLabelEdit}
                className="text-[10px] px-2 py-0.5 rounded-[2px]"
                style={{ color: gf.textMuted, border: `1px solid ${gf.border}` }}>
                Edit labels
              </button>
            )
          ) : undefined
        }
        noPad
      >
        {ifaces.length === 0 ? (
          <div className="px-3 py-4 text-[11px]" style={{ color: gf.textDim }}>
            {d.status === "Online" ? "No interfaces reported." : "Offline — awaiting next poll."}
          </div>
        ) : editLabels ? (
          <div className="flex flex-col">
            <div className="px-3 py-2 text-[10px]" style={{ color: gf.textDim, borderBottom: `1px solid ${gf.divider}` }}>
              Name each port by what it connects to. Leave blank to show the raw interface name.
            </div>
            {ifaces.map((i) => (
              <div key={i.name} className="flex items-center gap-3 px-3 py-2" style={{ borderBottom: `1px solid ${gf.divider}` }}>
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: i.linkUp ? GREEN : RED }} />
                <span className="w-28 shrink-0 text-[12px] font-medium truncate" style={{ color: gf.textPrimary }}>{i.name}</span>
                <input
                  value={labelDraft[i.name] ?? ""}
                  maxLength={100}
                  onChange={(e) => setLabelDraft((p) => ({ ...p, [i.name]: e.target.value }))}
                  placeholder="e.g. ISP uplink, Rack A switch"
                  className="flex-1 min-w-0 px-2 py-1 text-[12px] rounded-[2px] outline-none"
                  style={{ background: gf.bg, border: `1px solid ${gf.border}`, color: gf.textPrimary }}
                />
              </div>
            ))}
            {labelError && <div className="px-3 py-2 text-[10.5px]" style={{ color: RED }}>{labelError}</div>}
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
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[11px]" style={{ color: gf.textMuted }}>
          <span>Host <span style={{ color: gf.textPrimary }}>{d.ip}</span></span>
          <span>Version <span style={{ color: gf.textPrimary }}>v2c</span></span>
          <span>Hostname <span style={{ color: gf.textPrimary }}>{d.sysName || "—"}</span></span>
          <span>Uptime <span style={{ color: gf.textPrimary }}>{formatUptime(d.uptimeSeconds)}</span></span>
        </div>
        <p className="text-[9px] mt-2" style={{ color: gf.textDim }}>
          Read via the standard MIB-II / IF-MIB objects, so no vendor-specific setup is needed.
          CPU and memory aren't shown: those OIDs are vendor-specific and not part of the standard MIBs.
        </p>
      </Panel>

      {/* Event log */}
      <Panel title="Event Log">
        {logs.length === 0 ? (
          <div className="text-[11px] py-3 text-center" style={{ color: gf.textDim }}>No events recorded.</div>
        ) : (
          <div className="flex flex-col">
            {logs.slice(0, 30).map((l, i) => (
              <div key={i} className="flex items-center gap-2 py-1.5 text-[11px]" style={{ borderBottom: i < logs.length - 1 ? `1px solid ${gf.divider}` : "none" }}>
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: logColor(l.log_level) }} />
                <span className="shrink-0 w-28" style={{ color: gf.textDim }}>{fmtDateTime(l.recorded_at)}</span>
                <span className="truncate" style={{ color: gf.textPrimary }}>{l.message}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
