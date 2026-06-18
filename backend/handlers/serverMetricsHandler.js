import { writeClient, Point } from "../config/influx.js";
import agentService from "../services/agentService.js";
import notificationService from "../services/notificationService.js";
import alertsService from "../services/alertsService.js";

// Float fields every metric POST must carry. process_count is validated
// separately as an integer. Keep this list in sync with the Go agent's
// ServerMetrics struct (go-agent/internal/collector/metrics.go).
const NUMERIC_FIELDS = [
  "cpu_percent",
  "mem_used_mb",
  "mem_total_mb",
  "mem_percent",
  "disk_used_gb",
  "disk_total_gb",
  "disk_percent",
  "net_bytes_sent",
  "net_bytes_recv",
  "uptime_seconds",
];

function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// POST /api/servers/metrics — agentAuthMiddleware has set req.device.
export async function serverMetricsHandler(req, res) {
  const data = req.body;
  const device = req.device;

  // ---- Validate ----
  for (const f of NUMERIC_FIELDS) {
    if (typeof data?.[f] !== "number" || !Number.isFinite(data[f])) {
      return res.status(400).json({ error: `Invalid or missing field: ${f}` });
    }
  }
  if (!Number.isInteger(data.process_count)) {
    return res.status(400).json({ error: "Invalid or missing field: process_count" });
  }

  const timestamp = new Date(); // server-side ms precision (matches sensorHandler)
  const uptimeLabel = formatUptime(data.uptime_seconds);

  // ---- Write to InfluxDB (measurement: server_metrics) ----
  try {
    const point = new Point("server_metrics")
      .tag("device_id", String(device.device_id))
      .tag("device_name", device.device_name ?? "")
      .tag("location", device.location ?? "")
      .tag("os", device.os ?? "")
      .floatField("cpu_percent", data.cpu_percent)
      .floatField("mem_used_mb", data.mem_used_mb)
      .floatField("mem_total_mb", data.mem_total_mb)
      .floatField("mem_percent", data.mem_percent)
      .floatField("disk_used_gb", data.disk_used_gb)
      .floatField("disk_total_gb", data.disk_total_gb)
      .floatField("disk_percent", data.disk_percent)
      .floatField("net_bytes_sent", data.net_bytes_sent)
      .floatField("net_bytes_recv", data.net_bytes_recv)
      .floatField("uptime_seconds", data.uptime_seconds)
      .intField("process_count", data.process_count)
      .timestamp(timestamp);

    writeClient.writePoint(point);
    await writeClient.flush();
  } catch (err) {
    console.error("[SERVER_METRICS] InfluxDB error:", err);
    // fall through — still update status + broadcast so the UI stays live
  }

  // ---- Heartbeat: mark online + refresh last_seen/uptime in MySQL ----
  let cameOnline = false;
  try {
    const hb = await agentService.recordHeartbeat(device.device_id, uptimeLabel);
    cameOnline = hb?.cameOnline ?? false;
  } catch (err) {
    console.error("[SERVER_METRICS] heartbeat error:", err);
  }

  // ---- Cache live values so GET /api/servers renders instantly after refresh ----
  agentService.cacheLatest(device.device_id, {
    cpu: data.cpu_percent,
    memory: data.mem_percent,
    diskUsed: data.disk_percent,
    uptime: uptimeLabel,
  });

  // ---- Device event log: online transition + threshold crossings (device_logs) ----
  try {
    const io = req.app.get("io");
    const events = [];
    if (cameOnline) {
      events.push(await agentService.logDevice(device.device_id, "info", "Server came online"));

      // Symmetric to the offline-sweep alert: notify on a (re)connect. Covers both a
      // reconnect (offline→online) and a brand-new server's first report (approve()
      // leaves it offline until it actually reports).
      const name = device.display_name?.trim() || device.device_name || `Server ${device.device_id}`;
      // Close the open "offline" incident first so the Alerts page + badge clear.
      await alertsService.autoResolveMetric(device.device_id, "offline");
      await notificationService.raiseAlert({
        deviceId: device.device_id,
        type: "online",
        title: "Server online",
        message: `${name} is online`,
        severity: "info",
      });
      // "Online" is a point-in-time event, not an open incident — resolve it right
      // away so it stays in the bell feed + Alerts history without inflating the
      // open-alert badge (only the real "offline" condition should count as open).
      await alertsService.autoResolveMetric(device.device_id, "online");
    }
    events.push(
      ...(await agentService.checkThresholds(device.device_id, {
        cpu: data.cpu_percent,
        mem: data.mem_percent,
        disk: data.disk_percent,
      })),
    );
    for (const e of events) if (e) io?.emit("deviceLog", e);
  } catch (err) {
    console.error("[SERVER_METRICS] device log error:", err);
  }

  // ---- Broadcast camelCase to dashboards ----
  try {
    req.app.get("io")?.emit("serverMetrics", {
      server: {
        id: device.device_id,
        // Effective label for the UI (admin display name else hostname). The
        // InfluxDB tag above stays the real hostname so the time-series isn't
        // re-keyed when a server is renamed.
        name: device.display_name?.trim() || device.device_name,
        ip: device.ip_address,
        location: device.location,
        os: device.os,
        status: "Online",
        cpuPercent: data.cpu_percent,
        memPercent: data.mem_percent,
        memUsedMB: data.mem_used_mb,
        memTotalMB: data.mem_total_mb,
        diskPercent: data.disk_percent,
        diskUsedGB: data.disk_used_gb,
        diskTotalGB: data.disk_total_gb,
        netBytesSent: data.net_bytes_sent,
        netBytesRecv: data.net_bytes_recv,
        uptimeSeconds: data.uptime_seconds,
        uptimeLabel,
        processCount: data.process_count,
        timestamp: timestamp.toISOString(),
      },
    });
  } catch (err) {
    console.error("[SERVER_METRICS] emit error:", err);
  }

  res.json({ success: true });
}
