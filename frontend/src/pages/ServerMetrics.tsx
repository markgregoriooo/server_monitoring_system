import React, { useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/api";
import ServerDetail from "./ServerDetail";
import InstallKeysPanel from "../components/servers/InstallKeysPanel";
import { socket } from "../socket/socket";
import { useAuth } from "../context/AuthContext";
import { resolveColor, alphaColor } from "../utils/canvasColor";
import type { Volume } from "../types/server";
import { GF as gf, STATUS } from "../theme/gf";
import { GhostButton } from "../components/ui/primitives";
const { green: GREEN, orange: ORANGE, red: RED, blue: BLUE } = STATUS;

// Volume is in ../types/server (ServerDetail needs it, and importing it from here
// formed a cycle). Re-exported so existing imports still work.
export type { Volume } from "../types/server";

interface Server {
  id: string;
  name: string;        // effective label: display name if set, else hostname
  hostname: string;    // the real hostname reported by the agent
  displayName: string | null; // admin-set label (null = none)
  ip: string;
  status: string;
  /** Approved, but its agent has never once reached the backend. See below — this is
   *  NOT the same event as "Offline" and needs the opposite reaction. */
  awaitingFirstReport: boolean;
  cpu: number;
  memory: number;
  memoryTotalGB: number;
  diskUsed: number;
  diskTotalGB: number;
  volumes: Volume[];
  processCount: number | null;
  agentVersion: string;
  lastSeen: string | null;
  metricIntervalSec: number | null;
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
    hostname: r.hostname ?? r.name ?? "—",
    displayName: r.displayName ?? null,
    ip: r.ip ?? "—",
    status: r.status ?? "Offline",
    awaitingFirstReport: Boolean(r.awaitingFirstReport),
    cpu: Number(r.cpu ?? 0),
    memory: Number(r.memory ?? 0),
    memoryTotalGB: r.memoryTotalMB ? +(r.memoryTotalMB / 1024).toFixed(1) : 0,
    diskUsed: Number(r.diskUsed ?? 0),
    diskTotalGB: Number(r.diskTotalGB ?? 0),
    volumes: Array.isArray(r.volumes) ? r.volumes : [],
    processCount: r.processCount ?? null,
    agentVersion: r.agentVersion ?? "",
    lastSeen: r.lastSeen ?? null,
    metricIntervalSec: r.metricIntervalSec ?? null,
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
    // A metric arriving is the first report, so clear "Never reported" right away.
    awaitingFirstReport: false,
    cpu: Math.round(p.cpuPercent ?? base.cpu),
    memory: Math.round(p.memPercent ?? base.memory),
    memoryTotalGB: p.memTotalMB ? +(p.memTotalMB / 1024).toFixed(1) : base.memoryTotalGB,
    diskUsed: Math.round(p.diskPercent ?? base.diskUsed),
    diskTotalGB: p.diskTotalGB != null ? Math.round(p.diskTotalGB) : base.diskTotalGB,
    volumes: Array.isArray(p.volumes) ? p.volumes : base.volumes,
    processCount: p.processCount ?? base.processCount,
    // A live metric push means the agent just reported, so this IS its last seen.
    lastSeen: p.timestamp ?? base.lastSeen,
    uptime: p.uptimeLabel ?? base.uptime,
  };
}

// ─── Grafana design tokens (match Dashboard.tsx) ──────────────────────────────


const TRACK = "rgba(127,127,127,0.18)";
const BAR_GRADIENT = "linear-gradient(90deg,#73BF69 0%,#73BF69 55%,#FF780A 78%,#F2495C 95%)";

function loadColor(v: number) {
  if (v >= 85) return RED;
  if (v >= 65) return ORANGE;
  return GREEN;
}

// Compare dotted numeric versions ("1.10.0" > "1.9.0"). Returns 0 for anything
// non-numeric rather than guessing, so an odd version string never gets flagged.
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10));
  const pb = b.split(".").map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function fmtAgo(iso: string | null) {
  if (!iso) return "never";
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function statusColor(s: string) {
  if (s === "Online") return GREEN;
  if (s === "Warning") return ORANGE;
  // Planned downtime is not a fault — red would read as an outage.
  if (s === "Maintenance") return BLUE;
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
          <span className="text-[13px] font-medium tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>
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
    // Resolved, not concatenated — see utils/canvasColor. A CSS custom property reaching
    // addColorStop throws, and the throw escapes this effect and unmounts the page.
    const stroke = resolveColor(color);
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, alphaColor(stroke, 0.27));
    grad.addColorStop(1, alphaColor(stroke, 0));
    ctx.beginPath();
    ctx.moveTo(0, H);
    pts.forEach((v, i) => ctx.lineTo(x(i), y(v)));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    pts.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.strokeStyle = stroke;
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
        <span className="text-[12px] tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>{label}</span>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      </div>
      <div className="px-3 pt-1.5 z-10">
        <span className="text-[28px] font-bold leading-none" style={{ color }}>{value}</span>
        {unit && <span className="text-[15px] ml-1" style={{ color: color + "AA" }}>{unit}</span>}
        {sub && <div className="text-[11px] mt-1 tracking-widest uppercase" style={{ color: gf.textDim }}>{sub}</div>}
      </div>
      {spark && spark.length > 1 && (
        <div className="absolute inset-x-0 bottom-0 opacity-70 pointer-events-none">
          <Sparkline data={spark} color={color} height={36} />
        </div>
      )}
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
      <span className="text-[13px] font-bold w-9 text-right" style={{ color: loadColor(v) }}>{v}%</span>
    </div>
  );
}

// ─── Metric bar (mobile card) ─────────────────────────────────────────────────

function MetricBar({ label, value }: { label: string; value: number }) {
  const v = Math.min(Math.max(value, 0), 100);
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[11px] uppercase tracking-wider" style={{ color: gf.textDim }}>{label}</span>
        <span className="text-[13px] font-bold font-mono" style={{ color: loadColor(v) }}>{v}%</span>
      </div>
      <div className="h-1.5 rounded-[2px] overflow-hidden" style={{ background: TRACK }}>
        <div className="h-full rounded-[2px] transition-all duration-500" style={{ width: `${v}%`, background: BAR_GRADIENT, backgroundSize: `${v > 0 ? (100 / v) * 100 : 100}% 100%` }} />
      </div>
    </div>
  );
}

// A server that has never reported is different from one that went down. Offline means
// check a machine that was working; this means the agent has never reached the backend
// (wrong -server URL, a firewall, or a service that never started). Amber, not red.
function StatusDot({ status, awaiting }: { status: string; awaiting?: boolean }) {
  const pending = Boolean(awaiting) && status !== "Maintenance";
  const c = pending ? ORANGE : statusColor(status);
  const label = pending ? "Never reported" : status;
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={pending ? "Approved, but this server's agent has never sent a metric. Check that the agent service is running and that its -server URL points at this backend." : undefined}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: c, boxShadow: `0 0 5px ${c}` }} />
      <span className="text-[13px]" style={{ color: pending ? ORANGE : gf.textMuted }}>{label}</span>
    </span>
  );
}

// ─── Buttons ──────────────────────────────────────────────────────────────────

// ─── OS badge ─────────────────────────────────────────────────────────────────

// "W" or "L" from the agent's OS string. The agent only runs on Windows and Linux, so
// anything not Windows is Linux. Blank gets no badge.
function osTag(os: string | null | undefined): "W" | "L" | null {
  const v = (os ?? "").trim().toLowerCase();
  if (!v || v === "—" || v === "unknown") return null;
  if (v.includes("windows")) return "W";
  if (v.includes("darwin") || v.includes("mac")) return null;
  return "L";
}

// Windows blue, Linux yellow; not the status colours, so the badge is not read as a status.
const OS_COLOR = { W: "#5794F2", L: "#EAB839" } as const;

function OsBadge({ os }: { os: string | null | undefined }) {
  const tag = osTag(os);
  if (!tag) return null;
  return (
    <span
      title={os ?? undefined}
      aria-label={tag === "W" ? "Windows" : "Linux"}
      className="font-mono text-[12px] font-semibold leading-none"
      style={{ color: OS_COLOR[tag] }}
    >
      {tag}
    </span>
  );
}

// ─── ServerCard (mobile) ──────────────────────────────────────────────────────

function ServerCard({ s, isAdmin, onView, onRename, onDelete, onMaintenance }: {
  s: Server; isAdmin: boolean; onView: () => void; onRename: () => void; onDelete: () => void; onMaintenance: () => void;
}) {
  const renamed = !!s.displayName && s.hostname !== s.name;
  return (
    <div className="rounded-lg p-3" style={{ border: `1px solid ${gf.border}` }}>
      <div className="flex items-start justify-between gap-2">
        <button onClick={onView} className="min-w-0 text-left">
          <div className="flex items-center gap-1.5 min-w-0">
            <OsBadge os={s.os} />
            <span className="text-[15px] font-medium truncate" style={{ color: gf.textPrimary }}>{s.name}</span>
          </div>
          {renamed && <div className="text-[12px] font-mono truncate" style={{ color: gf.textDim }}>host: {s.hostname}</div>}
          <div className="text-[13px] font-mono truncate" style={{ color: gf.textMuted }}>{s.ip}</div>
        </button>
        <StatusDot status={s.status} awaiting={s.awaitingFirstReport} />
      </div>
      <div className="grid grid-cols-3 gap-3 mt-3">
        <MetricBar label="CPU" value={s.cpu} />
        <MetricBar label="Mem" value={s.memory} />
        <MetricBar label="Disk" value={s.diskUsed} />
      </div>
      {/* flex-wrap, and the button group is not shrink-0: an admin's four buttons (~290px) do
         not fit a phone card (~315px) next to the uptime, so they wrap to their own line.
         Same as MikrotikMonitoring.tsx. */}
      <div className="flex items-center justify-between gap-2 mt-3 pt-2.5 flex-wrap" style={{ borderTop: `1px solid ${gf.divider}` }}>
        <span className="text-[13px] truncate" style={{ color: gf.textMuted }}>↑ {s.uptime}</span>
        <div className="flex flex-wrap gap-2">
          <GhostButton onClick={onView}>View</GhostButton>
          {isAdmin && <GhostButton onClick={onRename}>Rename</GhostButton>}
          {isAdmin && (
            <GhostButton onClick={onMaintenance}>
              {s.status === "Maintenance" ? "Resume" : "Maintain"}
            </GhostButton>
          )}
          {isAdmin && <GhostButton onClick={onDelete} danger>Remove</GhostButton>}
        </div>
      </div>
    </div>
  );
}

// ─── RenameModal (admin: set/clear a server's display label) ───────────────────

function RenameModal({ server, onClose }: { server: Server; onClose: () => void }) {
  const [value, setValue] = useState(server.displayName ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setSaving(true);
    setError("");
    const r = await api.renameServer(Number(server.id), value.trim());
    setSaving(false);
    if (r.success) onClose();             // serverRenamed socket event updates the list
    else setError(r.error ?? "Failed to rename server.");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg p-4"
        style={{ background: gf.panel, border: `1px solid ${gf.border}`, boxShadow: "var(--gf-shadow)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[13px] font-semibold mb-1" style={{ color: gf.textPrimary }}>Rename server</h3>
        <p className="text-[11px] mb-3" style={{ color: gf.textMuted }}>
          Hostname <span className="font-mono" style={{ color: gf.textPrimary }}>{server.hostname}</span> · {server.ip}
        </p>
        <input name="value"
          autoFocus
          value={value}
          maxLength={100}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") onClose();
          }}
          placeholder={server.hostname}
          className="w-full text-[13px] px-2.5 py-2 rounded-md outline-none"
          style={{ background: gf.bg, border: `1px solid ${gf.border}`, color: gf.textPrimary }}
        />
        <p className="text-[10px] mt-1.5" style={{ color: gf.textDim }}>Leave blank to use the hostname.</p>
        {error && <p className="text-[11px] mt-2" style={{ color: RED }}>{error}</p>}
        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            className="text-[11px] px-3 py-1.5 rounded-md transition-colors active:scale-95"
            style={{ color: gf.textMuted, border: `1px solid ${gf.border}`, background: "transparent" }}
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="text-[11px] font-medium px-3 py-1.5 rounded-md text-white active:scale-95 transition"
            style={{ background: BLUE, opacity: saving ? 0.6 : 1 }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
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
        <span className="text-[13px] font-medium" style={{ color: gf.textMuted }}>{label}</span>
      </div>
      <div className="font-mono text-[18px] font-medium leading-none" style={{ color: gf.textPrimary }}>{value}</div>
      {percent !== undefined && (
        <div className="h-[3px] rounded-full overflow-hidden" style={{ background: TRACK }}>
          <div className="h-full rounded-full transition-all duration-500" style={{ width: `${percent}%`, background: loadColor(percent) }} />
        </div>
      )}
      <div className="text-[13px]" style={{ color: gf.textDim }}>{sub}</div>
    </div>
  );
}

// Expandable detail row. `newestAgent` is the highest agent version in the fleet, used
// to flag outdated agents without a hardcoded version.
function ServerDrawerRow({ server: s, isOpen, newestAgent }: {
  server: Server; isOpen: boolean; newestAgent: string;
}) {
  const memUsedGB  = ((s.memory / 100) * s.memoryTotalGB).toFixed(1);
  const memFreeGB  = (s.memoryTotalGB - parseFloat(memUsedGB)).toFixed(1);
  const diskUsedGB = Math.round((s.diskUsed / 100) * s.diskTotalGB);
  const diskFreeGB = s.diskTotalGB - diskUsedGB;
  const outdated =
    !!s.agentVersion && !!newestAgent && compareVersions(s.agentVersion, newestAgent) < 0;

  return (
    <tr>
      <td colSpan={8} className="p-0">
        <div
          className="overflow-hidden transition-all duration-300 ease-in-out"
          style={{ maxHeight: isOpen ? 280 : 0, borderBottom: isOpen ? `1px solid ${gf.divider}` : "none" }}
        >
          <div className="p-3" style={{ background: gf.bg }}>
            <div className="flex flex-wrap gap-2">
              <MetricCard icon={<CpuIcon />}      iconBg="#E6F1FB" iconColor="#185FA5" label="CPU usage" value={`${s.cpu}%`}       percent={s.cpu}      sub={s.cpu > 80 ? "High load" : s.cpu > 60 ? "Moderate" : "Healthy"} />
              <MetricCard icon={<MemUsedIcon />}  iconBg="#EEEDFE" iconColor="#534AB7" label="Mem used"  value={`${memUsedGB} GB`} percent={s.memory}   sub={`of ${s.memoryTotalGB} GB`} />
              <MetricCard icon={<MemFreeIcon />}  iconBg="#EAF3DE" iconColor="#3B6D11" label="Mem free"  value={`${memFreeGB} GB`} sub="available" />
              <MetricCard icon={<DiskUsedIcon />} iconBg="#FAEEDA" iconColor="#854F0B" label="Disk used" value={`${diskUsedGB} GB`} percent={s.diskUsed} sub={`of ${s.diskTotalGB} GB`} />
              <MetricCard icon={<DiskFreeIcon />} iconBg="#E1F5EE" iconColor="#0F6E56" label="Disk free" value={`${diskFreeGB} GB`} sub="available" />
            </div>

            {/* Agent health + per-volume usage — neither was visible anywhere before */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2.5 text-[12px]" style={{ color: gf.textDim }}>
              <span>
                agent <span style={{ color: gf.textMuted }}>{s.agentVersion || "—"}</span>
                {outdated && (
                  <span className="ml-1.5 px-1 py-0.5 rounded-[2px]" style={{ color: ORANGE, border: `1px solid ${ORANGE}55` }}>
                    outdated · fleet {newestAgent}
                  </span>
                )}
              </span>
              <span>last report <span style={{ color: gf.textMuted }}>{fmtAgo(s.lastSeen)}</span></span>
              {s.metricIntervalSec != null && <span>every {s.metricIntervalSec}s</span>}
              {s.processCount != null && <span>{s.processCount} processes</span>}
              {s.volumes.length > 0 && (
                <span className="truncate">
                  volumes{" "}
                  {s.volumes.map((v) => (
                    <span key={v.mount} className="ml-1" style={{ color: loadColor(v.percent) }}>
                      {v.mount} {Math.round(v.percent)}%
                    </span>
                  ))}
                </span>
              )}
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
}

// ─── ServerMetrics (main) ─────────────────────────────────────────────────────

export default function ServerMetrics() {
  const [servers, setServers]           = useState<Server[]>([]);
  const [loaded, setLoaded]             = useState(false);
  const [pending, setPending]           = useState<PendingAgent[]>([]);
  const [aggCpu, setAggCpu]             = useState<number[]>([]);
  const [aggMem, setAggMem]             = useState<number[]>([]);
  const [openId, setOpenId]             = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<Server | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const toggleDrawer = (id: string) => setOpenId((prev) => (prev === id ? null : id));

  // The open detail view is in the URL (?device=<id>), so a refresh stays on the same
  // server and Back returns to the list. Looked up from `servers`, which the socket
  // handlers keep live.
  const detailId = searchParams.get("device");
  const detailServer = detailId ? servers.find((s) => s.id === detailId) ?? null : null;
  const openDetail = (id: string) => setSearchParams({ device: id });
  const closeDetail = () => {
    searchParams.delete("device");
    setSearchParams(searchParams);
  };

  const loadServers = () =>
    api.getServers().then((result) => {
      if (result.success && result.data) setServers((result.data.servers ?? []).map(mapServerRow));
      setLoaded(true);
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
    };
    const onApproved = () => { loadServers(); loadPending(); };
    const onRemoved = (data: { id: number }) => {
      const rid = String(data?.id);
      setServers((prev) => prev.filter((s) => s.id !== rid));
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
    };

    // Admin renamed a server elsewhere → patch its label live in the list + detail.
    const onRenamed = (data: { id: number | string; name: string; displayName: string | null; hostname: string }) => {
      const id = String(data?.id);
      const apply = (s: Server): Server =>
        s.id !== id ? s : { ...s, name: data.name, displayName: data.displayName, hostname: data.hostname };
      setServers((prev) => prev.map(apply));
    };

    socket.on("serverMetrics", onMetrics);
    socket.on("agentApproved", onApproved);
    socket.on("serverRemoved", onRemoved);
    socket.on("agentPending", onPending);
    socket.on("serverStatus", onStatus);
    socket.on("serverRenamed", onRenamed);
    return () => {
      socket.off("serverMetrics", onMetrics);
      socket.off("agentApproved", onApproved);
      socket.off("serverRemoved", onRemoved);
      socket.off("agentPending", onPending);
      socket.off("serverStatus", onStatus);
      socket.off("serverRenamed", onRenamed);
    };
  }, []);

  // Remove a ?device= that matches no server (removed, rejected, old bookmark) once the
  // list has loaded.
  useEffect(() => {
    if (loaded && detailId && !detailServer) closeDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, detailId, detailServer]);

  const total  = servers.length;
  const online = servers.filter((s) => s.status === "Online").length;
  const cpuAvg = total ? Math.round(servers.reduce((a, s) => a + s.cpu, 0) / total) : 0;
  const memAvg = total ? Math.round(servers.reduce((a, s) => a + s.memory, 0) / total) : 0;

  // Highest agent version in the fleet — the yardstick for flagging stale agents,
  // so nothing has to hardcode (and then forget to bump) a "current version".
  const newestAgent = servers.reduce(
    (max, s) => (s.agentVersion && compareVersions(s.agentVersion, max) > 0 ? s.agentVersion : max),
    "",
  );

  // Keep the latest averages in a ref so the fixed-interval sampler below reads
  // current values without re-arming the timer on every render.
  const avgRef = useRef({ cpu: cpuAvg, mem: memAvg, count: total });
  avgRef.current = { cpu: cpuAvg, mem: memAvg, count: total };

  // Keep a short history of the fleet averages for the sparklines on a fixed 10s tick,
  // so the x-axis is evenly spaced.
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
      if (detailId === id) closeDetail();
    } else {
      alert(r.error ?? "Failed to remove server.");
    }
  };

  // Park / unpark a server. The backend broadcasts serverStatus, so other open
  // dashboards re-badge on their own — we apply it locally for instant feedback.
  const handleMaintenance = async (id: string, name: string, currentlyParked: boolean) => {
    if (!currentlyParked && !window.confirm(
      `Put "${name}" into maintenance?\n\n` +
      `Offline and threshold alerts stay suppressed for this server until you resume it.`,
    )) return;

    const r = await api.setServerMaintenance(Number(id), !currentlyParked);
    if (!r.success) {
      alert(r.error ?? "Failed to change maintenance state.");
      return;
    }
    const status = r.data?.status ?? (currentlyParked ? "Online" : "Maintenance");
    const apply = (s: Server): Server => (s.id === id ? { ...s, status } : s);
    setServers((prev) => prev.map(apply));
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
    return <ServerDetail server={detailServer} onBack={closeDetail} />;
  }
  // Refreshed on a detail URL: wait for the list rather than flashing it for a moment
  // before the detail view appears.
  if (detailId && !loaded) return null;

  const onlineColor = total === 0 ? gf.textMuted : online === total ? GREEN : online === 0 ? RED : ORANGE;

  return (
    <div className="flex flex-col gap-2.5" style={{ background: gf.bg, minHeight: "100%", padding: 12 }}>
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 px-0.5">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-[15px] font-semibold truncate" style={{ color: gf.textPrimary }}>Server Metrics</h1>
          <span className="text-[13px] hidden sm:inline" style={{ color: gf.textDim }}>{total} hosts · {online} online</span>
        </div>
        <span className="flex items-center gap-1.5 text-[12px] tracking-widest uppercase shrink-0" style={{ color: gf.textMuted }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: GREEN, boxShadow: `0 0 6px ${GREEN}` }} /> Live
        </span>
      </div>

      {/* Install keys (admin), above Pending approvals in the order the work happens: create a
         key, run the install command, approve the server. */}
      {isAdmin && <InstallKeysPanel />}

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
                  <div className="text-[14px] font-medium truncate" style={{ color: gf.textPrimary }}>{a.name}</div>
                  <div className="text-[12px] truncate" style={{ color: gf.textMuted }}>
                    {(a.ip ?? "—")} · {(a.os ?? "—")} · {(a.arch ?? "—")} · {a.cores ?? "?"} cores
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleApprove(a.id)}
                    className="gf-raise flex-1 sm:flex-none text-[13px] font-medium px-3 py-1.5 rounded-md text-white active:scale-95 transition"
                    style={{ background: GREEN }}
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => handleReject(a.id)}
                    className="flex-1 sm:flex-none text-[13px] font-medium px-3 py-1.5 rounded-md active:scale-95 transition"
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

      {/* Server list */}
      <Panel
        title="Servers"
        noPad
        right={<span className="text-[12px]" style={{ color: gf.textDim }}>{online}/{total} online</span>}
      >
        {servers.length === 0 ? (
          <div className="flex flex-col items-center justify-center text-center py-12 px-4">
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" style={{ color: gf.textDim }}>
              <rect x="3" y="4" width="18" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <rect x="3" y="14" width="18" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="7" cy="7" r="1" fill="currentColor" />
              <circle cx="7" cy="17" r="1" fill="currentColor" />
            </svg>
            <p className="text-[15px] mt-3" style={{ color: gf.textMuted }}>No servers monitored yet</p>
            <p className="text-[13px] mt-1 max-w-xs" style={{ color: gf.textDim }}>
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
                  onView={() => openDetail(s.id)}
                  onRename={() => setRenameTarget(s)}
                  onDelete={() => handleDelete(s.id, s.name)}
                  onMaintenance={() => handleMaintenance(s.id, s.name, s.status === "Maintenance")}
                />
              ))}
            </div>

            {/* Desktop: table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr style={{ borderBottom: `1px solid ${gf.divider}` }}>
                    {["Host", "IP Address", "Status", "CPU", "Memory", "Disk", "Uptime", ""].map((h) => (
                      <th key={h} className="text-left px-3 py-2 text-[11px] tracking-widest uppercase font-medium whitespace-nowrap" style={{ color: gf.textDim }}>
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
                        <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: gf.textPrimary }}>
                          <div className="text-[14px] font-medium flex items-center gap-1.5">
                            <OsBadge os={s.os} />
                            {s.name}
                            <span className="ml-1.5 text-[12px] inline-block transition-transform" style={{ color: gf.textDim, transform: openId === s.id ? "rotate(180deg)" : "none" }}>▾</span>
                          </div>
                          {s.displayName && s.hostname !== s.name && (
                            <div className="text-[12px] font-mono font-normal" style={{ color: gf.textDim }}>host: {s.hostname}</div>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-[13px] font-mono whitespace-nowrap" style={{ color: gf.textMuted }}>{s.ip}</td>
                        <td className="px-3 py-2.5"><StatusDot status={s.status} awaiting={s.awaitingFirstReport} /></td>
                        <td className="px-3 py-2.5"><TableBar value={s.cpu} /></td>
                        <td className="px-3 py-2.5"><TableBar value={s.memory} /></td>
                        <td className="px-3 py-2.5"><TableBar value={s.diskUsed} /></td>
                        <td className="px-3 py-2.5 text-[13px] whitespace-nowrap" style={{ color: gf.textMuted }}>{s.uptime}</td>
                        {/* One flex row with one gap, like the mobile card, so all buttons are evenly spaced. */}
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className="flex items-center justify-end gap-2">
                            <GhostButton onClick={(e) => { e.stopPropagation(); openDetail(s.id); }}>View</GhostButton>
                            {isAdmin && <GhostButton onClick={(e) => { e.stopPropagation(); setRenameTarget(s); }}>Rename</GhostButton>}
                            {isAdmin && (
                              <GhostButton onClick={(e) => {
                                e.stopPropagation();
                                handleMaintenance(s.id, s.name, s.status === "Maintenance");
                              }}>
                                {s.status === "Maintenance" ? "Resume" : "Maintain"}
                              </GhostButton>
                            )}
                            {isAdmin && (
                              <GhostButton onClick={(e) => { e.stopPropagation(); handleDelete(s.id, s.name); }} danger>Remove</GhostButton>
                            )}
                          </div>
                        </td>
                      </tr>
                      <ServerDrawerRow server={s} isOpen={openId === s.id} newestAgent={newestAgent} />
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>

      {renameTarget && (
        <RenameModal server={renameTarget} onClose={() => setRenameTarget(null)} />
      )}
    </div>
  );
}
