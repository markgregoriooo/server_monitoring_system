import "../config/env.js";
import db from "../config/mysql.js";
import analyticsService from "./analyticsService.js";
import notificationService from "./notificationService.js";
import alertsService from "./alertsService.js";

// ─── Predictive alerting ──────────────────────────────────────────────────────
//
// Everything analyticsService produces was PULL-only: a disk projected to fill in three
// days existed solely on the Analytics page, so it reached nobody unless someone happened
// to have that page open. Threshold alerting pushes (bell, toast, email, Alerts page);
// forecasts did not. This closes that gap by running the same forecasts on a schedule and
// raising REAL alerts through notificationService, so a prediction reaches an operator the
// same way a breach does.
//
// Why a scheduled job and not the metric path: a forecast is several Flux queries over
// weeks of history. Evaluating it on every agent POST (~10s per host) would be absurd, and
// pointless — a multi-week regression does not meaningfully move between two samples.
//
// De-dup: forecasts are re-raised at most once per ALERT_COOLDOWN_MIN while the alert
// stays open (default 24h), rather than the 30-minute default meant for live metrics.
// Recovery auto-resolves through alertsService, exactly like a threshold alert.

// Alert types. Deliberately distinct from the threshold types (`disk`, `ups_runtime`, …):
// "disk is 95% full NOW" and "disk will be full in 6 days" are different incidents with
// different responses, and sharing a type would make them de-dup against each other.
export const TYPE_DISK = "disk_forecast";
export const TYPE_UPS = "ups_battery_forecast";
export const TYPE_LINK = "link_forecast";
const FORECAST_TYPES = [TYPE_DISK, TYPE_UPS, TYPE_LINK];

const num = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt);

// An ETA inside CRITICAL_DAYS needs action now; inside WARNING_DAYS needs planning.
// Beyond that there is nothing to do yet, so nothing is raised.
const CRITICAL_DAYS = num(process.env.ANALYTICS_ALERT_CRITICAL_DAYS, 7);
const WARNING_DAYS = num(process.env.ANALYTICS_ALERT_WARNING_DAYS, 30);
const COOLDOWN_MIN = num(process.env.ANALYTICS_ALERT_COOLDOWN_MIN, 1440); // 24h

// Lookback per forecast — the same windows the page defaults to (predictive-analytics.md
// §16), since those are sized to each phenomenon's real timescale.
const DISK_DAYS = num(process.env.ANALYTICS_ALERT_DISK_DAYS, 30);
const LINK_DAYS = num(process.env.ANALYTICS_ALERT_LINK_DAYS, 90);
const UPS_DAYS = num(process.env.ANALYTICS_ALERT_UPS_DAYS, 180);

const severityForEta = (etaDays) => {
  if (etaDays == null) return null;
  if (etaDays <= CRITICAL_DAYS) return "critical";
  if (etaDays <= WARNING_DAYS) return "warning";
  return null; // far enough out that there is nothing to act on
};

const fmtEta = (d) => (d < 1 ? "less than a day" : `~${d} day${d >= 2 ? "s" : ""}`);

// Raise, or resolve if the concern has passed. Every branch is best-effort: this job must
// never throw into the interval that drives it.
async function reconcile({ deviceId, type, severity, title, message, metricValue }) {
  if (!severity) {
    // No longer projecting trouble (trend flattened, capacity added, battery replaced) →
    // close any open forecast alert, same as a recovering metric does.
    await alertsService.autoResolveMetric(deviceId, type);
    return false;
  }
  await notificationService.raiseAlert({
    deviceId, type, severity, title, message, metricValue,
    cooldownMin: COOLDOWN_MIN,
  });
  return true;
}

// ─── Disk ─────────────────────────────────────────────────────────────────────
async function checkDiskForecasts() {
  const forecasts = await analyticsService.forecastDiskFull({ lookbackDays: DISK_DAYS });
  let raised = 0;
  for (const f of forecasts) {
    // "full" is a measured fact rather than a projection, so it is always critical.
    const severity = f.status === "full" ? "critical" : severityForEta(f.status === "filling" ? f.etaDays : null);
    // Name the volume only when the server has more than one, mirroring how the
    // threshold alert phrases it ("Disk critical (D:\)").
    const where = f.volumes.length > 1 && f.mount ? ` (${f.mount})` : "";
    const message =
      f.status === "full"
        ? `${f.name}${where}: disk is at capacity (~${f.full}%).`
        : `${f.name}${where}: disk projected to reach ${f.full}% in ${fmtEta(f.etaDays)} (now ${f.currentPercent}%).`;
    if (await reconcile({
      deviceId: f.deviceId,
      type: TYPE_DISK,
      severity,
      title: f.status === "full" ? "Disk at capacity" : "Disk projected to fill",
      message,
      metricValue: f.currentPercent,
    })) raised++;
  }
  return raised;
}

// ─── UPS battery ──────────────────────────────────────────────────────────────
async function checkUpsForecasts() {
  const forecasts = await analyticsService.forecastUpsBattery({ lookbackDays: UPS_DAYS });
  let raised = 0;
  for (const u of forecasts) {
    const severity = u.status === "reached" ? "critical" : severityForEta(u.status === "declining" ? u.etaDays : null);
    const message =
      u.status === "reached"
        ? `${u.name}: battery runtime is at/below the ${u.floorMinutes}-minute floor — replace the battery.`
        : `${u.name}: battery runtime projected below ${u.floorMinutes} min in ${fmtEta(u.etaDays)} (now ${u.currentRuntimeMin} min).`;
    if (await reconcile({
      deviceId: u.deviceId,
      type: TYPE_UPS,
      severity,
      title: "UPS battery nearing replacement",
      message,
      metricValue: u.currentRuntimeMin,
    })) raised++;
  }
  return raised;
}

// ─── Link saturation ──────────────────────────────────────────────────────────
// One alert per DEVICE, not per interface: `alerts` is keyed by device_id + type, so two
// saturating ports on one router would de-dup against each other and the second would be
// silently dropped. Alerting on the worst interface keeps the signal honest, and the
// message names which port it is.
async function checkLinkForecasts() {
  const forecasts = await analyticsService.forecastLinkSaturation({ lookbackDays: LINK_DAYS });
  const worstByDevice = new Map();
  for (const l of forecasts) {
    const eta = l.status === "reached" ? 0 : l.status === "rising" ? l.etaDays : null;
    if (eta == null) continue;
    const cur = worstByDevice.get(l.deviceId);
    if (!cur || eta < cur.eta) worstByDevice.set(l.deviceId, { link: l, eta });
  }

  let raised = 0;
  const seen = new Set();
  for (const [deviceId, { link, eta }] of worstByDevice) {
    seen.add(deviceId);
    const port = link.interfaceLabel ? `${link.interfaceLabel} (${link.interface})` : link.interface;
    const message =
      link.status === "reached"
        ? `${link.name} — ${port}: link is at/above ${link.ceiling}% utilization.`
        : `${link.name} — ${port}: projected to reach ${link.ceiling}% utilization in ${fmtEta(eta)} (now ${link.currentUtil}%).`;
    if (await reconcile({
      deviceId,
      type: TYPE_LINK,
      severity: link.status === "reached" ? "critical" : severityForEta(eta),
      title: "Network link nearing saturation",
      message,
      metricValue: link.currentUtil,
    })) raised++;
  }

  // Devices that no longer have ANY concerning interface get their open alert resolved.
  for (const l of forecasts) {
    if (!seen.has(l.deviceId)) await alertsService.autoResolveMetric(l.deviceId, TYPE_LINK);
  }
  return raised;
}

// ─── Anomalies ────────────────────────────────────────────────────────────────
// detectAnomalies was pull-only too, which quietly undercut the feature's own claim: the
// pitch for a per-hour-of-day baseline is that it catches what static thresholds miss (a
// 2 AM CPU spike still under 80%), but that only holds if somebody is looking. Here it
// pushes, like every other detector in the system.
//
// An anomaly is an EVENT, not an ongoing condition, so — like the server "came online"
// alert — it is raised and then immediately resolved: it belongs in the feed and the
// history, not in the open-alert count forever.
//
// De-dup is therefore by FRESHNESS rather than by the open-alert cooldown: only anomalies
// newer than the last pass are considered, so a given spike is announced exactly once.
const ANOMALY_ENABLED = String(process.env.ANALYTICS_ANOMALY_ALERTS ?? "true").toLowerCase() !== "false";
const ANOMALY_DAYS = num(process.env.ANALYTICS_ANOMALY_DAYS, 14);
// Freshness window, with a margin so an anomaly landing near a pass boundary is not lost
// between two runs.
const FRESH_MS = num(process.env.ANALYTICS_ALERT_INTERVAL_H, 6) * 3_600_000 * 1.1;

const SERVER_ANOMALY_METRICS = ["cpu", "mem", "disk"];
const ROUTER_ANOMALY_METRICS = ["router_cpu", "router_mem", "router_clients"];
const ENV_ANOMALY_METRICS = ["temperature", "gas", "humidity"];

// Which (metric, device) pairs to scan. Bounded by the device count on purpose — this is
// a handful of Flux queries per device, run a few times a day, not a per-sample cost.
// Offline devices are skipped: they cannot produce a fresh anomaly, only stale ones.
async function anomalyTargets() {
  const [rows] = await db.query(
    `SELECT device_id AS id,
            COALESCE(NULLIF(display_name, ''), device_name) AS name,
            device_type AS type
       FROM devices
      WHERE device_type IN ('server', 'router', 'mikrotik')
        AND status <> 'offline'`,
  );
  const targets = [];
  // Room-level environment metrics have no device row (the ESP32 isn't in `devices`).
  for (const metric of ENV_ANOMALY_METRICS) targets.push({ metric, deviceId: null, name: "Server room" });
  for (const d of rows) {
    const metrics = d.type === "server" ? SERVER_ANOMALY_METRICS : ROUTER_ANOMALY_METRICS;
    for (const metric of metrics) targets.push({ metric, deviceId: d.id, name: d.name });
  }
  return targets;
}

async function checkAnomalies() {
  if (!ANOMALY_ENABLED) return 0;
  const targets = await anomalyTargets();
  const cutoff = Date.now() - FRESH_MS;
  let raised = 0;

  for (const t of targets) {
    let result;
    try {
      result = await analyticsService.detectAnomalies({
        metric: t.metric, deviceId: t.deviceId, lookbackDays: ANOMALY_DAYS,
      });
    } catch (err) {
      console.error(`[analytics-alerts] anomaly scan failed (${t.metric}):`, err.message);
      continue;
    }
    if (!result || result.status !== "ok" || !result.anomalies.length) continue;

    const fresh = result.anomalies.filter((a) => Date.parse(a.t) >= cutoff);
    if (!fresh.length) continue;

    // ONE alert per device+metric summarising the burst. A noisy hour can produce dozens
    // of flagged readings, and dozens of notifications for one event is how people learn
    // to ignore the bell.
    const worst = fresh.reduce((w, a) => (Math.abs(a.z) > Math.abs(w.z) ? a : w));
    const severe = worst.iqrOutlier || Math.abs(worst.z) >= 4;
    const when = new Date(worst.t).toLocaleString("en-PH", {
      month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    const count = fresh.length > 1 ? `${fresh.length} anomalous readings` : "an anomalous reading";
    const message =
      `${t.name} — ${result.label}: ${count} vs the usual pattern for that hour. ` +
      `Worst ${worst.value}${result.unit} at ${when} (typical ~${worst.expected}${result.unit}, ${worst.z > 0 ? "+" : ""}${worst.z}σ).`;

    const alertId = await notificationService.raiseAlert({
      deviceId: t.deviceId,
      type: `anomaly_${t.metric}`,
      // Deliberately not critical: this is "unusual", not "broken". Keeping it below the
      // default email threshold means anomalies inform the bell without mailing everyone
      // every time the campus has a quiet afternoon.
      severity: severe ? "warning" : "info",
      title: `Unusual ${result.label.toLowerCase()}`,
      message,
      metricValue: worst.value,
    });
    if (alertId) {
      raised++;
      // Self-resolve: a point-in-time event shouldn't sit in the open-alert badge.
      await alertsService.autoResolveMetric(t.deviceId, `anomaly_${t.metric}`);
    }
  }
  return raised;
}

// ─── Entry point ──────────────────────────────────────────────────────────────
// Never throws: one failing forecast (Influx down, say) must not stop the others or kill
// the interval that calls this.
async function runForecastAlerts() {
  const results = await Promise.allSettled([
    checkDiskForecasts(),
    checkUpsForecasts(),
    checkLinkForecasts(),
    checkAnomalies(),
  ]);
  let raised = 0;
  for (const r of results) {
    if (r.status === "fulfilled") raised += r.value;
    else console.error("[analytics-alerts] forecast check failed:", r.reason?.message ?? r.reason);
  }
  return raised;
}

export default { runForecastAlerts, FORECAST_TYPES, TYPE_DISK, TYPE_UPS, TYPE_LINK };
