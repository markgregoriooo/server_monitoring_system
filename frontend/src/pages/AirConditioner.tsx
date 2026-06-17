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

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Room temperature mapped to the CLAUDE.md IR comfort zones.
function tempColor(t: number | string): string {
  if (typeof t !== "number") return MUTED;
  if (t < 22) return BLUE; // TOO_COLD
  if (t <= 27) return GREEN; // NORMAL / ACCEPTABLE
  if (t <= 29) return ORANGE; // NEAR_CRIT
  return RED; // CRITICAL
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
        <span className="text-[10px] tracking-widest uppercase" style={{ color: GF.textMuted }}>
          {label}
        </span>
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      </div>
      <div className="px-3 pt-1.5 z-10">
        <span className="text-[28px] font-bold leading-none" style={{ color }}>
          {value}
        </span>
        {unit && <span className="text-[13px] ml-1" style={{ color: color + "AA" }}>{unit}</span>}
        {sub && (
          <div className="text-[9px] mt-1 tracking-widest" style={{ color: GF.textDim }}>
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
  ac, log, canDelete, canManage, onDelete, onToggle,
}: {
  ac: Aircon;
  log: LogEntry[];
  canDelete: boolean;
  canManage: boolean;
  onDelete: (id: number) => void;
  onToggle: (id: number, enabled: boolean) => void;
}) {
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
      <span className="text-[12px] font-semibold truncate" style={{ color: GF.textPrimary }}>{ac.name}</span>
      <span
        className="text-[9px] px-1.5 py-0.5 rounded-[2px] tracking-widest shrink-0"
        style={{ color: GF.textDim, background: GF.hover, border: `1px solid ${GF.divider}` }}
      >
        CH {ac.ir_channel}
      </span>
      <span
        className="text-[9px] font-bold tracking-widest px-2 py-0.5 rounded-[2px] shrink-0"
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
      {canManage && (
        <button
          onClick={handleToggle}
          disabled={toggling}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-[2px] text-[10px] font-semibold transition-colors disabled:opacity-40"
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
            <span className="text-[8px] tracking-widest uppercase" style={{ color: GF.textDim }}>{label}</span>
            <span className="text-[11px] font-bold" style={{ color: GF.textPrimary }}>{value}</span>
          </div>
        ))}
      </div>

      {/* Activity log */}
      <div className="flex flex-col p-3 gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[9px] tracking-widest uppercase" style={{ color: GF.textDim }}>Activity Log</span>
          {log.length > 0 && <span className="text-[9px]" style={{ color: GF.textDim }}>{log.length} entries</span>}
        </div>
        <div className="flex flex-col gap-1 overflow-y-auto" style={{ maxHeight: 160 }}>
          {log.length === 0 ? (
            <div className="text-[10px] py-2" style={{ color: GF.textDim }}>No activity recorded.</div>
          ) : log.slice(0, 6).map((entry, i) => {
            const isOff = entry.action.toLowerCase().includes("off") || entry.action.toLowerCase().includes("error");
            const isWarn = entry.action.toLowerCase().includes("trigger") || entry.action.toLowerCase().includes("exceeded");
            const dot = isOff ? RED : isWarn ? ORANGE : BLUE;
            return (
              <div key={i} className="flex gap-2 items-start px-2.5 py-1.5 rounded-[2px]" style={{ background: GF.hover, borderLeft: `2px solid ${dot}` }}>
                <span className="text-[9px] flex-shrink-0 whitespace-nowrap pt-0.5" style={{ color: GF.textDim }}>{entry.time}</span>
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold truncate" style={{ color: GF.textPrimary }}>{entry.action}</div>
                  <div className="text-[9px]" style={{ color: GF.textMuted }}>{entry.reason}</div>
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

function AddAirconModal({ usedChannels, channelMap, onAdd, onClose }: {
  usedChannels: number[];
  channelMap: ChannelEntry[];
  onAdd: (ac: Aircon, logs: LogEntry[]) => void;
  onClose: () => void;
}) {
  const [name,    setName]    = useState("");
  const [channel, setChannel] = useState("");
  const [error,   setError]   = useState("");
  const [saving,  setSaving]  = useState(false);

  const esp32Online  = channelMap.length > 0;
  const allChannels  = esp32Online
    ? channelMap
    : Array.from({ length: 8 }, (_, i) => ({ channel: i + 1, gpio: 0 }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const ch = parseInt(channel);
    if (!name.trim())              return setError("Name is required.");
    if (!ch || ch < 1 || ch > 8)   return setError("Select a valid IR channel.");
    if (usedChannels.includes(ch)) return setError(`Channel ${ch} is already assigned.`);

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
            <div className="text-[12px] font-semibold" style={{ color: GF.textPrimary }}>
              Add Air Conditioner
            </div>
            <div className="text-[10px] mt-0.5" style={{ color: GF.textMuted }}>
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
              <p className="text-[10px] leading-relaxed" style={{ color: ORANGE }}>
                ESP32 offline — GPIO assignments unavailable.
              </p>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <label className="text-[9px] tracking-widest uppercase" style={{ color: GF.textMuted }}>
              Unit Name
            </label>
            <input type="text" value={name} onChange={e => setName(e.target.value)}
              placeholder="e.g. AC Unit 3"
              className="w-full px-3 py-2 rounded-[2px] text-[12px] focus:outline-none"
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
            <label className="text-[9px] tracking-widest uppercase" style={{ color: GF.textMuted }}>
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
                      <span className="w-6 h-6 rounded-[2px] flex items-center justify-center text-[11px] font-bold"
                        style={{
                          background: selected ? GF.accent : GF.hoverStrong,
                          color:      selected ? "#fff" : GF.textMuted,
                        }}>
                        {ch}
                      </span>
                      <div>
                        <div className="text-[11px] font-semibold" style={{ color: GF.textPrimary }}>
                          Channel {ch}
                        </div>
                        {esp32Online && gpio > 0 && (
                          <div className="text-[10px]" style={{ color: GF.textMuted }}>
                            Wire IR TX → <span className="font-bold" style={{ color: GF.accent }}>GPIO {gpio}</span>
                          </div>
                        )}
                      </div>
                    </div>
                    <span className="text-[9px] font-bold tracking-widest px-2 py-0.5 rounded-[2px]"
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

          {error && (
            <p className="text-[11px] px-3 py-2 rounded-[2px]"
              style={{ color: RED, background: "rgba(242,73,92,0.08)", border: "1px solid rgba(242,73,92,0.2)" }}>
              {error}
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 py-2 rounded-[2px] text-[12px] transition-colors"
              style={{ color: GF.textMuted, border: `1px solid ${GF.divider}`, background: "transparent" }}
              onMouseEnter={e => (e.currentTarget.style.background = GF.hover)}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
              Cancel
            </button>
            <button type="submit" disabled={saving || !channel}
              className="flex-1 py-2 rounded-[2px] text-[12px] font-bold transition-colors disabled:opacity-40"
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

function IRZoneConfig({ isAdmin, roomTemp }: { isAdmin: boolean; roomTemp: number | string }) {
  // Firmware-compiled defaults (CLAUDE.md IR Zone table): <22 / 22–24 / 25–27 / 28–29 / >29.
  const DEFAULTS = { coldBelow: "22", normalMax: "24", acceptableMax: "27", nearCritMax: "29" };

  const [form, setForm]       = useState({ coldBelow: "", normalMax: "", acceptableMax: "", nearCritMax: "" });
  const [initial, setInitial] = useState(form); // last saved/loaded snapshot → drives dirty tracking
  const [meta, setMeta] = useState<{ updatedByName: string | null; updatedAt: string | null }>({
    updatedByName: null, updatedAt: null,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [error, setError]     = useState("");

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
  const valid     = filled && ascending;
  const dirty     = JSON.stringify(form) !== JSON.stringify(initial);

  // per-field order violations — highlight both sides of a bad boundary
  const bad = {
    coldBelow:     filled && !(n.coldBelow < n.normalMax),
    normalMax:     filled && !(n.coldBelow < n.normalMax && n.normalMax < n.acceptableMax),
    acceptableMax: filled && !(n.normalMax < n.acceptableMax && n.acceptableMax < n.nearCritMax),
    nearCritMax:   filled && !(n.acceptableMax < n.nearCritMax),
  };

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
  const ZONES = [
    { name: "Too Cold",      target: "28°C", fan: "Auto", color: BLUE },
    { name: "Normal",        target: "26°C", fan: "Auto", color: GREEN },
    { name: "Acceptable",    target: "24°C", fan: "Auto", color: GREEN },
    { name: "Near Critical", target: "22°C", fan: "High", color: ORANGE },
    { name: "Critical",      target: "20°C", fan: "High", color: RED },
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

  const numField = (key: keyof typeof form, label: string) => (
    <div className="flex flex-col gap-1">
      <label className="text-[9px] tracking-widest uppercase" style={{ color: bad[key] ? RED : GF.textMuted }}>{label}</label>
      <div
        className="flex items-stretch rounded-[2px] overflow-hidden"
        style={{ border: `1px solid ${bad[key] ? RED : GF.divider}`, background: GF.hover, opacity: isAdmin ? 1 : 0.6 }}
      >
        {isAdmin && (
          <button type="button" onClick={() => adjust(key, -0.5)} title="−0.5°C"
            className="w-7 flex items-center justify-center text-[14px] font-bold transition-colors"
            style={{ color: GF.textMuted, borderRight: `1px solid ${GF.divider}` }}
            onMouseEnter={(e) => (e.currentTarget.style.color = GF.accent)}
            onMouseLeave={(e) => (e.currentTarget.style.color = GF.textMuted)}>−</button>
        )}
        <input
          type="number" step="0.5" value={form[key]} disabled={!isAdmin}
          onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))}
          className="min-w-0 flex-1 px-2 py-1.5 text-[12px] text-center focus:outline-none"
          style={{ background: "transparent", border: "none", color: GF.textPrimary, fontFamily: "monospace" }}
        />
        <span className="flex items-center px-1.5 text-[10px]" style={{ color: GF.textDim }}>°C</span>
        {isAdmin && (
          <button type="button" onClick={() => adjust(key, 0.5)} title="+0.5°C"
            className="w-7 flex items-center justify-center text-[14px] font-bold transition-colors"
            style={{ color: GF.textMuted, borderLeft: `1px solid ${GF.divider}` }}
            onMouseEnter={(e) => (e.currentTarget.style.color = GF.accent)}
            onMouseLeave={(e) => (e.currentTarget.style.color = GF.textMuted)}>+</button>
        )}
      </div>
    </div>
  );

  const title = (
    <>
      <span className="text-[12px] font-semibold" style={{ color: GF.textPrimary }}>Auto-Cooling Thresholds</span>
      {dirty && !loading && (
        <span className="text-[9px] tracking-widest uppercase px-1.5 py-0.5 rounded-[2px]"
          style={{ color: ORANGE, background: "rgba(255,120,10,0.12)" }}>● Unsaved</span>
      )}
    </>
  );

  return (
    <Panel title={title}>
      {loading ? (
        <div className="text-[11px] py-2" style={{ color: GF.textDim }}>Loading…</div>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-[10px] leading-relaxed" style={{ color: GF.textMuted }}>
            Room temperature at which the ESP32 fires IR to change the AC setting — target temps per
            zone are fixed (captured IR codes), so these set <span style={{ color: GF.textPrimary }}>when</span> each
            kicks in. Separate from <span style={{ color: GF.textPrimary }}>Alert Rules</span>; keep them at or below
            your temperature alerts so the AC ramps up before the room alarms.
          </p>

          {/* ── Live status line ── */}
          {liveTemp != null && ZONES[activeZone] && (() => {
            const az = ZONES[activeZone]!;
            return (
              <div className="flex items-center gap-2 flex-wrap text-[11px] px-3 py-2 rounded-[2px]"
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
                  <div className="absolute top-0 -translate-x-1/2 text-[9px] font-bold px-1 py-0.5 rounded-[2px] whitespace-nowrap z-20"
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
                      <span className="text-[9px] font-bold leading-tight truncate max-w-full" style={{ color: z.color }}>{z.name}</span>
                      <span className="text-[9px] leading-tight" style={{ color: GF.textMuted }}>{z.target}·{z.fan}</span>
                    </div>
                  );
                })}
              </div>
              {/* boundary tick labels */}
              <div className="relative" style={{ height: 16 }}>
                {boundaries.map((b, i) => (
                  <span key={i} className="absolute -translate-x-1/2 text-[9px] font-bold pt-0.5"
                    style={{ left: `${posPct(b)}%`, color: GF.textPrimary }}>
                    {b}°
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-[10px] px-3 py-2 rounded-[2px]"
              style={{ color: ORANGE, background: "rgba(255,120,10,0.08)", border: "1px solid rgba(255,120,10,0.2)" }}>
              Set ascending boundaries (Too&nbsp;Cold &lt; Normal &lt; Acceptable &lt; Near&nbsp;Critical) to preview the zone map.
            </div>
          )}

          {/* ── Editable boundaries (admin) ── */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {numField("coldBelow", "Too Cold below")}
            {numField("normalMax", "Normal ≤")}
            {numField("acceptableMax", "Acceptable ≤")}
            {numField("nearCritMax", "Near Critical ≤")}
          </div>

          {error && (
            <div className="text-[11px] px-3 py-2 rounded-[2px]" style={{ color: RED, background: "rgba(242,73,92,0.08)", border: "1px solid rgba(242,73,92,0.2)" }}>
              {error}
            </div>
          )}

          {/* ── Footer ── */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-[9px]" style={{ color: GF.textDim }}>
              {meta.updatedByName ? `Edited by ${meta.updatedByName}` : "System default"}
              {meta.updatedAt ? ` · ${new Date(meta.updatedAt).toLocaleString("en-PH", { timeZone: "Asia/Manila", hour12: false })}` : ""}
            </span>
            {isAdmin ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setForm(DEFAULTS)} disabled={saving}
                  className="px-3 py-1.5 rounded-[2px] text-[11px] transition-colors disabled:opacity-50"
                  style={{ color: GF.textMuted, border: `1px solid ${GF.divider}`, background: "transparent" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = GF.hover)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                  Reset to defaults
                </button>
                <button
                  onClick={save} disabled={saving || !valid || !dirty}
                  className="px-3 py-1.5 rounded-[2px] text-[11px] font-semibold transition-colors disabled:opacity-50"
                  style={{ background: saved ? GREEN : GF.accent, color: "#fff" }}>
                  {saved ? "✓ Saved" : saving ? "Saving…" : "Save thresholds"}
                </button>
              </div>
            ) : (
              <span className="text-[9px] tracking-widest uppercase" style={{ color: GF.textDim }}>Admin only</span>
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
  const [loading,    setLoading]    = useState(true);
  const [roomTemp,   setRoomTemp]   = useState<number | string>("--");
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

  const handleUnitAdded   = (ac: Aircon, newLogs: LogEntry[]) => {
    setAircons(prev => [...prev, ac]);
    setLogs(prev => ({ ...prev, [ac.id]: newLogs }));
  };
  const handleUnitDeleted = (id: number) => {
    setAircons(prev => prev.filter(a => a.id !== id));
    setLogs(prev => { const n = { ...prev }; delete n[id]; return n; });
  };
  const handleUnitToggled = (id: number, enabled: boolean) => {
    setAircons(prev => prev.map(a =>
      a.id === id ? { ...a, enabled, uptime: enabled ? "just now" : "offline" } : a));
  };

  const usedChannels = aircons.map(a => a.ir_channel);
  const online       = aircons.filter(a => a.enabled).length;
  const total        = aircons.length;
  const activeMode   = aircons.find(a => a.enabled)?.mode ?? "—";
  const esp32Online  = channelMap.length > 0;
  const onlineColor  = total === 0 ? MUTED : online === total ? GREEN : online === 0 ? RED : ORANGE;

  const pill = "flex items-center gap-1.5 h-7 px-2.5 rounded-[2px] text-[11px]";
  const pillStyle: React.CSSProperties = { color: GF.textMuted, border: `1px solid ${GF.divider}`, background: GF.panel };

  return (
    <div className="flex flex-col gap-3 p-3"
      style={{ background: GF.bg, minHeight: "100%", fontFamily: "'JetBrains Mono', monospace" }}>

      {/* ── Toolbar ── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2.5">
          <span className="text-[9px] px-1.5 py-0.5 rounded-[2px] tracking-widest uppercase"
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
              className="flex items-center gap-1.5 h-7 px-3 rounded-[2px] text-[11px] font-semibold transition-colors"
              style={{ background: GF.accent, color: "#fff" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#4a82d8")}
              onMouseLeave={e => (e.currentTarget.style.background = GF.accent)}>
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
          <span className="text-[11px] tracking-widest" style={{ color: GF.textDim }}>Loading…</span>
        </div>
      ) : (
        <>
          {/* ── Stat row ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatPanel
              label="Room Temp"
              value={typeof roomTemp === "number" ? roomTemp.toFixed(1) : "--"}
              unit="°C"
              color={tempColor(roomTemp)}
              sub="DHT11 · LIVE"
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
          <IRZoneConfig isAdmin={isAdmin} roomTemp={roomTemp} />

          {/* ── AC unit cards ── */}
          {total === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" style={{ color: GF.textDim }}>
                <rect x="2" y="6" width="20" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M8 10h8M8 14h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              <span className="text-[11px]" style={{ color: GF.textMuted }}>No aircon units registered.</span>
              {canManage && (
                <button onClick={() => setShowModal(true)}
                  className="text-[11px] font-semibold transition-colors"
                  style={{ color: GF.accent }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = "0.8")}
                  onMouseLeave={e => (e.currentTarget.style.opacity = "1")}>
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
                />
              ))}
            </div>
          )}
        </>
      )}

      {showModal && (
        <AddAirconModal
          usedChannels={usedChannels}
          channelMap={channelMap}
          onAdd={handleUnitAdded}
          onClose={() => setShowModal(false)}
        />
      )}
    </div>
  );
}
