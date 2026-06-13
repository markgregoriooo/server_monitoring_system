import { writeClient, Point } from "../config/influx.js";

// ─── UPS sample → InfluxDB + Socket.IO ────────────────────────────────────────
//
// Called by snmpPollerService once per reachable UPS each poll cycle. One
// `ups_metrics` point per device. All readings are plain gauges (float), except
// on_battery (boolean — consistent with network_traffic.link_up). A field is only
// written when the UPS actually reports it (many omit temperature), so the Influx
// schema isn't pinned to a bogus 0. Never throws — Influx errors log and we still
// broadcast so the dashboard stays live.

// sample = {
//   batteryChargePct, runtimeRemainingMin, loadPct, inputVoltage, outputVoltage,
//   batteryVoltage, onBattery(bool|null), batteryStatus, temperature|null
// }
export async function writeUpsSample(io, device, sample) {
  const ts = new Date();

  try {
    const p = new Point("ups_metrics")
      .tag("device_id", String(device.id))
      .tag("device_name", device.name ?? "")
      .tag("location", device.location ?? "")
      .tag("communication_type", device.commType ?? "snmp");

    const f = (key, v) => {
      if (v != null && Number.isFinite(Number(v))) p.floatField(key, Number(v));
    };
    f("battery_charge_pct", sample.batteryChargePct);
    f("runtime_remaining_min", sample.runtimeRemainingMin);
    f("load_pct", sample.loadPct);
    f("input_voltage", sample.inputVoltage);
    f("output_voltage", sample.outputVoltage);
    f("battery_voltage", sample.batteryVoltage);
    f("temperature", sample.temperature); // only if the UPS reports it
    p.booleanField("on_battery", Boolean(sample.onBattery));
    p.timestamp(ts);

    writeClient.writePoint(p);
    await writeClient.flush();
  } catch (err) {
    console.error("[UPS_METRICS] InfluxDB error:", err);
  }

  try {
    io?.emit("upsMetrics", {
      ups: {
        id: device.id,
        name: device.name,
        ip: device.ip,
        location: device.location,
        status: "Online",
        batteryChargePct: sample.batteryChargePct ?? null,
        runtimeRemainingMin: sample.runtimeRemainingMin ?? null,
        loadPct: sample.loadPct ?? null,
        inputVoltage: sample.inputVoltage ?? null,
        outputVoltage: sample.outputVoltage ?? null,
        batteryVoltage: sample.batteryVoltage ?? null,
        onBattery: sample.onBattery ?? null,
        batteryStatus: sample.batteryStatus ?? null,
        temperature: sample.temperature ?? null,
        timestamp: ts.toISOString(),
      },
    });
  } catch (err) {
    console.error("[UPS_METRICS] emit error:", err);
  }
}

export default { writeUpsSample };
