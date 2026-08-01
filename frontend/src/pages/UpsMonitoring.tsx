import { useState, useEffect, useRef } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";

// ─── Types ────────────────────────────────────────────────────────────────────

interface UpsDevice {
  id: string;
  name: string;
  ip: string;
  location: string;
  brand: string | null;
  model: string | null;
  commType: string | null;
  status: string;
  batteryChargePct: number | null;
  runtimeRemainingMin: number | null;
  loadPct: number | null;
  inputVoltage: number | null;
  outputVoltage: number | null;
  batteryVoltage: number | null;
  onBattery: boolean | null;
  temperature: number | null;
  monitored: boolean;
}
interface HistPoint {
  time: string;
  batteryChargePct: number | null;
  loadPct: number | null;
  runtimeRemainingMin: number | null;
  inputVoltage: number | null;
  outputVoltage: number | null;
}

// ─── Grafana tokens ───────────────────────────────────────────────────────────

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

const RANGES = ["-1h", "-6h", "-24h"] as const;
type Range = (typeof RANGES)[number];
const rangeLabel: Record<Range, string> = { "-1h": "1h", "-6h": "6h", "-24h": "24h" };

function loadColor(v: number) {
  if (v >= 85) return RED;
  if (v >= 65) return ORANGE;
  return GREEN;
}
// Battery: low charge is BAD, so the scale is inverted vs. load.
function batteryColor(v: number) {
  if (v <= 20) return RED;
  if (v <= 50) return ORANGE;
  return GREEN;
}
function statusColor(s: string) {
  if (s === "Online") return GREEN;
  if (s === "Warning") return ORANGE;
  return RED;
}
const fmt = (v: number | null, unit = "", digits = 0) =>
  v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(digits)}${unit}`;

// ─── Mapping ──────────────────────────────────────────────────────────────────

function mapUps(r: any): UpsDevice {
  return {
    id: String(r.id),
    name: r.name ?? "—",
    ip: r.ip ?? "—",
    location: r.location ?? "—",
    brand: r.brand ?? null,
    model: r.model ?? null,
    commType: r.commType ?? null,
    status: r.status ?? "Offline",
    batteryChargePct: r.batteryChargePct ?? null,
    runtimeRemainingMin: r.runtimeRemainingMin ?? null,
    loadPct: r.loadPct ?? null,
    inputVoltage: r.inputVoltage ?? null,
    outputVoltage: r.outputVoltage ?? null,
    batteryVoltage: r.batteryVoltage ?? null,
    onBattery: r.onBattery ?? null,
    temperature: r.temperature ?? null,
    monitored: r.monitored ?? true,
  };
}
function mergeUpsLive(prev: UpsDevice | undefined, p: any): UpsDevice {
  const base = prev ?? mapUps({ ...p, monitored: true });
  return { ...base, ...mapUps({ ...p, brand: base.brand, model: base.model, commType: base.commType, monitored: base.monitored }) };
}

// ─── Panel / Stat ─────────────────────────────────────────────────────────────

function Panel({ title, right, children, noPad }: { title?: string; right?: React.ReactNode; children: React.ReactNode; noPad?: boolean }) {
  return (
    <div className="flex flex-col rounded-lg overflow-hidden" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
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

function Bar({ value, color }: { value: number; color?: string }) {
  const v = Math.min(Math.max(value, 0), 100);
  return (
    <div className="h-2 rounded-[2px] overflow-hidden" style={{ background: TRACK }}>
      <div className="h-full rounded-[2px] transition-all duration-500" style={{ width: `${v}%`, background: color ?? BAR_GRADIENT, backgroundSize: color ? undefined : `${v > 0 ? (100 / v) * 100 : 100}% 100%` }} />
    </div>
  );
}

// ─── History chart (battery % + load %) ───────────────────────────────────────

function UpsHistoryChart({ history }: { history: HistPoint[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const W = (c.width = c.clientWidth * 2);
    const H = (c.height = 160 * 2);
    ctx.clearRect(0, 0, W, H);
    const batt = history.map((p) => p.batteryChargePct ?? 0);
    const load = history.map((p) => p.loadPct ?? 0);
    if (batt.length < 2) {
      ctx.fillStyle = "#6B7280";
      ctx.font = "24px 'JetBrains Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText("No data in range", W / 2, H / 2);
      return;
    }
    const pad = 12 * 2;
    const x = (i: number, len: number) => pad + (i / (len - 1)) * (W - pad * 2);
    const y = (v: number) => H - pad - (v / 100) * (H - pad * 2); // both are percentages → fixed 0..100
    const line = (data: number[], color: string) => {
      ctx.beginPath();
      data.forEach((v, i) => (i ? ctx.lineTo(x(i, data.length), y(v)) : ctx.moveTo(x(i, data.length), y(v))));
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";
      ctx.stroke();
    };
    line(batt, GREEN);
    line(load, ORANGE);
  }, [history]);
  return <canvas ref={ref} style={{ width: "100%", height: 160, display: "block" }} />;
}

// ─── UPS card ─────────────────────────────────────────────────────────────────

function UpsCard({ u, selected, onSelect }: { u: UpsDevice; selected: boolean; onSelect: () => void }) {
  const charge = u.batteryChargePct ?? 0;
  const load = u.loadPct ?? 0;
  const onBattery = u.onBattery === true;
  return (
    <div
      onClick={onSelect}
      className="flex flex-col rounded-lg overflow-hidden cursor-pointer transition-colors"
      style={{ background: gf.panel, border: `1px solid ${selected ? BLUE : gf.border}` }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: `1px solid ${gf.divider}` }}>
        <div className="min-w-0">
          <div className="text-[13px] font-medium truncate" style={{ color: gf.textPrimary }}>{u.name}</div>
          <div className="text-[10px] truncate" style={{ color: gf.textDim }}>
            {[u.brand, u.model].filter(Boolean).join(" ") || u.location}
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor(u.status), boxShadow: `0 0 5px ${statusColor(u.status)}` }} />
          <span className="text-[11px]" style={{ color: gf.textMuted }}>{u.status}</span>
        </span>
      </div>

      {/* On-battery banner */}
      {onBattery && (
        <div className="px-3 py-1.5 text-[11px] font-medium" style={{ background: "rgba(242,73,92,0.12)", color: RED }}>
          ⚡ ON BATTERY — running on backup power
        </div>
      )}

      {!u.monitored ? (
        <div className="px-3 py-4 text-[11px]" style={{ color: ORANGE }}>
          {u.commType ? `${u.commType.toUpperCase()} UPS` : "USB/serial UPS"} — not reachable over SNMP (needs a network/SNMP card).
        </div>
      ) : (
        <div className="p-3 flex flex-col gap-3">
          {/* Battery + load bars */}
          <div>
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-[9px] uppercase tracking-wider" style={{ color: gf.textDim }}>Battery</span>
              <span className="text-[12px] font-bold" style={{ color: batteryColor(charge) }}>{fmt(u.batteryChargePct, "%")}</span>
            </div>
            <Bar value={charge} color={batteryColor(charge)} />
          </div>
          <div>
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-[9px] uppercase tracking-wider" style={{ color: gf.textDim }}>Load</span>
              <span className="text-[12px] font-bold" style={{ color: loadColor(load) }}>{fmt(u.loadPct, "%")}</span>
            </div>
            <Bar value={load} />
          </div>

          {/* Detail grid */}
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 pt-1" style={{ borderTop: `1px solid ${gf.divider}` }}>
            <Detail label="Runtime" value={fmt(u.runtimeRemainingMin, " min")} />
            <Detail label="Input" value={fmt(u.inputVoltage, " V")} />
            <Detail label="Output" value={fmt(u.outputVoltage, " V")} />
            <Detail label="Battery V" value={fmt(u.batteryVoltage, " V", 1)} />
            {u.temperature != null && <Detail label="Temp" value={fmt(u.temperature, " °C")} />}
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[10px]" style={{ color: gf.textMuted }}>{label}</span>
      <span className="text-[11px] font-mono" style={{ color: gf.textPrimary }}>{value}</span>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function UpsMonitoring() {
  const [devices, setDevices] = useState<UpsDevice[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("-1h");
  const [history, setHistory] = useState<HistPoint[]>([]);

  const load = () =>
    api.getUpsDevices().then((r) => {
      if (r.success && r.data) {
        const list: UpsDevice[] = (r.data.devices ?? []).map(mapUps);
        setDevices(list);
        setSelectedId((cur) => cur ?? (list[0]?.id ?? null));
      }
    });

  useEffect(() => {
    load();
    const onMetrics = (data: { ups: any }) => {
      if (!data?.ups) return;
      const id = String(data.ups.id);
      setDevices((prev) => {
        const idx = prev.findIndex((d) => d.id === id);
        if (idx === -1) return [...prev, mergeUpsLive(undefined, data.ups)];
        const next = [...prev];
        next[idx] = mergeUpsLive(next[idx], data.ups);
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
              ? { ...d, status: "Offline" }
              : { ...d, status: data.status },
        ),
      );
    };
    socket.on("upsMetrics", onMetrics);
    socket.on("upsStatus", onStatus);
    return () => {
      socket.off("upsMetrics", onMetrics);
      socket.off("upsStatus", onStatus);
    };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setHistory([]);
      return;
    }
    api.getUpsHistory(Number(selectedId), range).then((r) => {
      if (r.success && r.data) setHistory(r.data.history ?? []);
    });
  }, [selectedId, range]);

  const total = devices.length;
  const online = devices.filter((d) => d.status === "Online").length;
  const onBatteryCount = devices.filter((d) => d.onBattery === true).length;
  const loads = devices.filter((d) => d.loadPct != null).map((d) => d.loadPct as number);
  const avgLoad = loads.length ? Math.round(loads.reduce((a, b) => a + b, 0) / loads.length) : 0;
  const onlineColor = total === 0 ? gf.textMuted : online === total ? GREEN : online === 0 ? RED : ORANGE;
  const selected = devices.find((d) => d.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-2.5" style={{ background: gf.bg, minHeight: "100%", padding: 12 }}>
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 px-0.5">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-[15px] font-semibold truncate" style={{ color: gf.textPrimary }}>UPS Monitoring</h1>
          <span className="text-[11px] hidden sm:inline" style={{ color: gf.textDim }}>{total} units · {online} online</span>
        </div>
        <span className="flex items-center gap-1.5 text-[10px] tracking-widest uppercase shrink-0" style={{ color: gf.textMuted }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: GREEN, boxShadow: `0 0 6px ${GREEN}` }} /> Live
        </span>
      </div>

      {/* On-battery alert banner */}
      {onBatteryCount > 0 && (
        <div className="rounded-lg px-3 py-2 text-[12px] font-medium" style={{ background: "rgba(242,73,92,0.12)", border: "1px solid rgba(242,73,92,0.3)", color: RED }}>
          ⚡ {onBatteryCount} UPS {onBatteryCount === 1 ? "is" : "are"} running on battery — mains power may be down.
        </div>
      )}

      {/* Stat row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <StatPanel label="UPS Units" value={String(total)} color={BLUE} sub="monitored" />
        <StatPanel label="Online" value={`${online}/${total}`} color={onlineColor} sub={`${total - online} offline`} />
        <StatPanel label="On Battery" value={String(onBatteryCount)} color={onBatteryCount > 0 ? RED : GREEN} sub={onBatteryCount > 0 ? "outage" : "on mains"} />
        <StatPanel label="Avg Load" value={String(avgLoad)} unit="%" color={loadColor(avgLoad)} sub="output load" />
      </div>

      {total === 0 ? (
        <Panel title="UPS Units">
          <div className="flex flex-col items-center justify-center text-center py-12 px-4">
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" style={{ color: gf.textDim }}>
              <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
              <path d="M13 8l-3 4h3l-1 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <p className="text-[13px] mt-3" style={{ color: gf.textMuted }}>No UPS units monitored yet</p>
            <p className="text-[11px] mt-1 max-w-md" style={{ color: gf.textDim }}>
              Register a UPS with an SNMP/network card in the database to see live battery metrics here.
            </p>
          </div>
        </Panel>
      ) : (
        <>
          {/* Selected UPS history */}
          {selected && selected.monitored && (
            <Panel
              title={`History · ${selected.name}`}
              right={
                <div className="flex items-center gap-2">
                  <span className="text-[10px]" style={{ color: GREEN }}>● Battery %</span>
                  <span className="text-[10px]" style={{ color: ORANGE }}>● Load %</span>
                  <div className="flex rounded-md overflow-hidden" style={{ border: `1px solid ${gf.border}` }}>
                    {RANGES.map((rg) => (
                      <button
                        key={rg}
                        onClick={() => setRange(rg)}
                        className="text-[10px] px-2 py-0.5 transition-colors"
                        style={{ background: range === rg ? gf.hover : "transparent", color: range === rg ? gf.textPrimary : gf.textMuted }}
                      >
                        {rangeLabel[rg]}
                      </button>
                    ))}
                  </div>
                </div>
              }
            >
              <UpsHistoryChart history={history} />
            </Panel>
          )}

          {/* UPS cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {devices.map((u) => (
              <UpsCard key={u.id} u={u} selected={u.id === selectedId} onSelect={() => setSelectedId(u.id)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
