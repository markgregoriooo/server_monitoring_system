import { useState, useEffect, useRef } from "react";
import { api } from "../api/api";

type FilterType = "all" | "temp" | "humidity" | "alerts" | "aircon";
type SeverityType = "all" | "critical" | "warning" | "info";

interface HistoryLog {
  date: string;
  avgTemp: number;
  maxTemp: number;
  minTemp: number;
  avgHum: number;
  events: number;
}

interface LogEntry {
  id: number;
  timestamp: string;
  type: FilterType;
  severity: SeverityType;
  message: string;
  value?: string;
  source?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tempColor(t: number) {
  if (t >= 28) return "text-red-600 dark:text-red-400";
  if (t >= 25) return "text-amber-600 dark:text-amber-400";
  return "text-cyan-600 dark:text-cyan-400";
}

function severityStyle(s: SeverityType) {
  switch (s) {
    case "critical": return "bg-red-100 dark:bg-red-500/10 border-red-300 dark:border-red-500/25 text-red-600 dark:text-red-400";
    case "warning":  return "bg-amber-100 dark:bg-amber-500/10 border-amber-300 dark:border-amber-500/25 text-amber-600 dark:text-amber-400";
    case "info":     return "bg-blue-100 dark:bg-blue-500/10 border-blue-300 dark:border-blue-500/25 text-blue-600 dark:text-blue-400";
    default:         return "bg-slate-100 dark:bg-white/[0.04] border-slate-200 dark:border-white/[0.07] text-slate-600 dark:text-slate-400";
  }
}

function severityDot(s: SeverityType) {
  switch (s) {
    case "critical": return "bg-red-500";
    case "warning":  return "bg-amber-500";
    case "info":     return "bg-blue-500";
    default:         return "bg-slate-400";
  }
}

function typeLabel(t: FilterType) {
  switch (t) {
    case "temp":     return "Temperature";
    case "humidity": return "Humidity";
    case "alerts":   return "Alert";
    case "aircon":   return "Aircon";
    default:         return "System";
  }
}

function typeBadgeStyle(t: FilterType) {
  switch (t) {
    case "temp":     return "bg-orange-100 dark:bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-200 dark:border-orange-500/20";
    case "humidity": return "bg-sky-100 dark:bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-200 dark:border-sky-500/20";
    case "alerts":   return "bg-red-100 dark:bg-red-500/10 text-red-600 dark:text-red-400 border-red-200 dark:border-red-500/20";
    case "aircon":   return "bg-purple-100 dark:bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-500/20";
    default:         return "bg-slate-100 dark:bg-white/[0.04] text-slate-500 dark:text-slate-400 border-slate-200 dark:border-white/[0.07]";
  }
}

// Convert HistoryLog rows into synthetic LogEntry list for the live log view
function logsToEntries(logs: HistoryLog[]): LogEntry[] {
  const entries: LogEntry[] = [];
  logs.forEach((row, i) => {
    // Temperature entry
    const tempSeverity: SeverityType = row.maxTemp >= 28 ? "critical" : row.maxTemp >= 25 ? "warning" : "info";
    entries.push({
      id: i * 10 + 1,
      timestamp: row.date,
      type: "temp",
      severity: tempSeverity,
      message: `Daily temperature reading — avg ${row.avgTemp} °C, max ${row.maxTemp} °C, min ${row.minTemp} °C`,
      value: `${row.avgTemp} °C`,
      source: "DHT11 Sensor",
    });
    // Humidity entry
    entries.push({
      id: i * 10 + 2,
      timestamp: row.date,
      type: "humidity",
      severity: row.avgHum > 70 ? "warning" : "info",
      message: `Daily humidity reading — avg ${row.avgHum} %`,
      value: `${row.avgHum} %`,
      source: "DHT11 Sensor",
    });
    // Events / alerts
    if (row.events > 0) {
      entries.push({
        id: i * 10 + 3,
        timestamp: row.date,
        type: "alerts",
        severity: row.events > 3 ? "critical" : "warning",
        message: `${row.events} alert event${row.events !== 1 ? "s" : ""} triggered on this day`,
        value: `${row.events} events`,
        source: "Alert Engine",
      });
    }
  });
  return entries.sort((a, b) => b.id - a.id);
}

// ─── FilterPill ───────────────────────────────────────────────────────────────

function FilterPill({
  label, active, onClick, dot,
}: {
  label: string; active: boolean; onClick: () => void; dot?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer transition-all whitespace-nowrap ${
        active
          ? "bg-blue-100 dark:bg-blue-500/20 border-blue-300 dark:border-blue-500/40 text-blue-600 dark:text-blue-400"
          : "bg-slate-100 dark:bg-white/[0.04] border-slate-200 dark:border-white/[0.07] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
      }`}
    >
      {dot && <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />}
      {label}
    </button>
  );
}

// ─── StatCard ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color }: {
  label: string; value: string | number; sub?: string; color: string;
}) {
  return (
    <div className="rounded-xl bg-slate-100 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08] p-3 flex flex-col gap-1">
      <div className="text-[9px] font-mono text-slate-500 dark:text-slate-400 tracking-widest uppercase">{label}</div>
      <div className={`text-xl font-bold font-mono leading-none ${color}`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-400 font-mono">{sub}</div>}
    </div>
  );
}

// ─── VolumeBar ────────────────────────────────────────────────────────────────
// Grafana-style log volume histogram

function VolumeBar({ logs, filter }: { logs: HistoryLog[]; filter: FilterType }) {
  const max = Math.max(...logs.map(l => l.events), 1);
  const visible = logs.slice(-14).reverse();
  return (
    <div className="rounded-xl bg-slate-100 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08] p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400 uppercase tracking-widest">
          Log volume — last {visible.length} days
        </span>
        <span className="text-[10px] font-mono text-slate-400">events / day</span>
      </div>
      <div className="flex items-end gap-1 h-14">
        {visible.map((row, i) => {
          const h = Math.max(4, Math.round((row.events / max) * 52));
          const color = row.events > 3 ? "bg-red-400 dark:bg-red-500" :
                        row.events > 0 ? "bg-amber-400 dark:bg-amber-500" :
                        "bg-slate-300 dark:bg-white/20";
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-0.5 group relative">
              <div className={`w-full rounded-sm transition-all ${color}`} style={{ height: h }} />
              <div className="absolute -top-7 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-[9px] font-mono px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10">
                {row.date}: {row.events} events
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-[9px] font-mono text-slate-400">{visible[0]?.date ?? ""}</span>
        <span className="text-[9px] font-mono text-slate-400">{visible[visible.length - 1]?.date ?? ""}</span>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function History() {
  const [logs,      setLogs]      = useState<HistoryLog[]>([]);
  const [filter,    setFilter]    = useState<FilterType>("all");
  const [severity,  setSeverity]  = useState<SeverityType>("all");
  const [search,    setSearch]    = useState("");
  const [view,      setView]      = useState<"logs" | "table">("logs");
  const [loading,   setLoading]   = useState<boolean>(true);
  const [expanded,  setExpanded]  = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.getHistoryLogs().then((result) => {
      if (result.success && result.data) setLogs(result.data.logs);
      setLoading(false);
    });
  }, []);

  const entries = logsToEntries(logs);

  const filtered = entries.filter(e => {
    if (filter !== "all" && e.type !== filter) return false;
    if (severity !== "all" && e.severity !== severity) return false;
    if (search && !e.message.toLowerCase().includes(search.toLowerCase()) &&
        !e.source?.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // Summary stats
  const totalEvents = logs.reduce((a, l) => a + l.events, 0);
  const critCount   = entries.filter(e => e.severity === "critical").length;
  const warnCount   = entries.filter(e => e.severity === "warning").length;
  const avgTemp     = logs.length ? (logs.reduce((a, l) => a + l.avgTemp, 0) / logs.length).toFixed(1) : "--";
  const avgHum      = logs.length ? (logs.reduce((a, l) => a + l.avgHum,  0) / logs.length).toFixed(1) : "--";

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4 bg-white dark:bg-transparent">

      {/* ── Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="text-[10px] font-mono text-slate-400 dark:text-slate-500 tracking-widest uppercase">
          Environment · Alerts · Aircon — {logs.length} days recorded
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setView("logs")}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer transition-all ${
              view === "logs"
                ? "bg-blue-100 dark:bg-blue-500/20 border-blue-300 dark:border-blue-500/40 text-blue-600 dark:text-blue-400"
                : "bg-slate-100 dark:bg-white/[0.04] border-slate-200 dark:border-white/[0.07] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
            }`}
          >
            ▤ Logs
          </button>
          <button
            onClick={() => setView("table")}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer transition-all ${
              view === "table"
                ? "bg-blue-100 dark:bg-blue-500/20 border-blue-300 dark:border-blue-500/40 text-blue-600 dark:text-blue-400"
                : "bg-slate-100 dark:bg-white/[0.04] border-slate-200 dark:border-white/[0.07] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
            }`}
          >
            ☰ Table
          </button>
        </div>
      </div>

      {/* ── Summary stat cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <StatCard label="Total Events"   value={totalEvents}      color="text-slate-900 dark:text-white"    sub="all time" />
        <StatCard label="Critical"       value={critCount}        color="text-red-600 dark:text-red-400"    sub="entries" />
        <StatCard label="Warnings"       value={warnCount}        color="text-amber-600 dark:text-amber-400" sub="entries" />
        <StatCard label="Avg Temp"       value={`${avgTemp} °C`}  color="text-cyan-600 dark:text-cyan-400"  sub="across period" />
        <StatCard label="Avg Humidity"   value={`${avgHum} %`}    color="text-blue-600 dark:text-blue-400"  sub="across period" />
      </div>

      {/* ── Volume histogram ── */}
      {logs.length > 0 && <VolumeBar logs={logs} filter={filter} />}

      {/* ── Filter bar ── */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Search */}
        <div className="relative flex-1 min-w-[180px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs pointer-events-none">⌕</span>
          <input
            ref={searchRef}
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search logs…"
            className="w-full pl-7 pr-3 py-1.5 text-xs font-mono rounded-lg border border-slate-200 dark:border-white/[0.08] bg-slate-50 dark:bg-white/[0.03] text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:border-blue-400 dark:focus:border-blue-500 transition-colors"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:hover:text-white text-xs">✕</button>
          )}
        </div>

        <div className="h-5 w-px bg-slate-200 dark:bg-white/10" />

        {/* Type filters */}
        <FilterPill label="All"         active={filter === "all"}      onClick={() => setFilter("all")} />
        <FilterPill label="Temperature" active={filter === "temp"}     onClick={() => setFilter("temp")}     dot="bg-orange-400" />
        <FilterPill label="Humidity"    active={filter === "humidity"} onClick={() => setFilter("humidity")} dot="bg-sky-400" />
        <FilterPill label="Alerts"      active={filter === "alerts"}   onClick={() => setFilter("alerts")}   dot="bg-red-400" />
        <FilterPill label="Aircon"      active={filter === "aircon"}   onClick={() => setFilter("aircon")}   dot="bg-purple-400" />

        <div className="h-5 w-px bg-slate-200 dark:bg-white/10" />

        {/* Severity filters */}
        <FilterPill label="All severity" active={severity === "all"}      onClick={() => setSeverity("all")} />
        <FilterPill label="Critical"     active={severity === "critical"} onClick={() => setSeverity("critical")} dot="bg-red-500" />
        <FilterPill label="Warning"      active={severity === "warning"}  onClick={() => setSeverity("warning")}  dot="bg-amber-500" />
        <FilterPill label="Info"         active={severity === "info"}     onClick={() => setSeverity("info")}      dot="bg-blue-500" />
      </div>

      {/* ── Result count ── */}
      <div className="text-[10px] font-mono text-slate-400 dark:text-slate-500 -mt-2">
        Showing {filtered.length} of {entries.length} log entries
        {search && <span className="ml-1">matching "<span className="text-slate-600 dark:text-slate-300">{search}</span>"</span>}
      </div>

      {/* ── Content ── */}
      {loading ? (
        <div className="text-center py-16 text-slate-400 text-sm font-mono">Loading...</div>
      ) : view === "logs" ? (

        /* ── Grafana-style log lines ── */
        <div className="rounded-xl bg-slate-100 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08] overflow-hidden">
          {/* Log list header */}
          <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-200 dark:border-white/[0.07] bg-slate-50 dark:bg-white/[0.02]">
            <span className="text-[9px] font-mono text-slate-400 uppercase tracking-widest w-28 flex-shrink-0">Timestamp</span>
            <span className="text-[9px] font-mono text-slate-400 uppercase tracking-widest w-14 flex-shrink-0">Level</span>
            <span className="text-[9px] font-mono text-slate-400 uppercase tracking-widest w-20 flex-shrink-0">Type</span>
            <span className="text-[9px] font-mono text-slate-400 uppercase tracking-widest flex-1">Message</span>
            <span className="text-[9px] font-mono text-slate-400 uppercase tracking-widest w-16 text-right">Value</span>
          </div>

          {filtered.length === 0 ? (
            <div className="text-center py-12 text-slate-400 dark:text-slate-600 font-mono text-xs">
              No log entries match the current filters.
            </div>
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-white/[0.04] max-h-[520px] overflow-y-auto">
              {filtered.map(entry => (
                <div key={entry.id}>
                  <div
                    onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-200 dark:hover:bg-white/[0.04] cursor-pointer transition-colors group"
                  >
                    {/* Severity dot */}
                    <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${severityDot(entry.severity)}`} />

                    {/* Timestamp */}
                    <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400 w-28 flex-shrink-0 whitespace-nowrap">
                      {entry.timestamp}
                    </span>

                    {/* Severity badge */}
                    <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border w-14 flex-shrink-0 text-center uppercase tracking-wider ${severityStyle(entry.severity)}`}>
                      {entry.severity === "all" ? "info" : entry.severity}
                    </span>

                    {/* Type badge */}
                    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border w-20 flex-shrink-0 text-center ${typeBadgeStyle(entry.type)}`}>
                      {typeLabel(entry.type)}
                    </span>

                    {/* Message */}
                    <span className="text-[11px] font-mono text-slate-700 dark:text-slate-300 flex-1 truncate">
                      {entry.message}
                    </span>

                    {/* Value */}
                    <span className="text-[10px] font-mono font-bold text-slate-600 dark:text-slate-300 w-16 text-right flex-shrink-0">
                      {entry.value ?? "—"}
                    </span>

                    {/* Expand chevron */}
                    <span className={`text-slate-400 text-[10px] transition-transform ${expanded === entry.id ? "rotate-180" : ""}`}>▾</span>
                  </div>

                  {/* Expanded detail */}
                  {expanded === entry.id && (
                    <div className="px-4 py-3 bg-slate-50 dark:bg-white/[0.02] border-t border-slate-200 dark:border-white/[0.06] flex flex-col gap-1.5">
                      <div className="flex gap-6 flex-wrap">
                        {[
                          ["Source",    entry.source ?? "—"],
                          ["Type",      typeLabel(entry.type)],
                          ["Severity",  entry.severity],
                          ["Date",      entry.timestamp],
                          ["Value",     entry.value ?? "—"],
                        ].map(([k, v]) => (
                          <div key={k} className="flex flex-col gap-0.5">
                            <span className="text-[9px] font-mono text-slate-400 uppercase tracking-widest">{k}</span>
                            <span className="text-[11px] font-mono text-slate-700 dark:text-slate-200 font-semibold">{v}</span>
                          </div>
                        ))}
                      </div>
                      <div className="mt-1 text-[10px] font-mono text-slate-600 dark:text-slate-400 bg-slate-200 dark:bg-white/[0.04] rounded-md px-3 py-2">
                        {entry.message}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

      ) : (

        /* ── Table view ── */
        <div className="rounded-xl bg-slate-100 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08] p-4">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  {["Date", "Avg Temp", "Max Temp", "Min Temp", "Avg Humidity", "Events"].map(h => (
                    <th key={h} className="text-left px-3 py-2 text-[10px] text-slate-500 font-semibold tracking-widest border-b border-slate-200 dark:border-white/[0.07] whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logs
                  .filter(row => {
                    if (filter === "temp" || filter === "humidity") return true;
                    if (filter === "alerts") return row.events > 0;
                    return true;
                  })
                  .filter(row => {
                    if (!search) return true;
                    return row.date.includes(search) ||
                      String(row.avgTemp).includes(search) ||
                      String(row.events).includes(search);
                  })
                  .map((row, i) => (
                    <tr key={i} className={i % 2 === 0 ? "bg-slate-50 dark:bg-white/[0.015]" : ""}>
                      <td className="px-3 py-3 font-mono text-slate-900 dark:text-white text-xs whitespace-nowrap">{row.date}</td>
                      <td className={`px-3 py-3 font-mono font-bold text-xs ${tempColor(row.avgTemp)}`}>{row.avgTemp} °C</td>
                      <td className="px-3 py-3 font-mono font-bold text-red-600 dark:text-red-400 text-xs">{row.maxTemp} °C</td>
                      <td className="px-3 py-3 font-mono font-bold text-green-600 dark:text-green-400 text-xs">{row.minTemp} °C</td>
                      <td className="px-3 py-3 font-mono font-bold text-blue-600 dark:text-blue-400 text-xs">{row.avgHum} %</td>
                      <td className="px-3 py-3">
                        <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                          row.events > 3
                            ? "bg-red-100 dark:bg-red-500/10 border-red-300 dark:border-red-500/25 text-red-600 dark:text-red-400"
                            : row.events > 0
                            ? "bg-amber-100 dark:bg-amber-500/10 border-amber-300 dark:border-amber-500/25 text-amber-600 dark:text-amber-400"
                            : "bg-green-100 dark:bg-green-500/10 border-green-300 dark:border-green-500/25 text-green-600 dark:text-green-400"
                        }`}>
                          {row.events} event{row.events !== 1 ? "s" : ""}
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>

      )}
    </div>
  );
}