import { useState, useEffect } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import { useAuth } from "../context/AuthContext";
import UpsDetail from "./UpsDetail";

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
const BLUE_HOVER = "#4A82DD";
const TRACK = "rgba(127,127,127,0.18)";
const BAR_GRADIENT = "linear-gradient(90deg,#73BF69 0%,#73BF69 55%,#FF780A 78%,#F2495C 95%)";

const inputStyle: React.CSSProperties = {
  background: gf.bg,
  border: `1px solid ${gf.border}`,
  color: gf.textPrimary,
  fontFamily: "'JetBrains Mono', monospace",
};

// Blank form for "Add UPS". Only SNMP/network UPS units are monitorable (SNMP-only).
interface UpsForm {
  name: string;
  ip: string;
  community: string;
  snmpPort: string;
  location: string;
  brand: string;
  model: string;
  batteryCapacity: string;
  commType: string;
  serialNumber: string;
}
const EMPTY_UPS_FORM: UpsForm = {
  name: "",
  ip: "",
  community: "public",
  snmpPort: "161",
  location: "CSPC-ICTU Server Room",
  brand: "",
  model: "",
  batteryCapacity: "",
  commType: "snmp",
  serialNumber: "",
};

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

// ─── Ghost button (matches ServerMetrics "View") ──────────────────────────────

function GhostButton({ children, onClick, danger }: { children: React.ReactNode; onClick: (e: React.MouseEvent) => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className="text-[11px] font-medium px-2.5 py-1 rounded-md transition-colors active:scale-95"
      style={{ color: danger ? RED : gf.textMuted, border: `1px solid ${danger ? `${RED}55` : gf.border}`, background: "transparent" }}
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[9px] tracking-wider uppercase" style={{ color: gf.textDim }}>{label}</span>
      {children}
    </div>
  );
}

// ─── UPS card ─────────────────────────────────────────────────────────────────

function UpsCard({ u, onView, isAdmin, confirming, onAskRemove, onCancelRemove, onRemove }: {
  u: UpsDevice; onView: () => void; isAdmin: boolean; confirming: boolean;
  onAskRemove: () => void; onCancelRemove: () => void; onRemove: () => void;
}) {
  const charge = u.batteryChargePct ?? 0;
  const load = u.loadPct ?? 0;
  const onBattery = u.onBattery === true;
  return (
    <div
      onClick={onView}
      className="flex flex-col rounded-lg overflow-hidden cursor-pointer transition-colors"
      style={{ background: gf.panel, border: `1px solid ${gf.border}` }}
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
          {confirming ? (
            <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <span className="text-[10px]" style={{ color: gf.textMuted }}>Remove?</span>
              <button onClick={(e) => { e.stopPropagation(); onRemove(); }} className="px-2 py-1 rounded-md text-[10px] font-medium" style={{ color: "#fff", background: RED }}>Yes</button>
              <button onClick={(e) => { e.stopPropagation(); onCancelRemove(); }} className="px-2 py-1 rounded-md text-[10px]" style={{ color: gf.textMuted, border: `1px solid ${gf.border}` }}>No</button>
            </span>
          ) : (
            <>
              <GhostButton onClick={(e) => { e.stopPropagation(); onView(); }}>View</GhostButton>
              {isAdmin && <GhostButton danger onClick={(e) => { e.stopPropagation(); onAskRemove(); }}>Remove</GhostButton>}
            </>
          )}
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
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [devices, setDevices] = useState<UpsDevice[]>([]);
  const [detail, setDetail] = useState<UpsDevice | null>(null);

  // Add-UPS modal + inline remove-confirm + toast (admin only).
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<UpsForm>(EMPTY_UPS_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  };

  const openAdd = () => {
    setForm(EMPTY_UPS_FORM);
    setFormError("");
    setFormOpen(true);
  };

  const save = async () => {
    if (!form.name.trim()) return setFormError("UPS name is required.");
    if (!form.ip.trim()) return setFormError("IP address is required.");
    if (!form.community.trim()) return setFormError("SNMP community is required.");
    setSaving(true);
    setFormError("");
    const res = await api.addUpsDevice({
      name: form.name.trim(),
      ip: form.ip.trim(),
      community: form.community.trim(),
      snmpPort: form.snmpPort.trim() || undefined,
      location: form.location.trim() || undefined,
      brand: form.brand.trim() || undefined,
      model: form.model.trim() || undefined,
      batteryCapacity: form.batteryCapacity.trim() || undefined,
      commType: form.commType,
      serialNumber: form.serialNumber.trim() || undefined,
    });
    setSaving(false);
    if (res.success && res.data?.device) {
      const added = mapUps(res.data.device);
      setDevices((prev) => (prev.some((d) => d.id === added.id) ? prev : [...prev, added]));
      setFormOpen(false);
      showToast("UPS added — polling starts within a minute.");
    } else {
      setFormError(res.error || "Could not add UPS.");
    }
  };

  const remove = async (id: string) => {
    setConfirmId(null);
    const res = await api.deleteUpsDevice(Number(id));
    if (res.success) {
      setDevices((prev) => prev.filter((d) => d.id !== id));
      setDetail((prev) => (prev?.id === id ? null : prev));
      showToast("UPS removed.");
    } else {
      showToast(res.error || "Could not remove UPS.");
    }
  };

  // Escape closes the add modal.
  useEffect(() => {
    if (!formOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFormOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [formOpen]);

  const load = () =>
    api.getUpsDevices().then((r) => {
      if (r.success && r.data) setDevices((r.data.devices ?? []).map(mapUps));
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
    const onRemoved = (data: { id: number | string }) => {
      const id = String(data?.id);
      setDevices((prev) => prev.filter((d) => d.id !== id));
      setDetail((prev) => (prev?.id === id ? null : prev));
    };
    socket.on("upsMetrics", onMetrics);
    socket.on("upsStatus", onStatus);
    socket.on("upsRemoved", onRemoved);
    return () => {
      socket.off("upsMetrics", onMetrics);
      socket.off("upsStatus", onStatus);
      socket.off("upsRemoved", onRemoved);
    };
  }, []);

  const total = devices.length;
  const online = devices.filter((d) => d.status === "Online").length;
  const onBatteryCount = devices.filter((d) => d.onBattery === true).length;
  const loads = devices.filter((d) => d.loadPct != null).map((d) => d.loadPct as number);
  const avgLoad = loads.length ? Math.round(loads.reduce((a, b) => a + b, 0) / loads.length) : 0;
  const onlineColor = total === 0 ? gf.textMuted : online === total ? GREEN : online === 0 ? RED : ORANGE;

  // Drill-down: render the per-UPS detail in place (Back returns to the list),
  // mirroring ServerMetrics ↔ ServerDetail. Pass the live row so it opens current.
  if (detail) {
    const live = devices.find((x) => x.id === detail.id) ?? detail;
    return <UpsDetail device={live} onBack={() => setDetail(null)} />;
  }

  return (
    <div className="flex flex-col gap-2.5" style={{ background: gf.bg, minHeight: "100%", padding: 12 }}>
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 px-0.5">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-[15px] font-semibold truncate" style={{ color: gf.textPrimary }}>UPS Monitoring</h1>
          <span className="text-[11px] hidden sm:inline" style={{ color: gf.textDim }}>{total} units · {online} online</span>
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          {isAdmin && (
            <button
              onClick={openAdd}
              className="inline-flex items-center gap-1.5 text-[11px] font-medium transition-colors active:translate-y-px"
              style={{ height: 28, padding: "0 10px", color: "#fff", background: BLUE, border: `1px solid ${BLUE}`, borderRadius: 2 }}
              onMouseEnter={(e) => { e.currentTarget.style.background = BLUE_HOVER; e.currentTarget.style.borderColor = BLUE_HOVER; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = BLUE; e.currentTarget.style.borderColor = BLUE; }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              Add UPS
            </button>
          )}
          <span className="flex items-center gap-1.5 text-[10px] tracking-widest uppercase" style={{ color: gf.textMuted }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: GREEN, boxShadow: `0 0 6px ${GREEN}` }} /> Live
          </span>
        </div>
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
              {isAdmin
                ? "Click “Add UPS” to register a UPS with an SNMP/network card — it starts polling within a minute."
                : "A UPS with an SNMP/network card must be registered by an admin to see live battery metrics here."}
            </p>
            {isAdmin && (
              <button onClick={openAdd} className="mt-4 text-[11px] font-semibold px-3 py-1.5 rounded-md" style={{ color: "#fff", background: BLUE }}>
                + Add UPS
              </button>
            )}
          </div>
        </Panel>
      ) : (
        /* UPS cards — click any card (or "View →") to open its full detail */
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {devices.map((u) => (
            <UpsCard
              key={u.id}
              u={u}
              onView={() => setDetail(u)}
              isAdmin={isAdmin}
              confirming={confirmId === u.id}
              onAskRemove={() => setConfirmId(u.id)}
              onCancelRemove={() => setConfirmId(null)}
              onRemove={() => remove(u.id)}
            />
          ))}
        </div>
      )}

      {/* Add-UPS modal (admin) */}
      {formOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }} onClick={() => setFormOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-[2px] overflow-hidden" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
            <div className="flex items-center justify-between px-4" style={{ height: 44, borderBottom: `1px solid ${gf.divider}`, background: gf.panel }}>
              <span className="text-[12px] font-semibold tracking-wide" style={{ color: gf.textPrimary }}>Add UPS</span>
              <button onClick={() => setFormOpen(false)} className="grid place-items-center w-7 h-7 rounded-md" style={{ color: gf.textMuted }} title="Close (Esc)">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-4 flex flex-col gap-3">
              <Field label="Name">
                <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus placeholder="Rack A UPS" className="w-full text-[11px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="IP address">
                  <input value={form.ip} onChange={(e) => setForm((f) => ({ ...f, ip: e.target.value }))} placeholder="192.168.1.50" className="w-full text-[11px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                </Field>
                <Field label="SNMP port">
                  <input value={form.snmpPort} onChange={(e) => setForm((f) => ({ ...f, snmpPort: e.target.value }))} placeholder="161" className="w-full text-[11px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="SNMP community (v2c)">
                  <input value={form.community} onChange={(e) => setForm((f) => ({ ...f, community: e.target.value }))} placeholder="public" className="w-full text-[11px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                </Field>
                <Field label="Comm. type">
                  <select value={form.commType} onChange={(e) => setForm((f) => ({ ...f, commType: e.target.value }))} className="w-full text-[11px] px-2 py-1.5 rounded-[2px] outline-none cursor-pointer" style={inputStyle}>
                    <option value="snmp">snmp</option>
                    <option value="network">network</option>
                  </select>
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Brand (optional)">
                  <input value={form.brand} onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))} placeholder="APC" className="w-full text-[11px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                </Field>
                <Field label="Model (optional)">
                  <input value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} placeholder="Smart-UPS 1500" className="w-full text-[11px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Battery capacity (optional)">
                  <input value={form.batteryCapacity} onChange={(e) => setForm((f) => ({ ...f, batteryCapacity: e.target.value }))} placeholder="1500 VA" className="w-full text-[11px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                </Field>
                <Field label="Serial no. (optional)">
                  <input value={form.serialNumber} onChange={(e) => setForm((f) => ({ ...f, serialNumber: e.target.value }))} className="w-full text-[11px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                </Field>
              </div>
              <Field label="Location">
                <input value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} className="w-full text-[11px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
              </Field>
              <p className="text-[10px] leading-relaxed" style={{ color: gf.textDim }}>
                UPS-MIB (RFC 1628) over SNMP v2c — the UPS must have a network/SNMP card. Confirm UDP {form.snmpPort || "161"} is reachable from the backend host. Polling begins on the next cycle (≤60s).
              </p>
              {formError && <div className="text-[10.5px]" style={{ color: RED }}>{formError}</div>}
              <div className="flex gap-2 mt-1">
                <button onClick={save} disabled={saving} className="text-[11px] font-semibold px-4 py-2 rounded-md transition-colors active:scale-95 disabled:opacity-50" style={{ color: "#fff", background: BLUE }}>
                  {saving ? "Adding…" : "Add UPS"}
                </button>
                <button onClick={() => setFormOpen(false)} className="text-[11px] font-medium px-4 py-2 rounded-md transition-colors active:scale-95" style={{ color: gf.textMuted, border: `1px solid ${gf.border}`, background: "transparent" }}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed top-5 right-5 z-[100] flex items-center gap-2 px-4 py-3 rounded-[2px] border text-xs shadow-xl" style={{ color: GREEN, background: `${GREEN}14`, borderColor: `${GREEN}40`, fontFamily: "'JetBrains Mono', monospace" }}>
          <span>✓</span> {toast}
        </div>
      )}
    </div>
  );
}
