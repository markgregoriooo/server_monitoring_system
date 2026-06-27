import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";

// ─── Unified activity / audit history ─────────────────────────────────────────
// One accountable timeline merged from system_logs + aircon_logs + alerts +
// device_logs (backend services/historyService.js). Every event is tagged with
// an ACTOR — Admin / Staff / System — so it's clear who (or what) did it.
// (Metric history lives on the Environment / Server Detail pages, not here.)

// ── Grafana design tokens ──
const gf = {
  panel: "var(--gf-panel)",
  border: "var(--gf-panel-border)",
  header: "var(--gf-header)",
  textPrimary: "var(--gf-text-primary)",
  textMuted: "var(--gf-text-muted)",
  textDim: "var(--gf-text-dim)",
  hover: "var(--gf-hover)",
  accent: "var(--gf-accent)",
  accentDim: "var(--gf-accent-dim)",
} as const;

const GREEN = "#73BF69";

// ── Types ──
type ActorType = "admin" | "staff" | "system";

interface HistoryEvent {
  id: string;
  source: string;
  category: string;
  timestamp: string;
  actorType: ActorType;
  actorName: string;
  severity: string;
  action: string;
  message: string;
  device: string | null;
}

interface HistorySummary {
  critical: number;
  warning: number;
  info: number;
  system: number;
  admin: number;
  staff: number;
}

// ── Color / label resolvers (no Record indexing → noUncheckedIndexedAccess-safe) ──
function sevColor(s: string): string {
  return s === "critical" ? "#E02F44" : s === "warning" ? "#FF780A" : "#5794F2";
}

function actorMeta(t: string): { label: string; color: string } {
  if (t === "admin") return { label: "Admin", color: "#B877D9" };
  if (t === "staff") return { label: "Staff", color: "#5794F2" };
  return { label: "System", color: "#6E7B91" };
}

function catMeta(c: string): { label: string; color: string } {
  switch (c) {
    case "auth": return { label: "Auth", color: "#5794F2" };
    case "users": return { label: "Users", color: "#B877D9" };
    case "alerts": return { label: "Alerts", color: "#F2495C" };
    case "environment": return { label: "Environment", color: "#73BF69" };
    case "aircon": return { label: "Aircon", color: "#37C2C4" };
    case "devices": return { label: "Devices", color: "#FF9830" };
    case "reports": return { label: "Reports", color: "#8E9097" };
    case "network": return { label: "Network", color: "#FADE2A" };
    default: return { label: c ? c.charAt(0).toUpperCase() + c.slice(1) : "System", color: "#8E9097" };
  }
}

// ── Time formatting (Manila) ──
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Filter option sets ──
const DAYS: { label: string; value: number }[] = [
  { label: "24h", value: 1 },
  { label: "7d", value: 7 },
  { label: "14d", value: 14 },
  { label: "30d", value: 30 },
];
const CATEGORIES = ["all", "auth", "users", "alerts", "environment", "aircon", "devices"];
const SEVERITIES = ["all", "critical", "warning", "info"];
const PAGE_SIZE = 50;

// ── Small UI atoms ──
function Seg({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="text-[10.5px] px-2.5 py-1 rounded-[2px] transition-colors whitespace-nowrap"
      style={{
        color: active ? gf.textPrimary : gf.textMuted,
        background: active ? gf.accentDim : "transparent",
        border: `1px solid ${active ? gf.accent : gf.border}`,
      }}
    >
      {children}
    </button>
  );
}

function Pill({ active, color, onClick, children }: {
  active: boolean; color?: string; onClick: () => void; children: ReactNode;
}) {
  const c = color ?? gf.accent;
  return (
    <button
      onClick={onClick}
      className="text-[10px] px-2 py-1 rounded-[2px] capitalize transition-colors whitespace-nowrap"
      style={{
        color: active ? "#fff" : gf.textMuted,
        background: active ? c : "transparent",
        border: `1px solid ${active ? c : gf.border}`,
      }}
    >
      {children}
    </button>
  );
}

function Tile({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className="rounded-[2px] px-3 py-2.5" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
      <div className="text-[8.5px] tracking-widest uppercase" style={{ color: gf.textDim }}>{label}</div>
      <div className="text-[20px] font-bold leading-tight mt-0.5" style={{ color }}>{value}</div>
    </div>
  );
}

function Badge({ label, color, subtle }: { label: string; color: string; subtle?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[2px] text-[9px] tracking-wider uppercase font-medium whitespace-nowrap"
      style={{ color: subtle ? color : "#fff", background: subtle ? `${color}1f` : color }}
    >
      {subtle && <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />}
      {label}
    </span>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function History() {
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [summary, setSummary] = useState<HistorySummary | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const silentRef = useRef(false); // background (realtime) refresh → don't flash "Loading…"

  // filters
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [severity, setSeverity] = useState("all");
  // single actor filter: "all" | "type:admin|staff|system" | "user:<id>"
  const [actor, setActor] = useState("all");
  const [days, setDays] = useState(7);
  const [rangeMode, setRangeMode] = useState<"preset" | "custom">("preset");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [page, setPage] = useState(1);

  // people who appear in the history → the per-user filter dropdown
  const [actors, setActors] = useState<{ id: number; name: string; role: string }[]>([]);
  useEffect(() => {
    api.getHistoryActors().then((res) => {
      if (res.success && res.data) setActors(res.data.actors ?? []);
    });
  }, []);

  // debounce search
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  // fetch (filter/page changes show "Loading…"; realtime refreshes are silent)
  useEffect(() => {
    let cancelled = false;
    const silent = silentRef.current;
    silentRef.current = false;
    if (!silent) setLoading(true);
    const actorType = actor.startsWith("type:") ? actor.slice(5) : undefined;
    const filterUserId = actor.startsWith("user:") ? Number(actor.slice(5)) : undefined;
    const useCustom = rangeMode === "custom" && customStart !== "" && customEnd !== "";
    api.getHistory({
      ...(useCustom ? { start: customStart, end: customEnd } : { days }),
      category, severity, actorType, userId: filterUserId, search, page, pageSize: PAGE_SIZE,
    }).then((res) => {
      if (cancelled) return;
      if (res.success && res.data) {
        setEvents(res.data.events ?? []);
        setSummary(res.data.summary ?? null);
        setTotal(res.data.total ?? 0);
      }
      if (!silent) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [days, rangeMode, customStart, customEnd, category, severity, actor, search, page, reloadKey]);

  // realtime — auto-update while on the first page (don't yank the viewport while
  // someone is paging or reading older entries). Socket events give instant
  // updates for the activity they broadcast; a short poll is the catch-all for
  // events that don't push to browsers (login/logout, alert-rule changes, etc.).
  const live = page === 1;
  const liveRef = useRef(live);
  liveRef.current = live;
  useEffect(() => {
    const onChange = () => {
      if (!liveRef.current) return;
      silentRef.current = true;
      setReloadKey((k) => k + 1);
    };
    const evs = [
      "notification", "alertUpdated", "deviceLog", "airconStatus", "airconAutoUpdate",
      "userApproved", "userPending", "agentApproved", "agentPending", "serverRemoved", "serverStatus",
    ];
    evs.forEach((e) => socket.on(e, onChange));
    const poll = setInterval(onChange, 10000);
    return () => {
      evs.forEach((e) => socket.off(e, onChange));
      clearInterval(poll);
    };
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, page * PAGE_SIZE);

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4" style={{ fontFamily: "'JetBrains Mono', monospace" }}>

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[15px] font-bold" style={{ color: gf.textPrimary }}>History</h1>
          <p className="text-[11px] mt-1" style={{ color: gf.textMuted }}>
            Unified activity &amp; audit timeline — every event attributed to{" "}
            <span style={{ color: "#B877D9" }}>Admin</span>,{" "}
            <span style={{ color: "#5794F2" }}>Staff</span> or{" "}
            <span style={{ color: "#6E7B91" }}>System</span>.
          </p>
        </div>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <Tile label="Total events" value={total} color={gf.textPrimary} />
        <Tile label="Critical" value={summary?.critical ?? 0} color="#E02F44" />
        <Tile label="Warnings" value={summary?.warning ?? 0} color="#FF780A" />
        <Tile label="By Admin" value={summary?.admin ?? 0} color="#B877D9" />
        <Tile label="By Staff" value={summary?.staff ?? 0} color="#5794F2" />
        <Tile label="By System" value={summary?.system ?? 0} color="#6E7B91" />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[11px] pointer-events-none" style={{ color: gf.textDim }}>⌕</span>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search events, actor or device…"
            className="w-full pl-7 pr-7 py-1.5 text-[11px] rounded-[2px] focus:outline-none"
            style={{ background: gf.panel, border: `1px solid ${gf.border}`, color: gf.textPrimary }}
          />
          {searchInput && (
            <button onClick={() => setSearchInput("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px]" style={{ color: gf.textDim }}>✕</button>
          )}
        </div>
        <div className="flex gap-1">
          {DAYS.map((d) => (
            <Seg key={d.value} active={rangeMode === "preset" && days === d.value}
              onClick={() => { setRangeMode("preset"); setDays(d.value); setPage(1); }}>{d.label}</Seg>
          ))}
          <Seg active={rangeMode === "custom"} onClick={() => {
            if (!customStart || !customEnd) {
              const fmt = (dt: Date) => dt.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
              const today = new Date();
              const prior = new Date();
              prior.setDate(today.getDate() - 7);
              setCustomStart(fmt(prior));
              setCustomEnd(fmt(today));
            }
            setRangeMode("custom");
            setPage(1);
          }}>Custom</Seg>
        </div>
        {rangeMode === "custom" && (
          <div className="flex items-center gap-1">
            <input
              type="date"
              value={customStart}
              max={customEnd || undefined}
              onChange={(e) => { setCustomStart(e.target.value); setPage(1); }}
              className="text-[10.5px] px-2 py-1 rounded-[2px] focus:outline-none"
              style={{ background: gf.panel, border: `1px solid ${gf.border}`, color: gf.textPrimary }}
            />
            <span className="text-[10px]" style={{ color: gf.textDim }}>→</span>
            <input
              type="date"
              value={customEnd}
              min={customStart || undefined}
              onChange={(e) => { setCustomEnd(e.target.value); setPage(1); }}
              className="text-[10.5px] px-2 py-1 rounded-[2px] focus:outline-none"
              style={{ background: gf.panel, border: `1px solid ${gf.border}`, color: gf.textPrimary }}
            />
          </div>
        )}
      </div>

      {/* Filter pills */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[8.5px] tracking-widest uppercase mr-0.5" style={{ color: gf.textDim }}>Category</span>
          {CATEGORIES.map((c) => (
            <Pill key={c} active={category === c} color={c === "all" ? gf.accent : catMeta(c).color} onClick={() => { setCategory(c); setPage(1); }}>
              {c === "all" ? "all" : catMeta(c).label}
            </Pill>
          ))}
        </div>
        <div className="h-4 w-px" style={{ background: gf.border }} />
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[8.5px] tracking-widest uppercase mr-0.5" style={{ color: gf.textDim }}>Severity</span>
          {SEVERITIES.map((s) => (
            <Pill key={s} active={severity === s} color={s === "all" ? gf.accent : sevColor(s)} onClick={() => { setSeverity(s); setPage(1); }}>{s}</Pill>
          ))}
        </div>
        <div className="h-4 w-px" style={{ background: gf.border }} />
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[8.5px] tracking-widest uppercase mr-0.5" style={{ color: gf.textDim }}>Actor</span>
          <select
            value={actor}
            onChange={(e) => { setActor(e.target.value); setPage(1); }}
            className="text-[10px] px-2 py-1 rounded-[2px] focus:outline-none"
            style={{ background: gf.panel, border: `1px solid ${actor !== "all" ? gf.accent : gf.border}`, color: gf.textPrimary }}
          >
            <option value="all">All actors</option>
            <optgroup label="By role">
              <option value="type:admin">Admin</option>
              <option value="type:staff">Staff</option>
              <option value="type:system">System (automated)</option>
            </optgroup>
            {actors.length > 0 && (
              <optgroup label="By person">
                {actors.map((a) => (
                  <option key={a.id} value={`user:${a.id}`}>{a.name}</option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
      </div>

      {/* Result count + live */}
      <div className="flex items-center justify-between -mt-1">
        <span className="text-[10px]" style={{ color: gf.textDim }}>
          {loading ? "Loading…" : total === 0 ? "No events" : `Showing ${from}–${to} of ${total}`}
        </span>
        {live && !loading && (
          <span className="inline-flex items-center gap-1.5 text-[9px] tracking-wider uppercase" style={{ color: GREEN }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: GREEN }} /> Live
          </span>
        )}
      </div>

      {/* Table */}
      <div className="rounded-[2px] overflow-hidden" style={{ border: `1px solid ${gf.border}` }}>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: gf.header, color: gf.textDim }}>
                {["When", "Actor", "Category", "Sev", "Event", "Source"].map((h) => (
                  <th key={h} className="text-left font-medium px-3 py-2 whitespace-nowrap tracking-wider uppercase text-[9px]"
                    style={{ borderBottom: `1px solid ${gf.border}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="px-3 py-8 text-center" style={{ color: gf.textDim }}>Loading…</td></tr>
              ) : events.length === 0 ? (
                <tr><td colSpan={6} className="px-3 py-8 text-center" style={{ color: gf.textDim }}>No events match the current filters.</td></tr>
              ) : (
                events.map((e, i) => {
                  const am = actorMeta(e.actorType);
                  const cm = catMeta(e.category);
                  const open = expanded === e.id;
                  const src = e.device ?? (e.category === "environment" ? "Server room" : "—");
                  return (
                    <tr key={e.id}
                      onClick={() => setExpanded(open ? null : e.id)}
                      className="cursor-pointer transition-colors align-top"
                      style={{ background: open ? gf.accentDim : i % 2 ? gf.hover : "transparent", color: gf.textPrimary }}
                    >
                      <td className="px-3 py-2 whitespace-nowrap" style={{ color: gf.textMuted }}>
                        <div className="flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: sevColor(e.severity) }} />
                          {fmtTime(e.timestamp)}
                        </div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Badge label={am.label} color={am.color} />
                        {e.actorType !== "system" && (
                          <div className="text-[9.5px] mt-0.5 truncate max-w-[120px]" style={{ color: gf.textMuted }}>{e.actorName}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Badge label={cm.label} color={cm.color} subtle />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="text-[9px] tracking-wider uppercase font-medium" style={{ color: sevColor(e.severity) }}>{e.severity}</span>
                      </td>
                      <td className="px-3 py-2">
                        <div className={open ? "" : "truncate max-w-[420px]"} style={{ color: gf.textPrimary }}>{e.message}</div>
                        {open && (
                          <div className="mt-2 flex flex-col gap-1 text-[10px]" style={{ color: gf.textMuted }}>
                            <div className="flex gap-6 flex-wrap">
                              <span>action: <span style={{ color: gf.textPrimary }}>{e.action}</span></span>
                              <span>actor: <span style={{ color: am.color }}>{am.label}</span> {e.actorName}</span>
                              <span>source: <span style={{ color: gf.textPrimary }}>{e.source ?? "—"}</span></span>
                              <span>when: <span style={{ color: gf.textPrimary }}>{fmtTime(e.timestamp)}</span> · {relTime(e.timestamp)}</span>
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap" style={{ color: gf.textMuted }}>{src}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between">
          <span className="text-[10px]" style={{ color: gf.textDim }}>Page {page} of {totalPages}</span>
          <div className="flex gap-1">
            <button
              disabled={page <= 1}
              onClick={() => { setPage((p) => Math.max(1, p - 1)); setExpanded(null); }}
              className="text-[10.5px] px-2.5 py-1 rounded-[2px] transition-colors disabled:opacity-40"
              style={{ color: gf.textMuted, border: `1px solid ${gf.border}` }}
            >← Prev</button>
            <button
              disabled={page >= totalPages}
              onClick={() => { setPage((p) => Math.min(totalPages, p + 1)); setExpanded(null); }}
              className="text-[10.5px] px-2.5 py-1 rounded-[2px] transition-colors disabled:opacity-40"
              style={{ color: gf.textMuted, border: `1px solid ${gf.border}` }}
            >Next →</button>
          </div>
        </div>
      )}
    </div>
  );
}
