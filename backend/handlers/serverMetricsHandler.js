import { writeClient, Point } from "../config/influx.js";
import agentService from "../services/agentService.js";
import notificationService from "../services/notificationService.js";
import alertsService from "../services/alertsService.js";
import backupService from "../services/backupService.js";
import { logDevice } from "../services/deviceLogs.js";
import {
  backfillTimestamp,
  formatUptime,
  sanitizeInterval,
  sanitizeVolumes,
  validateSample,
} from "../services/serverMetricUtils.js";

// Build the InfluxDB points for one sample. Shared by the live POST and the
// backfill batch so a buffered sample lands in exactly the same shape as a live
// one — only its timestamp differs.
function writeSamplePoints(device, data, volumes, timestamp) {
  writeClient.writePoint(
    new Point("server_metrics")
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
      .timestamp(timestamp),
  );

  // Per-volume series (measurement: server_volumes), one point per mount, so a
  // data volume has its own history instead of being hidden behind the root's.
  for (const v of volumes) {
    writeClient.writePoint(
      new Point("server_volumes")
        .tag("device_id", String(device.device_id))
        .tag("device_name", device.device_name ?? "")
        .tag("mount", v.mount)
        .floatField("total_gb", v.total_gb)
        .floatField("used_gb", v.used_gb)
        .floatField("percent", v.percent)
        .timestamp(timestamp),
    );
  }
}

function backupPayload(device, data, volumes) {
  return {
    device_id: device.device_id,
    device_name: device.device_name,
    location: device.location,
    os: device.os,
    cpu_percent: data.cpu_percent,
    mem_used_mb: data.mem_used_mb,
    mem_total_mb: data.mem_total_mb,
    mem_percent: data.mem_percent,
    disk_used_gb: data.disk_used_gb,
    disk_total_gb: data.disk_total_gb,
    disk_percent: data.disk_percent,
    net_bytes_sent: data.net_bytes_sent,
    net_bytes_recv: data.net_bytes_recv,
    uptime_seconds: data.uptime_seconds,
    process_count: data.process_count,
    volumes,
  };
}

// POST /api/servers/metrics — agentAuthMiddleware has set req.device.
export async function serverMetricsHandler(req, res) {
  const data = req.body;
  const device = req.device;

  // ---- Validate ----
  const invalid = validateSample(data);
  if (invalid) return res.status(400).json({ error: invalid });

  // The agent's own clock is ignored on the LIVE path (matches sensorHandler);
  // it is trusted only for backfilled samples, which have no other timestamp.
  const timestamp = new Date(); // server-side ms precision
  const uptimeLabel = formatUptime(data.uptime_seconds);
  const volumes = sanitizeVolumes(data.volumes);
  const intervalSec = sanitizeInterval(data.interval_seconds);

  // ---- Write to InfluxDB (measurements: server_metrics + server_volumes) ----
  try {
    writeSamplePoints(device, data, volumes, timestamp);
    await writeClient.flush();
  } catch (err) {
    console.error("[SERVER_METRICS] InfluxDB error:", err);
    // fall through — still update status + broadcast so the UI stays live
  }

  // ---- On-site backup copy (independent of InfluxDB) ----
  backupService.record("server", backupPayload(device, data, volumes));

  // ---- Occasional host-info refresh (the agent attaches `host` hourly) ----
  // Without this, static facts freeze at enrollment: a DHCP lease change would
  // leave a stale IP on screen forever, and a RAM upgrade would make the
  // "Mem used GB" figure — which divides by memory_total_mb — quietly wrong.
  if (data.host && typeof data.host === "object" && !Array.isArray(data.host)) {
    try {
      await agentService.refreshHostInfo(device.device_id, data.host);
    } catch (err) {
      console.error("[SERVER_METRICS] host refresh error:", err);
    }
  }

  // ---- Heartbeat: mark online + refresh last_seen/uptime in MySQL ----
  // Also auto-resolves the open offline alert on an offline→online transition.
  let cameOnline = false;
  let maintenance = false;
  try {
    const hb = await agentService.recordHeartbeat(device.device_id, uptimeLabel, intervalSec);
    cameOnline = hb?.cameOnline ?? false;
    maintenance = hb?.maintenance ?? false;
  } catch (err) {
    console.error("[SERVER_METRICS] heartbeat error:", err);
  }

  // ---- Cache live values so GET /api/servers renders instantly after refresh ----
  agentService.cacheLatest(device.device_id, {
    cpu: data.cpu_percent,
    memory: data.mem_percent,
    diskUsed: data.disk_percent,
    uptime: uptimeLabel,
    processCount: data.process_count,
    volumes,
  });

  // ---- Device event log: online transition + threshold crossings (device_logs) ----
  // Skipped entirely during a maintenance window — the operator took this box
  // down on purpose, so neither the log nor the bell should fire for it.
  try {
    const io = req.app.get("io");
    const events = [];
    if (cameOnline) {
      events.push(await logDevice(device.device_id, "info", "Server came online"));

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
    if (!maintenance) {
      events.push(
        ...(await agentService.checkThresholds(device.device_id, {
          cpu: data.cpu_percent,
          mem: data.mem_percent,
          disk: data.disk_percent,
          volumes,
        })),
      );
    }
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
        status: maintenance ? "Maintenance" : "Online",
        volumes,
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

// Largest backlog accepted in one request. The agent chunks its spool to match;
// this bound is what keeps a batch inside express.json()'s 100kb default.
const MAX_BATCH = 60;

// POST /api/servers/metrics/batch — backfill of samples the agent buffered while
// the backend was unreachable. agentAuthMiddleware has set req.device.
//
// This is HISTORY ONLY, and deliberately narrower than the live path: it writes
// InfluxDB + the on-site backup and nothing else. No heartbeat, no status change,
// no threshold evaluation, no broadcast — alerting on an hours-old CPU spike
// would page someone for a condition that has long since passed, and letting a
// backlog mark a server "Online" would resurrect a host that is still down.
export async function serverMetricsBatchHandler(req, res) {
  const device = req.device;
  const samples = req.body?.samples;

  if (!Array.isArray(samples) || samples.length === 0) {
    return res.status(400).json({ error: "Body must include a non-empty `samples` array." });
  }
  if (samples.length > MAX_BATCH) {
    return res.status(413).json({ error: `Too many samples in one batch (max ${MAX_BATCH}).` });
  }

  const now = Date.now();
  let accepted = 0;
  let skipped = 0;

  try {
    for (const sample of samples) {
      // Same validator as the live path — a buffered sample must not enter by a
      // laxer door. A bad entry is skipped, not fatal: the rest is still real data.
      if (validateSample(sample)) {
        skipped++;
        continue;
      }
      // The agent's clock is the ONLY timestamp a buffered sample has. Clamped,
      // so a host with a broken RTC can't write points years out.
      const ts = backfillTimestamp(sample.collected_at, now);
      if (!ts) {
        skipped++;
        continue;
      }

      const volumes = sanitizeVolumes(sample.volumes);
      writeSamplePoints(device, sample, volumes, ts);
      backupService.record("server", {
        ...backupPayload(device, sample, volumes),
        backfilled: true,
        collected_at: ts.toISOString(),
      });
      accepted++;
    }
    await writeClient.flush();
  } catch (err) {
    console.error("[SERVER_METRICS] batch write error:", err);
    return res.status(500).json({ error: "Failed to store backfilled samples." });
  }

  console.log(
    `[SERVER_METRICS] backfilled ${accepted} sample(s) for device ${device.device_id}` +
      (skipped ? ` (${skipped} skipped)` : ""),
  );
  res.json({ success: true, accepted, skipped });
}
