import { useCallback, useEffect, useState } from "react";
import { api } from "../api/api";

// Predictive Analytics (Phase 1): disk-full ETA (linear regression) + alert
// analytics. Backend: services/analyticsService.js → /api/analytics. See
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
  const [days, setDays] = useState(14);
  const [forecasts, setForecasts] = useState<DiskForecast[]>([]);
  const [summary, setSummary] = useState<AlertSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    const [f, s] = await Promise.all([api.getDiskForecast(days), api.getAlertSummary(30)]);
    if (f.success) setForecasts(f.data?.forecasts ?? []);
    else setError(f.error || "Failed to load forecasts.");
    if (s.success) setSummary(s.data?.summary ?? null);
    setLoading(false);
  }, [days]);

  useEffect(() => { load(); }, [load]);

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

function fmtDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const days = Math.floor(h / 24);
  return `${days}d ${h % 24}h`;
}
