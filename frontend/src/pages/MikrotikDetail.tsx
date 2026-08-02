import { useState, useEffect, useRef } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import Chart from "../chart/ChartConfig";

// ─── Per-MikroTik detail view (throughput + ports + log) ──────────────────────
// Reached from MikrotikMonitoring via "View". In-page swap (Back button), mirroring
// ServerMetrics ↔ ServerDetail and NetworkMonitoring ↔ NetworkDetail. Ports/CPU/mem
// stay live via `networkMetrics`; throughput history is fetched per range.
//
// Types live here (not in MikrotikMonitoring) so the list can import them without a
// circular import — the list imports this module, never the other way round.

export interface MkIface {
  name: string;
  locationLabel: string; // optional friendly label from network_interfaces
  linkUp: boolean;
  utilizationPct: number | null;
  rxBytes: string | null;
  txBytes: string | null;
  rxErrors?: number | null;
  txErrors?: number | null;
  speedMbps?: number | null;
  clients?: number | null; // DHCP clients on this port; null = not attributable
}
// Per-port throughput derived on the client from the cumulative byte counters between
// two polls. The API only ever reports totals, so without this a port shows a bare
// utilization % — which reads as "0%" whenever link speed is unknown, even under load.
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
  routerosVersion: string | null;
  boardModel: string | null;
  apiPort: number | null;
  useTls: boolean;
  apiUsername: string | null;
  interfaces: MkIface[];
  monitored: boolean;
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

const RANGES = ["-1h", "-6h", "-24h"] as const;
type Range = (typeof RANGES)[number];
const rangeLabel: Record<Range, string> = { "-1h": "1h", "-6h": "6h", "-24h": "24h" };

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
function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-PH", {
    timeZone: "Asia/Manila", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

// Chart.js line chart — same config as NetworkDetail so both network pages read alike.
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
    <div className="flex flex-col rounded-lg overflow-hidden" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
      <div className="flex items-center justify-between px-3 shrink-0" style={{ height: 32, borderBottom: `1px solid ${gf.divider}` }}>
        <span className="text-[11px] font-medium tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>{title}</span>
        {right && <div className="flex items-center gap-2">{right}</div>}
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

function formatSpeed(mbps: number | null | undefined): string | null {
  if (mbps == null || !Number.isFinite(mbps) || mbps <= 0) return null;
  return mbps >= 1000
    ? `${(mbps / 1000).toFixed(mbps % 1000 === 0 ? 0 : 1)} Gb/s`
    : `${Math.round(mbps)} Mb/s`;
}

// ─── Interface table (WinBox "Interface List" style) ──────────────────────────
// Deliberately a dense table of NUMBERS rather than progress bars. Two reasons:
//  • an idle port is the normal state here, and a wide empty bar track reads as a
//    skeleton-loading placeholder rather than a real measurement;
//  • it matches the Interface List in WinBox, which is what an operator already knows —
//    the `R` running flag, Tx/Rx rate columns and right-aligned figures all carry over.
// Every colour is either a --gf-* token or a status colour, so it holds up in light and
// dark mode without hardcoded greys.

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

function PortRow({ i, rate }: { i: MkIface; rate?: PortRate | undefined }) {
  const hasUtil = i.utilizationPct != null && Number.isFinite(i.utilizationPct);
  const util = Math.round(i.utilizationPct ?? 0);
  const speed = formatSpeed(i.speedMbps);
  const errors = (i.rxErrors ?? 0) + (i.txErrors ?? 0);
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
  const [range, setRange] = useState<Range>("-1h");
  const [history, setHistory] = useState<HistPoint[]>([]);
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
      // Derive per-port throughput from the counter delta since the previous poll.
      // A negative delta means a counter wrap or a router reboot — drop it rather than
      // graph a spike, matching how the pollers handle the same case server-side.
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
    // device_logs inserts are broadcast as they happen (poller reachability flips +
    // deviceAlerts threshold/event alerts) — prepend ours so the log is live, not a
    // snapshot from page load.
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

  // Re-fetch on each poll so the chart stays current. Naturally rate-limited by the
  // poll cadence (~30s), and it reuses the server's own derivative rather than
  // deriving throughput client-side from the cumulative counters.
  useEffect(() => {
    api.getMikrotikHistory(Number(d.id), range, chartPort || undefined).then((r) => {
      if (r.success && r.data) setHistory(r.data.history ?? []);
    });
  }, [d.id, range, poll, chartPort]);

  useEffect(() => {
    api.getMikrotikLogs(Number(d.id)).then((r) => {
      if (r.success && r.data) setLogs(r.data.logs ?? []);
    });
  }, [d.id]);

  const ifaces = d.interfaces ?? [];
  const portsUp = ifaces.filter((i) => i.linkUp).length;

  const startLabelEdit = () => {
    const draft: Record<string, string> = {};
    for (const i of ifaces) draft[i.name] = i.locationLabel ?? "";
    setLabelDraft(draft);
    setEditLabels(true);
  };

  const saveLabels = async () => {
    setSavingLabels(true);
    const labels = Object.entries(labelDraft).map(([name, label]) => ({ name, label }));
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

  return (
    <div className="flex flex-col gap-2.5" style={{ background: gf.bg, minHeight: "100%", padding: 12 }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-0.5">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-[13px] transition-colors text-[var(--gf-text-muted)] hover:text-[var(--gf-text-primary)]"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          All MikroTiks
        </button>
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold truncate" style={{ color: gf.textPrimary }}>{d.name}</h1>
          <div className="text-[11px] truncate" style={{ color: gf.textDim }}>
            {d.location} · {d.ip}
            {d.routerosVersion ? ` · RouterOS ${d.routerosVersion}` : ""}
            {d.boardModel ? ` · ${d.boardModel}` : ""}
          </div>
        </div>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          {onConfigure && (
            <button
              onClick={onConfigure}
              className="text-[11px] font-medium px-2.5 py-1 rounded-md transition-colors active:scale-95"
              style={{ color: gf.textMuted, border: `1px solid ${gf.border}`, background: "transparent" }}
            >
              Configure
            </button>
          )}
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
          API not configured — set the read-only RouterOS login (admin) before this router can be polled.
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
        <Stat label="Status" value={d.status} color={statusColor(d.status)} sub={d.reachable ? "reachable" : "—"} />
        <Stat label="CPU" value={d.cpuPercent != null ? String(cpu) : "—"} unit={d.cpuPercent != null ? "%" : undefined} color={loadColor(cpu)} sub="router load" />
        <Stat label="Memory" value={d.memPercent != null ? String(mem) : "—"} unit={d.memPercent != null ? "%" : undefined} color={loadColor(mem)} sub="router RAM" />
        <Stat label="Ports Up" value={`${portsUp}/${ifaces.length}`} color={ifaces.length > 0 && portsUp === ifaces.length ? GREEN : portsUp === 0 ? RED : ORANGE} sub="links online" />
        {/* Named for what it actually measures: bound DHCP leases, not live links. A
            lease survives the device unplugging until it expires, so this lags reality
            by up to one lease period — calling it "clients" invites the wrong reading. */}
        <Stat label="DHCP Leases" value={d.connectedClients != null ? String(d.connectedClients) : "—"} color={BLUE} sub="bound" />
      </div>

      {/* Throughput history */}
      <Panel
        title={chartPort ? `Throughput · ${chartPort}` : "Total Throughput"}
        right={
          <div className="flex items-center gap-2">
            {/* Per-port history: the data was always tagged by interface_name in
                InfluxDB, there was simply no way to ask for one port. */}
            <select
              value={chartPort}
              onChange={(e) => setChartPort(e.target.value)}
              className="text-[10px] px-1.5 py-0.5 rounded-[2px] outline-none"
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
            <div className="flex rounded-md overflow-hidden" style={{ border: `1px solid ${gf.border}` }}>
              {RANGES.map((rg) => (
                <button key={rg} onClick={() => setRange(rg)} className="text-[10px] px-2 py-0.5 transition-colors"
                  style={{ background: range === rg ? gf.hover : "transparent", color: range === rg ? gf.textPrimary : gf.textMuted }}>
                  {rangeLabel[rg]}
                </button>
              ))}
            </div>
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
            {d.status === "Online" ? "No ports reported." : "Offline — awaiting next poll."}
          </div>
        ) : editLabels ? (
          <div className="flex flex-col">
            <div className="px-3 py-2 text-[10px]" style={{ color: gf.textDim, borderBottom: `1px solid ${gf.divider}` }}>
              Name each port by what it connects to. Leave blank to show the raw RouterOS name.
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
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[11px]" style={{ color: gf.textMuted }}>
          <span>Host <span style={{ color: gf.textPrimary }}>{d.ip}</span></span>
          <span>Port <span style={{ color: gf.textPrimary }}>{d.apiPort ?? "—"}</span></span>
          <span>TLS <span style={{ color: d.useTls ? GREEN : gf.textDim }}>{d.useTls ? "on (API-SSL)" : "off"}</span></span>
          <span>User <span style={{ color: gf.textPrimary }}>{d.apiUsername || "—"}</span></span>
          <span>Uptime <span style={{ color: gf.textPrimary }}>{formatUptime(d.uptimeSeconds)}</span></span>
        </div>
        <p className="text-[9px] mt-2" style={{ color: gf.textDim }}>
          The API password is stored encrypted (AES-256-GCM) and is never returned to the dashboard.
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
