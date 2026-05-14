import React, { useState, useEffect } from "react";
import "../chart/ChartConfig";
import StatusBadge from "../components/ui/StatusBadge";
import { api } from "../api/api";
import ServerDetail from "./ServerDetail";
import { socket } from "../socket/socket";

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function barColor(v: number) {
  if (v > 70) return "#E24B4A";
  if (v > 50) return "#BA7517";
  return "#3B6D11";
}

// ─── GaugeCanvas ──────────────────────────────────────────────────────────────

function GaugeCanvas({
  value, label, pct, color, size = 130,
}: {
  value: string | number; label: string; pct: number; color: string; size?: number;
}) {
  const ref = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const cx = size / 2, cy = size * 0.65, r = size * 0.36;
    const s  = Math.PI * 0.8, e = Math.PI * 2.2;
    const f  = s + (e - s) * Math.min(Math.max(pct, 0), 1);
    const sw = e - s;

    ctx.clearRect(0, 0, size, size);

    // bg track
    ctx.beginPath(); ctx.arc(cx, cy, r, s, e);
    ctx.strokeStyle = "rgba(128,128,128,0.15)";
    ctx.lineWidth = size * 0.07; ctx.lineCap = "round"; ctx.stroke();

    // threshold bands
    let prev = s;
    for (const [end, col] of [
      [0.5,  "rgba(115,191,105,0.15)"],
      [0.75, "rgba(239,159,39,0.15)"],
      [1.0,  "rgba(226,75,74,0.15)"],
    ] as [number, string][]) {
      const be = s + sw * end;
      ctx.beginPath(); ctx.arc(cx, cy, r, prev, be);
      ctx.strokeStyle = col; ctx.lineWidth = size * 0.07; ctx.lineCap = "butt"; ctx.stroke();
      prev = be;
    }

    // fill arc
    if (pct > 0) {
      ctx.beginPath(); ctx.arc(cx, cy, r, s, f);
      ctx.strokeStyle = color; ctx.lineWidth = size * 0.07; ctx.lineCap = "round"; ctx.stroke();
    }

    // value text
    ctx.fillStyle = color;
    ctx.font      = `bold ${Math.round(size * 0.2)}px monospace`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(value), cx, cy - r * 0.08);

    // label text
    ctx.fillStyle = "rgba(148,163,184,0.6)";
    ctx.font      = `${Math.round(size * 0.1)}px monospace`;
    ctx.fillText(label, cx, cy + r * 0.35);
  }, [pct, color, value, label, size]);

  return (
    <canvas
      ref={ref}
      width={size}
      height={size * 0.78}
      style={{ width: "100%", maxWidth: size, height: "auto" }}
    />
  );
}

// ─── SummaryGaugeCard ─────────────────────────────────────────────────────────

function SummaryGaugeCard({
  title, value, pct, color, sub,
}: {
  title: string;
  value: string | number;
  pct: number;
  color: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl bg-slate-100 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08] overflow-hidden flex flex-col">
      <div className="px-4 pt-3 pb-1 border-b border-slate-200 dark:border-white/[0.06]">
        <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400 tracking-widest uppercase">{title}</span>
      </div>
      <div className="flex flex-1 items-center justify-center py-2 px-4">
        <GaugeCanvas value={value} label={sub ?? ""} pct={pct} color={color} size={120} />
      </div>
    </div>
  );
}

// ─── MiniBar ──────────────────────────────────────────────────────────────────

function MiniBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="w-12 h-1 bg-black/10 dark:bg-white/10 rounded-full overflow-hidden inline-block align-middle ml-1.5">
      <div className="h-full rounded-full transition-all" style={{ width: `${value}%`, background: color }} />
    </div>
  );
}

// ─── Metric icons ─────────────────────────────────────────────────────────────

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

// ─── MetricCard (inline drawer) ───────────────────────────────────────────────

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
    <div className="flex flex-col gap-1 bg-white dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08] rounded-lg p-3 min-w-[100px] flex-1">
      <div className="flex items-center gap-1.5">
        <div className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0" style={{ background: iconBg, color: iconColor }}>
          {icon}
        </div>
        <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{label}</span>
      </div>
      <div className="font-mono text-[18px] font-medium text-slate-900 dark:text-white leading-none">{value}</div>
      {percent !== undefined && (
        <div className="h-[3px] bg-slate-100 dark:bg-white/10 rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all duration-500" style={{ width: `${percent}%`, background: barColor(percent) }} />
        </div>
      )}
      <div className="text-[11px] text-slate-400">{sub}</div>
    </div>
  );
}

// ─── ServerDrawerRow ──────────────────────────────────────────────────────────

function ServerDrawerRow({ server: s, isOpen }: { server: Server; isOpen: boolean }) {
  const memUsedGB  = ((s.memory  / 100) * s.memoryTotalGB).toFixed(1);
  const memFreeGB  = (s.memoryTotalGB - parseFloat(memUsedGB)).toFixed(1);
  const diskUsedGB = Math.round((s.diskUsed / 100) * s.diskTotalGB);
  const diskFreeGB = s.diskTotalGB - diskUsedGB;

  return (
    <tr>
      <td colSpan={7} className="p-0">
        <div className={`overflow-hidden transition-all duration-300 ease-in-out border-b border-slate-200 dark:border-white/[0.07] ${isOpen ? "max-h-40" : "max-h-0"}`}>
          <div className="flex flex-wrap gap-2 p-3 bg-slate-50 dark:bg-white/[0.015]">
            <MetricCard icon={<CpuIcon />}     iconBg="#E6F1FB" iconColor="#185FA5" label="CPU usage" value={`${s.cpu}%`}          percent={s.cpu}     sub={s.cpu > 70 ? "High load" : s.cpu > 50 ? "Moderate" : "Healthy"} />
            <MetricCard icon={<MemUsedIcon />} iconBg="#EEEDFE" iconColor="#534AB7" label="Mem used"  value={`${s.memory}%`}       percent={s.memory}  sub={`${memUsedGB} GB of ${s.memoryTotalGB} GB`} />
            <MetricCard icon={<MemFreeIcon />} iconBg="#EAF3DE" iconColor="#3B6D11" label="Mem free"  value={`${memFreeGB} GB`}    sub={`of ${s.memoryTotalGB} GB total`} />
            <MetricCard icon={<DiskUsedIcon />}iconBg="#FAEEDA" iconColor="#854F0B" label="Disk used" value={`${s.diskUsed}%`}     percent={s.diskUsed} sub={`${diskUsedGB} GB of ${s.diskTotalGB} GB`} />
            <MetricCard icon={<DiskFreeIcon />}iconBg="#E1F5EE" iconColor="#0F6E56" label="Disk free" value={`${diskFreeGB} GB`}   sub="available" />
          </div>
        </div>
      </td>
    </tr>
  );
}

// ─── InfoCard ─────────────────────────────────────────────────────────────────

function InfoCard({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="bg-white dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08] rounded-xl p-4">
      <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-3">{title}</div>
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between items-center py-1.5 border-b border-slate-100 dark:border-white/[0.05] last:border-none text-xs">
          <span className="text-slate-500 dark:text-slate-400">{k}</span>
          <span className="font-mono font-medium text-slate-900 dark:text-white">{v}</span>
        </div>
      ))}
    </div>
  );
}

// ─── ServerMetrics (main) ─────────────────────────────────────────────────────

export default function ServerMetrics() {
  const [servers,      setServers]      = useState<Server[]>([]);
  const [openId,       setOpenId]       = useState<string | null>(null);
  const [detailServer, setDetailServer] = useState<Server | null>(null);

  useEffect(() => {
    api.getServers().then((result) => {
      if (result.success && result.data) setServers(result.data.servers);
    });
    socket.on("serverMetrics", (data: { servers: Server[] }) => setServers(data.servers));
    return () => { socket.off("serverMetrics"); };
  }, []);

  const total   = servers.length;
  const online  = servers.filter((s) => s.status === "Online").length;
  const cpuAvg  = total ? Math.round(servers.reduce((a, s) => a + s.cpu, 0) / total) : 0;

  const toggleDrawer = (id: string) => setOpenId((prev) => (prev === id ? null : id));

  if (detailServer) {
    return <ServerDetail server={detailServer} onBack={() => setDetailServer(null)} />;
  }

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4 bg-white dark:bg-transparent">
      <div className="text-base font-bold text-slate-900 dark:text-white">Server Metrics Overview</div>

      {/* Summary gauge cards */}
      <div className="grid grid-cols-3 gap-3" style={{ height: 160 }}>
        <SummaryGaugeCard
          title="Total Servers"
          value={total}
          pct={total > 0 ? 1 : 0}
          color="#378ADD"
          sub="servers"
        />
        <SummaryGaugeCard
          title="Online"
          value={online}
          pct={total > 0 ? online / total : 0}
          color={online === total ? "#73BF69" : online === 0 ? "#E24B4A" : "#EF9F27"}
          sub={`of ${total}`}
        />
        <SummaryGaugeCard
          title="Avg CPU Load"
          value={`${cpuAvg}%`}
          pct={cpuAvg / 100}
          color={barColor(cpuAvg)}
          sub="average"
        />
      </div>

      {/* Server table */}
      <div className="rounded-xl bg-slate-100 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08] p-4">
        <div className="text-sm font-bold text-slate-900 dark:text-white mb-3">Live Server List</div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {["Server", "IP Address", "Status", "CPU", "Memory", "Uptime", ""].map((h) => (
                  <th key={h} className="text-left px-3 py-2 text-[10px] text-slate-500 font-semibold tracking-widest border-b border-slate-200 dark:border-white/[0.07] whitespace-nowrap">
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
                    className={`cursor-pointer transition-colors hover:bg-slate-200 dark:hover:bg-white/[0.05]
                      ${openId === s.id ? "bg-slate-200 dark:bg-white/[0.05]" : i % 2 === 0 ? "bg-slate-50 dark:bg-white/[0.015]" : ""}`}
                  >
                    <td className="px-3 py-3 text-slate-900 dark:text-white font-semibold text-xs">
                      {s.name}
                      <span className={`inline-block ml-1.5 text-slate-400 text-[10px] transition-transform duration-200 ${openId === s.id ? "rotate-180" : ""}`}>▾</span>
                    </td>
                    <td className="px-3 py-3 font-mono text-slate-500 dark:text-slate-400 text-xs">{s.ip}</td>
                    <td className="px-3 py-3"><StatusBadge status={s.status} /></td>
                    <td className="px-3 py-3">
                      <span className="font-mono font-bold text-xs" style={{ color: barColor(s.cpu) }}>{s.cpu}%</span>
                      <MiniBar value={s.cpu} color={barColor(s.cpu)} />
                    </td>
                    <td className="px-3 py-3">
                      <span className="font-mono font-bold text-xs" style={{ color: barColor(s.memory) }}>{s.memory}%</span>
                      <MiniBar value={s.memory} color={barColor(s.memory)} />
                    </td>
                    <td className="px-3 py-3 text-slate-500 dark:text-slate-400 text-xs whitespace-nowrap">{s.uptime}</td>
                    <td className="px-3 py-3">
                      <button
                        onClick={(e) => { e.stopPropagation(); setDetailServer(s); }}
                        className="text-xs font-medium px-2.5 py-1 rounded-md border border-slate-200 dark:border-white/[0.1]
                          bg-transparent text-slate-700 dark:text-slate-300
                          hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors whitespace-nowrap"
                      >
                        View
                      </button>
                    </td>
                  </tr>
                  <ServerDrawerRow server={s} isOpen={openId === s.id} />
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}