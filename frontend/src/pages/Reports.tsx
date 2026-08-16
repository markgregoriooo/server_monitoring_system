import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import { useAuth } from "../context/AuthContext";

// Reports are real now: MySQL `reports` + an on-disk CSV/PDF per report, built on
// generate from the live stores (InfluxDB sensor_environment / server_metrics /
// router_metrics + network_traffic / ups_metrics, MySQL alerts / aircon_logs).
// Backend: services/reportService.js + routes/reports.js.

interface Report {
  id: number;
  title: string;
  type: string; // environment | server | network | ups | alerts | aircon
  status: string; // pending | generated | failed
  generatedBy: number | null;
  generatedByName: string | null;
  deviceId: number | null; // null = campus-wide
  deviceName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string | null;
  hasFile: boolean;
}

interface TypeMeta {
  value: string;
  label: string;
  desc: string;
  color: string;
}

// A device a report can be scoped to. The backend decides which types are scopeable
// (GET /reports/scope-options) from the same map it validates against, so this page
// never hardcodes "network means routers".
interface ScopeDevice {
  id: number;
  name: string;
  type: string;
  location: string | null;
}

// Device CLASS, shown beside each name in the scope picker. It answers the question the
// list actually raises — "which of these is the router?" — where a location does not: most
// devices here share one server room, so the location repeated on every row distinguished
// nothing while making the names harder to scan.
const DEVICE_TYPE_LABEL: Record<string, string> = {
  server: "Server",
  router: "Router",
  mikrotik: "MikroTik",
  ups: "UPS",
  aircon: "Aircon",
  esp32: "Sensor",
};
const deviceTypeLabel = (t: string): string => DEVICE_TYPE_LABEL[t] ?? t;

const TYPES: TypeMeta[] = [
  { value: "environment", label: "Environment", desc: "Temperature, humidity & gas — daily min / max / avg from the sensor.", color: "#FF6B6B" },
  { value: "server", label: "Server Metrics", desc: "CPU, memory & disk per server — average & peak over the period.", color: "#5794F2" },
  { value: "network", label: "Network Traffic", desc: "Routers & the MikroTik — traffic per port, peak utilization, link errors.", color: "#73BF69" },
  { value: "ups", label: "UPS Power", desc: "Battery charge, runtime & load, plus on-battery and offline events.", color: "#B877D9" },
  { value: "alerts", label: "Alert History", desc: "Every alert raised in the window, counted by severity.", color: "#FF780A" },
  { value: "aircon", label: "Aircon Activity", desc: "Manual & auto IR triggers — who acted, when and why.", color: "#3CC8E8" },
  // The one FORWARD-looking report: the period is used as the regression's lookback
  // rather than as the window being summarised. See predictive-analytics.md §18.
  { value: "forecast", label: "Capacity Forecast", desc: "What runs out and when — disk, UPS battery & link projections, with their measured accuracy.", color: "#E8C33C" },
];

const RANGES = [
  { value: "24h", label: "Last 24h", ms: 24 * 3600 * 1000 },
  { value: "7d", label: "Last 7 days", ms: 7 * 24 * 3600 * 1000 },
  { value: "30d", label: "Last 30 days", ms: 30 * 24 * 3600 * 1000 },
  { value: "custom", label: "Custom", ms: 0 },
];

const GREEN = "#73BF69";
const AMBER = "#FF780A";
const RED = "#F2495C";
const ACCENT = "#5794F2";

const gf = {
  bg: "var(--gf-bg)",
  panel: "var(--gf-panel)",
  border: "var(--gf-panel-border)",
  divider: "var(--gf-divider)",
  header: "var(--gf-header)",
  textPrimary: "var(--gf-text-primary)",
  textMuted: "var(--gf-text-muted)",
  textDim: "var(--gf-text-dim)",
  hover: "var(--gf-hover)",
  hoverStrong: "var(--gf-hover-strong)",
  accent: "var(--gf-accent)",
  accentDim: "var(--gf-accent-dim)",
} as const;

const inputStyle: React.CSSProperties = {
  background: gf.bg,
  border: `1px solid ${gf.border}`,
  color: gf.textPrimary,
  fontFamily: "'JetBrains Mono', monospace",
};

const STATUS_COLOR: Record<string, string> = { generated: GREEN, pending: AMBER, failed: RED };
const typeMeta = (v: string): TypeMeta =>
  TYPES.find((t) => t.value === v) ?? { value: v, label: v, desc: "", color: gf.textMuted };

const fmtDateTime = (iso?: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-PH", {
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Manila",
  });
};

const fmtDay = (iso?: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-PH", { month: "short", day: "2-digit", timeZone: "Asia/Manila" });
};

const fmtPeriod = (r: Report): string =>
  r.periodStart && r.periodEnd ? `${fmtDay(r.periodStart)} – ${fmtDay(r.periodEnd)}` : "—";

// Download filename = "<title> <start> to <end>.<fmt>", sanitized for the filesystem.
const downloadName = (r: Report, format: string): string => {
  const dayIso = (iso?: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  };
  const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  const period = r.periodStart && r.periodEnd ? `_${dayIso(r.periodStart)}_to_${dayIso(r.periodEnd)}` : "";
  return `${safe(r.title || "report") || "report"}${period}.${format}`;
};

const todayStr = () => new Date().toISOString().slice(0, 10);
const daysAgoStr = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString().slice(0, 10);

export default function Reports() {
  const { user } = useAuth();
  const role = String(user?.role ?? "");
  const canGenerate = ["admin", "it_staff"].includes(role);
  const canDelete = role === "admin";

  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  // filters
  const [typeFilter, setTypeFilter] = useState("all");
  const [search, setSearch] = useState("");

  // generate modal
  const [modalOpen, setModalOpen] = useState(false);
  const [genType, setGenType] = useState("environment");
  const [genTitle, setGenTitle] = useState("");
  const [genDevice, setGenDevice] = useState(""); // "" = all devices
  const [scopeDevices, setScopeDevices] = useState<ScopeDevice[]>([]);
  const [rangeMode, setRangeMode] = useState("7d");
  const [customStart, setCustomStart] = useState(daysAgoStr(7));
  const [customEnd, setCustomEnd] = useState(todayStr());
  const [generating, setGenerating] = useState(false);
  const [formError, setFormError] = useState("");

  // per-row busy state (download / delete)
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [confirmId, setConfirmId] = useState<number | null>(null);

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  };

  const load = async () => {
    const res = await api.getReports();
    if (res.success && res.data) setReports(res.data.reports ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  // Insert-or-replace by id. EVERY path that adds a row must go through this — the
  // socket handlers below AND the Generate response.
  //
  // The two race, and the socket usually wins: the backend emits `reportCreated`
  // inside create(), then the route awaits an audit-log write before sending its
  // 202. So by the time the HTTP response resolves the row is normally already in
  // state, and an unconditional prepend there duplicated it.
  const upsertReport = useCallback((r: Report) => {
    setReports((prev) => {
      const i = prev.findIndex((x) => x.id === r.id);
      if (i === -1) return [r, ...prev];
      const next = [...prev];
      next[i] = r;
      return next;
    });
  }, []);

  // Live lifecycle. Reports are a SHARED list — everyone sees every row — so the
  // backend broadcasts all three events to every dashboard: an admin watching this
  // page sees a colleague's report appear as `pending`, then flip to generated or
  // failed, then vanish if it's deleted. No refresh anywhere.
  useEffect(() => {
    const onCreated = (r: Report) => upsertReport(r);

    const onUpdated = (r: Report) => {
      upsertReport(r);
      // Toast only for the person who asked for it — otherwise every user gets a
      // popup every time anyone anywhere generates a report.
      if (user && r.generatedBy === user.id) {
        if (r.status === "failed") showToast(`"${r.title}" failed to generate.`, false);
        else if (r.status === "generated") showToast(`"${r.title}" is ready.`);
      }
    };

    const onDeleted = ({ id }: { id: number }) => {
      setReports((prev) => prev.filter((x) => x.id !== id));
      setConfirmId((c) => (c === id ? null : c)); // don't strand an open confirm
    };

    socket.on("reportCreated", onCreated);
    socket.on("reportUpdated", onUpdated);
    socket.on("reportDeleted", onDeleted);
    return () => {
      socket.off("reportCreated", onCreated);
      socket.off("reportUpdated", onUpdated);
      socket.off("reportDeleted", onDeleted);
    };
  }, [user, upsertReport]);

  // Escape closes the modal
  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setModalOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen]);

  // Which devices the chosen type can be scoped to. Refetched on every type change —
  // switching from Network to UPS must not leave a router selected.
  useEffect(() => {
    if (!modalOpen) return;
    let cancelled = false;
    setGenDevice("");
    api.getReportScopeOptions(genType).then((res) => {
      if (cancelled) return;
      setScopeDevices(res.success && res.data ? (res.data.devices ?? []) : []);
    });
    return () => {
      cancelled = true;
    };
  }, [genType, modalOpen]);

  const openModal = () => {
    setGenType("environment");
    setGenTitle("");
    setGenDevice("");
    setRangeMode("7d");
    setCustomStart(daysAgoStr(7));
    setCustomEnd(todayStr());
    setFormError("");
    setModalOpen(true);
  };

  const handleGenerate = async () => {
    let periodStart: string;
    let periodEnd: string;
    if (rangeMode === "custom") {
      if (!customStart || !customEnd) {
        setFormError("Pick a start and end date.");
        return;
      }
      if (customStart > customEnd) {
        setFormError("Start date must be on or before the end date.");
        return;
      }
      periodStart = new Date(`${customStart}T00:00:00`).toISOString();
      periodEnd = new Date(`${customEnd}T23:59:59`).toISOString();
    } else {
      const ms = RANGES.find((r) => r.value === rangeMode)?.ms ?? 7 * 24 * 3600 * 1000;
      periodEnd = new Date().toISOString();
      periodStart = new Date(Date.now() - ms).toISOString();
    }

    setGenerating(true);
    setFormError("");
    const title = genTitle.trim();
    const res = await api.generateReport({
      type: genType,
      periodStart,
      periodEnd,
      ...(title ? { title } : {}),
      ...(genDevice ? { deviceId: Number(genDevice) } : {}),
    });
    setGenerating(false);
    if (res.success && res.data?.report) {
      // 202: the row comes back `pending` and the backend builds it in the
      // background, flipping to generated (or failed) when `reportUpdated` arrives.
      //
      // upsert, NOT a prepend: `reportCreated` has almost certainly delivered this
      // same row over the socket already (see upsertReport). Still done here so the
      // row appears even if the socket is down.
      upsertReport(res.data.report as Report);
      setModalOpen(false);
      showToast("Generating report…");
    } else {
      setFormError(res.error || "Could not generate the report.");
    }
  };

  const download = async (r: Report, format: "csv" | "pdf") => {
    const key = `${r.id}-${format}`;
    setBusy((b) => ({ ...b, [key]: true }));
    const res = await api.downloadReport(r.id, format, downloadName(r, format));
    setBusy((b) => ({ ...b, [key]: false }));
    if (!res.success) showToast(res.error || "Download failed.", false);
  };

  const emailReport = async (r: Report) => {
    const key = `mail-${r.id}`;
    setBusy((b) => ({ ...b, [key]: true }));
    const res = await api.emailReport(r.id);
    setBusy((b) => ({ ...b, [key]: false }));
    if (res.success) showToast(`Sent to ${res.data?.sentTo ?? "your inbox"}.`);
    else showToast(res.error || "Could not send the email.", false);
  };

  const remove = async (id: number) => {
    setConfirmId(null);
    setBusy((b) => ({ ...b, [`del-${id}`]: true }));
    const res = await api.deleteReport(id);
    setBusy((b) => ({ ...b, [`del-${id}`]: false }));
    if (res.success) {
      setReports((p) => p.filter((r) => r.id !== id));
      showToast("Report deleted.");
    } else {
      showToast(res.error || "Delete failed.", false);
    }
  };

  // ─── derived ────────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const total = reports.length;
    const generated = reports.filter((r) => r.status === "generated").length;
    const issues = reports.filter((r) => r.status !== "generated").length;
    const latest = reports.reduce<string | null>(
      (m, r) => (r.createdAt && (!m || r.createdAt > m) ? r.createdAt : m),
      null,
    );
    return { total, generated, issues, latest };
  }, [reports]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return reports.filter((r) => {
      if (typeFilter !== "all" && r.type !== typeFilter) return false;
      if (q) {
        const hay = `${r.title} ${typeMeta(r.type).label} ${r.generatedByName ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [reports, typeFilter, search]);

  const filtersActive = typeFilter !== "all" || search.trim() !== "";

  const selectCls = "text-[13px] px-2 py-1.5 rounded-[2px] outline-none cursor-pointer";

  return (
    <div className="p-4 lg:p-6" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-[16px] font-bold" style={{ color: gf.textPrimary }}>
            Reports
          </h1>
          <p className="text-[13px] mt-1 max-w-2xl" style={{ color: gf.textMuted }}>
            Generate summaries from live monitoring data and download them as{" "}
            <b style={{ color: gf.textPrimary }}>CSV</b> or <b style={{ color: gf.textPrimary }}>PDF</b>.
            Each report is saved and stays available for later.
          </p>
        </div>
        {canGenerate && (
          <button
            onClick={openModal}
            className="gf-btn inline-flex items-center gap-2 text-[14px] font-medium whitespace-nowrap"
            style={{ height: 32, padding: "0 12px", color: "var(--gf-text-primary)" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Generate report
          </button>
        )}
      </div>

      {/* Stat panels */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard label="Total reports" value={stats.total} color={gf.accent} />
        <StatCard label="Generated" value={stats.generated} color={GREEN} sub="ready to download" />
        <StatCard label="Pending / failed" value={stats.issues} color={stats.issues ? AMBER : gf.textDim} />
        <StatCard label="Last generated" text={fmtDateTime(stats.latest)} color={gf.accent} />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[180px]">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={gf.textDim} strokeWidth="2" strokeLinecap="round" className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input name="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by title, type or author…"
            className="w-full text-[13px] pl-8 pr-2 py-1.5 rounded-[2px] outline-none"
            style={inputStyle}
          />
        </div>
        <select name="typeFilter" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={selectCls} style={inputStyle}>
          <option value="all">All types</option>
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        {filtersActive && (
          <button
            onClick={() => {
              setTypeFilter("all");
              setSearch("");
            }}
            className="text-[12px] px-2.5 py-1.5 rounded-[2px] transition-colors"
            style={{ color: gf.textMuted, border: `1px solid ${gf.border}`, background: "transparent" }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <div className="rounded-lg px-3 py-10 text-center text-[14px]" style={{ background: gf.panel, border: `1px solid ${gf.border}`, color: gf.textDim }}>
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState filtered={filtersActive} canGenerate={canGenerate} onGenerate={openModal} onClear={() => { setTypeFilter("all"); setSearch(""); }} />
      ) : (
        <div className="rounded-lg overflow-hidden" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr style={{ background: gf.header }}>
                  {["Report", "Type", "Period", "Generated by", "Created", "Status", ""].map((h) => (
                    <th key={h} className="text-left px-3 py-2.5 text-[11px] tracking-widest uppercase font-semibold whitespace-nowrap" style={{ color: gf.textMuted, borderBottom: `1px solid ${gf.divider}` }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => {
                  const meta = typeMeta(r.type);
                  const sc = STATUS_COLOR[r.status] ?? gf.textMuted;
                  const ready = r.status === "generated";
                  return (
                    <tr key={r.id} style={{ borderTop: i === 0 ? "none" : `1px solid ${gf.divider}` }}>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <span className="grid place-items-center rounded-md shrink-0" style={{ width: 28, height: 28, background: `${meta.color}1f`, color: meta.color }}>
                            <TypeIcon type={r.type} />
                          </span>
                          <span className="font-medium truncate max-w-[240px]" style={{ color: gf.textPrimary }}>
                            {r.title}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[2px] text-[11px] tracking-wider uppercase font-semibold" style={{ color: meta.color, background: `${meta.color}1f` }}>
                          {meta.label}
                        </span>
                        {/* Scope. A device deleted after the fact leaves deviceId set
                            but deviceName null (FK ON DELETE SET NULL clears the id) —
                            either way, absent means campus-wide. */}
                        {r.deviceName && (
                          <span className="block text-[11px] mt-1 truncate max-w-[150px]" style={{ color: gf.textDim }}>
                            {r.deviceName}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: gf.textMuted }}>
                        {fmtPeriod(r)}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap truncate max-w-[140px]" style={{ color: gf.textMuted }}>
                        {r.generatedByName ?? "—"}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: gf.textMuted }}>
                        {fmtDateTime(r.createdAt)}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[2px] text-[11px] tracking-wider uppercase font-semibold" style={{ color: sc, background: `${sc}1f` }}>
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: sc }} />
                          {r.status}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center justify-end gap-1.5">
                          {confirmId === r.id ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span className="text-[12px]" style={{ color: gf.textMuted }}>Delete?</span>
                              <button onClick={() => remove(r.id)} className="gf-raise px-2 py-1 rounded-md text-[12px] font-medium" style={{ color: "#fff", background: RED }}>Yes</button>
                              <button onClick={() => setConfirmId(null)} className="px-2 py-1 rounded-md text-[12px]" style={{ color: gf.textMuted, border: `1px solid ${gf.border}` }}>No</button>
                            </span>
                          ) : (
                            <>
                              <DownloadBtn label="CSV" disabled={!ready || !!busy[`${r.id}-csv`]} onClick={() => download(r, "csv")} />
                              <DownloadBtn label="PDF" disabled={!ready || !!busy[`${r.id}-pdf`]} onClick={() => download(r, "pdf")} />
                              {/* Mails the PDF to the signed-in user. Disabled until
                                  the background build has produced a file. */}
                              {/* Same raised/recessed rule as the download buttons beside
                                  it — a mixed row would read as three unrelated controls. */}
                              <button
                                onClick={() => emailReport(r)}
                                disabled={!ready || !!busy[`mail-${r.id}`]}
                                className={`grid place-items-center w-8 h-8 rounded-[3px] transition-all disabled:cursor-not-allowed ${ready ? "gf-btn" : ""}`}
                                style={
                                  ready
                                    ? { color: gf.textPrimary }
                                    : {
                                        color: gf.textDim,
                                        background: gf.bg,
                                        border: `1px solid ${gf.border}`,
                                        boxShadow: "var(--gf-btn-shadow-active)",
                                        opacity: 0.6,
                                      }
                                }
                                title={ready ? "Email this report to me (PDF)" : "Not ready to email yet"}
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M3 6.5h18v11H3zM3 7l9 6 9-6" />
                                </svg>
                              </button>
                              {canDelete && (
                                <button
                                  onClick={() => setConfirmId(r.id)}
                                  className="grid place-items-center w-7 h-7 rounded-md transition-colors"
                                  style={{ color: gf.textMuted }}
                                  title="Delete report"
                                  onMouseEnter={(e) => { e.currentTarget.style.background = `${RED}1f`; e.currentTarget.style.color = RED; }}
                                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = gf.textMuted; }}
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
                                  </svg>
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Generate modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }} onClick={() => setModalOpen(false)}>
          {/* Capped + scrollable: six type cards make this taller than a laptop
              viewport, and the Generate button lives at the bottom of the body. */}
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-xl max-h-[90vh] flex flex-col rounded-[2px] overflow-hidden" style={{ background: gf.panel, border: `1px solid ${gf.border}`, boxShadow: "var(--gf-shadow)" }}>
            <div className="flex items-center justify-between px-4 shrink-0" style={{ height: 44, borderBottom: `1px solid ${gf.divider}`, background: gf.header }}>
              <span className="text-[14px] font-semibold tracking-wide" style={{ color: gf.textPrimary }}>
                Generate report
              </span>
              <button onClick={() => setModalOpen(false)} className="grid place-items-center w-7 h-7 rounded-md" style={{ color: gf.textMuted }} title="Close (Esc)">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-4 overflow-y-auto">
              {/* Type cards */}
              <div className="text-[11px] tracking-wider uppercase mb-1.5" style={{ color: gf.textDim }}>Report type</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
                {TYPES.map((t) => {
                  const on = genType === t.value;
                  return (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => setGenType(t.value)}
                      className={`flex items-start gap-2.5 text-left px-3 py-2.5 rounded-[3px] transition-all ${on ? "gf-btn" : ""}`}
                      style={
                        on
                          // The type's own colour still tints the chosen card, but the
                          // RAISED surface is what makes the selection legible without it.
                          ? { borderColor: t.color, boxShadow: `var(--gf-btn-shadow), inset 0 0 0 1px ${t.color}55` }
                          : { background: gf.bg, border: `1px solid ${gf.border}`, boxShadow: "var(--gf-btn-shadow-active)" }
                      }
                    >
                      <span className="grid place-items-center rounded-md shrink-0 mt-0.5" style={{ width: 30, height: 30, background: `${t.color}1f`, color: t.color }}>
                        <TypeIcon type={t.value} />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[14px] font-semibold" style={{ color: on ? t.color : gf.textPrimary }}>{t.label}</span>
                        <span className="block text-[12px] leading-snug mt-0.5" style={{ color: gf.textMuted }}>{t.desc}</span>
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Device scope — only rendered for types the backend says are
                  scopeable. Environment returns no options (one server room), so the
                  control disappears rather than offering a meaningless choice. */}
              {scopeDevices.length > 0 && (
                <div className="mb-3">
                  <Field label="Device (optional)">
                    <select name="genDevice"
                      value={genDevice}
                      onChange={(e) => setGenDevice(e.target.value)}
                      className={selectCls}
                      style={{ ...inputStyle, width: "100%" }}
                    >
                      <option value="">All devices</option>
                      {scopeDevices.map((d) => (
                        <option key={d.id} value={String(d.id)}>
                          {d.name} — {deviceTypeLabel(d.type)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              )}

              {/* Title */}
              <Field label="Title (optional)">
                <input name="genTitle"
                  value={genTitle}
                  onChange={(e) => setGenTitle(e.target.value)}
                  placeholder={`${typeMeta(genType).label} Report${
                    genDevice ? ` — ${scopeDevices.find((d) => String(d.id) === genDevice)?.name ?? ""}` : ""
                  }`}
                  className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none"
                  style={inputStyle}
                />
              </Field>

              {/* Date range */}
              <div className="mt-3">
                <div className="text-[11px] tracking-wider uppercase mb-1.5" style={{ color: gf.textDim }}>Period</div>
                <div className="flex flex-wrap gap-1.5">
                  {RANGES.map((r) => {
                    const on = rangeMode === r.value;
                    return (
                      <button
                        key={r.value}
                        type="button"
                        onClick={() => setRangeMode(r.value)}
                        className={`text-[12px] px-3 py-1.5 rounded-[3px] transition-all ${on ? "gf-btn" : ""}`}
                        style={
                          on
                            // Neutral, not accent: a period is a filter, not an action, and
                            // it should not compete with Generate for the eye.
                            ? { color: gf.textPrimary, fontWeight: 700 }
                            : { color: gf.textMuted, background: gf.bg, border: `1px solid ${gf.border}`, boxShadow: "var(--gf-btn-shadow-active)" }
                        }
                      >
                        {r.label}
                      </button>
                    );
                  })}
                </div>
                {rangeMode === "custom" && (
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <Field label="Start">
                      <input name="customStart" type="date" value={customStart} max={customEnd || todayStr()} onChange={(e) => setCustomStart(e.target.value)} className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                    </Field>
                    <Field label="End">
                      <input name="customEnd" type="date" value={customEnd} min={customStart} max={todayStr()} onChange={(e) => setCustomEnd(e.target.value)} className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                    </Field>
                  </div>
                )}
              </div>

              {formError && (
                <div className="text-[12px] mt-3" style={{ color: RED }}>{formError}</div>
              )}

              <div className="flex gap-2 mt-4">
                <button
                  onClick={handleGenerate}
                  disabled={generating}
                  className="gf-raise inline-flex items-center gap-2 text-[13px] font-bold px-5 py-2.5 rounded-[3px] transition-all active:scale-95 disabled:opacity-50"
                  // The one primary action on the page, so it keeps the accent AND the
                  // strongest lift — everything around it is now neutral by design.
                  style={{
                    color: "#fff",
                    background: gf.accent,
                    border: `1px solid ${gf.accent}`,
                    boxShadow: "0 2px 6px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.25)",
                  }}
                >
                  {generating && (
                    <svg width="13" height="13" viewBox="0 0 24 24" className="animate-spin" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                      <path d="M12 3a9 9 0 1 0 9 9" />
                    </svg>
                  )}
                  {generating ? "Generating…" : "Generate"}
                </button>
                <button
                  onClick={() => setModalOpen(false)}
                  className="text-[13px] font-medium px-5 py-2.5 rounded-[3px] transition-all active:scale-95"
                  // Recessed on purpose: the way out, not a peer of the action that does
                  // the work. Raising both would make the pair ambiguous.
                  style={{
                    color: gf.textMuted,
                    border: `1px solid ${gf.border}`,
                    background: gf.bg,
                    boxShadow: "var(--gf-btn-shadow-active)",
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
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

// ─── small components ─────────────────────────────────────────────────────────
function StatCard({ label, value, text, color, sub }: { label: string; value?: number; text?: string; color: string; sub?: string }) {
  return (
    <div className="relative overflow-hidden rounded-lg flex flex-col" style={{ background: gf.panel, border: `1px solid ${gf.border}`, minHeight: 84 }}>
      <div className="flex items-center justify-between px-3 pt-2.5">
        <span className="text-[12px] tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>{label}</span>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      </div>
      <div className="px-3 pt-1.5 pb-3">
        {text !== undefined ? (
          <span className="text-[14px] font-bold leading-tight" style={{ color }}>{text}</span>
        ) : (
          <span className="text-[28px] font-bold leading-none" style={{ color }}>{value}</span>
        )}
        {sub && <div className="text-[11px] mt-1.5 tracking-widest uppercase" style={{ color: gf.textDim }}>{sub}</div>}
      </div>
    </div>
  );
}

// Raised while the file exists, recessed while it does not — the same rule the rest of the
// UI follows: a raised surface means "this will do something". A report still building has
// nothing to download, and a flat, sunken button says that before the cursor gets there.
//
// The hover/press states come from .gf-btn's own CSS (already scoped to :not(:disabled)),
// which replaces the hand-rolled onMouseEnter/onMouseLeave handlers this had — those also
// hardcoded the accent, so they fought the theme in light mode.
function DownloadBtn({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[3px] text-[12px] font-semibold transition-all disabled:cursor-not-allowed ${disabled ? "" : "gf-btn"}`}
      style={
        disabled
          ? {
              color: gf.textDim,
              background: gf.bg,
              border: `1px solid ${gf.border}`,
              boxShadow: "var(--gf-btn-shadow-active)",
              opacity: 0.6,
            }
          : { color: gf.textPrimary }
      }
      title={disabled ? `${label} not ready yet` : `Download ${label}`}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
      </svg>
      {label}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] tracking-wider uppercase" style={{ color: gf.textDim }}>{label}</span>
      {children}
    </div>
  );
}

function EmptyState({ filtered, canGenerate, onGenerate, onClear }: { filtered: boolean; canGenerate: boolean; onGenerate: () => void; onClear: () => void }) {
  return (
    <div className="rounded-lg px-4 py-12 flex flex-col items-center text-center" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
      <span className="grid place-items-center rounded-full mb-3" style={{ width: 44, height: 44, background: gf.accentDim, color: gf.accent }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6M9 13h6M9 17h6M9 9h1" />
        </svg>
      </span>
      {filtered ? (
        <>
          <div className="text-[15px] font-semibold mb-1" style={{ color: gf.textPrimary }}>No reports match your filters</div>
          <div className="text-[13px] mb-4" style={{ color: gf.textMuted }}>Try a different search or clear the filters.</div>
          <button onClick={onClear} className="text-[13px] font-medium px-3 py-1.5 rounded-md" style={{ color: gf.textMuted, border: `1px solid ${gf.border}` }}>Clear filters</button>
        </>
      ) : (
        <>
          <div className="text-[15px] font-semibold mb-1" style={{ color: gf.textPrimary }}>No reports yet</div>
          <div className="text-[13px] mb-4 max-w-sm" style={{ color: gf.textMuted }}>
            {canGenerate ? "Summarise environment, server, network, UPS, alert or aircon activity for any window — or project what runs out next with a capacity forecast." : "No reports have been generated yet."}
          </div>
          {canGenerate && (
            <button onClick={onGenerate} className="gf-btn text-[13px] font-semibold px-3 py-1.5" style={{ color: gf.textPrimary }}>+ Generate your first report</button>
          )}
        </>
      )}
    </div>
  );
}

function TypeIcon({ type, size = 15 }: { type: string; size?: number }) {
  const p = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (type) {
    case "environment":
      return (
        <svg {...p}>
          <path d="M14 14.76V5a2 2 0 0 0-4 0v9.76a4 4 0 1 0 4 0z" />
        </svg>
      );
    case "server":
      return (
        <svg {...p}>
          <rect x="3" y="4" width="18" height="7" rx="1" />
          <rect x="3" y="13" width="18" height="7" rx="1" />
          <path d="M7 7.5h.01M7 16.5h.01" />
        </svg>
      );
    // Stacked switch + link — matches the Network nav icon in the sidebar.
    case "network":
      return (
        <svg {...p}>
          <rect x="2" y="3" width="20" height="6" rx="1.5" />
          <rect x="2" y="15" width="20" height="6" rx="1.5" />
          <path d="M12 9v6M5.5 6h.01M5.5 18h.01" />
        </svg>
      );
    // Battery + bolt — matches the UPS nav icon.
    case "ups":
      return (
        <svg {...p}>
          <rect x="2" y="5" width="19" height="14" rx="2" />
          <path d="M13 8.5 9.5 12.5h3L11 15.5" />
        </svg>
      );
    case "alerts":
      return (
        <svg {...p}>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
      );
    case "aircon":
      return (
        <svg {...p}>
          <path d="M12 2v20M2 12h20M5 5l14 14M19 5 5 19" />
        </svg>
      );
    // Rising trend + arrow — matches the Analytics nav icon.
    case "forecast":
      return (
        <svg {...p}>
          <path d="M3 20V4M3 20h18" />
          <path d="M6 15l4-4 3 3 6-6" />
          <path d="M15 8h4v4" />
        </svg>
      );
    default:
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
  }
}
