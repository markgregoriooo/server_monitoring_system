import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";

// ─── History — two views ──────────────────────────────────────────────────────
// "Activity": one accountable timeline merged from system_logs + aircon_logs +
// alerts + device_logs (backend services/historyService.js). Every event is tagged
// with an ACTOR — Admin / Staff / System — so it's clear who (or what) did it.
//
// "Environment daily": per-day room conditions from InfluxDB (services/
// environmentService.js). Deliberately a SUMMARY, not a time-series — live charts
// still belong on the Environment / Server Detail pages. The two views answer
// different questions ("who did what" vs "what was the room like") over the same
// period, which is why they share a page rather than a query.

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
// Must stay in step with historyService.CATEGORIES — "reports" and "network" were
// accepted by the backend and already had catMeta styling, but had no filter pill,
// so their rows were only reachable via "all".
const CATEGORIES = ["all", "auth", "users", "alerts", "environment", "aircon", "devices", "reports", "network"];
const SEVERITIES = ["all", "critical", "warning", "info"];
const PAGE_SIZE = 50;

// ── Small UI atoms ──
function Seg({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    // Same toggle logic as Pill: the selected tab reads as pressed in, the other as
    // raised and clickable.
    <button
      onClick={onClick}
      className="gf-btn text-[12px] px-2.5 py-1 whitespace-nowrap"
      style={{
        color: active ? gf.textPrimary : gf.textMuted,
        ...(active
          ? { background: gf.accentDim, borderColor: gf.accent, boxShadow: "var(--gf-btn-shadow-active)" }
          : {}),
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
    // A filter is a TOGGLE, so the two states get opposite depth: unselected sits
    // raised on .gf-btn's face and invites a click, selected is pushed INTO the page
    // with the inset shadow. That reads as "this one is on" without relying on colour
    // alone, which matters here because the fill colour is the category's, not a
    // selection colour. Inline styles win over the class, so the active branch keeps
    // its own face and swaps only the shadow.
    <button
      onClick={onClick}
      className="gf-btn text-[12px] px-2 py-1 capitalize whitespace-nowrap"
      style={{
        color: active ? "#fff" : gf.textMuted,
        ...(active ? { background: c, borderColor: c, boxShadow: "var(--gf-btn-shadow-active)" } : {}),
      }}
    >
      {children}
    </button>
  );
}

function Tile({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className="rounded-[2px] px-3 py-2.5" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
      <div className="text-[10px] tracking-widest uppercase" style={{ color: gf.textDim }}>{label}</div>
      <div className="text-[20px] font-bold leading-tight mt-0.5" style={{ color }}>{value}</div>
    </div>
  );
}

function Badge({ label, color, subtle }: { label: string; color: string; subtle?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[2px] text-[11px] tracking-wider uppercase font-medium whitespace-nowrap"
      style={{ color: subtle ? color : "#fff", background: subtle ? `${color}1f` : color }}
    >
      {subtle && <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />}
      {label}
    </span>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
// ─── Environment daily summary ────────────────────────────────────────────────
// The second view on this page. Where the Activity tab answers "who did what", this
// answers "what was the room actually like" — per-UTC-day temperature avg/max/min,
// humidity, peak gas and that day's environment-alert count, measured from InfluxDB
// (GET /api/environment/daily). It replaces a mock that served five rows hardcoded to
// March 2025. Live charts still live on the Environment page; this is the summary.

interface DailyRow {
  date: string;
  avgTemp: number | null;
  maxTemp: number | null;
  minTemp: number | null;
  avgHum: number | null;
  peakGas: number | null;
  events: number;
}

const DAILY_DAYS: { label: string; value: number }[] = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
];

// A missing reading renders as "—", never a fabricated 0.
function metric(v: number | null, unit: string): string {
  return v == null ? "—" : `${v} ${unit}`;
}

function tempColor(v: number | null): string {
  if (v == null) return gf.textDim;
  if (v >= 28) return "#E02F44";
  if (v >= 25) return "#FF780A";
  return "#37C2C4";
}

function gasColor(v: number | null): string {
  if (v == null) return gf.textDim;
  if (v >= 300) return "#E02F44";
  if (v >= 150) return "#FF780A";
  return gf.textPrimary;
}

function DailySummary() {
  const [rows, setRows] = useState<DailyRow[]>([]);
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getEnvironmentDaily(days).then((res) => {
      if (cancelled) return;
      if (res.success && res.data) {
        setRows(res.data.logs ?? []);
        setError(null);
      } else {
        // "Query failed" and "no data yet" must not look the same — this reads
        // InfluxDB, which can be down independently of the rest of the app.
        setRows([]);
        setError(res.error ?? "Could not load the environment summary.");
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [days]);

  // Averages skip days with no reading rather than counting them as 0, which would
  // drag the mean toward zero every time the sensor was down.
  const mean = (pick: (r: DailyRow) => number | null): string => {
    const vals = rows.map(pick).filter((v): v is number => v != null);
    return vals.length ? (vals.reduce((a, v) => a + v, 0) / vals.length).toFixed(1) : "—";
  };
  const peak = rows.reduce<number | null>(
    (hi, r) => (r.maxTemp != null && (hi == null || r.maxTemp > hi) ? r.maxTemp : hi),
    null,
  );
  const totalEvents = rows.reduce((a, r) => a + r.events, 0);

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Tile label="Days with data" value={rows.length} color={gf.textPrimary} />
        <Tile label="Avg temp" value={`${mean((r) => r.avgTemp)} °C`} color="#37C2C4" />
        <Tile label="Peak temp" value={peak == null ? "—" : `${peak} °C`} color="#FF780A" />
        <Tile label="Env alerts" value={totalEvents} color="#E02F44" />
      </div>

      <div className="flex items-center gap-2">
        <div className="flex gap-1">
          {DAILY_DAYS.map((d) => (
            <Seg key={d.value} active={days === d.value} onClick={() => setDays(d.value)}>
              {d.label}
            </Seg>
          ))}
        </div>
        <span className="text-[12px]" style={{ color: gf.textDim }}>
          days are UTC (InfluxDB windows), so a day runs 08:00–08:00 Manila
        </span>
      </div>

      <div className="rounded-[2px] overflow-hidden" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] border-collapse">
            <thead>
              <tr style={{ background: gf.header }}>
                {["Date", "Avg temp", "Max temp", "Min temp", "Avg humidity", "Peak gas", "Alerts"].map((h) => (
                  <th key={h} className="text-left px-3 py-2 font-semibold whitespace-nowrap"
                    style={{ color: gf.textMuted, borderBottom: `1px solid ${gf.border}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-3 py-10 text-center" style={{ color: gf.textMuted }}>Loading…</td></tr>
              ) : error ? (
                <tr><td colSpan={7} className="px-3 py-10 text-center">
                  <div style={{ color: "#E02F44" }}>{error}</div>
                  <div className="mt-1 text-[12px]" style={{ color: gf.textDim }}>
                    Daily summaries read InfluxDB — check it is running and that INFLUX_BUCKET
                    matches the bucket the sensor writes to.
                  </div>
                </td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={7} className="px-3 py-10 text-center">
                  <div style={{ color: gf.textMuted }}>No environment readings in the last {days} days.</div>
                  <div className="mt-1 text-[12px]" style={{ color: gf.textDim }}>
                    Rows appear once the ESP32 has been reporting for at least one day.
                  </div>
                </td></tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.date} style={{ borderTop: `1px solid ${gf.border}` }}>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: gf.textPrimary }}>{r.date}</td>
                    <td className="px-3 py-2 font-bold whitespace-nowrap" style={{ color: tempColor(r.avgTemp) }}>{metric(r.avgTemp, "°C")}</td>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: r.maxTemp == null ? gf.textDim : "#E02F44" }}>{metric(r.maxTemp, "°C")}</td>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: r.minTemp == null ? gf.textDim : GREEN }}>{metric(r.minTemp, "°C")}</td>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: r.avgHum == null ? gf.textDim : "#5794F2" }}>{metric(r.avgHum, "%")}</td>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: gasColor(r.peakGas) }}>{metric(r.peakGas, "ppm")}</td>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: r.events > 0 ? "#FF780A" : gf.textDim }}>{r.events}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export default function History() {
  const [tab, setTab] = useState<"activity" | "daily">("activity");
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
          {tab === "activity" ? (
            <p className="text-[13px] mt-1" style={{ color: gf.textMuted }}>
              Unified activity &amp; audit timeline — every event attributed to{" "}
              <span style={{ color: "#B877D9" }}>Admin</span>,{" "}
              <span style={{ color: "#5794F2" }}>Staff</span> or{" "}
              <span style={{ color: "#6E7B91" }}>System</span>.
            </p>
          ) : (
            <p className="text-[13px] mt-1" style={{ color: gf.textMuted }}>
              Per-day server-room conditions, measured from InfluxDB.
            </p>
          )}
        </div>

        {/* Two questions, one page: who did what, vs. what the room was like. */}
        <div className="flex gap-1">
          <Seg active={tab === "activity"} onClick={() => setTab("activity")}>Activity</Seg>
          <Seg active={tab === "daily"} onClick={() => setTab("daily")}>Environment daily</Seg>
        </div>
      </div>

      {tab === "daily" && <DailySummary />}

      {tab === "activity" && (
      <>
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
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[13px] pointer-events-none" style={{ color: gf.textDim }}>⌕</span>
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search events, actor or device…"
            className="w-full pl-7 pr-7 py-1.5 text-[13px] rounded-[2px] focus:outline-none"
            style={{ background: gf.panel, border: `1px solid ${gf.border}`, color: gf.textPrimary }}
          />
          {searchInput && (
            <button onClick={() => setSearchInput("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-[13px]" style={{ color: gf.textDim }}>✕</button>
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
              className="text-[12px] px-2 py-1 rounded-[2px] focus:outline-none"
              style={{ background: gf.panel, border: `1px solid ${gf.border}`, color: gf.textPrimary }}
            />
            <span className="text-[12px]" style={{ color: gf.textDim }}>→</span>
            <input
              type="date"
              value={customEnd}
              min={customStart || undefined}
              onChange={(e) => { setCustomEnd(e.target.value); setPage(1); }}
              className="text-[12px] px-2 py-1 rounded-[2px] focus:outline-none"
              style={{ background: gf.panel, border: `1px solid ${gf.border}`, color: gf.textPrimary }}
            />
          </div>
        )}
      </div>

      {/* Filter pills */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] tracking-widest uppercase mr-0.5" style={{ color: gf.textDim }}>Category</span>
          {CATEGORIES.map((c) => (
            <Pill key={c} active={category === c} color={c === "all" ? gf.accent : catMeta(c).color} onClick={() => { setCategory(c); setPage(1); }}>
              {c === "all" ? "all" : catMeta(c).label}
            </Pill>
          ))}
        </div>
        <div className="h-4 w-px" style={{ background: gf.border }} />
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] tracking-widest uppercase mr-0.5" style={{ color: gf.textDim }}>Severity</span>
          {SEVERITIES.map((s) => (
            <Pill key={s} active={severity === s} color={s === "all" ? gf.accent : sevColor(s)} onClick={() => { setSeverity(s); setPage(1); }}>{s}</Pill>
          ))}
        </div>
        <div className="h-4 w-px" style={{ background: gf.border }} />
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] tracking-widest uppercase mr-0.5" style={{ color: gf.textDim }}>Actor</span>
          <select
            value={actor}
            onChange={(e) => { setActor(e.target.value); setPage(1); }}
            className="text-[12px] px-2 py-1 rounded-[2px] focus:outline-none"
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
        <span className="text-[12px]" style={{ color: gf.textDim }}>
          {loading ? "Loading…" : total === 0 ? "No events" : `Showing ${from}–${to} of ${total}`}
        </span>
        {live && !loading && (
          <span className="inline-flex items-center gap-1.5 text-[11px] tracking-wider uppercase" style={{ color: GREEN }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: GREEN }} /> Live
          </span>
        )}
      </div>

      {/* Table */}
      <div className="rounded-[2px] overflow-hidden" style={{ border: `1px solid ${gf.border}` }}>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: gf.header, color: gf.textDim }}>
                {["When", "Actor", "Category", "Sev", "Event", "Source"].map((h) => (
                  <th key={h} className="text-left font-medium px-3 py-2 whitespace-nowrap tracking-wider uppercase text-[11px]"
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
                          <div className="text-[11px] mt-0.5 truncate max-w-[120px]" style={{ color: gf.textMuted }}>{e.actorName}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Badge label={cm.label} color={cm.color} subtle />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="text-[11px] tracking-wider uppercase font-medium" style={{ color: sevColor(e.severity) }}>{e.severity}</span>
                      </td>
                      <td className="px-3 py-2">
                        <div className={open ? "" : "truncate max-w-[420px]"} style={{ color: gf.textPrimary }}>{e.message}</div>
                        {open && (
                          <div className="mt-2 flex flex-col gap-1 text-[12px]" style={{ color: gf.textMuted }}>
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
          <span className="text-[12px]" style={{ color: gf.textDim }}>Page {page} of {totalPages}</span>
          <div className="flex gap-1">
            <button
              disabled={page <= 1}
              onClick={() => { setPage((p) => Math.max(1, p - 1)); setExpanded(null); }}
              className="text-[12px] px-2.5 py-1 rounded-[2px] transition-colors disabled:opacity-40"
              style={{ color: gf.textMuted, border: `1px solid ${gf.border}` }}
            >← Prev</button>
            <button
              disabled={page >= totalPages}
              onClick={() => { setPage((p) => Math.min(totalPages, p + 1)); setExpanded(null); }}
              className="text-[12px] px-2.5 py-1 rounded-[2px] transition-colors disabled:opacity-40"
              style={{ color: gf.textMuted, border: `1px solid ${gf.border}` }}
            >Next →</button>
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}
