import { writeClient, Point } from "../config/influx.js";
import backupService from "../services/backupService.js";

// ─── Router/switch sample → InfluxDB + Socket.IO ──────────────────────────────
//
// Called by snmpPollerService once per reachable router each poll cycle. Mirrors
// serverMetricsHandler: shape → write Influx → flush → broadcast. Two measurements
// per device: one `router_metrics` point (per-device) + one `network_traffic`
// point per interface. The byte/error counters are written CUMULATIVE as uinteger
// (Counter64 BigInts) — rate is derived at query time (design doc §5). Never
// throws: an Influx outage logs and still broadcasts so the dashboard stays live.

// sample = {
//   reachable, uptimeSeconds, cpuPercent|null, memPercent|null,
//   latencyMs|null, packetLossPct|null, connectedClients|null,
//   interfaces: [{ name, locationLabel, rxBytes(BigInt), txBytes(BigInt),
//                  rxErrors(number), txErrors(number), linkUp(bool), utilizationPct|null }]
// }
export async function writeNetworkSample(io, device, sample) {
  const ts = new Date(); // server-side ms precision (matches the other handlers)

  // ---- Write to InfluxDB ----
  try {
    const rm = new Point("router_metrics")
      .tag("device_id", String(device.id))
      .tag("device_name", device.name ?? "")
      .tag("device_type", device.type ?? "router")
      .booleanField("reachable", sample.reachable !== false)
      .floatField("uptime_seconds", Number(sample.uptimeSeconds ?? 0));
    // CPU/mem come from vendor MIBs (non-standard) — only written where collected.
    if (sample.cpuPercent != null) rm.floatField("cpu_percent", Number(sample.cpuPercent));
    if (sample.memPercent != null) rm.floatField("mem_percent", Number(sample.memPercent));
    if (sample.latencyMs != null) rm.floatField("latency_ms", Number(sample.latencyMs));
    if (sample.packetLossPct != null) rm.floatField("packet_loss_pct", Number(sample.packetLossPct));
    if (sample.connectedClients != null) rm.intField("connected_clients", Math.trunc(sample.connectedClients));
    rm.timestamp(ts);
    writeClient.writePoint(rm);

    for (const i of sample.interfaces ?? []) {
      const p = new Point("network_traffic")
        .tag("device_id", String(device.id))
        .tag("device_name", device.name ?? "")
        .tag("interface_name", i.name ?? "")
        .tag("location_label", i.locationLabel ?? "")
        // uinteger, NOT float — a 64-bit octet counter exceeds float64 safe range.
        .uintField("rx_bytes", i.rxBytes ?? 0)
        .uintField("tx_bytes", i.txBytes ?? 0)
        .uintField("rx_errors", i.rxErrors ?? 0)
        .uintField("tx_errors", i.txErrors ?? 0)
        .booleanField("link_up", Boolean(i.linkUp));
      if (i.utilizationPct != null) p.floatField("utilization_pct", Number(i.utilizationPct));
      p.timestamp(ts);
      writeClient.writePoint(p);
    }
    await writeClient.flush();
  } catch (err) {
    console.error("[NETWORK_METRICS] InfluxDB error:", err);
    // fall through — still broadcast so the UI stays live
  }

  // ---- On-site backup copy (both non-MikroTik SNMP + MikroTik land here; the
  //      device_type field distinguishes them) ----
  backupService.record("network", {
    device_id: device.id,
    device_name: device.name,
    device_type: device.type ?? "router",
    ip: device.ip,
    location: device.location,
    reachable: sample.reachable !== false,
    uptime_seconds: sample.uptimeSeconds ?? null,
    cpu_percent: sample.cpuPercent ?? null,
    mem_percent: sample.memPercent ?? null,
    latency_ms: sample.latencyMs ?? null,
    packet_loss_pct: sample.packetLossPct ?? null,
    connected_clients: sample.connectedClients ?? null,
    interfaces: (sample.interfaces ?? []).map((i) => ({
      name: i.name,
      location_label: i.locationLabel ?? "",
      rx_bytes: i.rxBytes ?? null, // BigInt → string via backup's replacer
      tx_bytes: i.txBytes ?? null,
      rx_errors: i.rxErrors ?? 0,
      tx_errors: i.txErrors ?? 0,
      link_up: Boolean(i.linkUp),
      utilization_pct: i.utilizationPct ?? null,
    })),
  });

  // ---- Broadcast camelCase to dashboards (BigInts → strings: JSON can't carry BigInt) ----
  try {
    io?.emit("networkMetrics", {
      device: {
        id: device.id,
        name: device.name,
        ip: device.ip,
        type: device.type ?? "router",
        location: device.location,
        status: "Online",
        reachable: sample.reachable !== false,
        uptimeSeconds: sample.uptimeSeconds ?? null,
        cpuPercent: sample.cpuPercent ?? null,
        memPercent: sample.memPercent ?? null,
        // Was omitted, so the dashboard's client count never updated live — it only
        // arrived on the initial GET. SNMP leaves it null; MikroTik fills it.
        connectedClients: sample.connectedClients ?? null,
        interfaces: (sample.interfaces ?? []).map((i) => ({
          name: i.name,
          locationLabel: i.locationLabel ?? "",
          linkUp: Boolean(i.linkUp),
          utilizationPct: i.utilizationPct ?? null,
          rxBytes: i.rxBytes != null ? String(i.rxBytes) : null,
          txBytes: i.txBytes != null ? String(i.txBytes) : null,
          // Collected by both pollers and written to Influx, but previously never sent
          // to the browser — so error counts and link speed couldn't be shown at all.
          rxErrors: i.rxErrors ?? 0,
          txErrors: i.txErrors ?? 0,
          speedMbps: i.speedMbps ?? null,
          // Per-port DHCP client count; null when the topology can't attribute it.
          clients: i.clients ?? null,
        })),
        timestamp: ts.toISOString(),
      },
    });
  } catch (err) {
    console.error("[NETWORK_METRICS] emit error:", err);
  }
}

export default { writeNetworkSample };
