import { useState, useEffect, useRef } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import Chart from "../chart/ChartConfig";
import RangePicker from "../components/ui/RangePicker";
import type { RangeValue } from "../components/ui/RangePicker";
import { withGaps } from "../utils/seriesGaps";

// ─── Per-UPS detail view (live values + discharge history + event log) ────────
// Reached from UpsMonitoring via "View". In-page swap (Back button), and laid out
// to match NetworkDetail / MikrotikDetail: header → banner → stat grid → chart →
// facts panel → event log. Current values stay live via the `upsMetrics` socket.
//
// This page DOES chart, unlike the first cut. The earlier reasoning — "a healthy UPS
// is a flat line at 1h/6h/24h" — is true and is exactly why the chart earns its
// place: the moment it stops being flat is a power event, and the battery discharge
// curve is the single most useful thing on screen during one. It answers "how long
// have we got, and how fast are we losing it", which no instantaneous number does.
// (`/api/ups/:id/history` already existed and served this data; nothing called it.)
//
// Types live HERE so UpsMonitoring can import them without a circular import —
// the list imports this module, never the reverse. Same as NetworkDetail.

export interface UpsDevice {
  id: string;
  name: string;
  ip: string;
  location: string;
  brand: string | null;
  model: string | null;
  status: string;
  batteryChargePct: number | null;
  runtimeRemainingMin: number | null;
  loadPct: number | null;
  inputVoltage: number | null;
  outputVoltage: number | null;
  batteryVoltage: number | null;
  onBattery: boolean | null;
  // On BYPASS: the load is on raw mains with the inverter and battery cut out of
  // the path. Powered, but with zero protection — a distinct state from onBattery,
  // never both at once (RFC 1628 upsOutputSource is one value).
  onBypass?: boolean | null;
  // The raw state name from the backend: normal | battery | bypass | off | avr |
  // unknown. Lets the UI name WHICH abnormal source is in use instead of inferring
  // it from a pair of booleans.
  outputState?: string | null;
  temperature: number | null;
  batteryStatus?: number | null; // RFC 1628: 1 unknown, 2 normal, 3 low, 4 depleted
  commType?: string | null;
  batteryCapacity?: string | null;
  monitored?: boolean;
}
interface UpsHistPoint {
  time: string;
  batteryChargePct: number | null;
  loadPct: number | null;
  runtimeRemainingMin: number | null;
  inputVoltage: number | null;
  outputVoltage: number | null;
  temperature: number | null;
}
interface DeviceLog {
  log_level: "info" | "warning" | "critical" | "error";
  message: string;
  recorded_at: string;
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
} as const;

const GREEN = "#73BF69";
const ORANGE = "#FF780A";
const RED = "#F2495C";
const BLUE = "#5794F2";

const fmt = (v: number | null | undefined, unit = "", digits = 0) =>
  v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(digits)}${unit}`;
function batteryColor(v: number) {
  if (v <= 20) return RED;
  if (v <= 50) return ORANGE;
  return GREEN;
}
function loadColor(v: number) {
  if (v >= 85) return RED;
  if (v >= 65) return ORANGE;
  return GREEN;
}
function statusColor(s: string) {
  if (s === "Online") return GREEN;
  if (s === "Warning") return ORANGE;
  return RED;
}
function logColor(level: string) {
  if (level === "critical" || level === "error") return RED;
  if (level === "warning") return ORANGE;
  return BLUE;
}
// RFC 1628 upsBatteryStatus. Battery HEALTH, which is not the same as charge level —
// a pack sitting at 100% can still report "replace", and that's the early warning
// that matters most (a UPS only fails when you actually need it).
export function batteryHealth(v: number | null | undefined): { text: string; color: string } {
  switch (v) {
    case 2: return { text: "Normal", color: GREEN };
    case 3: return { text: "Low", color: ORANGE };
    case 4: return { text: "Replace", color: RED };
    default: return { text: "—", color: gf.textDim };
  }
}
function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-PH", {
    timeZone: "Asia/Manila", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

// Battery + load over time. Two y-axes would over-complicate it: both are percentages,
// so they share one 0–100 axis and read directly against each other — load is what
// determines how fast the battery line falls.
function UpsChart({ history }: { history: UpsHistPoint[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  useEffect(() => {
    if (!ref.current || history.length < 2) {
      chartRef.current?.destroy();
      chartRef.current = null;
      return;
    }
    chartRef.current?.destroy();
    // Break the line where the poller stopped. `spanGaps` was TRUE here, which does the
    // opposite — it bridges a null so the line jumps the hole. On a UPS that is the worst
    // possible default: the one thing you look at this chart to find is what the battery
    // did during an outage, and spanning drew it as a steady hold through hours that were
    // never measured.
    const gapped = withGaps(
      history.map((p) => Date.parse(p.time)),
      history.map((p) =>
        new Date(p.time).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", hour12: false }),
      ),
      [
        history.map((p) => p.batteryChargePct ?? null),
        history.map((p) => p.loadPct ?? null),
      ],
    );
    chartRef.current = new Chart(ref.current, {
      type: "line",
      data: {
        labels: gapped.labels,
        datasets: [
          { label: "Battery %", data: gapped.series[0]!, borderColor: GREEN, backgroundColor: GREEN + "22", borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3 },
          { label: "Load %", data: gapped.series[1]!, borderColor: ORANGE, backgroundColor: ORANGE + "18", borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: true, labels: { color: "#8E9297", boxWidth: 10, boxHeight: 10, font: { size: 10 } } },
          tooltip: { callbacks: { label: (ctx: any) => `${ctx.dataset.label}: ${ctx.parsed.y == null ? "—" : Math.round(ctx.parsed.y) + "%"}` } },
        },
        scales: {
          x: { ticks: { color: "#6B7280", maxTicksLimit: 6, font: { size: 9 } }, grid: { color: "rgba(127,127,127,0.10)" } },
          y: { beginAtZero: true, max: 100, ticks: { color: "#6B7280", font: { size: 9 }, callback: (v: any) => `${v}%` }, grid: { color: "rgba(127,127,127,0.10)" } },
        },
      },
    });
    return () => { chartRef.current?.destroy(); };
  }, [history]);
  return (
    <div style={{ height: 200 }}>
      {history.length < 2 ? (
        <div className="flex items-center justify-center h-full text-[13px]" style={{ color: gf.textDim }}>No data in range</div>
      ) : (
        <canvas ref={ref} />
      )}
    </div>
  );
}

function Panel({ title, right, children, noPad }: { title: string; right?: React.ReactNode; children: React.ReactNode; noPad?: boolean }) {
  return (
    // overflow-visible so the header's range dropdown isn't clipped by the panel box.
    <div className="flex flex-col rounded-lg overflow-visible" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
      {/* Header WRAPS rather than overflowing — a fixed non-wrapping 32px row pushed
          the right-most control off-screen on a phone. min-height keeps desktop identical. */}
      <div
        className="flex items-center justify-between gap-x-3 gap-y-1.5 flex-wrap px-3 py-1.5 sm:py-0 shrink-0"
        style={{ minHeight: 32, borderBottom: `1px solid ${gf.divider}` }}
      >
        <span className="text-[13px] font-medium tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>{title}</span>
        {right && <div className="flex items-center gap-2 flex-wrap">{right}</div>}
      </div>
      <div className="flex-1 min-h-0" style={{ padding: noPad ? 0 : 12 }}>{children}</div>
    </div>
  );
}

function Stat({ label, value, unit, color, sub }: { label: string; value: string; unit?: string | undefined; color: string; sub?: string | undefined }) {
  return (
    <div className="relative overflow-hidden rounded-lg flex flex-col" style={{ background: gf.panel, border: `1px solid ${gf.border}`, minHeight: 84 }}>
      <div className="flex items-center justify-between px-3 pt-2.5">
        <span className="text-[12px] tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>{label}</span>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      </div>
      <div className="px-3 pt-1.5">
        <span className="text-[24px] font-bold leading-none" style={{ color }}>{value}</span>
        {unit && <span className="text-[15px] ml-1" style={{ color: color + "AA" }}>{unit}</span>}
        {sub && <div className="text-[11px] mt-1 tracking-widest uppercase" style={{ color: gf.textDim }}>{sub}</div>}
      </div>
    </div>
  );
}

// Horizontal battery meter. The one place a bar beats a number: charge is a
// fraction of a known whole, which is exactly what a bar encodes well (unlike link
// utilization, where an idle port's empty track reads as a loading skeleton).
function BatteryMeter({ pct, onBattery }: { pct: number | null; onBattery: boolean }) {
  const v = pct == null || !Number.isFinite(pct) ? null : Math.max(0, Math.min(100, pct));
  const color = v == null ? gf.textDim : batteryColor(v);
  return (
    <div className="flex items-center gap-3">
      {/* Battery outline + terminal nub, so it reads as a battery at a glance. */}
      <div className="relative flex items-center" style={{ width: 132 }}>
        <div className="relative flex-1 h-7 rounded-[3px] overflow-hidden" style={{ border: `1.5px solid ${gf.border}`, background: gf.bg }}>
          <div
            className="h-full transition-all duration-700"
            style={{ width: `${v ?? 0}%`, background: color, opacity: 0.85 }}
          />
          <span
            className="absolute inset-0 grid place-items-center text-[13px] font-bold tabular-nums"
            style={{ color: gf.textPrimary }}
          >
            {v == null ? "—" : `${Math.round(v)}%`}
          </span>
        </div>
        <div className="h-3 w-1 rounded-r-[2px]" style={{ background: gf.border }} />
      </div>
      <div className="min-w-0">
        <div className="text-[13px]" style={{ color: onBattery ? RED : GREEN }}>
          {onBattery ? "Discharging" : "On mains"}
        </div>
        <div className="text-[11px] tracking-widest uppercase" style={{ color: gf.textDim }}>
          {onBattery ? "running on battery" : "charging / float"}
        </div>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function UpsDetail({ device, onBack }: { device: UpsDevice; onBack: () => void }) {
  const [u, setU] = useState<UpsDevice>(device);
  const [logs, setLogs] = useState<DeviceLog[]>([]);
  const [history, setHistory] = useState<UpsHistPoint[]>([]);
  // Defaults to 6h rather than 1h: a battery event is usually noticed after the
  // fact, and 6h is wide enough to still contain the discharge that caused it.
  const [range, setRange] = useState<RangeValue>({ kind: "preset", preset: "-6h" });
  const [rangeError, setRangeError] = useState("");
  const [poll, setPoll] = useState(0);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);

  // Keep the open device in sync when the parent list refreshes.
  useEffect(() => { setU(device); }, [device]);

  // Keep current values live from the poller.
  useEffect(() => {
    const onMetrics = (data: { ups: any }) => {
      if (!data?.ups || String(data.ups.id) !== String(u.id)) return;
      setU((prev) => ({ ...prev, ...data.ups, id: String(data.ups.id) }));
      setLastUpdate(Date.now());
      setPoll((n) => n + 1);
    };
    const onStatus = (data: { id: number | string; status: string }) => {
      if (String(data?.id) !== String(u.id)) return;
      setU((prev) => ({ ...prev, status: data.status }));
      setLastUpdate(Date.now());
    };
    // device_logs inserts are broadcast as they happen (reachability flips + the
    // on-battery / low-charge alerts) — prepend ours so the log is live rather than a
    // snapshot from page load. During an outage this panel is the running narrative.
    const onLog = (l: any) => {
      if (!l || String(l.device_id) !== String(u.id)) return;
      setLogs((prev) => [{ log_level: l.log_level, message: l.message, recorded_at: l.recorded_at }, ...prev].slice(0, 50));
    };
    socket.on("upsMetrics", onMetrics);
    socket.on("upsStatus", onStatus);
    socket.on("deviceLog", onLog);
    return () => {
      socket.off("upsMetrics", onMetrics);
      socket.off("upsStatus", onStatus);
      socket.off("deviceLog", onLog);
    };
  }, [u.id]);

  useEffect(() => {
    api.getUpsLogs(Number(u.id)).then((r) => {
      if (r.success && r.data) setLogs(r.data.logs ?? []);
    });
  }, [u.id]);

  // Re-fetch on each poll so the curve stays current — rate-limited by the ~60s
  // poll cadence rather than a timer of its own.
  // A CUSTOM window is a fixed slice of the past — it must not refetch on every
  // poll, since the answer cannot change. Only a relative preset tracks live.
  useEffect(() => {
    const custom = range.kind === "custom" ? { start: range.start, stop: range.stop } : undefined;
    api.getUpsHistory(Number(u.id), range.kind === "preset" ? range.preset : "", custom).then((r) => {
      if (r.success && r.data) {
        setHistory(r.data.history ?? []);
        setRangeError("");
      } else {
        setRangeError(r.error || "Could not load history.");
      }
    });
  }, [u.id, range, range.kind === "custom" ? 0 : poll]);

  const onBattery = u.onBattery === true;
  const onBypass = u.onBypass === true;
  const health = batteryHealth(u.batteryStatus);
  const charge = u.batteryChargePct;

  return (
    <div className="flex flex-col gap-2.5" style={{ background: gf.bg, minHeight: "100%", padding: 12 }}>
      {/* Header */}
      <div className="flex items-center gap-x-3 gap-y-1 px-0.5 flex-wrap">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-[15px] transition-colors text-[var(--gf-text-muted)] hover:text-[var(--gf-text-primary)]"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          All UPS
        </button>
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold truncate" style={{ color: gf.textPrimary }}>{u.name}</h1>
          <div className="text-[13px] truncate" style={{ color: gf.textDim }}>
            {u.location} · {u.ip}
            {[u.brand, u.model].filter(Boolean).length ? ` · ${[u.brand, u.model].filter(Boolean).join(" ")}` : ""}
            {u.batteryCapacity ? ` · ${u.batteryCapacity}` : ""}
          </div>
        </div>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor(u.status), boxShadow: `0 0 5px ${statusColor(u.status)}` }} />
            <span className="text-[13px]" style={{ color: gf.textMuted }}>{u.status}</span>
          </span>
          <span className="text-[12px] hidden sm:inline" style={{ color: gf.textDim }}>
            {lastUpdate
              ? `updated ${new Date(lastUpdate).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour12: false })}`
              : "awaiting poll…"}
          </span>
        </span>
      </div>

      {/* Bypass first: it is the state with NO runtime behind it, so it must not sit
          below a banner that talks about minutes remaining. */}
      {onBypass && (
        <div className="rounded-lg px-3 py-2 text-[14px] font-medium" style={{ background: "rgba(242,73,92,0.12)", border: "1px solid rgba(242,73,92,0.3)", color: RED }}>
          ⚠ ON BYPASS — the load is on raw mains with the inverter and battery cut out of the path.
          <span style={{ color: gf.textPrimary }}> There is no backup time at all: a mains dip now drops the load instantly.</span>
          <span style={{ color: gf.textMuted }}> Check for an overload, an over-temperature, or a maintenance bypass switch left engaged.</span>
        </div>
      )}
      {onBattery && (
        <div className="rounded-lg px-3 py-2 text-[14px] font-medium" style={{ background: "rgba(242,73,92,0.12)", border: "1px solid rgba(242,73,92,0.3)", color: RED }}>
          ⚡ ON BATTERY — running on backup power, mains may be down.
          {u.runtimeRemainingMin != null && Number.isFinite(u.runtimeRemainingMin) && (
            <span style={{ color: gf.textPrimary }}> ~{Math.round(u.runtimeRemainingMin)} min remaining at the current load.</span>
          )}
        </div>
      )}
      {health.text === "Replace" && !onBattery && !onBypass && (
        <div className="rounded-lg px-3 py-2 text-[14px] font-medium" style={{ background: ORANGE + "14", border: `1px solid ${ORANGE}40`, color: ORANGE }}>
          Battery reports REPLACE — it may not carry the load through the next outage, even at full charge.
        </div>
      )}

      {/* Battery at a glance */}
      <Panel title="Battery">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <BatteryMeter pct={charge} onBattery={onBattery} />
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[13px]" style={{ color: gf.textMuted }}>
            <span>Runtime <span style={{ color: gf.textPrimary }}>{fmt(u.runtimeRemainingMin, " min")}</span></span>
            <span>Health <span style={{ color: health.color }}>{health.text}</span></span>
            <span>DC <span style={{ color: gf.textPrimary }}>{fmt(u.batteryVoltage, " V", 1)}</span></span>
            <span>Temp <span style={{ color: gf.textPrimary }}>{fmt(u.temperature, " °C")}</span></span>
          </div>
        </div>
      </Panel>

      {/* Current values */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
        <Stat label="Battery" value={fmt(charge)} unit={charge == null ? undefined : "%"} color={charge == null ? gf.textDim : batteryColor(charge)} sub="charge" />
        <Stat label="Load" value={fmt(u.loadPct)} unit={u.loadPct == null ? undefined : "%"} color={u.loadPct == null ? gf.textDim : loadColor(u.loadPct)} sub="of capacity" />
        <Stat label="Runtime" value={fmt(u.runtimeRemainingMin)} unit={u.runtimeRemainingMin == null ? undefined : "min"} color={BLUE} sub="remaining" />
        <Stat label="Source" value={onBattery ? "Battery" : "Mains"} color={onBattery ? RED : GREEN} sub={onBattery ? "outage" : "on utility"} />
        <Stat label="Health" value={health.text} color={health.color} sub="battery pack" />
      </div>

      {/* Discharge / load history */}
      <Panel
        title="Battery & Load History"
        right={
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[12px]" style={{ color: GREEN }}>Battery {fmt(charge, "%")}</span>
            <span className="text-[12px]" style={{ color: ORANGE }}>Load {fmt(u.loadPct, "%")}</span>
            <RangePicker value={range} onChange={setRange} error={rangeError || undefined} />
          </div>
        }
      >
        <UpsChart history={history} />
      </Panel>

      {/* Power path — input → UPS → output, the three numbers read together */}
      <Panel title="Power">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[13px]" style={{ color: gf.textMuted }}>
          <span>Input <span style={{ color: onBattery ? RED : gf.textPrimary }}>{fmt(u.inputVoltage, " V")}</span></span>
          <span style={{ color: gf.textDim }}>→</span>
          <span>Output <span style={{ color: gf.textPrimary }}>{fmt(u.outputVoltage, " V")}</span></span>
          <span>Load <span style={{ color: u.loadPct == null ? gf.textDim : loadColor(u.loadPct) }}>{fmt(u.loadPct, "%")}</span></span>
          <span>Link <span style={{ color: gf.textPrimary }}>{u.commType ? `SNMP (${u.commType})` : "SNMP"}</span></span>
          <span>Host <span style={{ color: gf.textPrimary }}>{u.ip}</span></span>
        </div>
        <p className="text-[11px] mt-2" style={{ color: gf.textDim }}>
          Read over SNMP via the standard UPS-MIB (RFC 1628). Input voltage falling to 0 while the
          output holds is the signature of a mains failure the UPS is riding out.
        </p>
      </Panel>

      {/* Recent events (device_logs) — same shape as ServerDetail's panel: the MESSAGE
          leads and wraps, with the timestamp beneath it. The old single-line row put a
          fixed-width timestamp first and `truncate`d the message, so the very thing you
          open the log to read ("on battery", a runtime threshold crossing) was the part
          that got cut off on a narrow panel. */}
      <Panel
        title="Recent Events"
        right={logs.length > 0 ? <span className="text-[12px]" style={{ color: gf.textDim }}>{logs.length}</span> : undefined}
      >
        {logs.length === 0 ? (
          <div className="text-[13px] py-5 text-center" style={{ color: gf.textDim }}>No events logged yet.</div>
        ) : (
          // Scrolls rather than hard-capping the render at 30. The API returns up to 50
          // and the live socket feed keeps 50, so the whole list stays reachable.
          <div className="flex flex-col max-h-72 overflow-y-auto">
            {logs.map((l, i) => (
              <div key={i} className="flex items-start gap-2.5 py-2" style={{ borderTop: i > 0 ? `1px solid ${gf.divider}` : "none" }}>
                <span className="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0" style={{ background: logColor(l.log_level) }} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] break-words" style={{ color: gf.textPrimary }}>{l.message}</div>
                  <div className="text-[12px] mt-0.5" style={{ color: gf.textDim }}>{fmtDateTime(l.recorded_at)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
