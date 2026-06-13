import React, { useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/api";
import ServerDetail from "./ServerDetail";
import { socket } from "../socket/socket";
import { useAuth } from "../context/AuthContext";

interface Server {
  id: string;
  name: string;
  ip: string;
  status: string;
  cpu: number;
  memory: number;
  memoryTotalGB: number;
  diskUsed: number;
  diskTotalGB: number;
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

interface PendingAgent {
  id: number;
  name: string;
  ip: string | null;
  location: string;
  os: string | null;
  arch: string | null;
  cores: number | null;
  agent_version: string | null;
  mac: string | null;
  requestedAt: string;
}

// ─── Backend ↔ UI mapping ─────────────────────────────────────────────────────

function mapServerRow(r: any): Server {
  return {
    id: String(r.id),
    name: r.name ?? "—",
    ip: r.ip ?? "—",
    status: r.status ?? "Offline",
    cpu: Number(r.cpu ?? 0),
    memory: Number(r.memory ?? 0),
    memoryTotalGB: r.memoryTotalMB ? +(r.memoryTotalMB / 1024).toFixed(1) : 0,
    diskUsed: Number(r.diskUsed ?? 0),
    diskTotalGB: Number(r.diskTotalGB ?? 0),
    uptime: r.uptime || "—",
    os: r.os ?? "—",
    kernel: r.kernel ?? "—",
    cores: Number(r.cores ?? 0),
    arch: r.arch ?? "—",
    gateway: r.gateway ?? "—",
    dns: r.dns ?? "—",
    region: r.region ?? "—",
    role: r.location ?? "server",
  };
}

function mergeLive(prev: Server | undefined, p: any): Server {
  const base =
    prev ??
    mapServerRow({ id: p.id, name: p.name, ip: p.ip, os: p.os, location: p.location, status: p.status });
  return {
    ...base,
    status: p.status ?? base.status,
    cpu: Math.round(p.cpuPercent ?? base.cpu),
    memory: Math.round(p.memPercent ?? base.memory),
    memoryTotalGB: p.memTotalMB ? +(p.memTotalMB / 1024).toFixed(1) : base.memoryTotalGB,
    diskUsed: Math.round(p.diskPercent ?? base.diskUsed),
    diskTotalGB: p.diskTotalGB != null ? Math.round(p.diskTotalGB) : base.diskTotalGB,
    uptime: p.uptimeLabel ?? base.uptime,
  };
}

// ─── Grafana design tokens (match Dashboard.tsx) ──────────────────────────────

const gf = {
  bg:          "var(--gf-bg)",
  panel:       "var(--gf-panel)",
  border:      "var(--gf-panel-border)",
  divider:     "var(--gf-divider)",
  textPrimary: "var(--gf-text-primary)",
  textMuted:   "var(--gf-text-muted)",
  textDim:     "var(--gf-text-dim)",
  hover:       "var(--gf-hover)",
} as const;

const GREEN = "#73BF69";
const ORANGE = "#FF780A";
const RED = "#F2495C";
const BLUE = "#5794F2";
const TRACK = "rgba(127,127,127,0.18)";
const BAR_GRADIENT = "linear-gradient(90deg,#73BF69 0%,#73BF69 55%,#FF780A 78%,#F2495C 95%)";

function loadColor(v: number) {
  if (v >= 85) return RED;
  if (v >= 65) return ORANGE;
  return GREEN;
}

function statusColor(s: string) {
  if (s === "Online") return GREEN;
  if (s === "Warning") return ORANGE;
  return RED;
}

// ─── Panel (Grafana panel chrome) ─────────────────────────────────────────────

function Panel({
  title, right, children, className = "", bodyStyle, noPad,
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
      className={`flex flex-col rounded-lg overflow-hidden ${className}`}
      style={{ background: gf.panel, border: `1px solid ${gf.border}` }}
    >
      {title !== undefined && (
        <div
          className="flex items-center justify-between px-3 shrink-0"
          style={{ height: 32, borderBottom: `1px solid ${gf.divider}` }}
        >
          <span className="text-[11px] font-medium tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>
            {title}
          </span>
          {right && <div className="flex items-center gap-2">{right}</div>}
        </div>
      )}
      <div className="flex-1 min-h-0" style={{ padding: noPad ? 0 : 12, ...bodyStyle }}>
        {children}
      </div>
    </div>
  );
}

// ─── Sparkline (area, for stat panels) ────────────────────────────────────────

function Sparkline({ data, color, height = 38 }: { data: number[]; color: string; height?: number }) {
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
    ctx.beginPath();
    pts.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.stroke();
  }, [data, color, height]);
  return <canvas ref={ref} style={{ width: "100%", height, display: "block" }} />;
}

// ─── StatPanel (Grafana stat with sparkline background) ───────────────────────

function StatPanel({
  label, value, unit, color, sub, spark,
}: {
  label: string; value: string; unit?: string; color: string; sub?: string; spark?: number[];
}) {
  return (
    <div
      className="relative overflow-hidden rounded-lg flex flex-col"
      style={{ background: gf.panel, border: `1px solid ${gf.border}`, minHeight: 96 }}
    >
      <div className="flex items-center justify-between px-3 pt-2.5 z-10">
        <span className="text-[10px] tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>{label}</span>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      </div>
      <div className="px-3 pt-1.5 z-10">
        <span className="text-[28px] font-bold leading-none" style={{ color }}>{value}</span>
        {unit && <span className="text-[13px] ml-1" style={{ color: color + "AA" }}>{unit}</span>}
        {sub && <div className="text-[9px] mt-1 tracking-widest uppercase" style={{ color: gf.textDim }}>{sub}</div>}
      </div>
      {spark && spark.length > 1 && (
        <div className="absolute inset-x-0 bottom-0 opacity-70 pointer-events-none">
          <Sparkline data={spark} color={color} height={36} />
        </div>
      )}
    </div>
  );
}

// ─── BarGauge (Grafana gradient horizontal bar — per host) ────────────────────

function BarGauge({ label, value, status }: { label: string; value: number; status?: string }) {
  const v = Math.min(Math.max(value, 0), 100);
  return (
    <div className="flex items-center gap-3 px-3 py-1.5">
      <div className="flex items-center gap-2 w-28 shrink-0">
        {status && (
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: statusColor(status), boxShadow: `0 0 5px ${statusColor(status)}` }} />
        )}
        <span className="text-[11px] truncate" style={{ color: gf.textPrimary }}>{label}</span>
      </div>
      <div className="flex-1 h-3.5 rounded-[2px] overflow-hidden" style={{ background: TRACK }}>
        <div
          className="h-full rounded-[2px] transition-all duration-500"
          style={{ width: `${v}%`, background: BAR_GRADIENT, backgroundSize: `${v > 0 ? (100 / v) * 100 : 100}% 100%` }}
        />
      </div>
      <span className="text-[11px] font-bold w-10 text-right shrink-0" style={{ color: loadColor(v) }}>{v}%</span>
    </div>
  );
}

// ─── Inline bar (table cell) ──────────────────────────────────────────────────

function TableBar({ value }: { value: number }) {
  const v = Math.min(Math.max(value, 0), 100);
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-2 rounded-[2px] overflow-hidden" style={{ background: TRACK }}>
        <div className="h-full rounded-[2px] transition-all duration-500" style={{ width: `${v}%`, background: BAR_GRADIENT, backgroundSize: `${v > 0 ? (100 / v) * 100 : 100}% 100%` }} />
      </div>
      <span className="text-[11px] font-bold w-9 text-right" style={{ color: loadColor(v) }}>{v}%</span>
    </div>
  );
}

// ─── Metric bar (mobile card) ─────────────────────────────────────────────────

function MetricBar({ label, value }: { label: string; value: number }) {
  const v = Math.min(Math.max(value, 0), 100);
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[9px] uppercase tracking-wider" style={{ color: gf.textDim }}>{label}</span>
        <span className="text-[11px] font-bold font-mono" style={{ color: loadColor(v) }}>{v}%</span>
      </div>
      <div className="h-1.5 rounded-[2px] overflow-hidden" style={{ background: TRACK }}>
        <div className="h-full rounded-[2px] transition-all duration-500" style={{ width: `${v}%`, background: BAR_GRADIENT, backgroundSize: `${v > 0 ? (100 / v) * 100 : 100}% 100%` }} />
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const c = statusColor(status);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: c, boxShadow: `0 0 5px ${c}` }} />
      <span className="text-[11px]" style={{ color: gf.textMuted }}>{status}</span>
    </span>
  );
}

// ─── Buttons ──────────────────────────────────────────────────────────────────

function GhostButton({ children, onClick, danger }: { children: React.ReactNode; onClick: (e: React.MouseEvent) => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className="text-[11px] font-medium px-2.5 py-1 rounded-md transition-colors active:scale-95"
      style={{
        color: danger ? RED : gf.textMuted,
        border: `1px solid ${danger ? "rgba(242,73,92,0.3)" : gf.border}`,
        background: "transparent",
      }}
    >
      {children}
    </button>
  );
}

// ─── ServerCard (mobile) ──────────────────────────────────────────────────────

function ServerCard({ s, isAdmin, onView, onDelete }: {
  s: Server; isAdmin: boolean; onView: () => void; onDelete: () => void;
}) {
  return (
    <div className="rounded-lg p-3" style={{ border: `1px solid ${gf.border}` }}>
      <div className="flex items-start justify-between gap-2">
        <button onClick={onView} className="min-w-0 text-left">
          <div className="text-[13px] font-medium truncate" style={{ color: gf.textPrimary }}>{s.name}</div>
          <div className="text-[11px] font-mono truncate" style={{ color: gf.textMuted }}>{s.ip}</div>
        </button>
        <StatusDot status={s.status} />
      </div>
      <div className="grid grid-cols-3 gap-3 mt-3">
        <MetricBar label="CPU" value={s.cpu} />
        <MetricBar label="Mem" value={s.memory} />
        <MetricBar label="Disk" value={s.diskUsed} />
      </div>
      <div className="flex items-center justify-between gap-2 mt-3 pt-2.5" style={{ borderTop: `1px solid ${gf.divider}` }}>
        <span className="text-[11px] truncate" style={{ color: gf.textMuted }}>↑ {s.uptime}</span>
        <div className="flex gap-2 shrink-0">
          <GhostButton onClick={onView}>View</GhostButton>
          {isAdmin && <GhostButton onClick={onDelete} danger>Remove</GhostButton>}
        </div>
      </div>
    </div>
  );
}

// ─── Metric icons (desktop drawer) ────────────────────────────────────────────

const CpuIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
    <rect x="3" y="3" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <rect x="6" y="6" width="4" height="4" rx="1" fill="currentColor" />
    <line x1="6" y1="1" x2="6" y2="3" stroke="currentColor" strokeWidth="1.5" />
    <line x1="10" y1="1" x2="10" y2="3" stroke="currentColor" strokeWidth="1.5" />
    <line x1="6" y1="13" x2="6" y2="15" stroke="currentColor" strokeWidth="1.5" />
    <line x1="10" y1="13" x2="10" y2="15" stroke="currentColor" strokeWidth="1.5" />
    <line x1="1" y1="6" x2="3" y2="6" stroke="currentColor" strokeWidth="1.5" />
    <line x1="1" y1="10" x2="3" y2="10" stroke="currentColor" strokeWidth="1.5" />
    <line x1="13" y1="6" x2="15" y2="6" stroke="currentColor" strokeWidth="1.5" />
    <line x1="13" y1="10" x2="15" y2="10" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);
const MemUsedIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
    <rect x="1" y="4" width="14" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <rect x="3" y="6" width="4" height="4" rx="1" fill="currentColor" />
    <line x1="9" y1="8" x2="13" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);
const MemFreeIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
    <rect x="1" y="4" width="14" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" />
    <line x1="4" y1="8" x2="12" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="2 2" />
  </svg>
);
const DiskUsedIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
    <ellipse cx="8" cy="5" rx="6" ry="2.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M2 5v6c0 1.38 2.686 2.5 6 2.5S14 12.38 14 11V5" stroke="currentColor" strokeWidth="1.5" />
    <ellipse cx="8" cy="11" rx="6" ry="2.5" fill="currentColor" opacity=".2" />
  </svg>
);
const DiskFreeIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
    <ellipse cx="8" cy="5" rx="6" ry="2.5" stroke="currentColor" strokeWidth="1.5" />
    <path d="M2 5v6c0 1.38 2.686 2.5 6 2.5S14 12.38 14 11V5" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

interface MetricCardProps {
  icon: React.ReactNode;
  iconBg: string;
  iconColor: string;
  label: string;
  value: string;
  sub: string;
  percent?: number;
}

function MetricCard({ icon, iconBg, iconColor, label, value, sub, percent }: MetricCardProps) {
  return (
    <div className="flex flex-col gap-1 rounded-lg p-3 min-w-[130px] flex-1" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
      <div className="flex items-center gap-1.5">
        <div className="w-5 h-5 rounded-[3px] flex items-center justify-center shrink-0" style={{ background: iconBg, color: iconColor }}>
          {icon}
        </div>
        <span className="text-[11px] font-medium" style={{ color: gf.textMuted }}>{label}</span>
      </div>
      <div className="font-mono text-[18px] font-medium leading-none" style={{ color: gf.textPrimary }}>{value}</div>
      {percent !== undefined && (
        <div className="h-[3px] rounded-full overflow-hidden" style={{ background: TRACK }}>
          <div className="h-full rounded-full transition-all duration-500" style={{ width: `${percent}%`, background: loadColor(percent) }} />
        </div>
      )}
      <div className="text-[11px]" style={{ color: gf.textDim }}>{sub}</div>
    </div>
  );
}

// Expandable detail row shown when a table row is clicked.
function ServerDrawerRow({ server: s, isOpen }: { server: Server; isOpen: boolean }) {
  const memUsedGB  = ((s.memory / 100) * s.memoryTotalGB).toFixed(1);
  const memFreeGB  = (s.memoryTotalGB - parseFloat(memUsedGB)).toFixed(1);
  const diskUsedGB = Math.round((s.diskUsed / 100) * s.diskTotalGB);
  const diskFreeGB = s.diskTotalGB - diskUsedGB;

  return (
    <tr>
      <td colSpan={8} className="p-0">
        <div
          className="overflow-hidden transition-all duration-300 ease-in-out"
          style={{ maxHeight: isOpen ? 220 : 0, borderBottom: isOpen ? `1px solid ${gf.divider}` : "none" }}
        >
          <div className="flex flex-wrap gap-2 p-3" style={{ background: gf.bg }}>
            <MetricCard icon={<CpuIcon />}      iconBg="#E6F1FB" iconColor="#185FA5" label="CPU usage" value={`${s.cpu}%`}       percent={s.cpu}      sub={s.cpu > 80 ? "High load" : s.cpu > 60 ? "Moderate" : "Healthy"} />
            <MetricCard icon={<MemUsedIcon />}  iconBg="#EEEDFE" iconColor="#534AB7" label="Mem used"  value={`${memUsedGB} GB`} percent={s.memory}   sub={`of ${s.memoryTotalGB} GB`} />
            <MetricCard icon={<MemFreeIcon />}  iconBg="#EAF3DE" iconColor="#3B6D11" label="Mem free"  value={`${memFreeGB} GB`} sub="available" />
            <MetricCard icon={<DiskUsedIcon />} iconBg="#FAEEDA" iconColor="#854F0B" label="Disk used" value={`${diskUsedGB} GB`} percent={s.diskUsed} sub={`of ${s.diskTotalGB} GB`} />
            <MetricCard icon={<DiskFreeIcon />} iconBg="#E1F5EE" iconColor="#0F6E56" label="Disk free" value={`${diskFreeGB} GB`} sub="available" />
          </div>
        </div>
      </td>
    </tr>
  );
}

// ─── ServerMetrics (main) ─────────────────────────────────────────────────────

export default function ServerMetrics() {
  const [servers, setServers]           = useState<Server[]>([]);
  const [detailServer, setDetailServer] = useState<Server | null>(null);
  const [pending, setPending]           = useState<PendingAgent[]>([]);
  const [aggCpu, setAggCpu]             = useState<number[]>([]);
  const [aggMem, setAggMem]             = useState<number[]>([]);
  const [openId, setOpenId]             = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const toggleDrawer = (id: string) => setOpenId((prev) => (prev === id ? null : id));

  const loadServers = () =>
    api.getServers().then((result) => {
      if (result.success && result.data) setServers((result.data.servers ?? []).map(mapServerRow));
    });

  const loadPending = () =>
    api.getPendingAgents().then((result) => {
      setPending(result.success && result.data ? result.data.pending ?? [] : []);
    });

  useEffect(() => {
    loadServers();
    loadPending();

    const onMetrics = (data: { server: any }) => {
      if (!data?.server) return;
      const id = String(data.server.id);
      let isNew = false;
      setServers((prev) => {
        const idx = prev.findIndex((s) => s.id === id);
        if (idx === -1) {
          isNew = true;
          return [...prev, mergeLive(undefined, data.server)];
        }
        const next = [...prev];
        next[idx] = mergeLive(next[idx], data.server);
        return next;
      });
      // A metric for a host we don't have yet (e.g. approved in another session)
      // gives only live values — pull the full row so its specs/network fill in.
      if (isNew) loadServers();
      // Keep the open detail view live too — its gauges read from this prop.
      setDetailServer((d) => (d && d.id === id ? mergeLive(d, data.server) : d));
    };
    const onApproved = () => { loadServers(); loadPending(); };
    const onRemoved = (data: { id: number }) => {
      const rid = String(data?.id);
      setServers((prev) => prev.filter((s) => s.id !== rid));
      setDetailServer((d) => (d && d.id === rid ? null : d));
    };
    const onPending = () => loadPending();
    // Live offline/online flip from the backend's last_seen sweep. A stopped agent
    // sends no metrics, so this is the only signal that a server went down.
    const onStatus = (data: { id: number | string; status: string }) => {
      const id = String(data?.id);
      const apply = (s: Server): Server =>
        s.id !== id
          ? s
          : data.status === "Offline"
            ? { ...s, status: "Offline", cpu: 0, memory: 0, diskUsed: 0, uptime: "—" }
            : { ...s, status: data.status };
      setServers((prev) => prev.map(apply));
      // Mirror the flip onto the open detail view so its gauges go Offline live.
      setDetailServer((d) => (d ? apply(d) : d));
    };

    socket.on("serverMetrics", onMetrics);
    socket.on("agentApproved", onApproved);
    socket.on("serverRemoved", onRemoved);
    socket.on("agentPending", onPending);
    socket.on("serverStatus", onStatus);
    return () => {
      socket.off("serverMetrics", onMetrics);
      socket.off("agentApproved", onApproved);
      socket.off("serverRemoved", onRemoved);
      socket.off("agentPending", onPending);
      socket.off("serverStatus", onStatus);
    };
  }, []);

  // Deep-link from a notification: /server-metrics?device=<id> opens that server's
  // detail once the list has loaded, then drops the param (so Back returns to the
  // list and a refresh doesn't re-trigger).
  useEffect(() => {
    const deviceParam = searchParams.get("device");
    if (!deviceParam) return;
    const match = servers.find((s) => s.id === String(deviceParam));
    if (!match) return;
    setDetailServer(match);
    searchParams.delete("device");
    setSearchParams(searchParams, { replace: true });
  }, [servers, searchParams, setSearchParams]);

  const total  = servers.length;
  const online = servers.filter((s) => s.status === "Online").length;
  const cpuAvg = total ? Math.round(servers.reduce((a, s) => a + s.cpu, 0) / total) : 0;
  const memAvg = total ? Math.round(servers.reduce((a, s) => a + s.memory, 0) / total) : 0;

  // Keep the latest averages in a ref so the fixed-interval sampler below reads
  // current values without re-arming the timer on every render.
  const avgRef = useRef({ cpu: cpuAvg, mem: memAvg, count: total });
  avgRef.current = { cpu: cpuAvg, mem: memAvg, count: total };

  // Roll a short history of the aggregate averages for the stat sparklines on a
  // FIXED 10s tick. Sampling on each socket push (one per host, staggered) made
  // the x-axis non-uniform; a steady cadence matches the agents' interval.
  useEffect(() => {
    const t = setInterval(() => {
      if (avgRef.current.count === 0) return;
      setAggCpu((p) => [...p.slice(-47), avgRef.current.cpu]);
      setAggMem((p) => [...p.slice(-47), avgRef.current.mem]);
    }, 10_000);
    return () => clearInterval(t);
  }, []);

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(
      `Remove "${name}" from monitoring?\n\nThis deletes the server and revokes its agent token. ` +
      `If its agent is still running, stop it on that machine too.`,
    )) return;
    const r = await api.deleteServer(Number(id));
    if (r.success) {
      setServers((prev) => prev.filter((s) => s.id !== id));
      if (detailServer?.id === id) setDetailServer(null);
    } else {
      alert(r.error ?? "Failed to remove server.");
    }
  };

  const handleApprove = async (id: number) => {
    const r = await api.approveAgent(id);
    if (r.success) { setPending((p) => p.filter((x) => x.id !== id)); loadServers(); }
  };
  const handleReject = async (id: number) => {
    const r = await api.rejectAgent(id);
    if (r.success) setPending((p) => p.filter((x) => x.id !== id));
  };

  if (detailServer) {
    return <ServerDetail server={detailServer} onBack={() => setDetailServer(null)} />;
  }

  const onlineColor = total === 0 ? gf.textMuted : online === total ? GREEN : online === 0 ? RED : ORANGE;

  return (
    <div className="flex flex-col gap-2.5" style={{ background: gf.bg, minHeight: "100%", padding: 12 }}>
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 px-0.5">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-[15px] font-semibold truncate" style={{ color: gf.textPrimary }}>Server Metrics</h1>
          <span className="text-[11px] hidden sm:inline" style={{ color: gf.textDim }}>{total} hosts · {online} online</span>
        </div>
        <span className="flex items-center gap-1.5 text-[10px] tracking-widest uppercase shrink-0" style={{ color: gf.textMuted }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: GREEN, boxShadow: `0 0 6px ${GREEN}` }} /> Live
        </span>
      </div>

      {/* Pending approvals */}
      {pending.length > 0 && (
        <Panel title={`Pending approvals · ${pending.length}`} noPad bodyStyle={{ padding: 8 }}>
          <div className="flex flex-col gap-1.5">
            {pending.map((a) => (
              <div
                key={a.id}
                className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-lg px-3 py-2"
                style={{ background: "rgba(255,120,10,0.06)", border: "1px solid rgba(255,120,10,0.22)" }}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-medium truncate" style={{ color: gf.textPrimary }}>{a.name}</div>
                  <div className="text-[10px] truncate" style={{ color: gf.textMuted }}>
                    {(a.ip ?? "—")} · {(a.os ?? "—")} · {(a.arch ?? "—")} · {a.cores ?? "?"} cores
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleApprove(a.id)}
                    className="flex-1 sm:flex-none text-[11px] font-medium px-3 py-1.5 rounded-md text-white active:scale-95 transition"
                    style={{ background: GREEN }}
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => handleReject(a.id)}
                    className="flex-1 sm:flex-none text-[11px] font-medium px-3 py-1.5 rounded-md active:scale-95 transition"
                    style={{ background: gf.hover, color: gf.textMuted, border: `1px solid ${gf.border}` }}
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* Stat row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <StatPanel label="Total Servers" value={String(total)} color={BLUE} sub="monitored" />
        <StatPanel label="Online" value={`${online}/${total}`} color={onlineColor} sub={`${total - online} offline`} />
        <StatPanel label="Avg CPU" value={String(cpuAvg)} unit="%" color={loadColor(cpuAvg)} spark={aggCpu} />
        <StatPanel label="Avg Memory" value={String(memAvg)} unit="%" color={loadColor(memAvg)} spark={aggMem} />
      </div>

      {/* Per-host bar gauges */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
        <Panel title="Host CPU" noPad bodyStyle={{ padding: "6px 0" }}>
          {servers.length === 0
            ? <div className="text-[10px] text-center py-5" style={{ color: gf.textDim }}>No hosts</div>
            : servers.map((s) => <BarGauge key={s.id} label={s.name} value={s.cpu} status={s.status} />)}
        </Panel>
        <Panel title="Host Memory" noPad bodyStyle={{ padding: "6px 0" }}>
          {servers.length === 0
            ? <div className="text-[10px] text-center py-5" style={{ color: gf.textDim }}>No hosts</div>
            : servers.map((s) => <BarGauge key={s.id} label={s.name} value={s.memory} status={s.status} />)}
        </Panel>
      </div>

      {/* Server list */}
      <Panel
        title="Servers"
        noPad
        right={<span className="text-[10px]" style={{ color: gf.textDim }}>{online}/{total} online</span>}
      >
        {servers.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-12 px-4">
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" style={{ color: gf.textDim }}>
              <rect x="3" y="4" width="18" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <rect x="3" y="14" width="18" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="7" cy="7" r="1" fill="currentColor" />
              <circle cx="7" cy="17" r="1" fill="currentColor" />
            </svg>
            <p className="text-[13px] mt-3" style={{ color: gf.textMuted }}>No servers monitored yet</p>
            <p className="text-[11px] mt-1 max-w-xs" style={{ color: gf.textDim }}>
              Install the monitoring agent on a server and approve it to see live metrics here.
            </p>
          </div>
        ) : (
          <>
            {/* Mobile: card list */}
            <div className="md:hidden flex flex-col gap-2 p-2.5">
              {servers.map((s) => (
                <ServerCard
                  key={s.id}
                  s={s}
                  isAdmin={isAdmin}
                  onView={() => setDetailServer(s)}
                  onDelete={() => handleDelete(s.id, s.name)}
                />
              ))}
            </div>

            {/* Desktop: table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr style={{ borderBottom: `1px solid ${gf.divider}` }}>
                    {["Host", "IP Address", "Status", "CPU", "Memory", "Disk", "Uptime", ""].map((h) => (
                      <th key={h} className="text-left px-3 py-2 text-[9px] tracking-widest uppercase font-medium whitespace-nowrap" style={{ color: gf.textDim }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {servers.map((s, i) => (
                    <React.Fragment key={s.id}>
                      <tr
                        onClick={() => toggleDrawer(s.id)}
                        className="cursor-pointer transition-colors"
                        style={{ borderBottom: `1px solid ${gf.divider}`, background: openId === s.id ? gf.hover : i % 2 ? gf.hover : "transparent" }}
                      >
                        <td className="px-3 py-2.5 text-[12px] font-medium whitespace-nowrap" style={{ color: gf.textPrimary }}>
                          {s.name}
                          <span className="ml-1.5 text-[10px] inline-block transition-transform" style={{ color: gf.textDim, transform: openId === s.id ? "rotate(180deg)" : "none" }}>▾</span>
                        </td>
                        <td className="px-3 py-2.5 text-[11px] font-mono whitespace-nowrap" style={{ color: gf.textMuted }}>{s.ip}</td>
                        <td className="px-3 py-2.5"><StatusDot status={s.status} /></td>
                        <td className="px-3 py-2.5"><TableBar value={s.cpu} /></td>
                        <td className="px-3 py-2.5"><TableBar value={s.memory} /></td>
                        <td className="px-3 py-2.5"><TableBar value={s.diskUsed} /></td>
                        <td className="px-3 py-2.5 text-[11px] whitespace-nowrap" style={{ color: gf.textMuted }}>{s.uptime}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-right">
                          <GhostButton onClick={(e) => { e.stopPropagation(); setDetailServer(s); }}>View</GhostButton>
                          {isAdmin && (
                            <span className="ml-2 inline-block">
                              <GhostButton onClick={(e) => { e.stopPropagation(); handleDelete(s.id, s.name); }} danger>Remove</GhostButton>
                            </span>
                          )}
                        </td>
                      </tr>
                      <ServerDrawerRow server={s} isOpen={openId === s.id} />
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>
    </div>
  );
}
