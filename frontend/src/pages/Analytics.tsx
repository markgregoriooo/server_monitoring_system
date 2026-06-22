import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/api";
import { useAuth } from "../context/AuthContext";
import { socket } from "../socket/socket";

// Predictive Analytics: disk-full ETA (linear regression) + alert analytics
// (Phase 1), trend/projection (EWMA + Holt's linear, Phase 2), anomaly detection
// (per-hour z-score + IQR, Phase 3) and threshold recommendations (percentiles,
// Phase 4). Backend: services/analyticsService.js → /api/analytics. See
// predictive-analytics.md for the math/roadmap.

interface DiskForecast {
  deviceId: number;
  name: string;
  currentPercent: number | null;
  slopePerDay: number | null;
  etaDays: number | null;
  full: number;
  fitR2: number | null;
  mae: number | null;
  confidence: "high" | "medium" | "low";
  sampleCount: number;
  status: "filling" | "stable" | "falling" | "full" | "insufficient_data";
  advice: { level: "critical" | "warning"; message: string } | null;
}

interface AlertSummary {
  days: number;
  total: number;
  open: number;
  mttrMinutes: number | null;
  bySeverity: { severity: string; count: number }[];
  byDay: { day: string; count: number }[];
  topDevices: { deviceId: number | null; name: string; count: number }[];
  topTypes: { type: string; count: number }[];
}

interface MetricTrend {
  metric: string;
  label: string;
  unit: string;
  deviceId: number | null;
  lookbackHours: number;
  horizonHours: number;
  alpha: number;
  sampleCount: number;
  series: { t: string; value: number; ewma: number }[];
  projection: { t: string; value: number }[];
  trendPerHour: number | null;
  advice: {
    level: "critical" | "warning";
    severity: "warning" | "critical";
    threshold: number;
    already: boolean;
    etaHours: number;
    action: string;
  } | null;
  status: "ok" | "insufficient_data";
}

interface AnomalyResult {
  metric: string;
  label: string;
  unit: string;
  deviceId: number | null;
  days: number;
  z: number;
  baseline: { hour: number; n: number; mean: number | null; std: number }[];
  iqr: { q1: number; q3: number; lowerFence: number; upperFence: number } | null;
  anomalies: {
    t: string; value: number; expected: number; z: number;
    hour: number; direction: "high" | "low"; iqrOutlier: boolean;
  }[];
  totalPoints: number;
  anomalyCount: number;
  status: "ok" | "insufficient_data";
}

interface Recommendation {
  metric: string;
  label: string;
  unit: string;
  sampleCount: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  suggestedWarn: number | null;
  suggestedCrit: number | null;
  currentWarn: number | null;
  currentCrit: number | null;
  currentWarnId: number | null;
  currentCritId: number | null;
  status: "ok" | "insufficient_data";
}

const gf = {
  bg: "var(--gf-bg)",
  panel: "var(--gf-panel)",
  border: "var(--gf-panel-border)",
  divider: "var(--gf-divider)",
  textPrimary: "var(--gf-text-primary)",
  textMuted: "var(--gf-text-muted)",
  textDim: "var(--gf-text-dim)",
  hover: "var(--gf-hover)",
  accent: "var(--gf-accent)",
} as const;

const GREEN = "#73BF69";
const ORANGE = "#FF780A";
const RED = "#F2495C";
const GRAY = "#6B7280";
const SEV_COLOR: Record<string, string> = { critical: "#E02F44", warning: "#FF780A", info: "#5794F2" };
const CONF_COLOR: Record<DiskForecast["confidence"], string> = { high: GREEN, medium: ORANGE, low: GRAY };

const LOOKBACKS = [7, 14, 30];
const mono = "'JetBrains Mono', monospace";

const METRIC_OPTIONS = [
  { key: "temperature", label: "Temperature", scope: "env" },
  { key: "humidity", label: "Humidity", scope: "env" },
  { key: "gas", label: "Gas", scope: "env" },
  { key: "cpu", label: "CPU", scope: "server" },
  { key: "mem", label: "Memory", scope: "server" },
  { key: "disk", label: "Disk", scope: "server" },
] as const;
const SERVER_METRICS = new Set(["cpu", "mem", "disk"]);

const fmtTime = (iso: string): string =>
  new Date(iso).toLocaleString("en-PH", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const fmtHour = (h: number): string => {
  const ampm = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${ampm}`;
};

const fmtFullBy = (etaDays: number): string => {
  const d = new Date(Date.now() + etaDays * 86_400_000);
  return d.toLocaleDateString("en-PH", { month: "short", day: "2-digit", year: "numeric" });
};

// ETA color: < 7 days = red (act now), < 30 = orange, else green.
const etaColor = (etaDays: number | null): string => {
  if (etaDays == null) return gf.textDim as string;
  if (etaDays < 7) return RED;
  if (etaDays < 30) return ORANGE;
  return GREEN;
};

const STATUS_LABEL: Record<DiskForecast["status"], string> = {
  filling: "Filling",
  stable: "Stable",
  falling: "Falling",
  full: "Full",
  insufficient_data: "Need more data",
};

export default function Analytics() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [days, setDays] = useState(14);
  const [forecasts, setForecasts] = useState<DiskForecast[]>([]);
  const [summary, setSummary] = useState<AlertSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Phase 2/3 — metric focus (one selector drives both Trend and Anomaly panels).
  const [selMetric, setSelMetric] = useState("temperature");
  const [selDevice, setSelDevice] = useState<number | null>(null);
  const [trend, setTrend] = useState<MetricTrend | null>(null);
  const [anom, setAnom] = useState<AnomalyResult | null>(null);
  const [focusLoading, setFocusLoading] = useState(false);

  // Phase 4 — threshold recommendations.
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [recsLoading, setRecsLoading] = useState(true);
  const [applying, setApplying] = useState<string | null>(null);

  // Refresh just the alert summary (no full-panel spinner) so the live socket-driven
  // updates change the numbers in place rather than flashing "Loading…".
  const loadSummary = useCallback(async () => {
    const s = await api.getAlertSummary(30);
    if (s.success) setSummary(s.data?.summary ?? null);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const [f] = await Promise.all([api.getDiskForecast(days), loadSummary()]);
    if (f.success) setForecasts(f.data?.forecasts ?? []);
    else setError(f.error || "Failed to load forecasts.");
    setLoading(false);
  }, [days, loadSummary]);

  useEffect(() => { load(); }, [load]);

  // Live alert analytics: re-pull the summary whenever an alert is raised
  // (`notification`) or its lifecycle changes (`alertUpdated` — acknowledge / resolve /
  // auto-resolve), so "Open now" and the rest track without a manual refresh. Same
  // events NotificationContext uses for the sidebar badge.
  useEffect(() => {
    const onAlertChange = () => { loadSummary(); };
    socket.on("notification", onAlertChange);
    socket.on("alertUpdated", onAlertChange);
    return () => {
      socket.off("notification", onAlertChange);
      socket.off("alertUpdated", onAlertChange);
    };
  }, [loadSummary]);

  const servers = useMemo(
    () => forecasts.map((f) => ({ id: f.deviceId, name: f.name })),
    [forecasts],
  );
  const needsDevice = SERVER_METRICS.has(selMetric);
  const selServerName = useMemo(
    () => servers.find((s) => s.id === selDevice)?.name ?? null,
    [servers, selDevice],
  );

  // A server metric needs a server picked — default to the first one once forecasts load.
  useEffect(() => {
    if (needsDevice && selDevice == null && servers[0]) setSelDevice(servers[0].id);
  }, [needsDevice, selDevice, servers]);

  const loadFocus = useCallback(async () => {
    if (needsDevice && selDevice == null) { setTrend(null); setAnom(null); return; }
    setFocusLoading(true);
    const dev = needsDevice ? selDevice : null;
    const [t, a] = await Promise.all([
      api.getMetricTrend(selMetric, { deviceId: dev, hours: 48, horizon: 12 }),
      api.getAnomalies(selMetric, { deviceId: dev, days: 7 }),
    ]);
    setTrend(t.success ? (t.data?.trend ?? null) : null);
    setAnom(a.success ? (a.data?.result ?? null) : null);
    setFocusLoading(false);
  }, [selMetric, selDevice, needsDevice]);

  useEffect(() => { loadFocus(); }, [loadFocus]);

  const loadRecs = useCallback(async () => {
    setRecsLoading(true);
    const r = await api.getRecommendations(14);
    if (r.success) setRecs(r.data?.recommendations ?? []);
    setRecsLoading(false);
  }, []);

  useEffect(() => { loadRecs(); }, [loadRecs]);

  // Admin only: push the suggested warn (p95) + crit (p99) into the global alert_rules,
  // updating the existing rule if there is one, else creating it (comparison ">").
  const applyRecommendation = async (r: Recommendation) => {
    setApplying(r.metric);
    const upsert = (id: number | null, value: number | null, severity: string) => {
      if (value == null) return null;
      return id != null
        ? api.updateAlertRule(id, { thresholdValue: value })
        : api.createAlertRule({ deviceId: null, metricName: r.metric, thresholdValue: value, comparison: ">", severity });
    };
    const jobs = [
      upsert(r.currentWarnId, r.suggestedWarn, "warning"),
      upsert(r.currentCritId, r.suggestedCrit, "critical"),
    ].filter(Boolean) as Promise<unknown>[];
    await Promise.all(jobs);
    await loadRecs();
    setApplying(null);
  };

  return (
    <div className="p-4 sm:p-6 space-y-6" style={{ fontFamily: mono, color: gf.textPrimary }}>
      {/* ── Header / controls ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold">Predictive Analytics</h1>
          <p className="text-[11px]" style={{ color: gf.textMuted }}>
            Forecasts &amp; insight from historical metrics — supervised linear regression (validated) + alert statistics.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest" style={{ color: gf.textDim }}>Lookback</span>
          {LOOKBACKS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className="px-2.5 py-1 text-[11px] rounded-[2px] transition-colors"
              style={{
                background: days === d ? gf.accent : gf.panel,
                color: days === d ? "#fff" : gf.textMuted,
                border: `1px solid ${days === d ? gf.accent : gf.border}`,
              }}
            >
              {d}d
            </button>
          ))}
          <button
            onClick={load}
            className="px-2.5 py-1 text-[11px] rounded-[2px] transition-colors"
            style={{ background: gf.panel, color: gf.textMuted, border: `1px solid ${gf.border}` }}
            title="Refresh"
          >
            ↻
          </button>
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 text-[11px] rounded-[2px]" style={{ color: RED, background: `${RED}14`, border: `1px solid ${RED}40` }}>
          {error}
        </div>
      )}

      {/* ── Disk-full forecast ── */}
      <Panel
        title="Disk-Full Forecast"
        subtitle={`Linear regression on ${days}-day disk-usage trend → estimated time to ${forecasts[0]?.full ?? 100}% capacity`}
      >
        {loading ? (
          <Empty>Loading forecasts…</Empty>
        ) : forecasts.length === 0 ? (
          <Empty>No server disk history yet. Forecasts appear once agents have reported for a while.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ color: gf.textDim, textAlign: "left" }}>
                  <Th>Server</Th>
                  <Th>Current</Th>
                  <Th>Trend / day</Th>
                  <Th>ETA to full</Th>
                  <Th>Full by</Th>
                  <Th>Confidence</Th>
                  <Th title="Out-of-sample R² (fit quality) · mean abs. error">Fit (R² · MAE)</Th>
                </tr>
              </thead>
              <tbody>
                {forecasts.map((f) => (
                  <tr key={f.deviceId} style={{ borderTop: `1px solid ${gf.divider}` }}>
                    <Td><span style={{ color: gf.textPrimary }}>{f.name}</span></Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        <span>{f.currentPercent == null ? "—" : `${f.currentPercent}%`}</span>
                        {f.currentPercent != null && (
                          <div className="h-1.5 w-16 rounded-full overflow-hidden" style={{ background: gf.hover }}>
                            <div style={{ width: `${Math.min(100, f.currentPercent)}%`, height: "100%", background: etaColor(f.etaDays) }} />
                          </div>
                        )}
                      </div>
                    </Td>
                    <Td>
                      {f.slopePerDay == null ? "—" : (
                        <span style={{ color: f.slopePerDay > 0 ? ORANGE : f.slopePerDay < 0 ? GREEN : gf.textMuted }}>
                          {f.slopePerDay > 0 ? "▲" : f.slopePerDay < 0 ? "▼" : "■"} {Math.abs(f.slopePerDay)}%
                        </span>
                      )}
                    </Td>
                    <Td>
                      {f.status === "filling" && f.etaDays != null ? (
                        <span style={{ color: etaColor(f.etaDays), fontWeight: 600 }}>
                          {f.etaDays < 1 ? "< 1 day" : `${f.etaDays} day${f.etaDays >= 2 ? "s" : ""}`}
                        </span>
                      ) : (
                        <span style={{ color: gf.textMuted }}>{STATUS_LABEL[f.status]}</span>
                      )}
                    </Td>
                    <Td>
                      <span style={{ color: gf.textMuted }}>
                        {f.status === "filling" && f.etaDays != null ? fmtFullBy(f.etaDays) : "—"}
                      </span>
                    </Td>
                    <Td><Badge color={CONF_COLOR[f.confidence]} label={f.confidence} /></Td>
                    <Td>
                      <span style={{ color: gf.textDim }}>
                        {f.fitR2 == null ? "—" : `R²=${f.fitR2}`}{f.mae == null ? "" : ` · ±${f.mae}%`}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
            {forecasts.some((f) => f.advice) && (
              <div className="mt-4 space-y-1.5">
                <SectionLabel>Action needed</SectionLabel>
                {forecasts
                  .filter((f) => f.advice)
                  .map((f) => (
                    <AdviceCallout key={f.deviceId} level={f.advice!.level}>{f.advice!.message}</AdviceCallout>
                  ))}
              </div>
            )}
            <p className="mt-3 text-[10px]" style={{ color: gf.textDim }}>
              ETA is shown only for an upward trend. Low confidence (R² &lt; 0.4) means the trend is noisy — treat the date as indicative, not exact.
            </p>
          </div>
        )}
      </Panel>

      {/* ── Alert analytics ── */}
      <Panel title="Alert Analytics" subtitle={summary ? `Last ${summary.days} days` : "Last 30 days"}>
        {loading ? (
          <Empty>Loading…</Empty>
        ) : !summary || summary.total === 0 ? (
          <Empty>No alerts recorded in this window.</Empty>
        ) : (
          <div className="space-y-5">
            {/* stat tiles */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <Stat label="Total alerts" value={String(summary.total)} />
              <Stat label="Open now" value={String(summary.open)} color={summary.open > 0 ? ORANGE : GREEN} />
              <Stat
                label="Avg resolve time"
                value={summary.mttrMinutes == null ? "—" : fmtDuration(summary.mttrMinutes)}
              />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* severity mix */}
              <div>
                <SectionLabel>Severity mix</SectionLabel>
                <div className="space-y-1.5">
                  {summary.bySeverity.length === 0 ? <Dim>—</Dim> :
                    summary.bySeverity
                      .slice()
                      .sort((a, b) => b.count - a.count)
                      .map((s) => (
                        <BarRow
                          key={s.severity}
                          label={s.severity}
                          count={s.count}
                          max={Math.max(...summary.bySeverity.map((x) => x.count))}
                          color={SEV_COLOR[s.severity] ?? gf.accent}
                        />
                      ))}
                </div>
              </div>

              {/* noisiest devices */}
              <div>
                <SectionLabel>Noisiest sources</SectionLabel>
                <div className="space-y-1.5">
                  {summary.topDevices.length === 0 ? <Dim>—</Dim> :
                    summary.topDevices.map((d) => (
                      <BarRow
                        key={`${d.deviceId}-${d.name}`}
                        label={d.name}
                        count={d.count}
                        max={Math.max(...summary.topDevices.map((x) => x.count))}
                        color={gf.accent}
                      />
                    ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {/* by type */}
              <div>
                <SectionLabel>By type</SectionLabel>
                <div className="flex flex-wrap gap-1.5">
                  {summary.topTypes.map((t) => (
                    <span
                      key={t.type}
                      className="px-2 py-0.5 text-[10px] rounded-[2px]"
                      style={{ background: gf.hover, color: gf.textMuted, border: `1px solid ${gf.border}` }}
                    >
                      {t.type} · {t.count}
                    </span>
                  ))}
                </div>
              </div>

              {/* daily volume */}
              <div>
                <SectionLabel>Daily volume</SectionLabel>
                <DailyBars data={summary.byDay} />
              </div>
            </div>
          </div>
        )}
      </Panel>

      {/* ── Metric focus: selector drives Trend + Anomaly panels ── */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[10px] uppercase tracking-widest" style={{ color: gf.textDim }}>Metric</span>
        <select
          value={selMetric}
          onChange={(e) => { setSelMetric(e.target.value); }}
          className="px-2 py-1 text-[11px] rounded-[2px] outline-none"
          style={{ background: gf.panel, color: gf.textPrimary, border: `1px solid ${gf.border}` }}
        >
          <optgroup label="Environment">
            {METRIC_OPTIONS.filter((m) => m.scope === "env").map((m) => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </optgroup>
          <optgroup label="Servers">
            {METRIC_OPTIONS.filter((m) => m.scope === "server").map((m) => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </optgroup>
        </select>
        {needsDevice && (
          servers.length === 0 ? (
            <span className="text-[10px]" style={{ color: gf.textDim }}>no servers with data</span>
          ) : (
            <select
              value={selDevice ?? ""}
              onChange={(e) => setSelDevice(e.target.value ? Number(e.target.value) : null)}
              className="px-2 py-1 text-[11px] rounded-[2px] outline-none"
              style={{ background: gf.panel, color: gf.textPrimary, border: `1px solid ${gf.border}` }}
            >
              {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )
        )}
      </div>

      {/* ── Trend & short-term projection ── */}
      <Panel
        title="Trend & Short-Term Projection"
        subtitle="EWMA-smoothed history + Holt's linear (double-exponential) projection — next ~12h"
      >
        {focusLoading ? (
          <Empty>Loading trend…</Empty>
        ) : !trend || trend.status !== "ok" ? (
          <Empty>Not enough history for this metric yet.</Empty>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-4 text-[11px]">
              <LegendDot color={GRAY} label="actual" />
              <LegendDot color={gf.accent as string} label="EWMA (smoothed)" />
              <LegendDot color={ORANGE} label="projection" dashed />
              <span className="ml-auto" style={{ color: gf.textMuted }}>
                trend{" "}
                <span style={{ color: (trend.trendPerHour ?? 0) > 0 ? ORANGE : (trend.trendPerHour ?? 0) < 0 ? GREEN : gf.textMuted }}>
                  {trend.trendPerHour == null ? "—" : `${trend.trendPerHour > 0 ? "+" : ""}${trend.trendPerHour}${trend.unit}/h`}
                </span>{" "}
                · {trend.sampleCount} pts
              </span>
            </div>
            <TrendChart series={trend.series} projection={trend.projection} unit={trend.unit} />
            {trend.advice && (
              <AdviceCallout level={trend.advice.level}>
                {adviceSentence(trend, needsDevice ? selServerName : null)}
              </AdviceCallout>
            )}
          </div>
        )}
      </Panel>

      {/* ── Anomaly detection ── */}
      <Panel
        title="Anomaly Detection"
        subtitle={anom ? `Per-hour-of-day baseline · |z| > ${anom.z} over ${anom.days} days` : "Per-hour-of-day z-score + IQR"}
      >
        {focusLoading ? (
          <Empty>Scanning…</Empty>
        ) : !anom || anom.status !== "ok" ? (
          <Empty>Not enough history to baseline this metric yet.</Empty>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <Stat label="Anomalies" value={String(anom.anomalyCount)} color={anom.anomalyCount > 0 ? ORANGE : GREEN} />
              <Stat label="Points scanned" value={String(anom.totalPoints)} />
              <Stat
                label="Normal range (IQR)"
                value={anom.iqr ? `${anom.iqr.lowerFence}–${anom.iqr.upperFence}${anom.unit}` : "—"}
              />
            </div>
            {anom.anomalies.length === 0 ? (
              <Empty>No anomalies — every reading is normal for its hour of day.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]" style={{ borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ color: gf.textDim, textAlign: "left" }}>
                      <Th>When</Th><Th>Reading</Th><Th>Expected (that hour)</Th><Th>z-score</Th><Th>Flags</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {anom.anomalies.slice(0, 12).map((a, i) => (
                      <tr key={i} style={{ borderTop: `1px solid ${gf.divider}` }}>
                        <Td><span style={{ color: gf.textMuted }}>{fmtTime(a.t)}</span></Td>
                        <Td>
                          <span style={{ color: a.direction === "high" ? RED : gf.accent, fontWeight: 600 }}>
                            {a.direction === "high" ? "▲" : "▼"} {a.value}{anom.unit}
                          </span>
                        </Td>
                        <Td><span style={{ color: gf.textMuted }}>{a.expected}{anom.unit} <span style={{ color: gf.textDim }}>@ {fmtHour(a.hour)}</span></span></Td>
                        <Td><span style={{ color: gf.textPrimary }}>{a.z > 0 ? "+" : ""}{a.z}σ</span></Td>
                        <Td>{a.iqrOutlier && <Badge color={ORANGE} label="IQR" />}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {anom.anomalyCount > 12 && (
                  <p className="mt-2 text-[10px]" style={{ color: gf.textDim }}>+ {anom.anomalyCount - 12} more</p>
                )}
              </div>
            )}
          </div>
        )}
      </Panel>

      {/* ── Threshold recommendations ── */}
      <Panel
        title="Threshold Recommendations"
        subtitle="Suggested alert-rule values from the last 14 days — warn = p95, critical = p99"
      >
        {recsLoading ? (
          <Empty>Computing…</Empty>
        ) : recs.length === 0 ? (
          <Empty>No data to base recommendations on yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ color: gf.textDim, textAlign: "left" }}>
                  <Th>Metric</Th><Th>p50</Th><Th>p95</Th><Th>p99</Th><Th>Max</Th>
                  <Th>Current warn / crit</Th><Th>Suggested warn / crit</Th>
                  {isAdmin && <Th>Apply</Th>}
                </tr>
              </thead>
              <tbody>
                {recs.map((r) => {
                  const changed =
                    r.status === "ok" &&
                    (r.suggestedWarn !== r.currentWarn || r.suggestedCrit !== r.currentCrit);
                  return (
                    <tr key={r.metric} style={{ borderTop: `1px solid ${gf.divider}` }}>
                      <Td><span style={{ color: gf.textPrimary }}>{r.label}</span></Td>
                      {r.status !== "ok" ? (
                        <Td><span style={{ color: gf.textDim }} >need more data</span></Td>
                      ) : (
                        <>
                          <Td><Dim>{r.p50}{r.unit}</Dim></Td>
                          <Td><Dim>{r.p95}{r.unit}</Dim></Td>
                          <Td><Dim>{r.p99}{r.unit}</Dim></Td>
                          <Td><Dim>{r.max}{r.unit}</Dim></Td>
                        </>
                      )}
                      {r.status === "ok" && (
                        <>
                          <Td>
                            <span style={{ color: gf.textMuted }}>
                              {r.currentWarn ?? "—"} / {r.currentCrit ?? "—"}
                            </span>
                          </Td>
                          <Td>
                            <span style={{ color: changed ? ORANGE : gf.textMuted, fontWeight: changed ? 600 : 400 }}>
                              {r.suggestedWarn ?? "—"} / {r.suggestedCrit ?? "—"}
                            </span>
                          </Td>
                          {isAdmin && (
                            <Td>
                              <button
                                disabled={!changed || applying === r.metric}
                                onClick={() => applyRecommendation(r)}
                                className="px-2 py-0.5 text-[10px] rounded-[2px] transition-colors disabled:opacity-40"
                                style={{
                                  background: changed ? gf.accent : gf.panel,
                                  color: changed ? "#fff" : gf.textDim,
                                  border: `1px solid ${changed ? gf.accent : gf.border}`,
                                }}
                              >
                                {applying === r.metric ? "…" : changed ? "Apply" : "✓ in sync"}
                              </button>
                            </Td>
                          )}
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-3 text-[10px]" style={{ color: gf.textDim }}>
              {isAdmin
                ? "Apply writes the value into the global Alert Rules (comparison “>”). Per-server overrides stay untouched."
                : "Recommendations are advisory — an admin can apply them to the Alert Rules."}
            </p>
          </div>
        )}
      </Panel>
    </div>
  );
}

// ─── tiny presentational helpers ──────────────────────────────────────────────
function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[2px]" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
      <div className="px-4 py-3" style={{ borderBottom: `1px solid ${gf.divider}` }}>
        <h2 className="text-[13px] font-semibold">{title}</h2>
        {subtitle && <p className="text-[10px] mt-0.5" style={{ color: gf.textDim }}>{subtitle}</p>}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Th({ children, title }: { children: React.ReactNode; title?: string }) {
  return <th className="font-medium pb-2 pr-4 text-[10px] uppercase tracking-wider" title={title}>{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="py-2 pr-4 align-middle">{children}</td>;
}
function Badge({ color, label }: { color: string; label: string }) {
  return (
    <span className="px-1.5 py-0.5 text-[9px] uppercase tracking-wider rounded-[2px]"
      style={{ color, background: `${color}1f`, border: `1px solid ${color}55` }}>
      {label}
    </span>
  );
}
function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-[2px] px-3 py-2.5" style={{ background: gf.bg, border: `1px solid ${gf.border}` }}>
      <div className="text-[9px] uppercase tracking-widest" style={{ color: gf.textDim }}>{label}</div>
      <div className="text-lg font-bold mt-0.5" style={{ color: color ?? gf.textPrimary }}>{value}</div>
    </div>
  );
}
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[9px] uppercase tracking-widest mb-2" style={{ color: gf.textDim }}>{children}</div>;
}
function Dim({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px]" style={{ color: gf.textDim }}>{children}</span>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-6 text-center text-[11px]" style={{ color: gf.textDim }}>{children}</div>;
}
function BarRow({ label, count, max, color }: { label: string; count: number; max: number; color: string }) {
  const pct = max > 0 ? (count / max) * 100 : 0;
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-28 truncate" style={{ color: gf.textMuted }} title={label}>{label}</span>
      <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: gf.hover }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color }} />
      </div>
      <span className="w-6 text-right" style={{ color: gf.textPrimary }}>{count}</span>
    </div>
  );
}
function DailyBars({ data }: { data: { day: string; count: number }[] }) {
  if (!data.length) return <Dim>—</Dim>;
  const max = Math.max(...data.map((d) => d.count));
  return (
    <div className="flex items-end gap-0.5 h-16">
      {data.map((d) => (
        <div key={d.day} className="flex-1 flex flex-col justify-end" title={`${d.day}: ${d.count}`}>
          <div style={{ height: `${max > 0 ? (d.count / max) * 100 : 0}%`, minHeight: d.count > 0 ? 2 : 0, background: gf.accent, borderRadius: "1px 1px 0 0" }} />
        </div>
      ))}
    </div>
  );
}

function AdviceCallout({ level, children }: { level: "critical" | "warning"; children: React.ReactNode }) {
  const color = level === "critical" ? RED : ORANGE;
  return (
    <div
      className="flex items-start gap-2 px-3 py-2 text-[11px] rounded-[2px]"
      style={{ color: gf.textPrimary, background: `${color}14`, border: `1px solid ${color}40` }}
    >
      <span style={{ color, lineHeight: "1.4" }}>{level === "critical" ? "●" : "▲"}</span>
      <span>{children}</span>
    </div>
  );
}

// Compose the human recommendation for a trend that's heading toward an alert threshold.
function adviceSentence(trend: MetricTrend, serverName: string | null): string {
  const a = trend.advice;
  if (!a) return "";
  const subj = serverName ? `${trend.label} on ${serverName}` : `Server-room ${trend.label.toLowerCase()}`;
  const thr = `${a.threshold}${trend.unit}`;
  const tail = `Recommended: ${a.action}.`;
  if (a.already) return `${subj} is already above its ${a.severity} threshold (${thr}). ${tail}`;
  const when = a.etaHours <= 0 ? "imminently" : `in ~${a.etaHours}h`;
  return `${subj} is projected to cross the ${a.severity} threshold (${thr}) ${when}. ${tail}`;
}

function LegendDot({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="flex items-center gap-1.5" style={{ color: gf.textMuted }}>
      <span style={{ width: 14, height: 0, borderTop: `2px ${dashed ? "dashed" : "solid"} ${color}` }} />
      {label}
    </span>
  );
}

// Lightweight inline-SVG line chart (no chart lib — matches this page's hand-rolled
// style). Plots actual + EWMA history and the dashed Holt's-linear projection, with the
// forecast region shaded. Strokes use non-scaling-stroke so width stays uniform under
// the non-uniform viewBox scaling.
function TrendChart({
  series, projection, unit,
}: {
  series: { t: string; value: number; ewma: number }[];
  projection: { t: string; value: number }[];
  unit: string;
}) {
  const W = 1000, H = 220, padY = 12;
  const hist = series.map((s) => ({ t: Date.parse(s.t), v: s.value, e: s.ewma }));
  const proj = projection.map((p) => ({ t: Date.parse(p.t), v: p.value }));
  const all = [...hist.map((h) => h.v), ...hist.map((h) => h.e), ...proj.map((p) => p.v)];
  const ts = [...hist.map((h) => h.t), ...proj.map((p) => p.t)];
  if (hist.length < 2 || all.length < 2) return <Empty>Not enough points to chart.</Empty>;

  const tMin = Math.min(...ts), tMax = Math.max(...ts);
  let vMin = Math.min(...all), vMax = Math.max(...all);
  if (vMin === vMax) { vMin -= 1; vMax += 1; }
  const pad = (vMax - vMin) * 0.1; vMin -= pad; vMax += pad;

  const x = (t: number) => ((t - tMin) / (tMax - tMin || 1)) * W;
  const y = (v: number) => H - padY - ((v - vMin) / (vMax - vMin || 1)) * (H - 2 * padY);
  const path = (pts: { t: number; v: number }[]) =>
    pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");

  const lastE = hist[hist.length - 1];
  if (!lastE) return <Empty>Not enough points to chart.</Empty>;
  const projLine = [{ t: lastE.t, v: lastE.e }, ...proj]; // connect EWMA tail → projection
  const boundary = x(lastE.t);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 220, display: "block" }}>
        <rect x={boundary} y={0} width={W - boundary} height={H} fill="var(--gf-hover)" opacity={0.5} />
        <line x1={boundary} y1={0} x2={boundary} y2={H} stroke="var(--gf-divider)" strokeWidth={1} vectorEffect="non-scaling-stroke" strokeDasharray="2 3" />
        <path d={path(hist.map((h) => ({ t: h.t, v: h.v })))} fill="none" stroke={GRAY} strokeWidth={1} opacity={0.55} vectorEffect="non-scaling-stroke" />
        <path d={path(hist.map((h) => ({ t: h.t, v: h.e })))} fill="none" stroke="var(--gf-accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        <path d={path(projLine)} fill="none" stroke={ORANGE} strokeWidth={2} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-[10px] mt-1" style={{ color: gf.textDim }}>
        <span>{vMin.toFixed(1)}{unit} – {vMax.toFixed(1)}{unit}</span>
        <span>now → +{proj.at(-1) ? Math.round((proj.at(-1)!.t - lastE.t) / 3_600_000) : 0}h</span>
      </div>
    </div>
  );
}

function fmtDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const days = Math.floor(h / 24);
  return `${days}d ${h % 24}h`;
}
