import { useState, useEffect } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";

// ─── Per-UPS detail view (live values + event log) ────────────────────────────
// Reached from UpsMonitoring via the "View" button. Mirrors the ServerMetrics ↔
// ServerDetail in-page swap (no route change): renders full-screen with a Back
// button. Current values stay live via the `upsMetrics` socket.
//
// No trend charts: at the 1h/6h/24h timescales a healthy UPS is a flat line, and
// the value (battery aging) only shows over weeks/months. The operational signal
// is the live state + on-battery alert + event log, which is what this page shows.

interface UpsDevice {
  id: string;
  name: string;
  ip: string;
  location: string;
  brand: string | null;
  model: string | null;
  status: string;
  batteryChargePct: number | null;
  runtimeRemainingMin: number | null;
  loadPct: number | null;
  inputVoltage: number | null;
  outputVoltage: number | null;
  batteryVoltage: number | null;
  onBattery: boolean | null;
  temperature: number | null;
}
interface DeviceLog {
  log_level: "info" | "warning" | "critical" | "error";
  message: string;
  recorded_at: string;
}

const gf = {
  bg: "var(--gf-bg)",
  panel: "var(--gf-panel)",
  border: "var(--gf-panel-border)",
  divider: "var(--gf-divider)",
  textPrimary: "var(--gf-text-primary)",
  textMuted: "var(--gf-text-muted)",
  textDim: "var(--gf-text-dim)",
} as const;

const GREEN = "#73BF69";
const ORANGE = "#FF780A";
const RED = "#F2495C";
const BLUE = "#5794F2";

const fmt = (v: number | null, unit = "", digits = 0) =>
  v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(digits)}${unit}`;
function batteryColor(v: number) {
  if (v <= 20) return RED;
  if (v <= 50) return ORANGE;
  return GREEN;
}
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
function logColor(level: string) {
  if (level === "critical" || level === "error") return RED;
  if (level === "warning") return ORANGE;
  return BLUE;
}
function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-PH", {
    timeZone: "Asia/Manila", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col rounded-lg overflow-hidden" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
      <div className="flex items-center justify-between px-3 shrink-0" style={{ height: 32, borderBottom: `1px solid ${gf.divider}` }}>
        <span className="text-[11px] font-medium tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>{title}</span>
      </div>
      <div className="flex-1 min-h-0 p-3">{children}</div>
    </div>
  );
}

function Stat({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <div className="relative overflow-hidden rounded-lg flex flex-col" style={{ background: gf.panel, border: `1px solid ${gf.border}`, minHeight: 84 }}>
      <div className="flex items-center justify-between px-3 pt-2.5">
        <span className="text-[10px] tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>{label}</span>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      </div>
      <div className="px-3 pt-1.5">
        <span className="text-[24px] font-bold leading-none" style={{ color }}>{value}</span>
        {sub && <div className="text-[9px] mt-1 tracking-widest uppercase" style={{ color: gf.textDim }}>{sub}</div>}
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function UpsDetail({ device, onBack }: { device: UpsDevice; onBack: () => void }) {
  const [u, setU] = useState<UpsDevice>(device);
  const [logs, setLogs] = useState<DeviceLog[]>([]);

  // Keep current values live from the poller.
  useEffect(() => {
    const onMetrics = (data: { ups: any }) => {
      if (!data?.ups || String(data.ups.id) !== String(u.id)) return;
      setU((prev) => ({ ...prev, ...data.ups, id: String(data.ups.id) }));
    };
    const onStatus = (data: { id: number | string; status: string }) => {
      if (String(data?.id) !== String(u.id)) return;
      setU((prev) => ({ ...prev, status: data.status }));
    };
    socket.on("upsMetrics", onMetrics);
    socket.on("upsStatus", onStatus);
    return () => { socket.off("upsMetrics", onMetrics); socket.off("upsStatus", onStatus); };
  }, [u.id]);

  useEffect(() => {
    api.getUpsLogs(Number(u.id)).then((r) => {
      if (r.success && r.data) setLogs(r.data.logs ?? []);
    });
  }, [u.id]);

  const onBattery = u.onBattery === true;

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
          All UPS
        </button>
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold truncate" style={{ color: gf.textPrimary }}>{u.name}</h1>
          <div className="text-[11px] truncate" style={{ color: gf.textDim }}>
            {[u.brand, u.model].filter(Boolean).join(" ") || u.location} · {u.ip}
          </div>
        </div>
        <span className="ml-auto inline-flex items-center gap-1.5 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor(u.status), boxShadow: `0 0 5px ${statusColor(u.status)}` }} />
          <span className="text-[11px]" style={{ color: gf.textMuted }}>{u.status}</span>
        </span>
      </div>

      {onBattery && (
        <div className="rounded-lg px-3 py-2 text-[12px] font-medium" style={{ background: "rgba(242,73,92,0.12)", border: "1px solid rgba(242,73,92,0.3)", color: RED }}>
          ⚡ ON BATTERY — running on backup power, mains may be down.
        </div>
      )}

      {/* Current values */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <Stat label="Battery" value={fmt(u.batteryChargePct, "%")} color={batteryColor(u.batteryChargePct ?? 0)} sub="charge" />
        <Stat label="Load" value={fmt(u.loadPct, "%")} color={loadColor(u.loadPct ?? 0)} sub="output" />
        <Stat label="Runtime" value={fmt(u.runtimeRemainingMin, " min")} color={BLUE} sub="remaining" />
        <Stat label="Source" value={onBattery ? "Battery" : "Mains"} color={onBattery ? RED : GREEN} sub={onBattery ? "outage" : "on utility"} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <Stat label="Input V" value={fmt(u.inputVoltage, " V")} color={GREEN} sub="incoming" />
        <Stat label="Output V" value={fmt(u.outputVoltage, " V")} color={GREEN} sub="delivered" />
        <Stat label="Battery V" value={fmt(u.batteryVoltage, " V", 1)} color={BLUE} sub="dc" />
        <Stat label="Temp" value={fmt(u.temperature, " °C")} color={ORANGE} sub="battery" />
      </div>

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
