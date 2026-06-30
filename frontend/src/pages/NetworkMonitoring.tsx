import { useState, useEffect } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import NetworkDetail from "./NetworkDetail";

// ─── Types ────────────────────────────────────────────────────────────────────

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
  monitored: boolean;
}

// ─── Grafana tokens (match ServerMetrics.tsx) ─────────────────────────────────

const gf = {
  bg: "var(--gf-bg)",
  panel: "var(--gf-panel)",
  border: "var(--gf-panel-border)",
  divider: "var(--gf-divider)",
  textPrimary: "var(--gf-text-primary)",
  textMuted: "var(--gf-text-muted)",
  textDim: "var(--gf-text-dim)",
  hover: "var(--gf-hover)",
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
function formatUptime(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.floor(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

function mapNet(r: any): NetDevice {
  return {
    id: String(r.id),
    name: r.name ?? "—",
    ip: r.ip ?? "—",
    location: r.location ?? "—",
    status: r.status ?? "Offline",
    reachable: r.reachable ?? null,
    uptimeSeconds: r.uptimeSeconds ?? null,
    interfaces: (r.interfaces ?? []).map((i: any) => ({
      name: i.name ?? "—",
      locationLabel: i.locationLabel ?? "",
      linkUp: Boolean(i.linkUp),
      utilizationPct: i.utilizationPct ?? null,
      rxBytes: i.rxBytes ?? null,
      txBytes: i.txBytes ?? null,
    })),
    monitored: r.monitored ?? true,
  };
}
function mergeNetLive(prev: NetDevice | undefined, p: any): NetDevice {
  const base = prev ?? mapNet({ ...p, monitored: true });
  return {
    ...base,
    status: p.status ?? base.status,
    reachable: p.reachable ?? base.reachable,
    uptimeSeconds: p.uptimeSeconds ?? base.uptimeSeconds,
    interfaces: p.interfaces ? mapNet(p).interfaces : base.interfaces,
  };
}

// ─── Panel ────────────────────────────────────────────────────────────────────

function Panel({
  title, right, children, noPad, onClick,
}: {
  title?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  noPad?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`flex flex-col rounded-lg overflow-hidden${onClick ? " cursor-pointer" : ""}`}
      style={{ background: gf.panel, border: `1px solid ${gf.border}` }}
    >
      {title !== undefined && (
        <div className="flex items-center justify-between px-3 shrink-0" style={{ height: 32, borderBottom: `1px solid ${gf.divider}` }}>
          <span className="text-[11px] font-medium tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>{title}</span>
          {right && <div className="flex items-center gap-2">{right}</div>}
        </div>
      )}
      <div className="flex-1 min-h-0" style={{ padding: noPad ? 0 : 12 }}>{children}</div>
    </div>
  );
}

function StatPanel({ label, value, unit, color, sub }: { label: string; value: string; unit?: string; color: string; sub?: string }) {
  return (
    <div className="relative overflow-hidden rounded-lg flex flex-col" style={{ background: gf.panel, border: `1px solid ${gf.border}`, minHeight: 88 }}>
      <div className="flex items-center justify-between px-3 pt-2.5">
        <span className="text-[10px] tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>{label}</span>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      </div>
      <div className="px-3 pt-1.5">
        <span className="text-[26px] font-bold leading-none" style={{ color }}>{value}</span>
        {unit && <span className="text-[13px] ml-1" style={{ color: color + "AA" }}>{unit}</span>}
        {sub && <div className="text-[9px] mt-1 tracking-widest uppercase" style={{ color: gf.textDim }}>{sub}</div>}
      </div>
    </div>
  );
}

// ─── Ghost button (matches ServerMetrics "View") ──────────────────────────────

function GhostButton({ children, onClick }: { children: React.ReactNode; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={onClick}
      className="text-[11px] font-medium px-2.5 py-1 rounded-md transition-colors active:scale-95"
      style={{ color: gf.textMuted, border: `1px solid ${gf.border}`, background: "transparent" }}
    >
      {children}
    </button>
  );
}

// ─── Interface row ────────────────────────────────────────────────────────────

function IfaceRow({ i }: { i: NetIface }) {
  const util = Math.round(i.utilizationPct ?? 0);
  return (
    <div className="flex items-center gap-3 px-3 py-2" style={{ borderBottom: `1px solid ${gf.divider}` }}>
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: i.linkUp ? GREEN : RED, boxShadow: `0 0 5px ${i.linkUp ? GREEN : RED}` }} />
      <div className="w-32 min-w-0">
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

export default function NetworkMonitoring() {
  const [devices, setDevices] = useState<NetDevice[]>([]);
  const [detail, setDetail] = useState<NetDevice | null>(null);

  const load = () =>
    api.getNetworkDevices().then((r) => {
      if (r.success && r.data) setDevices((r.data.devices ?? []).map(mapNet));
    });

  useEffect(() => {
    load();
    const onMetrics = (data: { device: any }) => {
      if (!data?.device) return;
      const id = String(data.device.id);
      setDevices((prev) => {
        const idx = prev.findIndex((d) => d.id === id);
        if (idx === -1) return [...prev, mergeNetLive(undefined, data.device)];
        const next = [...prev];
        next[idx] = mergeNetLive(next[idx], data.device);
        return next;
      });
    };
    const onStatus = (data: { id: number | string; status: string }) => {
      const id = String(data?.id);
      setDevices((prev) =>
        prev.map((d) =>
          d.id !== id
            ? d
            : data.status === "Offline"
              ? { ...d, status: "Offline", reachable: false, interfaces: [] }
              : { ...d, status: data.status },
        ),
      );
    };
    socket.on("networkMetrics", onMetrics);
    socket.on("networkStatus", onStatus);
    return () => {
      socket.off("networkMetrics", onMetrics);
      socket.off("networkStatus", onStatus);
    };
  }, []);

  const total = devices.length;
  const online = devices.filter((d) => d.status === "Online").length;
  const allIfaces = devices.flatMap((d) => d.interfaces);
  const ifacesUp = allIfaces.filter((i) => i.linkUp).length;
  const upUtil = allIfaces.filter((i) => i.linkUp && i.utilizationPct != null).map((i) => i.utilizationPct as number);
  const avgUtil = upUtil.length ? Math.round(upUtil.reduce((a, b) => a + b, 0) / upUtil.length) : 0;
  const onlineColor = total === 0 ? gf.textMuted : online === total ? GREEN : online === 0 ? RED : ORANGE;

  // Drill-down: render the per-router detail in place (Back returns to the list),
  // mirroring ServerMetrics ↔ ServerDetail. Pass the live row so it opens current.
  if (detail) {
    const live = devices.find((x) => x.id === detail.id) ?? detail;
    return <NetworkDetail device={live} onBack={() => setDetail(null)} />;
  }

  return (
    <div className="flex flex-col gap-2.5" style={{ background: gf.bg, minHeight: "100%", padding: 12 }}>
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 px-0.5">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-[15px] font-semibold truncate" style={{ color: gf.textPrimary }}>Network Monitoring</h1>
          <span className="text-[11px] hidden sm:inline" style={{ color: gf.textDim }}>{total} devices · {online} online</span>
        </div>
        <span className="flex items-center gap-1.5 text-[10px] tracking-widest uppercase shrink-0" style={{ color: gf.textMuted }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: GREEN, boxShadow: `0 0 6px ${GREEN}` }} /> Live
        </span>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <StatPanel label="Routers/Switches" value={String(total)} color={BLUE} sub="monitored" />
        <StatPanel label="Online" value={`${online}/${total}`} color={onlineColor} sub={`${total - online} offline`} />
        <StatPanel label="Interfaces Up" value={String(ifacesUp)} color={GREEN} sub={`of ${allIfaces.length}`} />
        <StatPanel label="Avg Utilization" value={String(avgUtil)} unit="%" color={loadColor(avgUtil)} sub="of link speed" />
      </div>

      {total === 0 ? (
        <Panel title="Devices">
          <div className="flex flex-col items-center justify-center text-center py-12 px-4">
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" style={{ color: gf.textDim }}>
              <rect x="2" y="3" width="20" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <rect x="2" y="15" width="20" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M12 9v6M7 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <p className="text-[13px] mt-3" style={{ color: gf.textMuted }}>No routers or switches monitored yet</p>
            <p className="text-[11px] mt-1 max-w-md" style={{ color: gf.textDim }}>
              Register a managed router (with SNMP enabled) in the database to see live interface metrics here.
            </p>
          </div>
        </Panel>
      ) : (
        /* Per-device interface panels — click a panel (or "View →") to open its full detail */
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
          {devices.map((d) => (
            <Panel
              key={d.id}
              title={d.name}
              noPad
              onClick={() => setDetail(d)}
              right={
                <span className="flex items-center gap-2">
                  <span className="text-[10px] font-mono" style={{ color: gf.textDim }}>{d.ip}</span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor(d.status), boxShadow: `0 0 5px ${statusColor(d.status)}` }} />
                    <span className="text-[11px]" style={{ color: gf.textMuted }}>{d.status}</span>
                  </span>
                  <GhostButton onClick={(e) => { e.stopPropagation(); setDetail(d); }}>View</GhostButton>
                </span>
              }
            >
              <div className="flex items-center justify-between px-3 py-1.5 text-[10px]" style={{ color: gf.textDim, borderBottom: `1px solid ${gf.divider}` }}>
                <span>{d.location}</span>
                <span>↑ {formatUptime(d.uptimeSeconds)}</span>
              </div>
              {!d.monitored ? (
                <div className="px-3 py-4 text-[11px]" style={{ color: ORANGE }}>SNMP not configured — reachability only (ping fallback pending).</div>
              ) : d.interfaces.length === 0 ? (
                <div className="px-3 py-4 text-[11px]" style={{ color: gf.textDim }}>
                  {d.status === "Online" ? "No interfaces reported." : "Offline — awaiting next poll."}
                </div>
              ) : (
                d.interfaces.map((i) => <IfaceRow key={`${d.id}:${i.name}`} i={i} />)
              )}
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
