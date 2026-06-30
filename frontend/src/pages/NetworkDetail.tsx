import { useState, useEffect, useRef } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import Chart from "../chart/ChartConfig";

// ─── Per-router detail view (throughput + interfaces + log) ───────────────────
// Reached from NetworkMonitoring via "View". In-page swap (Back button), mirroring
// ServerMetrics ↔ ServerDetail. Interfaces/uptime stay live via `networkMetrics`;
// throughput history is fetched per range.

interface NetIface {
  name: string;
  locationLabel: string;
  linkUp: boolean;
  utilizationPct: number | null;
  rxBytes: string | null;
  txBytes: string | null;
}
interface NetDevice {
  id: string;
  name: string;
  ip: string;
  location: string;
  status: string;
  reachable: boolean | null;
  uptimeSeconds: number | null;
  interfaces: NetIface[];
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
const TRACK = "rgba(127,127,127,0.18)";
const BAR_GRADIENT = "linear-gradient(90deg,#73BF69 0%,#73BF69 55%,#FF780A 78%,#F2495C 95%)";

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

// Chart.js line chart (proper time x-axis, bits/sec y-axis, gridlines, tooltips —
// consistent with the Server/Dashboard/Environment charts).
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

function Stat({ label, value, unit, color, sub }: { label: string; value: string; unit?: string; color: string; sub?: string }) {
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

function IfaceRow({ i }: { i: NetIface }) {
  const util = Math.round(i.utilizationPct ?? 0);
  return (
    <div className="flex items-center gap-3 px-3 py-2" style={{ borderBottom: `1px solid ${gf.divider}` }}>
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: i.linkUp ? GREEN : RED, boxShadow: `0 0 5px ${i.linkUp ? GREEN : RED}` }} />
      <div className="w-36 min-w-0">
        <div className="text-[12px] truncate" style={{ color: gf.textPrimary }}>{i.name}</div>
        {i.locationLabel && <div className="text-[9px] truncate" style={{ color: gf.textDim }}>{i.locationLabel}</div>}
      </div>
      <div className="flex-1 h-3 rounded-[2px] overflow-hidden" style={{ background: TRACK }}>
        <div className="h-full rounded-[2px] transition-all duration-500" style={{ width: `${i.linkUp ? util : 0}%`, background: BAR_GRADIENT, backgroundSize: `${util > 0 ? (100 / util) * 100 : 100}% 100%` }} />
      </div>
      <span className="text-[11px] font-bold w-12 text-right shrink-0" style={{ color: i.linkUp ? loadColor(util) : gf.textDim }}>
        {i.linkUp ? `${util}%` : "down"}
      </span>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function NetworkDetail({ device, onBack }: { device: NetDevice; onBack: () => void }) {
  const [d, setD] = useState<NetDevice>(device);
  const [range, setRange] = useState<Range>("-1h");
  const [history, setHistory] = useState<HistPoint[]>([]);
  const [logs, setLogs] = useState<DeviceLog[]>([]);

  useEffect(() => {
    const onMetrics = (data: { device: any }) => {
      if (!data?.device || String(data.device.id) !== String(d.id)) return;
      setD((prev) => ({
        ...prev,
        status: data.device.status ?? prev.status,
        reachable: data.device.reachable ?? prev.reachable,
        uptimeSeconds: data.device.uptimeSeconds ?? prev.uptimeSeconds,
        interfaces: data.device.interfaces ?? prev.interfaces,
      }));
    };
    const onStatus = (data: { id: number | string; status: string }) => {
      if (String(data?.id) !== String(d.id)) return;
      setD((prev) => (data.status === "Offline" ? { ...prev, status: "Offline", reachable: false, interfaces: [] } : { ...prev, status: data.status }));
    };
    socket.on("networkMetrics", onMetrics);
    socket.on("networkStatus", onStatus);
    return () => { socket.off("networkMetrics", onMetrics); socket.off("networkStatus", onStatus); };
  }, [d.id]);

  useEffect(() => {
    api.getNetworkHistory(Number(d.id), range).then((r) => {
      if (r.success && r.data) setHistory(r.data.history ?? []);
    });
  }, [d.id, range]);

  useEffect(() => {
    api.getNetworkLogs(Number(d.id)).then((r) => {
      if (r.success && r.data) setLogs(r.data.logs ?? []);
    });
  }, [d.id]);

  const ifaces = d.interfaces ?? [];
  const ifacesUp = ifaces.filter((i) => i.linkUp).length;
  const upUtil = ifaces.filter((i) => i.linkUp && i.utilizationPct != null).map((i) => i.utilizationPct as number);
  const avgUtil = upUtil.length ? Math.round(upUtil.reduce((a, b) => a + b, 0) / upUtil.length) : 0;
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
          All routers
        </button>
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold truncate" style={{ color: gf.textPrimary }}>{d.name}</h1>
          <div className="text-[11px] truncate" style={{ color: gf.textDim }}>{d.location} · {d.ip}</div>
        </div>
        <span className="ml-auto inline-flex items-center gap-1.5 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor(d.status), boxShadow: `0 0 5px ${statusColor(d.status)}` }} />
          <span className="text-[11px]" style={{ color: gf.textMuted }}>{d.status}</span>
        </span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <Stat label="Status" value={d.status} color={statusColor(d.status)} sub={d.reachable ? "reachable" : "—"} />
        <Stat label="Interfaces Up" value={`${ifacesUp}/${ifaces.length}`} color={GREEN} sub="links" />
        <Stat label="Avg Utilization" value={String(avgUtil)} unit="%" color={loadColor(avgUtil)} sub="of link speed" />
        <Stat label="Uptime" value={formatUptime(d.uptimeSeconds)} color={BLUE} sub="since boot" />
      </div>

      {/* Throughput history */}
      <Panel
        title="Total Throughput"
        right={
          <div className="flex items-center gap-2">
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

      {/* Interfaces */}
      <Panel title={`Interfaces · ${ifaces.length}`} noPad>
        {ifaces.length === 0 ? (
          <div className="px-3 py-4 text-[11px]" style={{ color: gf.textDim }}>
            {d.status === "Online" ? "No interfaces reported." : "Offline — awaiting next poll."}
          </div>
        ) : (
          ifaces.map((i) => <IfaceRow key={i.name} i={i} />)
        )}
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
