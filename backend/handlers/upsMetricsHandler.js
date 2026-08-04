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

    let fields = 0;
    const f = (key, v) => {
      if (v != null && Number.isFinite(Number(v))) {
        p.floatField(key, Number(v));
        fields++;
      }
    };
    f("battery_charge_pct", sample.batteryChargePct);
    f("runtime_remaining_min", sample.runtimeRemainingMin);
    f("load_pct", sample.loadPct);
    f("input_voltage", sample.inputVoltage);
    f("output_voltage", sample.outputVoltage);
    f("battery_voltage", sample.batteryVoltage);
    f("temperature", sample.temperature); // only if the UPS reports it

    // RFC 1628 upsBatteryStatus enum (1 unknown, 2 normal, 3 low, 4 depleted). It
    // already drives the battery-replace alert but was broadcast only, never stored —
    // so the one signal that reveals itself over MONTHS (a battery degrading toward
    // replacement) had no history to chart or report on. intField, not float: it's
    // an enum, and InfluxDB pins a field's type on first write.
    if (sample.batteryStatus != null && Number.isFinite(Number(sample.batteryStatus))) {
      p.intField("battery_status", Math.trunc(Number(sample.batteryStatus)));
      fields++;
    }

    // on_battery is null when the UPS didn't answer upsOutputSource. Boolean(null)
    // would record "unknown" as "on mains" — a silent false-negative on the most
    // safety-critical signal here, indistinguishable later from a real mains-OK
    // reading. Leave the field absent instead, like every other unreported value.
    if (sample.onBattery != null) {
      p.booleanField("on_battery", Boolean(sample.onBattery));
      fields++;
    }
    p.timestamp(ts);

    // A point with tags but no fields is invalid line protocol and would fail the
    // whole batch. Now that on_battery is conditional, no field is guaranteed — so a
    // UPS that answered SNMP but reported nothing usable is skipped, not written.
    if (fields > 0) {
      writeClient.writePoint(p);
      await writeClient.flush();
    } else {
      console.warn(`[UPS_METRICS] device ${device.id}: no usable fields in sample — skipping write`);
    }
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
