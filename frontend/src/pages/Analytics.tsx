import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/api";
import { useAuth } from "../context/AuthContext";
import { socket } from "../socket/socket";
import { pathWithGaps } from "../utils/seriesGaps";
import { GF as gf, STATUS } from "../theme/gf";
import { usePersistedState as useSharedPersistedState } from "../hooks/usePersistedState";
const { green: GREEN, orange: ORANGE, red: RED } = STATUS;

// Predictive Analytics: disk-full ETA (linear regression) and alert analytics,
// trends with projection (seasonal Holt-Winters), anomaly detection (per-hour z-score
// + IQR), threshold recommendations (percentiles), and UPS battery / link saturation
// ETAs. Backend: services/analyticsService.js → /api/analytics. See
// predictive-analytics.md.
//
// Every device is shown through <DeviceLabel>: its name plus a type badge, since a
// bare name like "core-01" is ambiguous. Names come from MySQL (display_name →
// device_name), not the InfluxDB tag, so renamed devices match the rest of the app.

type Confidence = "high" | "medium" | "low";

interface Advice {
  level: "critical" | "warning";
  message: string;
}

// Identity block returned by every forecast endpoint (analyticsService.identify()).
interface DeviceIdentity {
  deviceId: number;
  name: string;
  hostname: string | null;
  deviceType: string | null;
  typeLabel: string | null;
  location: string | null;
}

interface VolumeForecast {
  mount: string;
  currentPercent: number | null;
  slopePerDay: number | null;
  etaDays: number | null;
  status: string;
  confidence: Confidence;
}

interface DiskForecast extends DeviceIdentity {
  historyDays: number;
  currentPercent: number | null;
  slopePerDay: number | null;
  etaDays: number | null;
  full: number;
  fitR2: number | null;
  mae: number | null;
  confidence: Confidence;
  sampleCount: number;
  status: "filling" | "stable" | "falling" | "full" | "insufficient_data";
  advice: Advice | null;
  mount: string | null;
  volumes: VolumeForecast[];
}

interface UpsBatteryForecast extends DeviceIdentity {
  historyDays: number;
  // The UPS's own RFC 1628 verdict, which outranks our regression when it is worse.
  batteryStatus: string | null;
  batteryStatusWorst: string | null;
  floorMinutes: number;
  currentRuntimeMin: number | null;
  slopePerDay: number | null;
  etaDays: number | null;
  fitR2: number | null;
  mae: number | null;
  confidence: Confidence;
  sampleCount: number;
  status: "declining" | "stable" | "reached" | "insufficient_data";
  advice: Advice | null;
}

interface LinkForecast extends DeviceIdentity {
  historyDays: number;
  interface: string;
  interfaceLabel: string | null;
  ceiling: number;
  currentUtil: number | null;
  slopePerDay: number | null;
  etaDays: number | null;
  fitR2: number | null;
  mae: number | null;
  confidence: Confidence;
  sampleCount: number;
  status: "rising" | "stable" | "reached" | "insufficient_data";
  advice: Advice | null;
}

interface AlertSummary {
  days: number;
  total: number;
  open: number;
  mttrMinutes: number | null;
  bySeverity: { severity: string; count: number }[];
  byDay: { day: string; count: number }[];
  topDevices: { deviceId: number | null; name: string; typeLabel: string | null; count: number }[];
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
  // Whether the projection carries the daily hour-of-day shape. The caption says which,
  // so a flat-looking forecast is explainable rather than just suspicious.
  seasonal?: boolean;
  profileHours?: number;
  profileCycles?: number;
  // Why a projection was withheld, when status === "insufficient_history".
  dataQuality?: {
    ok: boolean;
    reason: "no_data" | "too_short" | "hours_missing" | "gaps" | "sparse" | "ok";
    message: string;
    points: number;
    spanDays: number;
    hoursCovered: number;
    coverage: number;
    largestGapHours: number;
  } | null;
  advice: {
    level: "critical" | "warning";
    severity: "warning" | "critical";
    threshold: number;
    already: boolean;
    etaHours: number;
    action: string;
  } | null;
  // "insufficient_history" = there is history, but too little or too patchy to project
  // from (shows the quality notice). "insufficient_data" = hardly any points (empty panel).
  status: "ok" | "insufficient_data" | "insufficient_history";
}

interface AnomalyResult {
  metric: string;
  label: string;
  unit: string;
  deviceId: number | null;
  days: number;
  z: number;
  baseline: { hour: number; dayType: "weekday" | "weekend"; n: number; mean: number | null; std: number }[];
  iqr: { q1: number; q3: number; lowerFence: number; upperFence: number } | null;
  anomalies: {
    t: string; value: number; expected: number; z: number;
    hour: number; dayType: "weekday" | "weekend";
    direction: "high" | "low"; iqrOutlier: boolean;
  }[];
  totalPoints: number;
  anomalyCount: number;
  status: "ok" | "insufficient_data";
}

interface AccuracyResult {
  metric: string;
  label: string;
  unit: string;
  lookbackDays: number;
  horizonDays: number;
  overallMae: number | null;
  totalFolds: number;
  devices: {
    deviceId: number | null;
    name: string;
    typeLabel: string | null;
    // Which volume was graded — the same one the disk forecast headlines.
    mount: string | null;
    folds: number;
    mae: number | null;
    bias: number | null;
    worst: number | null;
  }[];
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


const GRAY = "#6B7280";
const SEV_COLOR: Record<string, string> = { critical: "#E02F44", warning: "#FF780A", info: "#5794F2" };
const CONF_COLOR: Record<Confidence, string> = { high: GREEN, medium: ORANGE, low: GRAY };

// One colour per device class, so a row's class is readable without reading the word.
const TYPE_COLOR: Record<string, string> = {
  Server: "#5794F2",
  MikroTik: "#B877D9",
  Router: "#FF9830",
  UPS: "#73BF69",
  Sensor: "#6B7280",
};

// Lookback windows fit how each thing changes: disk over weeks, an uplink over a
// semester, a UPS battery over years (so its default is much longer). See
// predictive-analytics.md §16.
interface LookbackOption { value: number; label: string }
const D = (d: number): LookbackOption => ({ value: d, label: `${d}d` });

const DISK_LOOKBACKS = [D(14), D(30), D(90)];
const LINK_LOOKBACKS = [D(30), D(90), D(180)];
const UPS_LOOKBACKS = [D(90), D(180), D(365)];
// Anomalies need several samples per hour bucket; 7 days has only one Saturday per
// bucket, so 14 days is the minimum.
const ANOMALY_LOOKBACKS = [D(7), D(14), D(30)];
// Alert analytics is descriptive, so any window is "valid"; 30 days is the usual
// incident-review period, 90 shows a term.
const ALERT_LOOKBACKS = [D(7), D(30), D(90)];
// Threshold suggestions use a fixed 30-day window, not a control: sliding the window
// until the suggestion matches what you wanted defeats the purpose.
const REC_WINDOW_DAYS = 30;
// Trend lookback is fixed, not a control: the hour-of-day profile is averaged over the
// window, and a window that is too short makes the projection fall back to a straight
// line. 7 days: on a test room, going from 48h to 168h cut the 12h error from 0.14 °C
// to 0.05 °C. The backend needs at least two days. (The anomaly window below stays
// adjustable.)
const TREND_LOOKBACK_HOURS = 168;
// How far ahead the projection runs, separate from the lookback. 12h: enough to act
// on before the next shift, and safe across a daily cycle since the projection
// includes the hour-of-day shape.
const TREND_HORIZON_HOURS = 12;
// Live updates arrive over the socket (servers ~10s, polls ~30-60s, environment ~3s).
// Refresh the analytics at most once per this window; each refresh runs several queries.
const LIVE_REFRESH_MS = 15_000;
const mono = "'JetBrains Mono', monospace";

// Scaling type: one root size that grows with the viewport, with all text in `em`,
// so the page scales smoothly from a laptop to the server-room wall display. 11px
// minimum for phones, 13.5px maximum for large monitors.
const ROOT_FONT = "clamp(11px, 0.25vw + 10.2px, 13.5px)";

const METRIC_OPTIONS = [
  { key: "temperature", label: "Temperature", scope: "env" },
  { key: "humidity", label: "Humidity", scope: "env" },
  { key: "gas", label: "Gas", scope: "env" },
  { key: "cpu", label: "CPU", scope: "server" },
  { key: "mem", label: "Memory", scope: "server" },
  { key: "disk", label: "Disk", scope: "server" },
  { key: "router_cpu", label: "Router CPU", scope: "router" },
  { key: "router_mem", label: "Router Memory", scope: "router" },
  { key: "router_clients", label: "Connected Devices", scope: "router" },
  // ICMP — on every router, and the ONLY two metrics a ping-only one has.
  { key: "router_latency", label: "Latency", scope: "router" },
  { key: "router_loss", label: "Packet Loss", scope: "router" },
] as const;
const METRIC_GROUP: Record<string, string> = {
  env: "Server Room", server: "Servers", router: "Network / MikroTik",
};
const METRIC_SELECT_OPTIONS: SelectOption[] = METRIC_OPTIONS.map((m) => ({
  value: m.key,
  label: m.label,
  group: METRIC_GROUP[m.scope] ?? null,
}));
const SERVER_METRICS = new Set<string>(["cpu", "mem", "disk"]);
// Metrics that need a DEVICE picked before they mean anything. Latency and loss join
// the list for the same reason as the rest: "the latency" of a fleet is not a quantity.
const ROUTER_METRICS = new Set<string>([
  "router_cpu", "router_mem", "router_clients", "router_latency", "router_loss",
]);

/* `short` is used on a phone, only for "Trends & Anomalies", which otherwise pushes
   "Recommendations" off the strip. */
const TABS = [
  { key: "forecasts", label: "Forecasts", short: "Forecasts" },
  { key: "trends", label: "Trends & Anomalies", short: "Trends" },
  { key: "alerts", label: "Alerts", short: "Alerts" },
  { key: "recs", label: "Recommendations", short: "Recommendations" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const fmtTime = (iso: string): string =>
  new Date(iso).toLocaleString("en-PH", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const fmtHour = (h: number): string => {
  const ampm = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${ampm}`;
};
// Clock label for a forecast point — hour-focused (e.g. "Tue 3:00 PM"), with the weekday
// so a horizon that crosses midnight stays unambiguous.
const fmtClock = (ms: number): string =>
  new Date(ms).toLocaleString("en-PH", { weekday: "short", hour: "numeric", minute: "2-digit" });

const fmtFullBy = (etaDays: number): string => {
  const d = new Date(Date.now() + etaDays * 86_400_000);
  return d.toLocaleDateString("en-PH", { month: "short", day: "2-digit", year: "numeric" });
};

// Round axis ticks (1/2/5 x a power of ten), e.g. 28 / 30 / 32. Same as `niceTicks` in
// backend/services/analyticsMath.js (which is Node-only); keep them identical.
function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [];
  const raw = (max - min) / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1.5 ? 1 : norm <= 3 ? 2 : norm <= 7 ? 5 : 10) * mag;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    out.push(Number(v.toFixed(decimals)));
  }
  return out;
}

// Readings and predicted readings (°C, %RH, ppm, %) show ONE decimal, the same as the
// Environment page: the DHT22 resolves 0.1 °C / 0.1 %RH, so a second decimal on a forecast
// claims precision the sensor never had. The backend still computes at full precision.
// Rates (trendPerHour) and statistics (R², MAE) keep their 2 decimals — a +0.04 °C/h trend
// would otherwise round to a flat 0.0.
const fmtReading = (v: number | null | undefined): string =>
  v == null || !Number.isFinite(v) ? "—" : v.toFixed(1);
// A change between two readings, signed; anything that rounds to zero prints as 0.0.
const fmtDelta = (d: number): string => {
  const r = Math.round(d * 10) / 10;
  return r === 0 ? "0.0" : `${r > 0 ? "+" : ""}${r.toFixed(1)}`;
};

const fmtEta = (etaDays: number): string =>
  etaDays < 1 ? "< 1 day" : `${etaDays} day${etaDays >= 2 ? "s" : ""}`;

// ETA color: < 7 days = red (act now), < 30 = orange, else green.
const etaColor = (etaDays: number | null): string => {
  if (etaDays == null) return gf.textDim as string;
  if (etaDays < 7) return RED;
  if (etaDays < 30) return ORANGE;
  return GREEN;
};

const DISK_STATUS_LABEL: Record<DiskForecast["status"], string> = {
  filling: "Filling",
  stable: "Stable",
  falling: "Falling",
  full: "Full",
  insufficient_data: "Need more data",
};
const UPS_STATUS_LABEL: Record<UpsBatteryForecast["status"], string> = {
  declining: "Declining", stable: "Stable", reached: "Critical now", insufficient_data: "Need more data",
};
const LINK_STATUS_LABEL: Record<LinkForecast["status"], string> = {
  rising: "Rising", stable: "Stable", reached: "Saturated", insufficient_data: "Need more data",
};

// ─── View state that survives navigation ──────────────────────────────────────
// The router unmounts this page when you leave, so without this the tab, metric,
// device and lookbacks reset on every visit. Stored in localStorage (like the sidebar
// and theme). `isValid` checks restored values so a stale key does not give an empty
// page or a 400.
const VIEW_KEY = "cspc_analytics_view";

// Thin wrapper around hooks/usePersistedState that keeps the existing short keys, so
// saved preferences keep working.
const usePersistedState = <T,>(
  key: string,
  initial: T,
  isValid?: (v: unknown) => boolean,
): [T, React.Dispatch<React.SetStateAction<T>>] =>
  useSharedPersistedState<T>(`${VIEW_KEY}.${key}`, initial, isValid);


const isTabKey = (v: unknown): boolean => TABS.some((t) => t.key === v);
const isMetricKey = (v: unknown): boolean => METRIC_OPTIONS.some((m) => m.key === v);
const isOneOf = (opts: readonly LookbackOption[]) => (v: unknown): boolean =>
  typeof v === "number" && opts.some((o) => o.value === v);

// ─── One row of any capacity forecast ─────────────────────────────────────────
// Disk, UPS battery and link saturation all ask "how long until this crosses a line?",
// so they share one table; only units, bound and direction differ.
interface ForecastRow {
  key: string;
  name: string;
  typeLabel: string | null;
  sub: string | null;          // secondary identity (hostname / interface / mount)
  currentText: string;
  barPct: number | null;       // 0-100 for the inline bar; null = no bar
  slopePerDay: number | null;
  slopeSuffix: string;
  risingIsBad: boolean;        // disk/link rise into trouble; UPS runtime falls into it
  etaDays: number | null;
  forecasting: boolean;        // true = heading for the bound, so show the ETA
  statusText: string;
  confidence: Confidence;
  fitR2: number | null;
  mae: number | null;
  maeSuffix: string;
  advice: Advice | null;
  volumes: VolumeForecast[];
  historyDays: number;      // actual span of data behind this row
  // Set only where rows should collapse under a parent device (link saturation).
  // null = render flat.
  groupKey: string | null;
  groupLabel: string | null;
  groupTypeLabel: string | null;
}

export default function Analytics() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  // One window per forecast, defaulted to that phenomenon's own timescale.
  const [diskDays, setDiskDays] = usePersistedState<number>("diskDays", 30, isOneOf(DISK_LOOKBACKS));
  const [linkDays, setLinkDays] = usePersistedState<number>("linkDays", 90, isOneOf(LINK_LOOKBACKS));
  const [upsDays, setUpsDays] = usePersistedState<number>("upsDays", 180, isOneOf(UPS_LOOKBACKS));
  const [anomDays, setAnomDays] = usePersistedState<number>("anomDays", 14, isOneOf(ANOMALY_LOOKBACKS));
  const [alertDays, setAlertDays] = usePersistedState<number>("alertDays", 30, isOneOf(ALERT_LOOKBACKS));
  const [tab, setTab] = usePersistedState<TabKey>("tab", "forecasts", isTabKey);
  const [forecasts, setForecasts] = useState<DiskForecast[]>([]);
  const [upsForecasts, setUpsForecasts] = useState<UpsBatteryForecast[]>([]);
  const [linkForecasts, setLinkForecasts] = useState<LinkForecast[]>([]);
  // The registered routers, fetched directly rather than inferred from the link
  // forecast. See the `routers` memo below for why that inference was wrong.
  const [netDevices, setNetDevices] = useState<{ id: number; name: string; typeLabel: string | null }[]>([]);
  const [summary, setSummary] = useState<AlertSummary | null>(null);
  const [diskLoading, setDiskLoading] = useState(true);
  const [upsLoading, setUpsLoading] = useState(true);
  const [linkLoading, setLinkLoading] = useState(true);
  const [error, setError] = useState("");

  // Phase 2/3 — metric focus (one selector drives both Trend and Anomaly panels).
  const [selMetric, setSelMetric] = usePersistedState<string>("metric", "temperature", isMetricKey);
  // The device is stored as a raw id and checked against the loaded options, so a
  // removed server does not leave the panels empty.
  const [selDevice, setSelDevice] = usePersistedState<number | null>("deviceId", null);
  const [trend, setTrend] = useState<MetricTrend | null>(null);
  const [anom, setAnom] = useState<AnomalyResult | null>(null);
  const [trendLoading, setTrendLoading] = useState(false);
  const [anomLoading, setAnomLoading] = useState(false);

  // Phase 4 — threshold recommendations.
  const [recs, setRecs] = useState<Recommendation[]>([]);
  const [recsLoading, setRecsLoading] = useState(true);
  const [accuracy, setAccuracy] = useState<AccuracyResult | null>(null);
  // null = fleet-wide (the global rule's scope); an id narrows to that server.
  const [recDevice, setRecDevice] = useState<number | null>(null);
  const [applying, setApplying] = useState<string | null>(null);

  // Refresh just the alert summary (no full-panel spinner) so the live socket-driven
  // updates change the numbers in place rather than flashing "Loading…".
  const loadSummary = useCallback(async () => {
    const s = await api.getAlertSummary(alertDays);
    if (s.success) setSummary(s.data?.summary ?? null);
  }, [alertDays]);

  // The three forecasts load separately, each with its own lookback, so changing one
  // does not blank all three panels and jump the scroll to the top.
  const loadDisk = useCallback(async (silent = false) => {
    if (!silent) setDiskLoading(true);
    const f = await api.getDiskForecast(diskDays);
    if (f.success) { setForecasts(f.data?.forecasts ?? []); setError(""); }
    else if (!silent) setError(f.error || "Failed to load forecasts.");
    if (!silent) setDiskLoading(false);
  }, [diskDays]);

  const loadUps = useCallback(async (silent = false) => {
    if (!silent) setUpsLoading(true);
    const ups = await api.getUpsBatteryForecast(upsDays);
    if (ups.success) setUpsForecasts(ups.data?.forecasts ?? []);
    if (!silent) setUpsLoading(false);
  }, [upsDays]);

  const loadLink = useCallback(async (silent = false) => {
    if (!silent) setLinkLoading(true);
    const link = await api.getLinkSaturationForecast(linkDays);
    if (link.success) setLinkForecasts(link.data?.forecasts ?? []);
    if (!silent) setLinkLoading(false);
  }, [linkDays]);

  // The router list for the Trends/Anomalies device picker. Fetched from the device
  // endpoints, NOT derived from a forecast — see the `routers` memo.
  const loadRouters = useCallback(async () => {
    const [net, mt] = await Promise.all([api.getNetworkDevices(), api.getMikrotikDevices()]);
    const rows = [
      ...(net.success ? net.data?.devices ?? [] : []),
      ...(mt.success ? mt.data?.devices ?? [] : []),
    ];
    const byId = new Map<number, { id: number; name: string; typeLabel: string | null }>();
    for (const d of rows) {
      const id = Number(d.id);
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          name: d.name ?? `#${id}`,
          typeLabel: d.type === "mikrotik" ? "MikroTik" : "Router",
        });
      }
    }
    setNetDevices([...byId.values()]);
  }, []);

  // Forecasts load on mount and when their lookback changes (they also feed the Trends
  // device list). Other tabs load when first opened. Accuracy is computed from existing
  // history, so it loads with the forecasts.
  const loadAccuracy = useCallback(async () => {
    const a = await api.getForecastAccuracy("disk", { days: diskDays, horizon: 7 });
    if (a.success) setAccuracy(a.data?.accuracy ?? null);
  }, [diskDays]);

  useEffect(() => { loadDisk(); }, [loadDisk]);
  useEffect(() => { loadAccuracy(); }, [loadAccuracy]);
  useEffect(() => { loadUps(); }, [loadUps]);
  useEffect(() => { loadLink(); }, [loadLink]);
  // Independent of the forecasts: the device picker must list every registered router,
  // including the ping-only ones that produce no forecast of any kind.
  useEffect(() => { loadRouters(); }, [loadRouters]);
  useEffect(() => { if (tab === "alerts") loadSummary(); }, [tab, loadSummary]);

  // Refresh the alert summary when an alert is raised (`notification`) or changes
  // (`alertUpdated`), so "Open now" stays current.
  useEffect(() => {
    const onAlertChange = () => { loadSummary(); };
    socket.on("notification", onAlertChange);
    socket.on("alertUpdated", onAlertChange);
    return () => {
      socket.off("notification", onAlertChange);
      socket.off("alertUpdated", onAlertChange);
    };
  }, [loadSummary]);

  // Device lists for the Trends tab: servers from the disk forecast, routers from the
  // link forecast; both already carry the display name and type.
  const servers = useMemo(
    () => forecasts.map((f) => ({ id: f.deviceId, name: f.name, typeLabel: f.typeLabel })),
    [forecasts],
  );
  // Routers come from the device endpoints, not only the link forecast: a ping-only
  // router has no interfaces, so it would never appear, and latency/loss are its only
  // metrics. The link forecast is still merged in so devices removed from the dashboard
  // but with history remain selectable.
  const routers = useMemo(() => {
    const seen = new Map<number, { id: number; name: string; typeLabel: string | null }>();
    for (const d of netDevices) seen.set(d.id, d);
    for (const l of linkForecasts) {
      if (!seen.has(l.deviceId)) seen.set(l.deviceId, { id: l.deviceId, name: l.name, typeLabel: l.typeLabel });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [netDevices, linkForecasts]);

  const needsDevice = SERVER_METRICS.has(selMetric) || ROUTER_METRICS.has(selMetric);
  const deviceOptions = ROUTER_METRICS.has(selMetric) ? routers : servers;
  // Grouped by device class, so two similarly-named devices stay distinguishable and the
  // list reads as "these are the servers, these are the routers".
  const deviceSelectOptions: SelectOption[] = useMemo(
    () => deviceOptions.map((s) => ({
      value: String(s.id),
      label: s.name,
      group: s.typeLabel,
    })),
    [deviceOptions],
  );

  const selDeviceName = useMemo(
    () => deviceOptions.find((s) => s.id === selDevice)?.name ?? null,
    [deviceOptions, selDevice],
  );

  // A device-level metric needs a device. Also fixes a restored id that no longer exists
  // or is the wrong type (e.g. a server id with a router metric) by picking the first
  // available one.
  useEffect(() => {
    if (!needsDevice) return;
    const first = deviceOptions[0];
    if (!first) return; // options not loaded yet — keep what we have
    const stillValid = selDevice != null && deviceOptions.some((o) => o.id === selDevice);
    if (!stillValid) setSelDevice(first.id);
  }, [needsDevice, selDevice, deviceOptions]);

  // Trend and anomalies load separately, so changing the anomaly window does not reload
  // the trend chart and jump the page to the top.
  const focusDevice = needsDevice ? selDevice : null;
  const focusReady = !needsDevice || selDevice != null;

  const loadTrend = useCallback(async (silent = false) => {
    if (!focusReady) { setTrend(null); return; }
    if (!silent) setTrendLoading(true);
    const t = await api.getMetricTrend(selMetric, {
      deviceId: focusDevice, hours: TREND_LOOKBACK_HOURS, horizon: TREND_HORIZON_HOURS,
    });
    setTrend(t.success ? (t.data?.trend ?? null) : null);
    if (!silent) setTrendLoading(false);
  }, [selMetric, focusDevice, focusReady]);

  const loadAnom = useCallback(async (silent = false) => {
    if (!focusReady) { setAnom(null); return; }
    if (!silent) setAnomLoading(true);
    const a = await api.getAnomalies(selMetric, { deviceId: focusDevice, days: anomDays });
    setAnom(a.success ? (a.data?.result ?? null) : null);
    if (!silent) setAnomLoading(false);
  }, [selMetric, focusDevice, focusReady, anomDays]);

  useEffect(() => { if (tab === "trends") loadTrend(); }, [tab, loadTrend]);
  useEffect(() => { if (tab === "trends") loadAnom(); }, [tab, loadAnom]);

  const loadRecs = useCallback(async (silent = false) => {
    if (!silent) setRecsLoading(true);
    const r = await api.getRecommendations(REC_WINDOW_DAYS, recDevice);
    if (r.success) setRecs(r.data?.recommendations ?? []);
    if (!silent) setRecsLoading(false);
  }, [recDevice]);

  useEffect(() => { if (tab === "recs") loadRecs(); }, [tab, loadRecs]);

  // ── Live data: keep the active tab current ──
  // serverMetrics (agents), networkMetrics/upsMetrics (pollers) and sensorData (ESP32)
  // trigger a quiet reload of the active tab, at most once per LIVE_REFRESH_MS. Alert
  // analytics uses the alert-socket effect above.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const trigger = () => {
      if (timer) return;                         // a refresh is already queued in this window
      timer = setTimeout(() => {
        timer = null;
        if (tab === "forecasts") { loadDisk(true); loadUps(true); loadLink(true); }
        else if (tab === "trends") { loadTrend(true); loadAnom(true); }
        else if (tab === "recs") loadRecs(true);
      }, LIVE_REFRESH_MS);
    };
    const events = ["serverMetrics", "sensorData", "networkMetrics", "upsMetrics"];
    for (const e of events) socket.on(e, trigger);
    return () => {
      for (const e of events) socket.off(e, trigger);
      if (timer) clearTimeout(timer);
    };
  }, [tab, loadDisk, loadUps, loadLink, loadTrend, loadAnom, loadRecs]);

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

  // ── Adapt each forecast type into the shared row shape ──
  const diskRows: ForecastRow[] = useMemo(
    () => forecasts.map((f) => ({
      key: `disk-${f.deviceId}`,
      name: f.name,
      typeLabel: f.typeLabel,
      // A renamed server shows its real hostname underneath, so the machine stays
      // identifiable; the mount matters only when there's more than one volume.
      sub: f.volumes.length > 1 && f.mount
        ? f.mount
        : (f.hostname && f.hostname !== f.name ? f.hostname : null),
      currentText: f.currentPercent == null ? "—" : `${f.currentPercent}%`,
      barPct: f.currentPercent,
      slopePerDay: f.slopePerDay,
      slopeSuffix: "%",
      risingIsBad: true,
      etaDays: f.etaDays,
      forecasting: f.status === "filling",
      statusText: DISK_STATUS_LABEL[f.status],
      confidence: f.confidence,
      fitR2: f.fitR2,
      mae: f.mae,
      maeSuffix: "%",
      advice: f.advice,
      volumes: f.volumes,
      historyDays: f.historyDays,
      groupKey: null, groupLabel: null, groupTypeLabel: null,
    })),
    [forecasts],
  );

  const upsRows: ForecastRow[] = useMemo(
    () => upsForecasts.map((u) => ({
      key: `ups-${u.deviceId}`,
      name: u.name,
      typeLabel: u.typeLabel,
      // Lead the sub-line with the hardware's own verdict when it is anything but
      // normal — that is a measurement from the device, not an inference from a trend.
      sub: u.batteryStatusWorst && u.batteryStatusWorst !== "normal" && u.batteryStatusWorst !== "unknown"
        ? `UPS reports battery: ${u.batteryStatusWorst.toUpperCase()}`
        : u.location,
      currentText: u.currentRuntimeMin == null ? "—" : `${u.currentRuntimeMin} min`,
      barPct: null, // runtime has no natural 0-100 scale
      slopePerDay: u.slopePerDay,
      slopeSuffix: " min",
      risingIsBad: false, // a UPS in trouble is one whose runtime is FALLING
      etaDays: u.etaDays,
      forecasting: u.status === "declining",
      statusText: UPS_STATUS_LABEL[u.status],
      confidence: u.confidence,
      fitR2: u.fitR2,
      mae: u.mae,
      maeSuffix: "",
      advice: u.advice,
      volumes: [],
      historyDays: u.historyDays,
      groupKey: null, groupLabel: null, groupTypeLabel: null,
    })),
    [upsForecasts],
  );

  const linkRows: ForecastRow[] = useMemo(
    () => linkForecasts.map((l) => ({
      key: `link-${l.deviceId}-${l.interface}`,
      // On the MikroTik each port is a building, so show the label first and the port name
      // below. Device name and type are on the group header.
      name: l.interfaceLabel ?? l.interface,
      typeLabel: null,
      sub: l.interfaceLabel ? l.interface : null,
      currentText: l.currentUtil == null ? "—" : `${l.currentUtil}%`,
      barPct: l.currentUtil,
      slopePerDay: l.slopePerDay,
      slopeSuffix: "%",
      risingIsBad: true,
      etaDays: l.etaDays,
      forecasting: l.status === "rising",
      statusText: LINK_STATUS_LABEL[l.status],
      confidence: l.confidence,
      fitR2: l.fitR2,
      mae: l.mae,
      maeSuffix: "%",
      advice: l.advice,
      volumes: [],
      historyDays: l.historyDays,
      groupKey: String(l.deviceId),
      groupLabel: l.name,
      groupTypeLabel: l.typeLabel,
    })),
    [linkForecasts],
  );

  // Everything the operator should act on, gathered above the tables so the page leads
  // with "what's wrong" instead of making them scan three tables for coloured rows.
  const allAdvice = useMemo(
    () => [...diskRows, ...upsRows, ...linkRows]
      .filter((r) => r.advice)
      .map((r) => ({ key: r.key, advice: r.advice as Advice }))
      .sort((a, b) => (a.advice.level === b.advice.level ? 0 : a.advice.level === "critical" ? -1 : 1)),
    [diskRows, upsRows, linkRows],
  );

  return (
    <div className="p-4 sm:p-6 space-y-6" style={{ fontFamily: mono, color: gf.textPrimary, fontSize: ROOT_FONT }}>
      {/* ── Header / controls ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[1.6em] font-bold">Predictive Analytics</h1>
          <p className="text-[1em]" style={{ color: gf.textMuted }}>
            Validated linear regression over historical metrics, plus alert statistics.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Lookback now lives per panel — each forecast has its own natural timescale. */}
          <span
            className="flex items-center gap-1.5 px-2 py-1 text-[0.9em] uppercase tracking-widest rounded-[2px]"
            style={{ color: GREEN, background: gf.panel, border: `1px solid ${gf.border}` }}
            title="Auto-updates as new metrics stream in — no refresh needed"
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: GREEN, boxShadow: `0 0 0 3px ${GREEN}33` }} />
            Live
          </span>
        </div>
      </div>

      {/* ── Tabs (each loads its own data; see the load effects above) ──
         Scrolls sideways on a phone instead of wrapping, so no tab ends up alone below the
         underline. */}
      <div
        className="flex items-center gap-1 overflow-x-auto"
        style={{
          borderBottom: `1px solid ${gf.divider}`,
          // Keep the strip one line; let it scroll instead of reflowing.
          flexWrap: "nowrap",
          // The bar is ~40px tall — a scrollbar inside it would eat a quarter of that and
          // sit across the active tab's underline. Touch devices show an overlay one anyway.
          scrollbarWidth: "none",
          // Snap so a swipe lands on a tab edge rather than mid-label.
          scrollSnapType: "x proximity",
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="px-3 py-2 text-[1em] transition-colors whitespace-nowrap shrink-0"
            style={{
              marginBottom: -1,
              color: tab === t.key ? gf.textPrimary : gf.textMuted,
              borderBottom: `2px solid ${tab === t.key ? gf.accent : "transparent"}`,
              fontWeight: tab === t.key ? 600 : 400,
              scrollSnapAlign: "start",
            }}
          >
            <span className="sm:hidden">{t.short}</span>
            <span className="hidden sm:inline">{t.label}</span>
          </button>
        ))}
      </div>

      {error && (
        <div className="px-3 py-2 text-[1em] rounded-[2px]" style={{ color: RED, background: `${RED}14`, border: `1px solid ${RED}40` }}>
          {error}
        </div>
      )}

      {tab === "forecasts" && (
        <>
          {/* Action summary — the whole point of the page, so it goes first. */}
          {allAdvice.length > 0 && (
            <Panel title="Action Needed" subtitle="Most urgent first">
              <div className="space-y-1.5">
                {allAdvice.map((a) => (
                  <AdviceCallout key={a.key} level={a.advice.level}>{a.advice.message}</AdviceCallout>
                ))}
              </div>
            </Panel>
          )}

          <ForecastPanel
            title="Disk-Full Forecast"
            subtitle={`Time to ${forecasts[0]?.full ?? 100}% · ${diskDays}-day trend · fastest-filling volume`}
            entityHeader="Server"
            etaHeader="ETA to full"
            byHeader="Full by"
            rows={diskRows}
            loading={diskLoading}
            lookback={{ value: diskDays, options: DISK_LOOKBACKS, onChange: setDiskDays }}
            empty="No server disk history yet. Forecasts appear once agents have reported for a while."
            note="An ETA appears only for a rising trend. Disks fill over weeks, so a short window is easily skewed by one large copy or a log rotation."
          />

          {/* Accuracy sits directly under the disk forecast it grades, so the claim and
              its evidence are read together rather than on separate screens. */}
          {accuracy && accuracy.status === "ok" && (
            <Panel
              title="Forecast Accuracy"
              subtitle={`How wrong the disk forecast above has been · ${accuracy.horizonDays}-day-ahead predictions · ${accuracy.totalFolds} checked`}
            >
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
                <Stat
                  label={`Typical miss (${accuracy.unit})`}
                  value={accuracy.overallMae == null ? "—" : `±${accuracy.overallMae}${accuracy.unit}`}
                  color={GREEN}
                />
                <Stat label="Predictions checked" value={String(accuracy.totalFolds)} />
                <Stat label="Horizon" value={`${accuracy.horizonDays}d ahead`} />
              </div>
              {/* Mobile: cards, as in the forecast panels. */}
              <div className="md:hidden flex flex-col gap-2">
                {accuracy.devices.filter((d) => d.folds > 0).map((d) => (
                  <div key={`${d.deviceId}-${d.name}`} className="rounded-[2px] p-2.5" style={{ background: gf.bg, border: `1px solid ${gf.border}` }}>
                    <DeviceLabel name={d.name} typeLabel={d.typeLabel} sub={d.mount} />
                    <div className="grid grid-cols-2 gap-x-3 gap-y-2 mt-2.5">
                      <CardField label="Typical miss">
                        <span style={{ color: gf.textPrimary }}>±{d.mae}{accuracy.unit}</span>
                      </CardField>
                      <CardField label="Bias">
                        <span style={{ color: (d.bias ?? 0) > 0 ? ORANGE : (d.bias ?? 0) < 0 ? gf.accent : gf.textMuted }}>
                          {(d.bias ?? 0) > 0 ? "over" : (d.bias ?? 0) < 0 ? "under" : "even"} {Math.abs(d.bias ?? 0)}{accuracy.unit}
                        </span>
                      </CardField>
                      <CardField label="Worst miss">
                        <span style={{ color: gf.textMuted }}>±{d.worst}{accuracy.unit}</span>
                      </CardField>
                      <CardField label="Checked">
                        <span style={{ color: gf.textDim }}>{d.folds}</span>
                      </CardField>
                    </div>
                  </div>
                ))}
              </div>
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-[1em]" style={{ borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ color: gf.textDim, textAlign: "left" }}>
                      <Th>Server</Th>
                      <Th title="Average size of the miss, ignoring direction">Typical miss</Th>
                      <Th title="Signed average: positive means we predicted MORE usage than actually happened">Bias</Th>
                      <Th>Worst miss</Th>
                      <Th title="How many past predictions could be checked against real data">Checked</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {accuracy.devices.filter((d) => d.folds > 0).map((d) => (
                      <tr key={`${d.deviceId}-${d.name}`} style={{ borderTop: `1px solid ${gf.divider}` }}>
                        {/* Naming the volume is what lets you see this row grades the
                            SAME series the forecast above headlines. */}
                        <Td><DeviceLabel name={d.name} typeLabel={d.typeLabel} sub={d.mount} /></Td>
                        <Td><span style={{ color: gf.textPrimary }}>±{d.mae}{accuracy.unit}</span></Td>
                        <Td>
                          {/* Direction matters more than size here: consistently
                              over-predicting is the safe failure, under-predicting is not. */}
                          <span style={{ color: (d.bias ?? 0) > 0 ? ORANGE : (d.bias ?? 0) < 0 ? gf.accent : gf.textMuted }}>
                            {(d.bias ?? 0) > 0 ? "over" : (d.bias ?? 0) < 0 ? "under" : "even"} {Math.abs(d.bias ?? 0)}{accuracy.unit}
                          </span>
                        </Td>
                        <Td><span style={{ color: gf.textMuted }}>±{d.worst}{accuracy.unit}</span></Td>
                        <Td><span style={{ color: gf.textDim }}>{d.folds}</span></Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          <ForecastPanel
            title="UPS Battery Forecast"
            subtitle={`Time to the ${upsForecasts[0]?.floorMinutes ?? 5}-min floor · ${upsDays}-day runtime trend`}
            entityHeader="UPS"
            etaHeader="ETA to critical"
            byHeader="Replace by"
            rows={upsRows}
            loading={upsLoading}
            lookback={{ value: upsDays, options: UPS_LOOKBACKS, onChange: setUpsDays }}
            empty="No UPS history yet. Runtime history builds up once the SNMP poller has been running against a UPS."
            note="Batteries age over years and runtime also moves with load, so below ~90 days of history expect Stable — that is the honest answer, not a fault."
          />

          <ForecastPanel
            title="Link Saturation Forecast"
            subtitle={`Time to ${linkForecasts[0]?.ceiling ?? 90}% · ${linkDays}-day trend · grouped by device`}
            entityHeader="Interface"
            etaHeader={`ETA to ${linkForecasts[0]?.ceiling ?? 90}%`}
            byHeader="Saturates by"
            rows={linkRows}
            loading={linkLoading}
            lookback={{ value: linkDays, options: LINK_LOOKBACKS, onChange: setLinkDays }}
            empty="No interface history yet. Each router/MikroTik port appears once the poller has collected traffic counters."
            note="On the campus MikroTik each interface is a building. Traffic follows the academic calendar, so a window on semester start projects a ramp that later plateaus — capacity planning, not promises."
          />
        </>
      )}

      {/* ── Alert analytics ── */}
      {tab === "alerts" && (
        <Panel
          title="Alert Analytics"
          subtitle={summary ? `Last ${summary.days} days` : `Last ${alertDays} days`}
          action={<LookbackPicker value={alertDays} options={ALERT_LOOKBACKS} onChange={setAlertDays} />}
        >
          {!summary ? (
            <Empty>Loading…</Empty>
          ) : summary.total === 0 ? (
            <Empty>No alerts recorded in this window.</Empty>
          ) : (
            <div className="space-y-5">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <Stat label="Total alerts" value={String(summary.total)} />
                <Stat label="Open now" value={String(summary.open)} color={summary.open > 0 ? ORANGE : GREEN} />
                <Stat
                  label="Avg resolve time"
                  value={summary.mttrMinutes == null ? "—" : fmtDuration(summary.mttrMinutes)}
                />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
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

                <div>
                  <SectionLabel>Noisiest sources</SectionLabel>
                  <div className="space-y-2.5">
                    {summary.topDevices.length === 0 ? <Dim>—</Dim> :
                      summary.topDevices.map((d) => (
                        <BarRow
                          key={`${d.deviceId}-${d.name}`}
                          label={d.name}
                          typeLabel={d.typeLabel}
                          count={d.count}
                          max={Math.max(...summary.topDevices.map((x) => x.count))}
                          color={gf.accent}
                          stacked
                        />
                      ))}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                <div>
                  <SectionLabel>By type</SectionLabel>
                  <div className="flex flex-wrap gap-1.5">
                    {summary.topTypes.map((t) => (
                      <span
                        key={t.type}
                        className="px-2 py-0.5 text-[0.9em] rounded-[2px]"
                        style={{ background: gf.hover, color: gf.textMuted, border: `1px solid ${gf.border}` }}
                      >
                        {t.type} · {t.count}
                      </span>
                    ))}
                  </div>
                </div>

                <div>
                  <SectionLabel>Daily volume</SectionLabel>
                  <DailyBars data={summary.byDay} />
                </div>
              </div>
            </div>
          )}
        </Panel>
      )}

      {tab === "trends" && (
        <>
          {/* ── Metric focus: selector drives Trend + Anomaly panels ── */}
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[0.9em] uppercase tracking-widest" style={{ color: gf.textDim }}>Metric</span>
            {/* Changing the metric keeps the device (CPU → Memory stays on the same server). The
               effect above only switches it when the metric is for the other device type. */}
            <Select
              value={selMetric}
              options={METRIC_SELECT_OPTIONS}
              onChange={setSelMetric}
              title="Metric to trend and baseline"
            />
            {needsDevice && (
              deviceOptions.length === 0 ? (
                <span className="text-[0.9em]" style={{ color: gf.textDim }}>no devices with data yet</span>
              ) : (
                <Select
                  value={selDevice == null ? "" : String(selDevice)}
                  options={deviceSelectOptions}
                  onChange={(v) => setSelDevice(v ? Number(v) : null)}
                  title="Device this metric is read from"
                />
              )
            )}
            {!needsDevice && (
              <span className="text-[0.9em]" style={{ color: gf.textDim }}>room-wide — no device to pick</span>
            )}
          </div>

          {/* ── Trend & short-term projection ── */}
          <Panel
            title="Trend & Short-Term Projection"
            // Says window, not history: this is what we ask InfluxDB for. How much history came
            // back is shown in the chart footer.
            subtitle={
              trend?.status === "insufficient_history"
                ? `${trend.lookbackHours}h window · projection withheld`
                : `${trend?.seasonal ? "Holt + daily cycle" : "Holt's linear"} · ${trend?.lookbackHours ?? TREND_LOOKBACK_HOURS}h window → ${trend?.horizonHours ?? TREND_HORIZON_HOURS}h projection`
            }
          >
            {trendLoading && !trend ? (
              <Empty>Loading trend…</Empty>
            ) : trend?.status === "insufficient_history" ? (
              // The data cannot support a projection, so none is drawn and the panel says which
              // check failed. The history is still drawn, which shows where the gaps are.
              <div className="space-y-3">
                <DataQualityNotice quality={trend.dataQuality} />
                {trend.series.length >= 2 && (
                  <TrendChart series={trend.series} projection={[]} unit={trend.unit} />
                )}
              </div>
            ) : !trend || trend.status !== "ok" ? (
              <Empty>Not enough history for this metric yet.</Empty>
            ) : (
              <div className="space-y-3" style={{ opacity: trendLoading ? 0.5 : 1, transition: "opacity 120ms" }}>
                <div className="flex flex-wrap items-center gap-4 text-[1em]">
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
                <HourlyForecast
                  projection={trend.projection}
                  current={trend.series.at(-1)?.value ?? null}
                  unit={trend.unit}
                  advice={trend.advice}
                />
                {trend.advice && (
                  <AdviceCallout level={trend.advice.level}>
                    {adviceSentence(trend, needsDevice ? selDeviceName : null)}
                  </AdviceCallout>
                )}
              </div>
            )}
          </Panel>

          {/* ── Anomaly detection ── */}
          <Panel
            title="Anomaly Detection"
            subtitle={anom ? `Baseline per hour × weekday/weekend · |z| > ${anom.z} over ${anom.days} days` : "Hour × day-type z-score + IQR"}
            action={<LookbackPicker value={anomDays} options={ANOMALY_LOOKBACKS} onChange={setAnomDays} />}
          >
            {anomLoading && !anom ? (
              <Empty>Scanning…</Empty>
            ) : !anom || anom.status !== "ok" ? (
              <Empty>Not enough history to baseline this metric yet.</Empty>
            ) : (
              <div className="space-y-4" style={{ opacity: anomLoading ? 0.5 : 1, transition: "opacity 120ms" }}>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <Stat label="Anomalies" value={String(anom.anomalyCount)} color={anom.anomalyCount > 0 ? ORANGE : GREEN} />
                  <Stat label="Points scanned" value={String(anom.totalPoints)} />
                  <Stat
                    label="Normal range (IQR)"
                    value={anom.iqr ? `${fmtReading(anom.iqr.lowerFence)}–${fmtReading(anom.iqr.upperFence)}${anom.unit}` : "—"}
                  />
                </div>
                {anom.anomalies.length === 0 ? (
                  <Empty>No anomalies — every reading is normal for its hour of day.</Empty>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[1em]" style={{ borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ color: gf.textDim, textAlign: "left" }}>
                          <Th>When</Th><Th>Reading</Th><Th title="Normal for that hour on that kind of day — a campus weekend is nothing like a weekday">Expected (same hour &amp; day type)</Th><Th>z-score</Th><Th>Flags</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {anom.anomalies.slice(0, 12).map((a, i) => (
                          <tr key={i} style={{ borderTop: `1px solid ${gf.divider}` }}>
                            <Td><span style={{ color: gf.textMuted }}>{fmtTime(a.t)}</span></Td>
                            <Td>
                              <span style={{ color: a.direction === "high" ? RED : gf.accent, fontWeight: 600 }}>
                                {a.direction === "high" ? "▲" : "▼"} {fmtReading(a.value)}{anom.unit}
                              </span>
                            </Td>
                            <Td>
                              <span style={{ color: gf.textMuted }}>
                                {fmtReading(a.expected)}{anom.unit}{" "}
                                <span style={{ color: gf.textDim }}>@ {fmtHour(a.hour)} {a.dayType}</span>
                              </span>
                            </Td>
                            <Td><span style={{ color: gf.textPrimary }}>{a.z > 0 ? "+" : ""}{a.z}σ</span></Td>
                            <Td>{a.iqrOutlier && <Badge color={ORANGE} label="IQR" />}</Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {anom.anomalyCount > 12 && (
                      <p className="mt-2 text-[0.9em]" style={{ color: gf.textDim }}>+ {anom.anomalyCount - 12} more</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </Panel>
        </>
      )}

      {/* ── Threshold recommendations ── */}
      {tab === "recs" && (
        <Panel
          title="Threshold Recommendations"
          subtitle={
            recDevice == null
              // Not "All servers": the unscoped view also includes the room metrics (temperature,
              // humidity, gas), which only exist here.
              ? `All servers + server room · pooled over ${REC_WINDOW_DAYS} days · warn = p95, critical = p99`
              : `${
                  [...servers, ...routers].find((s) => s.id === recDevice)?.name ?? "Device"
                } only · last ${REC_WINDOW_DAYS} days`
          }
          action={
            /* Routers are in this picker too: `router_latency` is only recommended per device
               (see analyticsService METRICS). */
            servers.length > 0 || routers.length > 0 ? (
              <Select
                value={recDevice == null ? "" : String(recDevice)}
                options={[
                  { value: "", label: "All servers", group: null },
                  ...servers.map((s) => ({ value: String(s.id), label: s.name, group: "Per server" })),
                  ...routers.map((r) => ({ value: String(r.id), label: r.name, group: "Per router" })),
                ]}
                onChange={(v) => setRecDevice(v ? Number(v) : null)}
                title="Suggest thresholds for one device instead of the whole fleet"
                align="right"
              />
            ) : undefined
          }
        >
          {recDevice != null && (
            <p className="mb-3 text-[0.9em]" style={{ color: gf.textMuted }}>
              {routers.some((r) => r.id === recDevice) ? (
                <>
                  Latency is a property of the individual link — a switch in the rack answers
                  in under 1 ms, an ISP router in 20–40 ms, and both are healthy. This is the
                  p95/p99 of what <em>this</em> link actually does. Applying writes a
                  per-device override, leaving the global rule untouched.
                </>
              ) : (
                <>
                  A busy server and an idle one share a pooled p95 that suits neither. Applying
                  here writes a per-server override, leaving the global rule untouched.
                </>
              )}
            </p>
          )}
          {recsLoading ? (
            <Empty>Computing…</Empty>
          ) : recs.length === 0 ? (
            <Empty>No data to base recommendations on yet.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[1em]" style={{ borderCollapse: "collapse" }}>
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
                          <Td><span style={{ color: gf.textDim }}>need more data</span></Td>
                        ) : (
                          <>
                            <Td><Dim>{fmtReading(r.p50)}{r.unit}</Dim></Td>
                            <Td><Dim>{fmtReading(r.p95)}{r.unit}</Dim></Td>
                            <Td><Dim>{fmtReading(r.p99)}{r.unit}</Dim></Td>
                            <Td><Dim>{fmtReading(r.max)}{r.unit}</Dim></Td>
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
                                {/* Raised only when applying would change something; this writes to live alert rules. */}
                                <button
                                  disabled={!changed || applying === r.metric}
                                  onClick={() => applyRecommendation(r)}
                                  className={`px-3 py-1.5 text-[0.9em] rounded-[3px] transition-all disabled:opacity-50 ${changed ? "gf-btn" : ""}`}
                                  style={{
                                    color: changed ? gf.textPrimary : gf.textDim,
                                    fontWeight: changed ? 700 : 500,
                                    cursor: changed ? "pointer" : "default",
                                    ...(changed ? {} : {
                                      background: gf.bg,
                                      border: `1px solid ${gf.border}`,
                                      boxShadow: "var(--gf-btn-shadow-active)",
                                    }),
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
              <p className="mt-3 text-[0.9em]" style={{ color: gf.textDim }}>
                {isAdmin
                  ? "Apply writes the value into the global Alert Rules (comparison “>”). Per-server overrides stay untouched."
                  : "Recommendations are advisory — an admin can apply them to the Alert Rules."}
              </p>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

// ─── Shared forecast table ────────────────────────────────────────────────────
// Disk, UPS and link forecasts use this one component, so they colour ETAs, word
// statuses and report fit the same way.
function ForecastPanel({
  title, subtitle, entityHeader, etaHeader, byHeader, rows, loading, empty, note, lookback,
}: {
  title: string;
  subtitle: string;
  entityHeader: string;
  etaHeader: string;
  byHeader: string;
  rows: ForecastRow[];
  loading: boolean;
  empty: string;
  note: string;
  lookback: { value: number; options: readonly LookbackOption[]; onChange: (d: number) => void };
}) {
  // Explicit toggles only. With none set, groups with something to act on open by
  // default; a group the user closed stays closed across refreshes.
  // The caveats are one click away rather than printed in full on the page.
  const [showNote, setShowNote] = useState(false);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const toggleGroup = (key: string) =>
    setToggled((t) => ({ ...t, [key]: !(t[key] ?? defaultOpen(key)) }));

  // Rows with a groupKey show as collapsible per-device sections (a router can have a
  // dozen interfaces). Rows without one (disk, UPS) are flat, one per device.
  const groups = useMemo(() => {
    if (!rows.some((r) => r.groupKey)) return null;
    const map = new Map<string, ForecastRow[]>();
    for (const r of rows) {
      const k = r.groupKey ?? "—";
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(r);
    }
    const out = [...map.entries()].map(([key, gRows]) => {
      const first = gRows[0];
      const etas = gRows.map((r) => r.etaDays).filter((e): e is number => e != null);
      return {
        key,
        label: first?.groupLabel ?? key,
        typeLabel: first?.groupTypeLabel ?? null,
        rows: gRows,
        worstEta: etas.length ? Math.min(...etas) : null,
        advice: gRows.filter((r) => r.advice).length,
        critical: gRows.filter((r) => r.advice?.level === "critical").length,
      };
    });
    // Most urgent device first; devices with nothing forecast sink to the bottom.
    out.sort((a, b) => {
      if (a.worstEta == null && b.worstEta == null) return a.label.localeCompare(b.label);
      if (a.worstEta == null) return 1;
      if (b.worstEta == null) return -1;
      return a.worstEta - b.worstEta;
    });
    return out;
  }, [rows]);

  // Open by default when there is something to act on, or when it is the only device —
  // a single collapsed group would just be an extra click to see the whole panel.
  const defaultOpen = (key: string): boolean => {
    const g = groups?.find((x) => x.key === key);
    if (!g) return false;
    return g.advice > 0 || (groups?.length ?? 0) === 1;
  };
  const isGroupOpen = (g: { key: string }): boolean => toggled[g.key] ?? defaultOpen(g.key);

  return (
    <Panel
      title={title}
      subtitle={subtitle}
      action={
        <span className="flex items-center gap-2">
          <InfoToggle open={showNote} onClick={() => setShowNote((v) => !v)} />
          <LookbackPicker {...lookback} />
        </span>
      }
    >
      {showNote && (
        <p
          className="mb-3 px-3 py-2 text-[0.9em] rounded-[2px]"
          style={{ color: gf.textMuted, background: gf.hover, border: `1px solid ${gf.border}` }}
        >
          {note}
        </p>
      )}
      {loading && rows.length === 0 ? (
        <Empty>Loading forecasts…</Empty>
      ) : rows.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <div style={{ opacity: loading ? 0.5 : 1, transition: "opacity 120ms" }}>
        {/* Mobile: one card per row. Eight columns do not fit a phone, and a table you
            have to swipe sideways hides the ETA — the column that matters — off-screen. */}
        <div className="md:hidden flex flex-col gap-2">
          {groups
            ? groups.map((g) => {
                const open = isGroupOpen(g);
                return (
                  <Fragment key={g.key}>
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.key)}
                      className="w-full text-left px-2.5 py-2 rounded-[2px] flex flex-wrap items-center gap-2"
                      style={{ background: gf.hover, border: `1px solid ${gf.border}` }}
                    >
                      <span aria-hidden style={{ color: gf.textMuted, width: "1em" }}>{open ? "▾" : "▸"}</span>
                      <span style={{ color: gf.textPrimary, fontWeight: 600 }}>{g.label}</span>
                      {g.typeLabel && <TypeBadge label={g.typeLabel} />}
                      <span className="text-[0.9em]" style={{ color: gf.textDim }}>
                        {g.rows.length} interface{g.rows.length === 1 ? "" : "s"}
                      </span>
                      {g.worstEta != null ? (
                        <span className="text-[0.9em]" style={{ color: etaColor(g.worstEta), fontWeight: 600 }}>
                          soonest {fmtEta(g.worstEta)}
                        </span>
                      ) : (
                        <span className="text-[0.9em]" style={{ color: gf.textMuted }}>all stable</span>
                      )}
                      {g.advice > 0 && (
                        <Badge color={g.critical > 0 ? RED : ORANGE} label={`${g.advice} to act on`} />
                      )}
                    </button>
                    {open && g.rows.map((r) => renderCard(r))}
                  </Fragment>
                );
              })
            : rows.map((r) => renderCard(r))}
        </div>

        {/* Desktop: the table. */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-[1em]" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ color: gf.textDim, textAlign: "left" }}>
                <Th>{entityHeader}</Th>
                <Th>Current</Th>
                <Th>Trend / day</Th>
                <Th>{etaHeader}</Th>
                <Th>{byHeader}</Th>
                <Th title="How much history this row's forecast actually saw — shorter than the window means the device is newer than it, or InfluxDB retention is">History</Th>
                <Th>Confidence</Th>
                <Th title="Out-of-sample R² (fit quality) · mean absolute error">Fit (R² · MAE)</Th>
              </tr>
            </thead>
            <tbody>
              {groups
                ? groups.map((g) => {
                    const open = isGroupOpen(g);
                    return (
                      <Fragment key={g.key}>
                        {/* The group header is the toggle. It stays a table row so all groups share the same
                           column widths. */}
                        <tr
                          onClick={() => toggleGroup(g.key)}
                          className="cursor-pointer"
                          style={{ borderTop: `1px solid ${gf.divider}`, background: gf.hover }}
                        >
                          <td colSpan={8} className="py-2 pr-4">
                            <div className="flex flex-wrap items-center gap-2">
                              <span aria-hidden style={{ color: gf.textMuted, width: "1em" }}>
                                {open ? "▾" : "▸"}
                              </span>
                              <span style={{ color: gf.textPrimary, fontWeight: 600 }}>{g.label}</span>
                              {g.typeLabel && <TypeBadge label={g.typeLabel} />}
                              <span className="text-[0.9em]" style={{ color: gf.textDim }}>
                                {g.rows.length} interface{g.rows.length === 1 ? "" : "s"}
                              </span>
                              {/* Collapsed rows must not hide a problem, so the worst ETA
                                  and any advisory are summarised on the header itself. */}
                              {g.worstEta != null ? (
                                <span className="text-[0.9em]" style={{ color: etaColor(g.worstEta), fontWeight: 600 }}>
                                  soonest {fmtEta(g.worstEta)}
                                </span>
                              ) : (
                                <span className="text-[0.9em]" style={{ color: gf.textMuted }}>all stable</span>
                              )}
                              {g.advice > 0 && (
                                <Badge color={g.critical > 0 ? RED : ORANGE} label={`${g.advice} to act on`} />
                              )}
                            </div>
                          </td>
                        </tr>
                        {open && g.rows.map((r) => renderRow(r))}
                      </Fragment>
                    );
                  })
                : rows.map((r) => renderRow(r))}
            </tbody>
          </table>
        </div>
        </div>
      )}
    </Panel>
  );

  // The same fields as renderRow, laid out to fit a phone: the device and its
  // confidence on top, then label/value pairs two to a line.
  function renderCard(r: ForecastRow) {
    return (
      <div key={r.key} className="rounded-[2px] p-2.5" style={{ background: gf.bg, border: `1px solid ${gf.border}` }}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <DeviceLabel name={r.name} typeLabel={r.typeLabel} sub={r.sub} />
          </div>
          <Badge color={CONF_COLOR[r.confidence]} label={r.confidence} />
        </div>
        {r.volumes.length > 1 && <VolumeChips volumes={r.volumes} />}
        <div className="grid grid-cols-2 gap-x-3 gap-y-2 mt-2.5">
          <CardField label="Current">
            <div className="flex items-center gap-2">
              <span>{r.currentText}</span>
              {r.barPct != null && (
                <div className="h-1.5 flex-1 max-w-16 rounded-full overflow-hidden" style={{ background: gf.hover }}>
                  <div style={{ width: `${Math.min(100, r.barPct)}%`, height: "100%", background: etaColor(r.etaDays) }} />
                </div>
              )}
            </div>
          </CardField>
          <CardField label="Trend / day">
            <TrendCell value={r.slopePerDay} suffix={r.slopeSuffix} risingIsBad={r.risingIsBad} />
          </CardField>
          <CardField label={etaHeader}>
            {r.forecasting && r.etaDays != null ? (
              <span style={{ color: etaColor(r.etaDays), fontWeight: 600 }}>{fmtEta(r.etaDays)}</span>
            ) : (
              <span style={{ color: gf.textMuted }}>{r.statusText}</span>
            )}
          </CardField>
          <CardField label={byHeader}>
            <span style={{ color: gf.textMuted }}>
              {r.forecasting && r.etaDays != null ? fmtFullBy(r.etaDays) : "—"}
            </span>
          </CardField>
          <CardField label="History">
            <HistoryCell days={r.historyDays} requested={lookback.value} />
          </CardField>
          <CardField label="Fit (R² · MAE)">
            <FitCell r2={r.fitR2} mae={r.mae} maeSuffix={r.maeSuffix} />
          </CardField>
        </div>
      </div>
    );
  }

  function renderRow(r: ForecastRow) {
    return (
                <tr key={r.key} style={{ borderTop: `1px solid ${gf.divider}` }}>
                  <Td>
                    <DeviceLabel name={r.name} typeLabel={r.typeLabel} sub={r.sub} />
                    {r.volumes.length > 1 && <VolumeChips volumes={r.volumes} />}
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <span>{r.currentText}</span>
                      {r.barPct != null && (
                        <div className="h-1.5 w-16 rounded-full overflow-hidden" style={{ background: gf.hover }}>
                          <div style={{ width: `${Math.min(100, r.barPct)}%`, height: "100%", background: etaColor(r.etaDays) }} />
                        </div>
                      )}
                    </div>
                  </Td>
                  <Td><TrendCell value={r.slopePerDay} suffix={r.slopeSuffix} risingIsBad={r.risingIsBad} /></Td>
                  <Td>
                    {r.forecasting && r.etaDays != null ? (
                      <span style={{ color: etaColor(r.etaDays), fontWeight: 600 }}>{fmtEta(r.etaDays)}</span>
                    ) : (
                      <span style={{ color: gf.textMuted }}>{r.statusText}</span>
                    )}
                  </Td>
                  <Td>
                    <span style={{ color: gf.textMuted }}>
                      {r.forecasting && r.etaDays != null ? fmtFullBy(r.etaDays) : "—"}
                    </span>
                  </Td>
                  <Td><HistoryCell days={r.historyDays} requested={lookback.value} /></Td>
                  <Td><Badge color={CONF_COLOR[r.confidence]} label={r.confidence} /></Td>
                  <Td><FitCell r2={r.fitR2} mae={r.mae} maeSuffix={r.maeSuffix} /></Td>
                </tr>
    );
  }
}

// Name + class badge + optional secondary line. The badge is what disambiguates a
// server from a router from a UPS once all three forecast on the same page.
function DeviceLabel({ name, typeLabel, sub }: { name: string; typeLabel: string | null; sub: string | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5">
        <span style={{ color: gf.textPrimary }}>{name}</span>
        {typeLabel && <TypeBadge label={typeLabel} />}
      </span>
      {sub && <span className="text-[0.9em]" style={{ color: gf.textDim }}>{sub}</span>}
    </div>
  );
}

// Depth has a meaning:
//   recessed (inset shadow)   = somewhere you enter a value (selects, lookback track)
//   raised (drop shadow)      = something that acts or is selected (chosen lookback,
//                               an active Apply button)
// A native <select> loses its arrow with appearance:none, so a chevron is drawn.
// Shows a panel's caveats on demand.
function InfoToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-label="About this forecast"
      title="About this forecast"
      className="w-6 h-6 rounded-full text-[0.9em] leading-none cursor-pointer transition-all"
      style={{
        color: open ? gf.textPrimary : gf.textMuted,
        background: open ? gf.hoverStrong : "transparent",
        border: `1px solid ${open ? gf.border : "transparent"}`,
        fontWeight: 700,
      }}
    >
      i
    </button>
  );
}

interface SelectOption { value: string; label: string; group: string | null }

// A custom listbox instead of a native <select>, whose dropdown is drawn by the OS and
// cannot be styled. It handles click-outside and Escape to close, Up/Down, Enter/Space,
// Home/End, listbox ARIA, and scrolls the active option into view.
function Select({ value, options, onChange, title, align = "left" }: {
  value: string;
  options: readonly SelectOption[];
  onChange: (v: string) => void;
  title?: string;
  // Which edge the dropdown is aligned to. The menu is wider than its trigger, so one in
  // a right-aligned header is aligned right to stay on screen.
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const selectedIdx = options.findIndex((o) => o.value === value);
  const current = selectedIdx >= 0 ? options[selectedIdx] : undefined;

  // Open at the current selection rather than the top of the list.
  useEffect(() => {
    if (open) setActiveIdx(selectedIdx >= 0 ? selectedIdx : 0);
  }, [open, selectedIdx]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the keyboard-highlighted row visible in a scrolling list.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, activeIdx]);

  const commit = (i: number) => {
    const opt = options[i];
    if (opt) onChange(opt.value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") { e.preventDefault(); setOpen(true); }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); return; }
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); commit(activeIdx); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(options.length - 1, i + 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(0, i - 1)); }
    if (e.key === "Home") { e.preventDefault(); setActiveIdx(0); }
    if (e.key === "End") { e.preventDefault(); setActiveIdx(options.length - 1); }
  };

  let lastGroup: string | null = null;

  return (
    <span ref={wrapRef} className="relative inline-flex items-center">
      <button
        type="button"
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        // Recessed when closed, raised when open. Shadows come from the theme's button tokens
        // so they also work in light mode.
        className={`flex items-center gap-2 pl-3 pr-2.5 py-1.5 text-[0.9em] rounded-[3px] outline-none cursor-pointer transition-all ${open ? "gf-btn" : ""}`}
        style={{
          color: gf.textPrimary,
          fontFamily: mono,
          fontWeight: 600,
          ...(open ? {} : {
            background: gf.bg,
            border: `1px solid ${gf.border}`,
            boxShadow: "var(--gf-btn-shadow-active)",
          }),
        }}
      >
        <span>{current?.label ?? "—"}</span>
        <span aria-hidden className="text-[0.75em]" style={{ color: gf.textMuted }}>
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          className={`absolute ${align === "right" ? "right-0" : "left-0"} top-full mt-1.5 z-50 min-w-full max-w-[min(20rem,80vw)] max-h-72 overflow-y-auto rounded-[3px] py-1`}
          style={{
            background: gf.panel,
            // --gf-shadow is the token defined for exactly this (dropdowns/toasts): a
            // light ring on dark so the edge reads, a darker drop shadow on light.
            boxShadow: "var(--gf-shadow)",
          }}
        >
          {options.map((o, i) => {
            const header = o.group && o.group !== lastGroup ? o.group : null;
            lastGroup = o.group;
            const selected = o.value === value;
            const active = i === activeIdx;
            return (
              <div key={o.value}>
                {header && (
                  <div
                    className="px-3 pt-2 pb-1 text-[0.78em] uppercase tracking-widest"
                    style={{ color: gf.textDim }}
                  >
                    {header}
                  </div>
                )}
                <div
                  role="option"
                  aria-selected={selected}
                  data-idx={i}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => commit(i)}
                  className="flex items-center justify-between gap-3 px-3 py-1.5 text-[0.9em] cursor-pointer"
                  style={{
                    background: active ? gf.hoverStrong : "transparent",
                    color: selected ? gf.textPrimary : gf.textMuted,
                    fontWeight: selected ? 700 : 500,
                    // currentColor-style bar: light on dark, dark on light.
                    boxShadow: selected ? `inset 3px 0 0 ${gf.textPrimary}` : "none",
                  }}
                >
                  <span className="truncate">{o.label}</span>
                  {selected && <span aria-hidden style={{ color: gf.textPrimary }}>✓</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}

// A segmented control for mutually exclusive options: a recessed track with the
// selected segment raised, so the active window shows from the shape alone, not just
// the colour.
function LookbackPicker({ value, options, onChange }: {
  value: number; options: readonly LookbackOption[]; onChange: (d: number) => void;
}) {
  return (
    <span className="flex items-center gap-2">
      <span className="text-[0.82em] uppercase tracking-widest" style={{ color: gf.textDim }}>Lookback</span>
      {/* The active segment uses the shared .gf-btn surface (per-theme tokens); a hand-picked
         grey was nearly invisible in dark mode and washed out in light mode. */}
      <span
        className="flex gap-0.5 p-0.5 rounded-[3px]"
        style={{
          background: gf.bg,
          border: `1px solid ${gf.border}`,
          boxShadow: "var(--gf-btn-shadow-active)", // theme-aware inset (recessed track)
        }}
      >
        {options.map((o) => {
          const active = value === o.value;
          return (
            <button
              key={o.value}
              onClick={() => onChange(o.value)}
              aria-pressed={active}
              // No accent colour: this is a view filter, not an action. The active state is shown by
              // surface and weight.
              className={`px-3 py-1 text-[0.9em] rounded-[2px] cursor-pointer transition-all ${active ? "gf-btn" : ""}`}
              style={{
                color: active ? gf.textPrimary : gf.textMuted,
                fontWeight: active ? 700 : 500,
                letterSpacing: active ? "0.02em" : undefined,
                ...(active ? {} : { background: "transparent", border: "1px solid transparent" }),
              }}
            >
              {o.label}
            </button>
          );
        })}
      </span>
    </span>
  );
}

// How much history this forecast actually used. It can be less than requested when the
// device is newer or retention is shorter. Amber when under half the requested window.
function HistoryCell({ days, requested }: { days: number; requested: number }) {
  if (!days) return <span style={{ color: gf.textDim }}>—</span>;
  const short = days < requested * 0.5;
  const text = days >= 1 ? `${Math.round(days)}d` : "< 1d";
  return (
    <span
      style={{ color: short ? ORANGE : gf.textMuted }}
      title={short ? `Only ${text} of the ${requested}-day window has data — the device is newer than the window, or InfluxDB retention is shorter than it` : `${text} of history`}
    >
      {text}
    </span>
  );
}

// R² below zero means "worse than predicting the average", so it is shown as a word
// instead of a huge negative number. MAE is still shown.
function FitCell({ r2, mae, maeSuffix }: { r2: number | null; mae: number | null; maeSuffix: string }) {
  const maeText = mae == null ? "" : `±${mae}${maeSuffix}`;
  if (r2 == null) return <span style={{ color: gf.textDim }}>{maeText || "—"}</span>;
  const poor = r2 < 0;
  return (
    <span style={{ color: gf.textDim }} title={poor ? `R² = ${r2} — the trend line fits worse than a flat average` : undefined}>
      {poor ? "no trend" : `R²=${r2}`}{maeText && ` · ${maeText}`}
    </span>
  );
}

function TypeBadge({ label }: { label: string }) {
  const color = TYPE_COLOR[label] ?? GRAY;
  return (
    <span
      className="px-1 py-px text-[0.82em] uppercase tracking-wider rounded-[2px]"
      style={{ color, background: `${color}1a`, border: `1px solid ${color}44` }}
    >
      {label}
    </span>
  );
}

// Per-volume detail for a multi-volume server: the headline row forecasts the
// fastest-filling mount, but an operator still needs to see the others.
function VolumeChips({ volumes }: { volumes: VolumeForecast[] }) {
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {volumes.map((v) => (
        <span
          key={v.mount}
          className="px-1 py-px text-[0.82em] rounded-[2px]"
          style={{ color: gf.textMuted, background: gf.hover, border: `1px solid ${gf.border}` }}
          title={v.etaDays != null ? `${v.mount} — full in ~${v.etaDays} days` : `${v.mount} — ${v.status}`}
        >
          {v.mount} {v.currentPercent == null ? "—" : `${v.currentPercent}%`}
          {v.etaDays != null && <span style={{ color: etaColor(v.etaDays) }}> · {fmtEta(v.etaDays)}</span>}
        </span>
      ))}
    </div>
  );
}

// Direction arrow + colour. Which direction is BAD depends on the metric: a disk or a
// link rising is trouble, a UPS runtime falling is.
function TrendCell({ value, suffix, risingIsBad }: { value: number | null; suffix: string; risingIsBad: boolean }) {
  if (value == null) return <span style={{ color: gf.textMuted }}>—</span>;
  const bad = risingIsBad ? value > 0 : value < 0;
  const good = risingIsBad ? value < 0 : value > 0;
  const color = bad ? ORANGE : good ? GREEN : gf.textMuted;
  const arrow = value > 0 ? "▲" : value < 0 ? "▼" : "■";
  return <span style={{ color }}>{arrow} {Math.abs(value)}{suffix}</span>;
}

// ─── tiny presentational helpers ──────────────────────────────────────────────
function Panel({ title, subtitle, children, action }: {
  title: string; subtitle?: string; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <section className="rounded-[2px]" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
      <div className="px-4 py-3 flex flex-wrap items-start justify-between gap-2" style={{ borderBottom: `1px solid ${gf.divider}` }}>
        <div className="min-w-0">
          <h2 className="text-[1.18em] font-semibold">{title}</h2>
          {subtitle && <p className="text-[0.9em] mt-0.5" style={{ color: gf.textDim }}>{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

// One label/value pair on a mobile card — the card's stand-in for a table column.
function CardField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[0.82em] uppercase tracking-wider" style={{ color: gf.textDim }}>{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function Th({ children, title }: { children: React.ReactNode; title?: string }) {
  return <th className="font-medium pb-2 pr-4 text-[0.9em] uppercase tracking-wider" title={title}>{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="py-2 pr-4 align-middle">{children}</td>;
}
function Badge({ color, label }: { color: string; label: string }) {
  return (
    <span className="px-1.5 py-0.5 text-[0.82em] uppercase tracking-wider rounded-[2px]"
      style={{ color, background: `${color}1f`, border: `1px solid ${color}55` }}>
      {label}
    </span>
  );
}
function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-[2px] px-3 py-2.5" style={{ background: gf.bg, border: `1px solid ${gf.border}` }}>
      <div className="text-[0.82em] uppercase tracking-widest" style={{ color: gf.textDim }}>{label}</div>
      <div className="text-[1.6em] font-bold mt-0.5" style={{ color: color ?? gf.textPrimary }}>{value}</div>
    </div>
  );
}
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[0.82em] uppercase tracking-widest mb-2" style={{ color: gf.textDim }}>{children}</div>;
}
function Dim({ children }: { children: React.ReactNode }) {
  return <span className="text-[1em]" style={{ color: gf.textDim }}>{children}</span>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div className="py-6 text-center text-[1em]" style={{ color: gf.textDim }}>{children}</div>;
}

// Why no projection is shown, specifically (e.g. "12 of 24 hours have been recorded"),
// so the operator knows what to fix.
function DataQualityNotice({ quality }: { quality: MetricTrend["dataQuality"] }) {
  if (!quality) return <Empty>Not enough history for this metric yet.</Empty>;

  // One short fix per reason. The backend message already states WHAT is wrong, so this
  // only says what to do about it — saying both at length made the notice repeat itself.
  const FIX: Record<string, string> = {
    no_data: "Check the sensor is reporting.",
    too_short: "Keep it running.",
    hours_missing: "Leave it running overnight.",
    gaps: "Check for dropouts.",
    sparse: "Check readings arrive steadily.",
  };

  return (
    <div
      className="flex flex-col gap-1 px-3 py-2.5 rounded-[2px]"
      style={{ background: "rgba(255,120,10,0.06)", border: "1px solid rgba(255,120,10,0.3)" }}
    >
      <div className="font-semibold" style={{ color: ORANGE }}>
         Not enough data to forecast
      </div>
      <div style={{ color: gf.textPrimary }}>
        {quality.message} {FIX[quality.reason] ?? ""}
      </div>
      {/* The raw figures, so the verdict is checkable rather than taken on trust. */}
      <div style={{ color: gf.textDim }}>
        {quality.points} readings · {quality.spanDays}d ·{" "}
        <span style={{ color: quality.hoursCovered < 18 ? ORANGE : gf.textDim }}>
          {quality.hoursCovered}/24 hours
        </span>{" "}
        ·{" "}
        <span style={{ color: quality.largestGapHours > 6 ? ORANGE : gf.textDim }}>
          {quality.largestGapHours}h gap
        </span>{" "}
        · {Math.round(quality.coverage * 100)}%
      </div>
    </div>
  );
}
function BarRow({ label, count, max, color, typeLabel, stacked }: {
  label: string; count: number; max: number; color: string; typeLabel?: string | null;
  // Device names are long ("Main Building Core Switch") and the fixed 144px label column
  // cut them to "Main Buildi…". Stacked puts the FULL name on its own line above the bar.
  stacked?: boolean;
}) {
  const pct = max > 0 ? (count / max) * 100 : 0;
  if (stacked) {
    return (
      <div className="flex flex-col gap-1 text-[1em]">
        <div className="flex items-start gap-2">
          <span className="flex-1 min-w-0 flex items-center gap-1.5 flex-wrap" style={{ color: gf.textMuted }}>
            <span className="break-words">{label}</span>
            {typeLabel && <TypeBadge label={typeLabel} />}
          </span>
          <span className="shrink-0 text-right" style={{ color: gf.textPrimary }}>{count}</span>
        </div>
        <div className="h-2 rounded-full overflow-hidden" style={{ background: gf.hover }}>
          <div style={{ width: `${pct}%`, height: "100%", background: color }} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-[1em]">
      <span className="w-36 shrink-0 flex items-center gap-1" style={{ color: gf.textMuted }} title={label}>
        <span className="truncate">{label}</span>
        {typeLabel && <TypeBadge label={typeLabel} />}
      </span>
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
      className="flex items-start gap-2 px-3 py-2 text-[1em] rounded-[2px]"
      style={{ color: gf.textPrimary, background: `${color}14`, border: `1px solid ${color}40` }}
    >
      <span style={{ color, lineHeight: "1.4" }}>{level === "critical" ? "●" : "▲"}</span>
      <span>{children}</span>
    </div>
  );
}

// Compose the human recommendation for a trend that's heading toward an alert threshold.
function adviceSentence(trend: MetricTrend, deviceName: string | null): string {
  const a = trend.advice;
  if (!a) return "";
  const subj = deviceName ? `${trend.label} on ${deviceName}` : `Server-room ${trend.label.toLowerCase()}`;
  const thr = `${fmtReading(a.threshold)}${trend.unit}`;
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

// Small inline-SVG line chart (no chart library). Plots actual and EWMA history and the
// dashed seasonal projection, with the forecast area shaded. non-scaling-stroke keeps
// line width even under the stretched viewBox.
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
  // Breaks the line where readings stopped, instead of drawing straight across an outage.
  // One `d` can hold several `M` subpaths, so it is still one <path> per series.
  const path = (pts: { t: number; v: number }[]) =>
    pathWithGaps(pts.map((p) => ({ t: p.t, x: x(p.t), y: y(p.v) })));

  const lastE = hist[hist.length - 1];
  if (!lastE) return <Empty>Not enough points to chart.</Empty>;
  // Start the projection from the last actual reading, not the EWMA tail; the forecast
  // is anchored to the reading (analyticsMath.forecastSeasonal).
  const projLine = [{ t: lastE.t, v: lastE.v }, ...proj];
  const boundary = x(lastE.t);

  // Value scale on the left edge. Ticks are round numbers (niceTicks) placed with the
  // same y() as the paths.
  const ticks = niceTicks(vMin, vMax, 4);
  const AXIS_W = 46;   // px reserved for the value labels
  const nowLeftPct = (boundary / W) * 100;

  return (
    <div>
      <div className="flex">
        {/* Y axis */}
        <div className="relative shrink-0" style={{ width: AXIS_W, height: H }}>
          {ticks.map((tv) => (
            <span
              key={tv}
              className="absolute right-1.5 text-[0.82em] tabular-nums"
              style={{ top: y(tv) - 7, color: gf.textDim }}
            >
              {tv}
            </span>
          ))}
        </div>

        <div className="flex-1 min-w-0">
          <div className="relative">
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: H, display: "block" }}>
            {/* Forecast region, shaded so past and projected are never confused. */}
            <rect x={boundary} y={0} width={W - boundary} height={H} fill="var(--gf-hover)" opacity={0.5} />
            {/* Gridlines share the tick positions, giving the labels something to sit on. */}
            {ticks.map((tv) => (
              <line
                key={tv} x1={0} y1={y(tv)} x2={W} y2={y(tv)}
                stroke="var(--gf-divider)" strokeWidth={1} vectorEffect="non-scaling-stroke"
              />
            ))}
            <line x1={boundary} y1={0} x2={boundary} y2={H} stroke="var(--gf-text-dim)" strokeWidth={1} vectorEffect="non-scaling-stroke" strokeDasharray="2 3" />
            <path d={path(hist.map((h) => ({ t: h.t, v: h.v })))} fill="none" stroke={GRAY} strokeWidth={1} opacity={0.55} vectorEffect="non-scaling-stroke" />
            <path d={path(hist.map((h) => ({ t: h.t, v: h.e })))} fill="none" stroke="var(--gf-accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
            <path d={path(projLine)} fill="none" stroke={ORANGE} strokeWidth={2} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
          </svg>
            {/* "now" sits above the axis on the boundary line, so it no longer overlaps the
               right-hand time label. HTML rather than SVG <text>, since the stretched viewBox
               (preserveAspectRatio="none") would distort text. */}
            {proj.length > 0 && (
              <span
                className="absolute whitespace-nowrap px-1 rounded-[2px] text-[0.82em] pointer-events-none"
                style={{
                  left: `${nowLeftPct}%`,
                  top: 2,
                  // Sits to the LEFT of the line once the boundary is near the right edge,
                  // so the label stays adjacent to what it marks instead of overflowing.
                  transform: nowLeftPct > 80 ? "translateX(calc(-100% - 4px))" : "translateX(-50%)",
                  color: gf.textMuted,
                  background: gf.panel,
                }}
              >
                now
              </span>
            )}
          </div>

          {/* X axis — start and end only, so the two can never overlap. */}
          <div className="relative mt-1 text-[0.82em]" style={{ height: 16, color: gf.textDim }}>
            <span className="absolute left-0">{fmtClock(tMin)}</span>
            <span className="absolute right-0">{fmtClock(proj.at(-1)?.t ?? lastE.t)}</span>
          </div>
        </div>
      </div>

      {/* Unit stated once, where the axis it belongs to can be seen. */}
      <div className="flex justify-between text-[0.82em] mt-1" style={{ color: gf.textDim }}>
        <span style={{ paddingLeft: AXIS_W }}>{unit ? `values in ${unit}` : ""}</span>
        <span>
          {Math.round((lastE.t - tMin) / 3_600_000)}h history · +
          {proj.at(-1) ? Math.round((proj.at(-1)!.t - lastE.t) / 3_600_000) : 0}h projected
        </span>
      </div>
    </div>
  );
}

// Per-hour forecast table: "at <time> ≈ <value>" rows, one per upcoming hour from the
// projection. "Change" is against the previous hour (the first row against the latest
// reading). Rows that reach the alert threshold get the severity badge.
function HourlyForecast({
  projection, current, unit, advice,
}: {
  projection: { t: string; value: number }[];
  current: number | null;
  unit: string;
  advice: MetricTrend["advice"];
}) {
  const proj = projection.map((p) => ({ t: Date.parse(p.t), v: p.value }));
  if (proj.length < 2) return null;

  const intervalMs = (proj[1]!.t - proj[0]!.t) || 3_600_000;
  const perHour = Math.max(1, Math.round(3_600_000 / intervalMs));
  const hourly: { t: number; v: number }[] = [];
  for (let i = perHour - 1; i < proj.length; i += perHour) hourly.push(proj[i]!);
  if (!hourly.length) hourly.push(proj[proj.length - 1]!);

  const thr = advice?.threshold ?? null;
  const sevColor = advice ? SEV_COLOR[advice.severity] ?? ORANGE : ORANGE;

  const rows = hourly.slice(0, 24).map((h, i) => {
    const base = i === 0 ? current : hourly[i - 1]?.v ?? null;
    const delta = base == null ? null : Math.round((h.v - base) * 100) / 100;
    return { ...h, delta, crosses: thr != null && h.v >= thr };
  });

  return (
    <div>
      <SectionLabel>Hourly forecast</SectionLabel>
      <div className="overflow-x-auto">
        <table className="w-full text-[1em]" style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ color: gf.textDim, textAlign: "left" }}>
              <Th>When</Th><Th>Predicted</Th><Th>Change vs prev. hour</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.t} style={{ borderTop: `1px solid ${gf.divider}` }}>
                <Td><span style={{ color: gf.textMuted }}>{fmtClock(r.t)}</span></Td>
                <Td>
                  <span style={{ color: r.crosses ? sevColor : gf.textPrimary, fontWeight: r.crosses ? 600 : 400 }}>
                    {fmtReading(r.v)}{unit}
                  </span>
                  {r.crosses && advice && (
                    <span className="ml-2"><Badge color={sevColor} label={advice.severity} /></span>
                  )}
                </Td>
                <Td>
                  {r.delta == null ? (
                    <span style={{ color: gf.textDim }}>—</span>
                  ) : (
                    <span style={{ color: r.delta > 0.05 ? ORANGE : r.delta < -0.05 ? GREEN : gf.textMuted }}>
                      {r.delta > 0.05 ? "▲" : r.delta < -0.05 ? "▼" : "■"} {fmtDelta(r.delta)}{unit}
                    </span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-[0.9em]" style={{ color: gf.textDim }}>
          Projected values (Holt’s linear) sampled hourly over the forecast horizon — indicative, not exact.
        </p>
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
