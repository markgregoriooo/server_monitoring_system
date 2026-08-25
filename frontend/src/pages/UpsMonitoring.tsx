import { Fragment, useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import { useAuth } from "../context/AuthContext";
import UpsDetail, { batteryHealth } from "./UpsDetail";
import type { UpsDevice } from "./UpsDetail";
import { GF as gf, STATUS } from "../theme/gf";
import { GhostButton, StatPanel, Field, Meta } from "../components/ui/primitives";
const { green: GREEN, orange: ORANGE, red: RED, blue: BLUE } = STATUS;

// ─── UPS list page ────────────────────────────────────────────────────────────
// Fleet list (one card per UPS, with "View"); clicking through swaps in UpsDetail.
// Same shape as NetworkMonitoring ↔ NetworkDetail and MikrotikMonitoring ↔
// MikrotikDetail. Types live in UpsDetail.tsx — imported here, never the reverse.

// ─── Grafana tokens ───────────────────────────────────────────────────────────


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
    onBypass: r.onBypass ?? null,
    outputState: r.outputState ?? null,
    batteryStatus: r.batteryStatus ?? null,
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
          <span className="text-[13px] font-medium tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>{title}</span>
          {right && <div className="flex items-center gap-2">{right}</div>}
        </div>
      )}
      <div className="flex-1 min-h-0" style={{ padding: noPad ? 0 : 12 }}>{children}</div>
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

// ─── UPS card ─────────────────────────────────────────────────────────────────

function UpsCard({ u, onView, isAdmin, confirming, onAskRemove, onCancelRemove, onRemove }: {
  u: UpsDevice; onView: () => void; isAdmin: boolean; confirming: boolean;
  onAskRemove: () => void; onCancelRemove: () => void; onRemove: () => void;
}) {
  const charge = u.batteryChargePct ?? 0;
  const load = u.loadPct ?? 0;
  const onBattery = u.onBattery === true;
  const onBypass = u.onBypass === true;
  const health = batteryHealth(u.batteryStatus);
  return (
    <div
      onClick={onView}
      className="flex flex-col rounded-lg overflow-hidden cursor-pointer transition-colors"
      style={{ background: gf.panel, border: `1px solid ${gf.border}` }}
      // Border highlight on hover — the affordance that the whole card opens the
      // detail view, not just the "View" button. Matches the router/MikroTik cards.
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "rgba(87,148,242,0.45)")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--gf-panel-border)")}
    >
      {/* Header — same 32px title bar as every other fleet card */}
      <div className="flex items-center justify-between px-3 shrink-0" style={{ height: 32, borderBottom: `1px solid ${gf.divider}` }}>
        <span className="text-[13px] font-medium tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>{u.name}</span>
        <span className="inline-flex items-center gap-1.5 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor(u.status), boxShadow: `0 0 5px ${statusColor(u.status)}` }} />
          <span className="text-[13px]" style={{ color: gf.textMuted }}>{u.status}</span>
          {confirming ? (
            <span className="inline-flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <span className="text-[12px]" style={{ color: gf.textMuted }}>Remove?</span>
              <button onClick={(e) => { e.stopPropagation(); onRemove(); }} className="gf-raise px-2 py-1 rounded-md text-[12px] font-medium" style={{ color: "#fff", background: RED }}>Yes</button>
              <button onClick={(e) => { e.stopPropagation(); onCancelRemove(); }} className="px-2 py-1 rounded-md text-[12px]" style={{ color: gf.textMuted, border: `1px solid ${gf.border}` }}>No</button>
            </span>
          ) : (
            <>
              <GhostButton onClick={(e) => { e.stopPropagation(); onView(); }}>View</GhostButton>
              {isAdmin && <GhostButton danger onClick={(e) => { e.stopPropagation(); onAskRemove(); }}>Remove</GhostButton>}
            </>
          )}
        </span>
      </div>

      {/* Summary strip — the facts you scan before deciding to drill in. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-[12px]" style={{ color: gf.textDim, borderBottom: `1px solid ${gf.divider}` }}>
        <span className="font-mono">{u.ip}</span>
        <span>{u.location}</span>
        {[u.brand, u.model].filter(Boolean).length > 0 && <span>{[u.brand, u.model].filter(Boolean).join(" ")}</span>}
        {health.text !== "—" && <span>Batt <span style={{ color: health.color }}>{health.text}</span></span>}
        <span className="ml-auto">{fmt(u.runtimeRemainingMin, " min")} left</span>
      </div>

      {/* Output-source banner. Bypass gets its own wording rather than being folded
          into "on battery": the two are opposite problems. On battery means powered
          and protected, with a clock running. On bypass means powered and NOT
          protected, with no clock at all — so it must not read as the milder case. */}
      {onBypass && (
        <div className="px-3 py-1.5 text-[13px] font-medium" style={{ background: "rgba(242,73,92,0.12)", color: RED }}>
           ON BYPASS — load on raw mains, no battery protection
        </div>
      )}
      {onBattery && (
        <div className="px-3 py-1.5 text-[13px] font-medium" style={{ background: "rgba(242,73,92,0.12)", color: RED }}>
          ⚡ ON BATTERY — running on backup power
        </div>
      )}

      {!u.monitored ? (
        <div className="px-3 py-4 text-[13px]" style={{ color: ORANGE }}>
          {u.commType ? `${u.commType.toUpperCase()} UPS` : "USB/serial UPS"} — not reachable over SNMP (needs a network/SNMP card).
        </div>
      ) : (
        <div className="p-3 flex flex-col gap-3">
          {/* Battery + load bars */}
          <div>
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-[11px] uppercase tracking-wider" style={{ color: gf.textDim }}>Battery</span>
              <span className="text-[14px] font-bold" style={{ color: batteryColor(charge) }}>{fmt(u.batteryChargePct, "%")}</span>
            </div>
            <Bar value={charge} color={batteryColor(charge)} />
          </div>
          <div>
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-[11px] uppercase tracking-wider" style={{ color: gf.textDim }}>Load</span>
              <span className="text-[14px] font-bold" style={{ color: loadColor(load) }}>{fmt(u.loadPct, "%")}</span>
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

// One labelled fact in the drawer's summary strip. Bare values like "APC Smart-UPS"
// or a lone health word only read if you already know which field is which.
// ─── Drawer row (expands under a table row) ───────────────────────────────────
// The bars and voltages that used to fill every card, shown only for the unit you
// actually clicked. Same max-height slide as ServerMetrics' drawer.
function UpsDrawerRow({ u, isOpen, colSpan }: { u: UpsDevice; isOpen: boolean; colSpan: number }) {
  const charge = u.batteryChargePct ?? 0;
  const load = u.loadPct ?? 0;
  const health = batteryHealth(u.batteryStatus);
  return (
    <tr>
      <td colSpan={colSpan} className="p-0">
        <div
          className="overflow-hidden transition-all duration-300 ease-in-out"
          style={{ maxHeight: isOpen ? 260 : 0, borderBottom: isOpen ? `1px solid ${gf.divider}` : "none" }}
        >
          <div className="p-3" style={{ background: gf.bg }}>
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 mb-2.5">
              <Meta label="IP" value={u.ip} mono />
              <Meta label="Location" value={u.location} />
              {[u.brand, u.model].filter(Boolean).length > 0 && (
                <Meta label="Model" value={[u.brand, u.model].filter(Boolean).join(" ")} />
              )}
              {u.commType && <Meta label="Comms" value={u.commType.toUpperCase()} />}
              {health.text !== "—" && (
                <Meta label="Battery health" value={<span style={{ color: health.color }}>{health.text}</span>} />
              )}
            </div>

            {!u.monitored ? (
              <div className="text-[13px]" style={{ color: ORANGE }}>
                {u.commType ? `${u.commType.toUpperCase()} UPS` : "USB/serial UPS"} — not reachable over SNMP (needs a network/SNMP card).
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-3">
                <div className="flex flex-col gap-3">
                  <div>
                    <div className="flex items-baseline justify-between mb-1">
                      <span className="text-[11px] uppercase tracking-wider" style={{ color: gf.textDim }}>Battery</span>
                      <span className="text-[14px] font-bold" style={{ color: batteryColor(charge) }}>{fmt(u.batteryChargePct, "%")}</span>
                    </div>
                    <Bar value={charge} color={batteryColor(charge)} />
                  </div>
                  <div>
                    <div className="flex items-baseline justify-between mb-1">
                      <span className="text-[11px] uppercase tracking-wider" style={{ color: gf.textDim }}>Load</span>
                      <span className="text-[14px] font-bold" style={{ color: loadColor(load) }}>{fmt(u.loadPct, "%")}</span>
                    </div>
                    <Bar value={load} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 content-start">
                  <Detail label="Runtime" value={fmt(u.runtimeRemainingMin, " min")} />
                  <Detail label="Input" value={fmt(u.inputVoltage, " V")} />
                  <Detail label="Output" value={fmt(u.outputVoltage, " V")} />
                  <Detail label="Battery V" value={fmt(u.batteryVoltage, " V", 1)} />
                  {u.temperature != null && <Detail label="Temp" value={fmt(u.temperature, " °C")} />}
                </div>
              </div>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[12px]" style={{ color: gf.textMuted }}>{label}</span>
      <span className="text-[13px] font-mono" style={{ color: gf.textPrimary }}>{value}</span>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function UpsMonitoring() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [devices, setDevices] = useState<UpsDevice[]>([]);
  // Drill-down target held by ID (not a snapshot) so the open detail page keeps
  // getting the list-level live updates. Same pattern as NetworkMonitoring.
  const [detailId, setDetailId] = useState<string | null>(null);

  // Add-UPS modal + inline remove-confirm + toast (admin only).
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<UpsForm>(EMPTY_UPS_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // Which row's drawer is open (one at a time), same as ServerMetrics.
  const [openId, setOpenId] = useState<string | null>(null);
  const toggleDrawer = (id: string) => setOpenId((prev) => (prev === id ? null : id));
  const [toast, setToast] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();

  // Deep-link from a notification: /ups?device=<id> opens that UPS's detail once the
  // list has loaded, then drops the param (so Back returns to the list and a refresh
  // doesn't re-trigger). Same contract as ServerMetrics — see routeFor.
  useEffect(() => {
    const deviceParam = searchParams.get("device");
    if (!deviceParam) return;
    if (!devices.some((d) => d.id === String(deviceParam))) return;
    setDetailId(String(deviceParam));
    searchParams.delete("device");
    setSearchParams(searchParams, { replace: true });
  }, [devices, searchParams, setSearchParams]);
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
      setDetailId((prev) => (prev === id ? null : prev));
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
      setDetailId((prev) => (prev === id ? null : prev));
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
  const onBypassCount = devices.filter((d) => d.onBypass === true).length;
  const loads = devices.filter((d) => d.loadPct != null).map((d) => d.loadPct as number);
  // Worst unit, not the mean. One UPS at 95% load or 15% charge is the incident;
  // averaging it against healthy units is exactly how you miss it.
  const peakLoad = loads.length ? Math.round(Math.max(...loads)) : 0;
  const charges = devices.filter((d) => d.batteryChargePct != null).map((d) => d.batteryChargePct as number);
  const worstCharge = charges.length ? Math.round(Math.min(...charges)) : null;
  const needReplace = devices.filter((d) => d.batteryStatus === 3 || d.batteryStatus === 4).length;
  const onlineColor = total === 0 ? gf.textMuted : online === total ? GREEN : online === 0 ? RED : ORANGE;

  // Drill-down: render the per-UPS detail in place (Back returns to the list),
  // mirroring ServerMetrics ↔ ServerDetail. Pass the live row so it opens current.
  const detail = detailId ? devices.find((x) => x.id === detailId) ?? null : null;
  if (detail) {
    return <UpsDetail device={detail} onBack={() => setDetailId(null)} />;
  }

  return (
    <div className="flex flex-col gap-2.5" style={{ background: gf.bg, minHeight: "100%", padding: 12 }}>
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 px-0.5">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-[15px] font-semibold truncate" style={{ color: gf.textPrimary }}>UPS Monitoring</h1>
          <span className="text-[13px] hidden sm:inline" style={{ color: gf.textDim }}>{total} units · {online} online</span>
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          {isAdmin && (
            <button
              onClick={openAdd}
              className="gf-btn inline-flex items-center gap-1.5 text-[13px] font-medium"
              style={{ height: 28, padding: "0 10px", color: "var(--gf-text-primary)" }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              Add UPS
            </button>
          )}
          <span className="flex items-center gap-1.5 text-[12px] tracking-widest uppercase" style={{ color: gf.textMuted }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: GREEN, boxShadow: `0 0 6px ${GREEN}` }} /> Live
          </span>
        </div>
      </div>

      {/* Bypass banner — above the on-battery one, because it is the state with no
          runtime behind it. */}
      {onBypassCount > 0 && (
        <div className="rounded-lg px-3 py-2 text-[14px] font-medium" style={{ background: "rgba(242,73,92,0.12)", border: "1px solid rgba(242,73,92,0.3)", color: RED }}>
           {onBypassCount} UPS {onBypassCount === 1 ? "is" : "are"} on BYPASS — the load is on raw mains with no battery protection. A mains dip now takes it down instantly.
        </div>
      )}

      {/* On-battery alert banner */}
      {onBatteryCount > 0 && (
        <div className="rounded-lg px-3 py-2 text-[14px] font-medium" style={{ background: "rgba(242,73,92,0.12)", border: "1px solid rgba(242,73,92,0.3)", color: RED }}>
          ⚡ {onBatteryCount} UPS {onBatteryCount === 1 ? "is" : "are"} running on battery — mains power may be down.
        </div>
      )}

      {/* Stat row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <StatPanel label="UPS Units" value={`${online}/${total}`} color={onlineColor} sub="online" />
        {/* One tile for "where is the load being fed from". Bypass takes the slot
            when present: it is rarer and more urgent, and two near-identical tiles
            would be read as one. */}
        {onBypassCount > 0 ? (
          <StatPanel label="On Bypass" value={String(onBypassCount)} color={RED} sub="unprotected" />
        ) : (
          <StatPanel label="On Battery" value={String(onBatteryCount)} color={onBatteryCount > 0 ? RED : GREEN} sub={onBatteryCount > 0 ? "outage" : "on mains"} />
        )}
        <StatPanel
          label="Lowest Battery"
          value={worstCharge == null ? "—" : String(worstCharge)}
          {...(worstCharge == null ? {} : { unit: "%" })}
          color={worstCharge == null ? gf.textMuted : batteryColor(worstCharge)}
          sub={charges.length > 1 ? `weakest of ${charges.length}` : "charge"}
        />
        <StatPanel
          label={needReplace > 0 ? "Battery Fault" : "Peak Load"}
          value={needReplace > 0 ? String(needReplace) : String(peakLoad)}
          {...(needReplace > 0 ? {} : { unit: "%" })}
          color={needReplace > 0 ? RED : loadColor(peakLoad)}
          sub={needReplace > 0 ? "need replacing" : loads.length > 1 ? `busiest of ${loads.length}` : "output load"}
        />
      </div>

      {total === 0 ? (
        <Panel title="UPS Units">
          <div className="flex flex-col items-center justify-center text-center py-12 px-4">
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" style={{ color: gf.textDim }}>
              <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
              <path d="M13 8l-3 4h3l-1 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <p className="text-[15px] mt-3" style={{ color: gf.textMuted }}>No UPS units monitored yet</p>
            <p className="text-[13px] mt-1 max-w-md" style={{ color: gf.textDim }}>
              {isAdmin
                ? "Click “Add UPS” to register a UPS with an SNMP/network card — it starts polling within a minute."
                : "A UPS with an SNMP/network card must be registered by an admin to see live battery metrics here."}
            </p>
            {isAdmin && (
              <button onClick={openAdd} className="gf-btn mt-4 text-[13px] font-semibold px-3 py-1.5" style={{ color: "var(--gf-text-primary)" }}>
                + Add UPS
              </button>
            )}
          </div>
        </Panel>
      ) : (
        /* Wide list + expandable drawer, matching the Server Metrics front page. The
           three-up card grid gave every UPS a full block of bars and voltages, so with
           several units the one that mattered — the one on battery — was no more
           prominent than the rest. In a table it's a row you can scan to. */
        <Panel
          title="UPS units"
          noPad
          right={<span className="text-[12px]" style={{ color: gf.textDim }}>{online}/{total} online</span>}
        >
          {/* Mobile: the existing card is already the right shape for a phone */}
          <div className="md:hidden flex flex-col gap-2.5 p-2.5">
            {devices.map((u) => (
              <UpsCard
                key={u.id}
                u={u}
                onView={() => setDetailId(u.id)}
                isAdmin={isAdmin}
                confirming={confirmId === u.id}
                onAskRemove={() => setConfirmId(u.id)}
                onCancelRemove={() => setConfirmId(null)}
                onRemove={() => remove(u.id)}
              />
            ))}
          </div>

          {/* Desktop: table + drawer */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr style={{ borderBottom: `1px solid ${gf.divider}` }}>
                  {["UPS", "IP Address", "Location", "Status", "Battery", "Runtime", "Load", ""].map((h) => (
                    <th key={h} className="text-left px-3 py-2 text-[11px] tracking-widest uppercase font-medium whitespace-nowrap" style={{ color: gf.textDim }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {devices.map((u, i) => {
                  const onBattery = u.onBattery === true;
                  const onBypass = u.onBypass === true;
                  return (
                    <Fragment key={u.id}>
                      <tr
                        onClick={() => toggleDrawer(u.id)}
                        className="cursor-pointer transition-colors"
                        style={{
                          borderBottom: `1px solid ${gf.divider}`,
                          // On battery outranks the zebra stripe: a discharging unit is
                          // the one row that must catch the eye without being opened.
                          background: onBattery
                            ? "rgba(242,73,92,0.12)"
                            : openId === u.id ? gf.hover : i % 2 ? gf.hover : "transparent",
                        }}
                      >
                        <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: gf.textPrimary }}>
                          <div className="text-[14px] font-medium">
                            {u.name}
                            <span className="ml-1.5 text-[12px] inline-block transition-transform" style={{ color: gf.textDim, transform: openId === u.id ? "rotate(180deg)" : "none" }}>▾</span>
                          </div>
                          {onBypass && <div className="text-[12px] font-medium" style={{ color: RED }}> on bypass</div>}
                          {onBattery && <div className="text-[12px] font-medium" style={{ color: RED }}>⚡ on battery</div>}
                        </td>
                        <td className="px-3 py-2.5 text-[13px] font-mono whitespace-nowrap" style={{ color: gf.textMuted }}>{u.ip}</td>
                        <td className="px-3 py-2.5 text-[13px] whitespace-nowrap" style={{ color: gf.textMuted }}>{u.location}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor(u.status), boxShadow: `0 0 5px ${statusColor(u.status)}` }} />
                            <span className="text-[13px]" style={{ color: gf.textMuted }}>{u.status}</span>
                          </span>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className="text-[13px] font-bold tabular-nums" style={{ color: batteryColor(u.batteryChargePct ?? 0) }}>
                            {fmt(u.batteryChargePct, "%")}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-[13px] tabular-nums whitespace-nowrap" style={{ color: onBattery || onBypass ? RED : gf.textMuted }}>
                          {fmt(u.runtimeRemainingMin, " min")}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className="text-[13px] tabular-nums" style={{ color: loadColor(u.loadPct ?? 0) }}>{fmt(u.loadPct, "%")}</span>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className="flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                            {confirmId === u.id ? (
                              <>
                                <span className="text-[12px]" style={{ color: RED }}>Remove?</span>
                                <button onClick={() => remove(u.id)} className="gf-btn px-2 py-1 text-[12px] font-medium" style={{ color: RED }}>Yes</button>
                                <button onClick={() => setConfirmId(null)} className="gf-btn px-2 py-1 text-[12px]" style={{ color: gf.textMuted }}>No</button>
                              </>
                            ) : (
                              <>
                                <GhostButton onClick={() => setDetailId(u.id)}>View</GhostButton>
                                {isAdmin && <GhostButton danger onClick={() => setConfirmId(u.id)}>Remove</GhostButton>}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                      <UpsDrawerRow u={u} isOpen={openId === u.id} colSpan={8} />
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* Add-UPS modal (admin) */}
      {formOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }} onClick={() => setFormOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-[2px] overflow-hidden" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
            <div className="flex items-center justify-between px-4" style={{ height: 44, borderBottom: `1px solid ${gf.divider}`, background: gf.panel }}>
              <span className="text-[14px] font-semibold tracking-wide" style={{ color: gf.textPrimary }}>Add UPS</span>
              <button onClick={() => setFormOpen(false)} className="grid place-items-center w-7 h-7 rounded-md" style={{ color: gf.textMuted }} title="Close (Esc)">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-4 flex flex-col gap-3">
              <Field label="Name">
                <input name="name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus placeholder="Rack A UPS" className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="IP address">
                  <input name="ip" value={form.ip} onChange={(e) => setForm((f) => ({ ...f, ip: e.target.value }))} placeholder="192.168.1.50" className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                </Field>
                <Field label="SNMP port">
                  <input name="snmpPort" value={form.snmpPort} onChange={(e) => setForm((f) => ({ ...f, snmpPort: e.target.value }))} placeholder="161" className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="SNMP community (v2c)">
                  <input name="community" value={form.community} onChange={(e) => setForm((f) => ({ ...f, community: e.target.value }))} placeholder="public" className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                </Field>
                <Field label="Comm. type">
                  <select name="commType" value={form.commType} onChange={(e) => setForm((f) => ({ ...f, commType: e.target.value }))} className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none cursor-pointer" style={inputStyle}>
                    <option value="snmp">snmp</option>
                    <option value="network">network</option>
                  </select>
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Brand (optional)">
                  <input name="brand" value={form.brand} onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))} placeholder="APC" className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                </Field>
                <Field label="Model (optional)">
                  <input name="model" value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} placeholder="Smart-UPS 1500" className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Battery capacity (optional)">
                  <input name="batteryCapacity" value={form.batteryCapacity} onChange={(e) => setForm((f) => ({ ...f, batteryCapacity: e.target.value }))} placeholder="1500 VA" className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                </Field>
                <Field label="Serial no. (optional)">
                  <input name="serialNumber" value={form.serialNumber} onChange={(e) => setForm((f) => ({ ...f, serialNumber: e.target.value }))} className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                </Field>
              </div>
              <Field label="Location">
                <input name="location" value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
              </Field>
              <p className="text-[12px] leading-relaxed" style={{ color: gf.textDim }}>
                UPS-MIB (RFC 1628) over SNMP v2c — the UPS must have a network/SNMP card. Confirm UDP {form.snmpPort || "161"} is reachable from the backend host. Polling begins on the next cycle (≤60s).
              </p>
              {formError && <div className="text-[12px]" style={{ color: RED }}>{formError}</div>}
              <div className="flex gap-2 mt-1">
                <button onClick={save} disabled={saving} className="gf-raise text-[13px] font-semibold px-4 py-2 rounded-md transition-colors active:scale-95 disabled:opacity-50" style={{ color: "#fff", background: BLUE }}>
                  {saving ? "Adding…" : "Add UPS"}
                </button>
                <button onClick={() => setFormOpen(false)} className="text-[13px] font-medium px-4 py-2 rounded-md transition-colors active:scale-95" style={{ color: gf.textMuted, border: `1px solid ${gf.border}`, background: "transparent" }}>
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
