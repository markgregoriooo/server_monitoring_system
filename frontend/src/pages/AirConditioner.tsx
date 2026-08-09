import { useState, useEffect, useRef } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import { useAuth } from "../context/AuthContext";

interface Aircon {
  id: number;
  name: string;
  ir_channel: number;
  enabled: boolean;
  mode: string;
  fanMode: string;
  setTemp: number;
  uptime: string;
}

interface LogEntry {
  time: string;
  action: string;
  reason: string;
}

interface SensorData {
  temperature: number;
  humidity: number;
  timestamp: string;
}

interface ChannelEntry { channel: number; gpio: number; }

// ─── GF tokens ────────────────────────────────────────────────────────────────

const GF = {
  bg:          "var(--gf-bg)",
  panel:       "var(--gf-panel)",
  border:      "var(--gf-panel-border)",
  divider:     "var(--gf-divider)",
  header:      "var(--gf-header)",
  textPrimary: "var(--gf-text-primary)",
  textMuted:   "var(--gf-text-muted)",
  textDim:     "var(--gf-text-dim)",
  hover:       "var(--gf-hover)",
  hoverStrong: "var(--gf-hover-strong)",
  accent:      "var(--gf-accent)",
  accentDim:   "var(--gf-accent-dim)",
} as const;

const GREEN = "#73BF69";
const ORANGE = "#FF780A";
const RED = "#F2495C";
const BLUE = "#5794F2";
const MUTED = "#6B7280";
// ACCEPTABLE sits between NORMAL green and NEAR-CRIT orange — a distinct step, not a
// shade of either, so the five zones stay countable at a glance.
const TEAL = "#3CC8E8";

// ─── Helpers ──────────────────────────────────────────────────────────────────

// The auto-cooling zone boundaries the ESP32 actually uses (aircon_ir_config, pushed to
// the device as `acConfig`). Admin-editable, so nothing here may assume the defaults.
interface IRZones { coldBelow: number; normalMax: number; acceptableMax: number; nearCritMax: number; }

// Firmware-compiled defaults. Used ONLY until the saved config loads — the boundaries
// below are admin-editable and have already been retuned in practice.
const ZONE_DEFAULTS: IRZones = { coldBelow: 22, normalMax: 24, acceptableMax: 27, nearCritMax: 29 };

// Which zone a room temperature falls in, per the SAVED thresholds. Previously these
// numbers were hardcoded (22/27/29) while the real boundaries lived in aircon_ir_config —
// so once an admin moved near_crit_max to 30.5, the box showed CRITICAL red from 29 while
// the ESP32 was still in NEAR_CRIT and cooling to 22 rather than 20.
function tempZone(t: number, z: IRZones): { label: string; color: string } {
  if (t < z.coldBelow) return { label: "TOO COLD", color: BLUE };
  if (t <= z.normalMax) return { label: "NORMAL", color: GREEN };
  // ACCEPTABLE is its own zone, not a shade of NORMAL: it drives a different IR target
  // (24°C vs 26°C), so collapsing the two hid which one the cooling was actually in.
  if (t <= z.acceptableMax) return { label: "ACCEPTABLE", color: TEAL };
  if (t <= z.nearCritMax) return { label: "NEAR CRITICAL", color: ORANGE };
  return { label: "CRITICAL", color: RED };
}

function tempColor(t: number | string, z: IRZones = ZONE_DEFAULTS): string {
  if (typeof t !== "number") return MUTED;
  return tempZone(t, z).color;
}

function humColor(h: number | string): string {
  if (typeof h !== "number") return MUTED;
  if (h < 30 || h > 70) return ORANGE;
  return GREEN;
}

// ─── Panel (Grafana panel chrome) ───────────────────────────────────────────────

function Panel({
  title,
  right,
  children,
  className = "",
  bodyStyle,
  noPad,
}: {
  title?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyStyle?: React.CSSProperties;
  noPad?: boolean;
}) {
  return (
    <div
      className={`flex flex-col rounded-[2px] ${className}`}
      style={{ background: GF.panel, border: `1px solid ${GF.border}` }}
    >
      {title !== undefined && (
        <div
          className="flex items-center justify-between gap-2 px-3 shrink-0"
          style={{ minHeight: 32, borderBottom: `1px solid ${GF.divider}` }}
        >
          <div className="flex items-center gap-2 min-w-0 py-1.5">{title}</div>
          {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}
        </div>
      )}
      <div className="flex-1 min-h-0" style={{ padding: noPad ? 0 : 12, ...bodyStyle }}>
        {children}
      </div>
    </div>
  );
}

// ─── Sparkline (area, for stat panels) ──────────────────────────────────────────

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

// ─── StatPanel (Grafana stat with sparkline background) ─────────────────────────

function StatPanel({
  label,
  value,
  unit,
  color,
  sub,
  spark,
}: {
  label: string;
  value: string;
  unit?: string;
  color: string;
  sub?: string;
  spark?: number[];
}) {
  return (
    <div
      className="relative overflow-hidden rounded-[2px] flex flex-col"
      style={{ background: GF.panel, border: `1px solid ${GF.border}`, minHeight: 104 }}
    >
      <div className="flex items-center justify-between px-3 pt-2.5 z-10">
        <span className="text-[12px] tracking-widest uppercase" style={{ color: GF.textMuted }}>
          {label}
        </span>
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      </div>
      <div className="px-3 pt-1.5 z-10">
        <span className="text-[28px] font-bold leading-none" style={{ color }}>
          {value}
        </span>
        {unit && <span className="text-[15px] ml-1" style={{ color: color + "AA" }}>{unit}</span>}
        {sub && (
          <div className="text-[11px] mt-1 tracking-widest" style={{ color: GF.textDim }}>
            {sub}
          </div>
        )}
      </div>
      {spark && spark.length > 1 && (
        <div className="absolute inset-x-0 bottom-0 opacity-70 pointer-events-none">
          <Sparkline data={spark} color={color} />
        </div>
      )}
    </div>
  );
}

// ─── AirconCard ───────────────────────────────────────────────────────────────

function AirconCard({
  ac, log, canDelete, canManage, onDelete, onToggle, onRename, siblingNames,
}: {
  ac: Aircon;
  log: LogEntry[];
  canDelete: boolean;
  canManage: boolean;
  onDelete: (id: number) => void;
  onToggle: (id: number, enabled: boolean) => void;
  onRename: (id: number, name: string) => void;
  siblingNames: string[]; // every OTHER unit's name — for the duplicate pre-check
}) {
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing]   = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft]       = useState(ac.name);

  // Inline rename: click the name, Enter or blur commits, Esc cancels. `session.done`
  // makes the commit idempotent — Enter sets editing=false, which can also fire blur,
  // and without the guard the rename would be submitted twice.
  const session = useRef({ done: false });

  const startEdit = () => {
    if (!canManage) return;
    session.current.done = false;
    setDraft(ac.name);
    setEditing(true);
  };

  const finishEdit = async (commit: boolean) => {
    if (session.current.done) return;
    session.current.done = true;
    setEditing(false);

    const next = draft.trim();
    if (!commit || !next || next === ac.name) return; // cancelled, empty, or unchanged

    // Instant feedback; the server enforces the same rule authoritatively (409).
    if (siblingNames.some((s) => s.toLowerCase() === next.toLowerCase())) {
      alert(`An AC unit named "${next}" already exists.`);
      return;
    }

    setRenaming(true);
    const result = await api.renameAircon(ac.id, next);
    setRenaming(false);
    if (result.success) onRename(ac.id, result.data?.name ?? next);
    else alert(result.error ?? "Failed to rename unit.");
  };

  const handleToggle = async () => {
    setToggling(true);
    const result = await api.toggleAircon(ac.id);
    setToggling(false);
    if (result.success) {
      onToggle(ac.id, result.data?.enabled ?? !ac.enabled);
    } else {
      alert(result.error ?? "Failed to toggle unit.");
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Remove "${ac.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    const result = await api.deleteAircon(ac.id);
    if (result.success) {
      onDelete(ac.id);
    } else {
      alert(result.error ?? "Failed to remove unit.");
      setDeleting(false);
    }
  };

  const dotColor = ac.enabled ? GREEN : MUTED;

  const header = (
    <>
      <span className="relative flex h-2 w-2 shrink-0">
        {ac.enabled && (
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60" style={{ background: dotColor }} />
        )}
        <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: dotColor }} />
      </span>
      {editing ? (
        <input
          autoFocus
          value={draft}
          maxLength={100}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => finishEdit(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter")  { e.preventDefault(); finishEdit(true); }
            if (e.key === "Escape") { e.preventDefault(); finishEdit(false); }
          }}
          className="min-w-0 flex-1 px-1.5 py-0.5 text-[14px] font-semibold rounded-[2px] focus:outline-none"
          style={{ background: GF.bg, color: GF.textPrimary, border: `1px solid ${GF.accent}` }}
        />
      ) : (
        <button
          type="button"
          onClick={startEdit}
          disabled={!canManage || renaming}
          title={canManage ? "Rename this unit" : undefined}
          className="group flex items-center gap-1.5 min-w-0 text-left rounded-[2px] px-1 -mx-1 transition-colors"
          style={{
            background: "transparent", border: "none",
            cursor: canManage ? "pointer" : "default",
          }}
          onMouseEnter={(e) => { if (canManage && !renaming) e.currentTarget.style.background = GF.hover; }}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <span className="text-[14px] font-semibold truncate" style={{ color: GF.textPrimary }}>
            {renaming ? "Saving…" : ac.name}
          </span>
          {/* Visible affordance — without it the name reads as plain text and nobody
              discovers that it's editable. Dim at rest, full strength on hover. */}
          {canManage && !renaming && (
            <svg
              width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
              className="shrink-0 opacity-40 group-hover:opacity-100 transition-opacity"
              style={{ color: GF.accent }}
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          )}
        </button>
      )}
      <span
        className="text-[11px] px-1.5 py-0.5 rounded-[2px] tracking-widest shrink-0"
        style={{ color: GF.textDim, background: GF.hover, border: `1px solid ${GF.divider}` }}
      >
        CH {ac.ir_channel}
      </span>
      <span
        className="text-[11px] font-bold tracking-widest px-2 py-0.5 rounded-[2px] shrink-0"
        style={{
          color: ac.enabled ? GREEN : GF.textMuted,
          background: ac.enabled ? "rgba(115,191,105,0.1)" : GF.hover,
        }}
      >
        {ac.enabled ? "ONLINE" : "OFFLINE"}
      </span>
    </>
  );

  const actions = (
    <>
      {/* .gf-raise, not .gf-btn: this button's red/green tint IS its meaning (on →
          "Turn Off" in red), and .gf-btn would replace that face with a neutral one.
          .gf-raise adds only the lift and the press. */}
      {canManage && (
        <button
          onClick={handleToggle}
          disabled={toggling}
          className="gf-raise flex items-center gap-1.5 px-2.5 py-1 rounded-[2px] text-[12px] font-semibold disabled:opacity-40"
          style={{
            color: ac.enabled ? RED : GREEN,
            background: ac.enabled ? "rgba(242,73,92,0.1)" : "rgba(115,191,105,0.1)",
            border: `1px solid ${ac.enabled ? "rgba(242,73,92,0.25)" : "rgba(115,191,105,0.25)"}`,
          }}
        >
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: ac.enabled ? RED : GREEN }} />
          {toggling ? "…" : ac.enabled ? "Turn Off" : "Turn On"}
        </button>
      )}
      {canDelete && (
        <button
          onClick={handleDelete}
          disabled={deleting}
          title="Remove this unit"
          className="w-6 h-6 flex items-center justify-center rounded-[2px] transition-colors disabled:opacity-40"
          style={{ color: GF.textMuted, background: GF.hover }}
          onMouseEnter={(e) => { e.currentTarget.style.color = RED; e.currentTarget.style.background = "rgba(242,73,92,0.1)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = GF.textMuted; e.currentTarget.style.background = GF.hover; }}
        >
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none">
            <path d="M2 3h10M5 3V2h4v1M6 6v4M8 6v4M3 3l1 9h6l1-9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </>
  );

  return (
    <Panel title={header} right={actions} noPad>
      {/* Compact stats row */}
      <div className="grid grid-cols-5 gap-px" style={{ background: GF.divider, borderBottom: `1px solid ${GF.divider}` }}>
        {[
          ["State", ac.enabled ? "on" : "off"],
          ["Fan", ac.fanMode ?? "auto"],
          ["Mode", ac.mode],
          ["Set Temp", `${ac.setTemp}°C`],
          ["Uptime", ac.uptime],
        ].map(([label, value]) => (
          <div key={label} className="flex flex-col px-3 py-2.5 gap-0.5" style={{ background: GF.panel }}>
            <span className="text-[10px] tracking-widest uppercase" style={{ color: GF.textDim }}>{label}</span>
            <span className="text-[13px] font-bold" style={{ color: GF.textPrimary }}>{value}</span>
          </div>
        ))}
      </div>

      {/* Activity log */}
      <div className="flex flex-col p-3 gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] tracking-widest uppercase" style={{ color: GF.textDim }}>Activity Log</span>
          {log.length > 0 && <span className="text-[11px]" style={{ color: GF.textDim }}>{log.length} entries</span>}
        </div>
        <div className="flex flex-col gap-1 overflow-y-auto" style={{ maxHeight: 160 }}>
          {log.length === 0 ? (
            <div className="text-[12px] py-2" style={{ color: GF.textDim }}>No activity recorded.</div>
          ) : log.slice(0, 6).map((entry, i) => {
            const isOff = entry.action.toLowerCase().includes("off") || entry.action.toLowerCase().includes("error");
            const isWarn = entry.action.toLowerCase().includes("trigger") || entry.action.toLowerCase().includes("exceeded");
            const dot = isOff ? RED : isWarn ? ORANGE : BLUE;
            return (
              <div key={i} className="flex gap-2 items-start px-2.5 py-1.5 rounded-[2px]" style={{ background: GF.hover, borderLeft: `2px solid ${dot}` }}>
                <span className="text-[11px] flex-shrink-0 whitespace-nowrap pt-0.5" style={{ color: GF.textDim }}>{entry.time}</span>
                <div className="min-w-0">
                  <div className="text-[12px] font-semibold truncate" style={{ color: GF.textPrimary }}>{entry.action}</div>
                  <div className="text-[11px]" style={{ color: GF.textMuted }}>{entry.reason}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}

// ─── AddAirconModal ───────────────────────────────────────────────────────────

function AddAirconModal({ usedChannels, usedNames, channelMap, onAdd, onClose }: {
  usedChannels: number[];
  usedNames: string[];
  channelMap: ChannelEntry[];
  onAdd: (ac: Aircon, logs: LogEntry[]) => void;
  onClose: () => void;
}) {
  const [name,    setName]    = useState("");
  const [channel, setChannel] = useState("");
  const [error,   setError]   = useState("");
  const [saving,  setSaving]  = useState(false);

  // The channel list comes from the DEVICE. The ESP32 reports its pin pool on connect,
  // so adding an AC unit means wiring a transmitter and registering it — no constant to
  // edit here, in the backend, or in the firmware.
  //
  // FALLBACK_CHANNELS is used only while the ESP32 has never connected, so the form is
  // still usable on a cold start.
  const FALLBACK_CHANNELS = 2;
  const esp32Online  = channelMap.length > 0;
  const allChannels  = esp32Online
    ? channelMap
    : Array.from({ length: FALLBACK_CHANNELS }, (_, i) => ({ channel: i + 1, gpio: 0 }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const ch = parseInt(channel);
    if (!name.trim())              return setError("Name is required.");
    if (!ch || ch < 1 || ch > allChannels.length) return setError("Select a valid IR channel.");
    if (usedChannels.includes(ch)) return setError(`Channel ${ch} is already assigned.`);
    // Names must be unique so two cards can't look identical; server enforces it too.
    if (usedNames.some(u => u.toLowerCase() === name.trim().toLowerCase()))
      return setError(`An AC unit named "${name.trim()}" already exists.`);

    setSaving(true);
    const result = await api.addAircon(name.trim(), ch);
    setSaving(false);
    if (!result.success) return setError(result.error ?? "Failed to add unit.");

    const refresh = await api.getAircon();
    if (refresh.success && refresh.data) {
      const newUnit = (refresh.data.aircons as Aircon[]).find(
        a => a.ir_channel === ch && a.name === name.trim()
      );
      if (newUnit) onAdd(newUnit, []);
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.75)", backdropFilter: "blur(6px)" }}>
      <div className="w-full max-w-sm mx-4 rounded-[2px] shadow-2xl overflow-hidden"
        style={{ background: GF.panel, border: `1px solid ${GF.border}` }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5"
          style={{ borderBottom: `1px solid ${GF.divider}` }}>
          <div>
            <div className="text-[14px] font-semibold" style={{ color: GF.textPrimary }}>
              Add Air Conditioner
            </div>
            <div className="text-[12px] mt-0.5" style={{ color: GF.textMuted }}>
              Register a new IR-controlled unit
            </div>
          </div>
          <button onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-[2px] transition-colors"
            style={{ color: GF.textMuted, background: GF.hover }}
            onMouseEnter={e => (e.currentTarget.style.color = GF.textPrimary)}
            onMouseLeave={e => (e.currentTarget.style.color = GF.textMuted)}>
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 flex flex-col gap-4">
          {!esp32Online && (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-[2px]"
              style={{ background: "rgba(255,120,10,0.08)", border: "1px solid rgba(255,120,10,0.2)" }}>
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" className="mt-0.5 flex-shrink-0" style={{ color: ORANGE }}>
                <path d="M7 1L13 12H1L7 1Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                <path d="M7 5v3M7 10v.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
              <p className="text-[12px] leading-relaxed" style={{ color: ORANGE }}>
                ESP32 offline — GPIO assignments unavailable.
              </p>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] tracking-widest uppercase" style={{ color: GF.textMuted }}>
              Unit Name
            </label>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. AC Unit 3"
              className="w-full px-3 py-2 rounded-[2px] text-[14px] focus:outline-none"
              style={{
                background:   GF.hover,
                border:       `1px solid ${GF.divider}`,
                color:        GF.textPrimary,
                fontFamily:   "monospace",
              }}
              onFocus={e  => (e.currentTarget.style.border = `1px solid ${GF.accent}`)}
              onBlur={e   => (e.currentTarget.style.border = `1px solid ${GF.divider}`)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] tracking-widest uppercase" style={{ color: GF.textMuted }}>
              IR Channel
            </label>
            <div className="flex flex-col gap-1.5">
              {allChannels.map(({ channel: ch, gpio }) => {
                const inUse    = usedChannels.includes(ch);
                const selected = channel === String(ch);
                return (
                  <button key={ch} type="button" disabled={inUse}
                    onClick={() => !inUse && setChannel(String(ch))}
                    className="flex items-center justify-between px-3 py-2.5 rounded-[2px] text-left transition-colors"
                    style={{
                      opacity:    inUse ? 0.4 : 1,
                      cursor:     inUse ? "not-allowed" : "pointer",
                      background: selected ? GF.accentDim : GF.hover,
                      border:     `1px solid ${selected ? GF.accent : GF.divider}`,
                    }}>
                    <div className="flex items-center gap-3">
                      <span className="w-6 h-6 rounded-[2px] flex items-center justify-center text-[13px] font-bold"
                        style={{
                          background: selected ? GF.accent : GF.hoverStrong,
                          color:      selected ? "#fff" : GF.textMuted,
                        }}>
                        {ch}
                      </span>
                      <div>
                        <div className="text-[13px] font-semibold" style={{ color: GF.textPrimary }}>
                          Channel {ch}
                        </div>
                        {esp32Online && gpio > 0 && (
                          <div className="text-[12px]" style={{ color: GF.textMuted }}>
                            Wire IR TX → <span className="font-bold" style={{ color: GF.accent }}>GPIO {gpio}</span>
                          </div>
                        )}
                      </div>
                    </div>
                    <span className="text-[11px] font-bold tracking-widest px-2 py-0.5 rounded-[2px]"
                      style={{
                        color:      inUse ? GF.textDim : GREEN,
                        background: inUse ? GF.hover    : "rgba(115,191,105,0.1)",
                      }}>
                      {inUse ? "IN USE" : "AVAIL"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {allChannels.every((c) => usedChannels.includes(c.channel)) && (
            <div className="flex flex-col gap-1.5 px-3 py-2.5 rounded-[2px]"
              style={{ background: "rgba(87,148,242,0.06)", border: `1px solid ${GF.divider}` }}>
              <p className="text-[12px] font-semibold" style={{ color: GF.textPrimary }}>
                All {allChannels.length} IR channels are in use
              </p>
              <p className="text-[12px] leading-relaxed" style={{ color: GF.textMuted }}>
                Every channel this ESP32 exposes already has a unit. Free one by removing
                an AC unit, or add more transmitter pins to the firmware's channel pool.
              </p>
            </div>
          )}

          {error && (
            <p className="text-[13px] px-3 py-2 rounded-[2px]"
              style={{ color: RED, background: "rgba(242,73,92,0.08)", border: "1px solid rgba(242,73,92,0.2)" }}>
              {error}
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 py-2 rounded-[2px] text-[14px] transition-colors"
              style={{ color: GF.textMuted, border: `1px solid ${GF.divider}`, background: "transparent" }}
              onMouseEnter={e => (e.currentTarget.style.background = GF.hover)}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
              Cancel
            </button>
            <button type="submit" disabled={saving || !channel}
              className="gf-raise flex-1 py-2 rounded-[2px] text-[14px] font-bold transition-colors disabled:opacity-40"
              style={{ background: GF.accent, color: "#fff" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#4a82d8")}
              onMouseLeave={e => (e.currentTarget.style.background = GF.accent)}>
              {saving ? "Adding…" : "Add Unit"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── IRZoneConfig (auto-cooling thresholds) ─────────────────────────────────────
// The ESP32's getIRZone() fires IR when the room temp crosses these boundaries. Target
// temps per zone are fixed (captured IR codes) — only the boundaries (WHEN it fires) are
// configurable. Admin edits; both roles can view. Saved via PUT /aircon/ir-config, which
// re-pushes "acConfig" to the device live. Kept separate from Alert Rules on purpose:
// cooling should ramp BEFORE the alarm thresholds, so its thresholds sit at/below them.

function IRZoneConfig({ isAdmin, roomTemp, onZones }: {
  isAdmin: boolean; roomTemp: number | string; onZones?: (z: IRZones) => void;
}) {
  // Firmware-compiled defaults (CLAUDE.md IR Zone table): <22 / 22–24 / 25–27 / 28–29 / >29.
  // Mirrors ZONE_DEFAULTS above, which mirrors the firmware's compiled values — kept as
  // one definition so the "Reset to defaults" button and the Room Temp colours cannot
  // drift apart.
  const DEFAULTS = Object.fromEntries(
    Object.entries(ZONE_DEFAULTS).map(([k, v]) => [k, String(v)]),
  ) as Record<keyof IRZones, string>;

  const [form, setForm]       = useState({ coldBelow: "", normalMax: "", acceptableMax: "", nearCritMax: "" });
  const [initial, setInitial] = useState(form); // last saved/loaded snapshot → drives dirty tracking
  const [meta, setMeta] = useState<{ updatedByName: string | null; updatedAt: string | null }>({
    updatedByName: null, updatedAt: null,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [error, setError]     = useState("");
  const [showHelp, setShowHelp] = useState(false);

  // Mirrors the backend guard rail (airconService.saveIRConfig) so an out-of-range
  // value is caught inline as you type, instead of as a red error after saving.
  const MIN_C = 10;
  const MAX_C = 40;

  const apply = (c: {
    coldBelow: number; normalMax: number; acceptableMax: number; nearCritMax: number;
    updatedByName?: string | null; updatedAt?: string | null;
  }) => {
    const next = {
      coldBelow: String(c.coldBelow), normalMax: String(c.normalMax),
      acceptableMax: String(c.acceptableMax), nearCritMax: String(c.nearCritMax),
    };
    setForm(next);
    setInitial(next);
    setMeta({ updatedByName: c.updatedByName ?? null, updatedAt: c.updatedAt ?? null });
    // Publish upward on both load AND save, so the Room Temp box re-colours the moment a
    // boundary changes instead of waiting for the next page load.
    onZones?.({
      coldBelow: c.coldBelow, normalMax: c.normalMax,
      acceptableMax: c.acceptableMax, nearCritMax: c.nearCritMax,
    });
  };

  useEffect(() => {
    api.getAirconIRConfig().then((res) => {
      if (res.success && res.data?.config) apply(res.data.config);
      setLoading(false);
    });
  }, []);

  // ── derived: numeric view, validation, dirty state ──
  const keys = ["coldBelow", "normalMax", "acceptableMax", "nearCritMax"] as const;
  const n = {
    coldBelow:     Number(form.coldBelow),
    normalMax:     Number(form.normalMax),
    acceptableMax: Number(form.acceptableMax),
    nearCritMax:   Number(form.nearCritMax),
  };
  const filled    = keys.every((k) => form[k] !== "" && !Number.isNaN(n[k]));
  const ascending = n.coldBelow < n.normalMax && n.normalMax < n.acceptableMax && n.acceptableMax < n.nearCritMax;
  const inRange   = keys.every((k) => n[k] >= MIN_C && n[k] <= MAX_C);
  const valid     = filled && ascending && inRange;
  const dirty     = JSON.stringify(form) !== JSON.stringify(initial);

  // per-field order violations — highlight both sides of a bad boundary
  const bad = {
    coldBelow:     filled && !(n.coldBelow < n.normalMax),
    normalMax:     filled && !(n.coldBelow < n.normalMax && n.normalMax < n.acceptableMax),
    acceptableMax: filled && !(n.normalMax < n.acceptableMax && n.acceptableMax < n.nearCritMax),
    nearCritMax:   filled && !(n.acceptableMax < n.nearCritMax),
  };
  const oor = (k: (typeof keys)[number]) => filled && (n[k] < MIN_C || n[k] > MAX_C);

  // Which dividing line each boundary controls — used by the "unsaved changes" recap
  // so saving states plainly what is about to change, rather than just "● Unsaved".
  const LINE_LABEL: Record<(typeof keys)[number], string> = {
    coldBelow:     "Too Cold → Normal",
    normalMax:     "Normal → Acceptable",
    acceptableMax: "Acceptable → Near Critical",
    nearCritMax:   "Near Critical → Critical",
  };
  const changes = keys.filter((k) => form[k] !== initial[k]);

  const save = async () => {
    if (!valid) return;
    setSaving(true); setError("");
    const res = await api.saveAirconIRConfig({
      coldBelow: n.coldBelow, normalMax: n.normalMax,
      acceptableMax: n.acceptableMax, nearCritMax: n.nearCritMax,
    });
    setSaving(false);
    if (res.success && res.data?.config) {
      apply(res.data.config);
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } else {
      setError(res.error ?? "Failed to save thresholds.");
    }
  };

  const adjust = (key: keyof typeof form, delta: number) =>
    setForm((p) => {
      const base = Number(p[key]);
      const next = Math.max(0, Math.round(((Number.isNaN(base) ? 0 : base) + delta) * 2) / 2);
      return { ...p, [key]: String(next) };
    });

  // ── zones (target temps are fixed = captured IR codes; only boundaries are editable) ──
  // `meaning` turns the internal zone name into something an operator can act on —
  // the names alone ("Acceptable", "Near Critical") don't say what the AC is doing.
  const ZONES = [
    { name: "Too Cold",      meaning: "over-cooled — ease off",     target: "28°C", fan: "Auto", color: BLUE },
    { name: "Normal",        meaning: "comfortable — gentle cooling", target: "26°C", fan: "Auto", color: GREEN },
    { name: "Acceptable",    meaning: "warming up — cool harder",   target: "24°C", fan: "Auto", color: GREEN },
    { name: "Near Critical", meaning: "too warm — strong cooling",  target: "22°C", fan: "High", color: ORANGE },
    { name: "Critical",      meaning: "overheating — max cooling",  target: "20°C", fan: "High", color: RED },
  ];
  const zoneForTemp = (t: number) =>
    t < n.coldBelow ? 0 : t <= n.normalMax ? 1 : t <= n.acceptableMax ? 2 : t <= n.nearCritMax ? 3 : 4;

  // ── threshold-bar geometry (pad each open-ended end zone with ~4°C of visual width) ──
  const lo  = (filled ? n.coldBelow : 22) - 4;
  const hi  = (filled ? n.nearCritMax : 29) + 4;
  const dom = hi - lo || 1;
  const posPct = (v: number) => Math.max(0, Math.min(100, ((v - lo) / dom) * 100));
  const segPts = [lo, n.coldBelow, n.normalMax, n.acceptableMax, n.nearCritMax, hi];
  const boundaries = [n.coldBelow, n.normalMax, n.acceptableMax, n.nearCritMax];

  const liveTemp   = typeof roomTemp === "number" ? roomTemp : null;
  const activeZone = liveTemp != null && valid ? zoneForTemp(liveTemp) : -1;

  // ── Plain-language helpers ────────────────────────────────────────────────────
  const fmt = (v: number) =>
    !Number.isFinite(v) ? "—" : Number.isInteger(v) ? String(v) : v.toFixed(1);

  // The ROOM-temperature span a zone covers, derived from the surrounding boundaries.
  // Spelling this out per zone is what makes "4 numbers → 5 zones" self-evident.
  const zoneRange = (i: number) => {
    if (i === 0) return `room below ${fmt(n.coldBelow)}°C`;
    if (i === 4) return `room above ${fmt(n.nearCritMax)}°C`;
    const lo = [0, n.coldBelow, n.normalMax, n.acceptableMax][i]!;
    const hi = [0, n.normalMax, n.acceptableMax, n.nearCritMax][i]!;
    return `room ${fmt(lo)} – ${fmt(hi)}°C`;
  };

  // One zone = one complete rule ("when the room is X, the AC is set to Y").
  const zoneRow = (i: number) => {
    const z = ZONES[i]!;
    const active = i === activeZone;
    return (
      <div className="flex items-center gap-3 px-3 py-2.5"
        style={{
          background: active ? z.color + "1f" : "transparent",
          boxShadow: active ? `inset 3px 0 0 ${z.color}` : "none",
        }}>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: z.color }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-[13px] font-semibold shrink-0" style={{ color: z.color }}>{z.name}</span>
            <span className="text-[11px] truncate" style={{ color: GF.textDim }}>{z.meaning}</span>
          </div>
          <div className="text-[12px] tabular-nums" style={{ color: GF.textMuted }}>
            {valid ? zoneRange(i) : "—"}
          </div>
        </div>
        {active && (
          <span className="text-[10px] tracking-widest uppercase shrink-0 px-1.5 py-0.5 rounded-[2px]"
            style={{ color: z.color, background: z.color + "22" }}>now</span>
        )}
        <div className="flex items-baseline gap-1.5 shrink-0">
          <span className="text-[12px]" style={{ color: GF.textDim }}>set AC to</span>
          <span className="text-[14px] font-bold tabular-nums" style={{ color: GF.textPrimary }}>{z.target}</span>
          <span className="text-[11px] px-1.5 py-0.5 rounded-[2px]"
            style={{ color: GF.textMuted, background: GF.hover }}>{z.fan}</span>
        </div>
      </div>
    );
  };

  // One editable dividing line, rendered BETWEEN the two zone rows it separates — so it
  // reads as the temperature where the AC switches setting, not an abstract number.
  const boundaryInput = (key: keyof typeof form) => (
    <div className="flex items-center gap-2 px-3 py-1.5 flex-wrap"
      style={{ background: GF.bg, borderTop: `1px solid ${GF.divider}`, borderBottom: `1px solid ${GF.divider}` }}>
      <span className="text-[12px] shrink-0" style={{ color: GF.textMuted }}>when the room reaches</span>
      <div className="flex items-stretch rounded-[2px] overflow-hidden"
        style={{ border: `1px solid ${bad[key] || oor(key) ? RED : GF.divider}`, background: GF.panel, opacity: isAdmin ? 1 : 0.6 }}>
        {isAdmin && (
          <button type="button" onClick={() => adjust(key, -0.5)} title="−0.5°C"
            className="w-6 flex items-center justify-center text-[15px] font-bold transition-colors"
            style={{ color: GF.textMuted, borderRight: `1px solid ${GF.divider}` }}
            onMouseEnter={(e) => (e.currentTarget.style.color = GF.accent)}
            onMouseLeave={(e) => (e.currentTarget.style.color = GF.textMuted)}>−</button>
        )}
        <input
          type="number" step="0.5" value={form[key]} disabled={!isAdmin}
          onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))}
          className="w-14 px-1 py-1 text-[14px] text-center focus:outline-none"
          style={{ background: "transparent", border: "none", color: GF.textPrimary, fontFamily: "monospace" }}
        />
        <span className="flex items-center pr-1.5 text-[12px]" style={{ color: GF.textDim }}>°C</span>
        {isAdmin && (
          <button type="button" onClick={() => adjust(key, 0.5)} title="+0.5°C"
            className="w-6 flex items-center justify-center text-[15px] font-bold transition-colors"
            style={{ color: GF.textMuted, borderLeft: `1px solid ${GF.divider}` }}
            onMouseEnter={(e) => (e.currentTarget.style.color = GF.accent)}
            onMouseLeave={(e) => (e.currentTarget.style.color = GF.textMuted)}>+</button>
        )}
      </div>
      {oor(key) ? (
        <span className="text-[11px]" style={{ color: RED }}>
          must be between {MIN_C}°C and {MAX_C}°C
        </span>
      ) : bad[key] ? (
        <span className="text-[11px]" style={{ color: RED }}>
          each step must be warmer than the one above it
        </span>
      ) : null}
    </div>
  );

  const title = (
    <>
      <span className="text-[14px] font-semibold" style={{ color: GF.textPrimary }}>Auto-Cooling Thresholds</span>
      {dirty && !loading && (
        <span className="text-[11px] tracking-widest uppercase px-1.5 py-0.5 rounded-[2px]"
          style={{ color: ORANGE, background: "rgba(255,120,10,0.12)" }}>● Unsaved</span>
      )}
    </>
  );

  return (
    <Panel title={title}>
      {loading ? (
        <div className="text-[13px] py-2" style={{ color: GF.textDim }}>Loading…</div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* One plain sentence is always visible; the rest is opt-in, so the card no
              longer opens as a wall of small text. */}
          <div className="flex flex-col gap-2 px-3 py-2 rounded-[2px]"
            style={{ background: GF.hover, border: `1px solid ${GF.divider}` }}>
            <div className="flex items-start justify-between gap-3">
              <p className="text-[12px] leading-relaxed" style={{ color: GF.textMuted }}>
                As the room warms up, the AC is automatically set colder. You choose
                {" "}<span style={{ color: GF.textPrimary }}>at which room temperature</span> each step kicks in.
              </p>
              <button type="button" onClick={() => setShowHelp((s) => !s)}
                className="text-[12px] shrink-0 underline underline-offset-2"
                style={{ color: GF.accent, background: "none", border: "none", cursor: "pointer" }}>
                {showHelp ? "Hide details" : "How this works"}
              </button>
            </div>
            {showHelp && (
              <div className="flex flex-col gap-1.5 pt-1.5" style={{ borderTop: `1px solid ${GF.divider}` }}>
                <p className="text-[12px] leading-relaxed" style={{ color: GF.textDim }}>
                  <span style={{ color: GREEN }}>You can change</span> the room temperature at which each
                  step starts. Saving pushes it to the ESP32 straight away — no reflashing.
                </p>
                <p className="text-[12px] leading-relaxed" style={{ color: GF.textDim }}>
                  <span style={{ color: ORANGE }}>You can't change</span> what the AC gets set to
                  (28 / 26 / 24 / 22 / 20°C). Each one is a recorded button-press from the physical
                  remote, so a different value needs a new recording and a firmware update.
                </p>
                <p className="text-[12px] leading-relaxed" style={{ color: GF.textDim }}>
                  <span style={{ color: GF.textMuted }}>Tip:</span> keep these at or below your{" "}
                  <span style={{ color: GF.textMuted }}>Alert Rules</span> temperatures, so cooling ramps
                  up before the room raises an alarm.
                </p>
              </div>
            )}
          </div>

          {/* ── Live status line ── */}
          {liveTemp != null && ZONES[activeZone] && (() => {
            const az = ZONES[activeZone]!;
            return (
              <div className="flex items-center gap-2 flex-wrap text-[13px] px-3 py-2 rounded-[2px]"
                style={{ background: GF.hover, border: `1px solid ${GF.divider}` }}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: az.color, boxShadow: `0 0 6px ${az.color}` }} />
                <span style={{ color: GF.textMuted }}>Room</span>
                <span className="font-bold" style={{ color: az.color }}>{liveTemp.toFixed(1)}°C</span>
                <span style={{ color: GF.textMuted }}>→</span>
                <span className="font-bold" style={{ color: az.color }}>{az.name}</span>
                <span style={{ color: GF.textDim }}>· AC holds {az.target} · {az.fan}</span>
              </div>
            );
          })()}

          {/* ── Threshold bar (Grafana bar-gauge style) ── */}
          {valid ? (
            <div className="relative" style={{ paddingTop: liveTemp != null ? 20 : 0 }}>
              {/* live room-temp marker */}
              {liveTemp != null && (
                <>
                  <div className="absolute top-0 -translate-x-1/2 text-[11px] font-bold px-1 py-0.5 rounded-[2px] whitespace-nowrap z-20"
                    style={{ left: `${posPct(liveTemp)}%`, color: "#fff", background: "rgba(0,0,0,0.75)", border: `1px solid ${GF.border}` }}>
                    {liveTemp.toFixed(1)}°
                  </div>
                  <div className="absolute -translate-x-1/2 z-20"
                    style={{ left: `${posPct(liveTemp)}%`, top: 20, height: 56, width: 2, background: "#fff", boxShadow: "0 0 4px rgba(0,0,0,0.6)" }} />
                </>
              )}
              {/* zone segments (width ∝ temperature span) */}
              <div className="flex w-full rounded-[2px] overflow-hidden" style={{ height: 56 }}>
                {ZONES.map((z, i) => {
                  const w = (segPts[i + 1] ?? 0) - (segPts[i] ?? 0);
                  const active = i === activeZone;
                  return (
                    <div key={z.name}
                      className="relative flex flex-col items-center justify-center px-1 text-center overflow-hidden"
                      style={{
                        flexGrow: w, flexBasis: 0, minWidth: 0,
                        background: z.color + (active ? "3a" : "1f"),
                        borderTop: `2px solid ${z.color}`,
                        boxShadow: active ? `inset 0 0 0 1px ${z.color}` : "none",
                      }}>
                      <span className="text-[11px] font-bold leading-tight truncate max-w-full" style={{ color: z.color }}>{z.name}</span>
                      <span className="text-[11px] leading-tight whitespace-nowrap" style={{ color: GF.textDim }}>AC → {z.target}</span>
                    </div>
                  );
                })}
              </div>
              {/* boundary tick labels */}
              <div className="relative" style={{ height: 16 }}>
                {boundaries.map((b, i) => (
                  <span key={i} className="absolute -translate-x-1/2 text-[11px] font-bold pt-0.5 tabular-nums"
                    style={{ left: `${posPct(b)}%`, color: GF.textPrimary }}>
                    {b}°
                  </span>
                ))}
              </div>
              {/* Name the axis explicitly — the bar is ROOM temperature, while the
                  "AC →" figure inside each block is what the unit gets set to. */}
              <div className="text-[11px] tracking-widest uppercase text-center pt-0.5"
                style={{ color: GF.textDim }}>
                room temperature →
              </div>
            </div>
          ) : (
            <div className="text-[12px] px-3 py-2 rounded-[2px]"
              style={{ color: ORANGE, background: "rgba(255,120,10,0.08)", border: "1px solid rgba(255,120,10,0.2)" }}>
              Each switching temperature must be warmer than the one above it. Fix the highlighted values below to preview the zone map.
            </div>
          )}

          {/* ── Rule ladder: 5 zones separated by the 4 editable boundaries ──
              Each row is a full sentence ("when the room is X, the AC is set to Y"),
              and each input sits on the line it actually divides — so the 4-numbers →
              5-zones relationship needs no explaining. */}
          <div className="rounded-[2px] overflow-hidden" style={{ border: `1px solid ${GF.divider}` }}>
            <div className="flex items-center gap-3 px-3 py-1.5"
              style={{ background: GF.header, borderBottom: `1px solid ${GF.divider}` }}>
              <span className="flex-1 text-[11px] tracking-widest uppercase" style={{ color: GF.textMuted }}>
                When the room is
              </span>
              <span className="text-[11px] tracking-widest uppercase shrink-0" style={{ color: GF.textMuted }}>
                The AC is set to
              </span>
            </div>
            {zoneRow(0)}
            {boundaryInput("coldBelow")}
            {zoneRow(1)}
            {boundaryInput("normalMax")}
            {zoneRow(2)}
            {boundaryInput("acceptableMax")}
            {zoneRow(3)}
            {boundaryInput("nearCritMax")}
            {zoneRow(4)}
          </div>

          {/* Say plainly what saving will change, old → new, so editing feels reversible. */}
          {dirty && changes.length > 0 && (
            <div className="flex flex-col gap-1 px-3 py-2 rounded-[2px]"
              style={{ background: "rgba(255,120,10,0.08)", border: "1px solid rgba(255,120,10,0.2)" }}>
              <span className="text-[11px] tracking-widest uppercase" style={{ color: ORANGE }}>
                Unsaved changes
              </span>
              {changes.map((k) => (
                <span key={k} className="text-[12px] tabular-nums" style={{ color: GF.textMuted }}>
                  {LINE_LABEL[k]}:{" "}
                  <span style={{ color: GF.textDim }}>{initial[k] || "—"}°C</span>
                  {" → "}
                  <span style={{ color: GF.textPrimary }}>{form[k] || "—"}°C</span>
                </span>
              ))}
            </div>
          )}

          {error && (
            <div className="text-[13px] px-3 py-2 rounded-[2px]" style={{ color: RED, background: "rgba(242,73,92,0.08)", border: "1px solid rgba(242,73,92,0.2)" }}>
              {error}
            </div>
          )}

          {/* ── Footer ── */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-[11px]" style={{ color: GF.textDim }}>
              {meta.updatedByName ? `Edited by ${meta.updatedByName}` : "System default"}
              {meta.updatedAt ? ` · ${new Date(meta.updatedAt).toLocaleString("en-PH", { timeZone: "Asia/Manila", hour12: false })}` : ""}
            </span>
            {isAdmin ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setForm(DEFAULTS)} disabled={saving}
                  className="px-3 py-1.5 rounded-[2px] text-[13px] transition-colors disabled:opacity-50"
                  style={{ color: GF.textMuted, border: `1px solid ${GF.divider}`, background: "transparent" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = GF.hover)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                  Reset to defaults
                </button>
                <button
                  onClick={save} disabled={saving || !valid || !dirty}
                  className="px-3 py-1.5 rounded-[2px] text-[13px] font-semibold transition-colors disabled:opacity-50"
                  style={{ background: saved ? GREEN : GF.accent, color: "#fff" }}>
                  {saved ? "✓ Saved" : saving ? "Saving…" : "Save thresholds"}
                </button>
              </div>
            ) : (
              <span className="text-[11px] tracking-widest uppercase" style={{ color: GF.textDim }}>Admin only</span>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function AirConditioner() {
  const { user }  = useAuth();
  const isAdmin   = user?.role === "admin";
  const canManage = isAdmin || user?.role === "it_staff";

  const [aircons,    setAircons]    = useState<Aircon[]>([]);
  const [logs,       setLogs]       = useState<Record<number, LogEntry[]>>({});
  const [channelMap, setChannelMap] = useState<ChannelEntry[]>([]);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [roomTemp,   setRoomTemp]   = useState<number | string>("--");
  // Lifted out of IRZoneConfig so the Room Temp box colours by the SAME boundaries the
  // ESP32 was given, and follows an admin edit immediately rather than after a reload.
  const [zones, setZones] = useState<IRZones>(ZONE_DEFAULTS);
  const [humidity,   setHumidity]   = useState<number | string>("--");
  const [tempHist,   setTempHist]   = useState<number[]>([]);
  const [humHist,    setHumHist]    = useState<number[]>([]);
  const [showModal,  setShowModal]  = useState(false);
  const [clock,      setClock]      = useState(() => new Date());

  // Live toolbar clock
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    api.getAircon().then(result => {
      if (result.success && result.data) {
        setAircons(result.data.aircons ?? []);
        setLogs(result.data.logs ?? {});
        setChannelMap(result.data.channelMap ?? []);
      }
      setLoading(false);
    }).catch(() => setLoading(false));

    const handleLive = (data: SensorData) => {
      if (!data) return;
      setRoomTemp(data.temperature);
      setHumidity(data.humidity);
      setTempHist(p => [...p.slice(-60), data.temperature]);
      setHumHist(p => [...p.slice(-60), data.humidity]);
    };
    socket.on("sensorData", handleLive);

    socket.on("airconStatus", (data: { aircon: Partial<Aircon>; entry?: LogEntry }) => {
      setAircons(prev => prev.map(a => {
        if (a.id !== data.aircon.id) return a;
        const merged = { ...a, ...data.aircon };
        // Keep Uptime in step with on/off so the card reflects a toggle live.
        // (getAll computes uptime server-side — without this it stays stale until refresh.)
        if (typeof data.aircon.enabled === "boolean") {
          merged.uptime = data.aircon.enabled ? "just now" : "offline";
        }
        return merged;
      }));
      if (data.entry && data.aircon.id != null) {
        setLogs(prev => ({
          ...prev,
          [data.aircon.id!]: [data.entry!, ...(prev[data.aircon.id!] ?? [])].slice(0, 50),
        }));
      }
    });

    socket.on("irChannelMap", (data: { channels: ChannelEntry[] }) => {
      setChannelMap(data.channels ?? []);
    });

    socket.on("airconAutoUpdate", (data: { setTemp: number; action: string; deviceIds?: number[] }) => {
      const ids = new Set((data.deviceIds ?? []).map(Number));
      if (ids.size === 0) return; // auto IR adjusted no running units
      // Only the units that were ON are re-targeted — a manually-off unit stays off
      // (auto IR no longer switches power, so it can't re-enable a unit you turned off).
      setAircons(prev => prev.map(a => ids.has(a.id) ? { ...a, setTemp: data.setTemp } : a));
      const entry: LogEntry = {
        time:   new Date().toLocaleTimeString("en-PH"),
        action: data.action,
        reason: "Temperature zone change",
      };
      setLogs(prev => {
        const next = { ...prev };
        for (const id of ids) next[id] = [entry, ...(next[id] ?? [])].slice(0, 50);
        return next;
      });
    });

    return () => {
      socket.off("sensorData", handleLive);
      socket.off("airconStatus");
      socket.off("irChannelMap");
      socket.off("airconAutoUpdate");
    };
  }, []);

  // Adding, removing and renaming a unit all changed the page silently — the modal shut
  // and you were left guessing whether it had worked. Registering an AC unit is also the
  // moment a channel goes live on the ESP32, so it deserves an explicit confirmation.
  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    window.setTimeout(() => setToast(null), 3500);
  };

  const handleUnitAdded   = (ac: Aircon, newLogs: LogEntry[]) => {
    setAircons(prev => [...prev, ac]);
    setLogs(prev => ({ ...prev, [ac.id]: newLogs }));
    // Names the channel and GPIO: right after wiring, that is the fact worth confirming.
    const gpio = channelMap.find(c => c.channel === ac.ir_channel)?.gpio;
    showToast(
      `"${ac.name}" added on channel ${ac.ir_channel}${gpio ? ` (GPIO ${gpio})` : ""}`,
    );
  };
  const handleUnitDeleted = (id: number) => {
    const name = aircons.find(a => a.id === id)?.name;
    setAircons(prev => prev.filter(a => a.id !== id));
    setLogs(prev => { const n = { ...prev }; delete n[id]; return n; });
    showToast(name ? `"${name}" removed` : "Unit removed");
  };
  const handleUnitToggled = (id: number, enabled: boolean) => {
    setAircons(prev => prev.map(a =>
      a.id === id ? { ...a, enabled, uptime: enabled ? "just now" : "offline" } : a));
  };
  // Apply the new name locally for instant feedback. The activity-log entry arrives via
  // the `airconStatus` broadcast (same as toggle), so it isn't appended twice here.
  const handleUnitRenamed = (id: number, name: string) => {
    setAircons(prev => prev.map(a => (a.id === id ? { ...a, name } : a)));
  };

  const usedChannels = aircons.map(a => a.ir_channel);
  const online       = aircons.filter(a => a.enabled).length;
  const total        = aircons.length;
  const activeMode   = aircons.find(a => a.enabled)?.mode ?? "—";
  const esp32Online  = channelMap.length > 0;
  const onlineColor  = total === 0 ? MUTED : online === total ? GREEN : online === 0 ? RED : ORANGE;

  const pill = "flex items-center gap-1.5 h-7 px-2.5 rounded-[2px] text-[13px]";
  const pillStyle: React.CSSProperties = { color: GF.textMuted, border: `1px solid ${GF.divider}`, background: GF.panel };

  return (
    <div className="flex flex-col gap-3 p-3"
      style={{ background: GF.bg, minHeight: "100%", fontFamily: "'JetBrains Mono', monospace" }}>

      {/* ── Toolbar ── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2.5">
          <span className="text-[11px] px-1.5 py-0.5 rounded-[2px] tracking-widest uppercase"
            style={{ color: GF.accent, background: "rgba(87,148,242,0.12)" }}>
            {total} unit{total !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* ESP32 link status */}
          <span className={pill} style={{ ...pillStyle, color: esp32Online ? GREEN : ORANGE,
            borderColor: esp32Online ? "rgba(115,191,105,0.3)" : "rgba(255,120,10,0.3)" }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: esp32Online ? GREEN : ORANGE }} />
            ESP32 {esp32Online ? "ONLINE" : "OFFLINE"}
          </span>

          {canManage && (
            <button onClick={() => setShowModal(true)}
              className="gf-btn flex items-center gap-1.5 h-7 px-3 text-[13px] font-semibold" style={{ color: "var(--gf-text-primary)" }}>
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
              Add Aircon
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <span className="text-[13px] tracking-widest" style={{ color: GF.textDim }}>Loading…</span>
        </div>
      ) : (
        <>
          {/* ── Stat row ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatPanel
              label="Room Temp"
              value={typeof roomTemp === "number" ? roomTemp.toFixed(1) : "--"}
              unit="°C"
              color={tempColor(roomTemp, zones)}
              // States the zone outright — a colour alone cannot say whether 27.5°C is
              // ACCEPTABLE or NEAR CRITICAL, and those cool to different temperatures.
              sub={typeof roomTemp === "number" ? `${tempZone(roomTemp, zones).label} · LIVE` : "DHT11 · LIVE"}
              spark={tempHist}
            />
            <StatPanel
              label="Room Humidity"
              value={typeof humidity === "number" ? humidity.toFixed(1) : "--"}
              unit="%"
              color={humColor(humidity)}
              sub="DHT11 · LIVE"
              spark={humHist}
            />
            <StatPanel
              label="Units Online"
              value={`${online}/${total}`}
              color={onlineColor}
              sub={`${total - online} offline`}
            />
            <StatPanel
              label="Active Mode"
              value={String(activeMode).toUpperCase()}
              color={activeMode === "—" ? MUTED : GF.accent}
              sub="auto IR control"
            />
          </div>

          {/* ── Auto-cooling thresholds ── */}
          <IRZoneConfig isAdmin={isAdmin} roomTemp={roomTemp} onZones={setZones} />

          {/* ── AC unit cards ── */}
          {total === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" style={{ color: GF.textDim }}>
                <rect x="2" y="6" width="20" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M8 10h8M8 14h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              <span className="text-[13px]" style={{ color: GF.textMuted }}>No aircon units registered.</span>
              {/* Was a bare accent-coloured text link, which read as a hyperlink rather
                  than the empty state's primary action. Now a real raised button,
                  matching the other pages' empty states. */}
              {canManage && (
                <button onClick={() => setShowModal(true)}
                  className="gf-btn text-[13px] font-semibold px-3 py-1.5"
                  style={{ color: GF.textPrimary }}>
                  Add the first unit →
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {aircons.map(ac => (
                <AirconCard
                  key={ac.id}
                  ac={ac}
                  log={logs[ac.id] ?? []}
                  canManage={canManage}
                  canDelete={isAdmin}
                  onToggle={handleUnitToggled}
                  onDelete={handleUnitDeleted}
                  onRename={handleUnitRenamed}
                  siblingNames={aircons.filter(a => a.id !== ac.id).map(a => a.name)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {showModal && (
        <AddAirconModal
          usedChannels={usedChannels}
          usedNames={aircons.map(a => a.name)}
          channelMap={channelMap}
          onAdd={handleUnitAdded}
          onClose={() => setShowModal(false)}
        />
      )}

      {/* Same toast chrome as the Reports page, so a confirmation looks the same
          wherever it appears. */}
      {toast && (
        <div
          className="fixed top-5 right-5 z-[100] flex items-center gap-2 px-4 py-3 rounded-[2px] border text-xs shadow-xl"
          style={{
            color: toast.ok ? GREEN : RED,
            background: toast.ok ? `${GREEN}14` : `${RED}14`,
            borderColor: toast.ok ? `${GREEN}40` : `${RED}40`,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          <span>{toast.ok ? "✓" : "✕"}</span> {toast.msg}
        </div>
      )}
    </div>
  );
}
