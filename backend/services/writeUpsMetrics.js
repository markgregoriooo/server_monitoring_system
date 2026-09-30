import { writeClient, Point } from "../config/influx.js";
import backupService from "./backupService.js";

// Moved from handlers/: this is called by the pollers, not a request handler.
// See audits/architecture-report-2026-08-25.md (A-02).

// ─── UPS sample → InfluxDB + Socket.IO ────────────────────────────────────────
// Called by the poller once per UPS per cycle: one `ups_metrics` point. Floats except
// on_battery (boolean). A field is only written when the UPS reports it (many have no
// temperature). Never throws: if InfluxDB is down it logs and still broadcasts.

// sample = {
//   batteryChargePct, runtimeRemainingMin, loadPct, inputVoltage, outputVoltage,
//   batteryVoltage, onBattery(bool|null), onBypass(bool|null),
//   outputState('normal'|'battery'|'bypass'|'off'|'avr'|'unknown'|null),
//   batteryStatus, temperature|null
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

    // upsBatteryStatus (1 unknown, 2 normal, 3 low, 4 depleted), stored so battery wear
    // can be charted over months. intField because it is an enum and InfluxDB fixes a
    // field's type on first write.
    if (sample.batteryStatus != null && Number.isFinite(Number(sample.batteryStatus))) {
      p.intField("battery_status", Math.trunc(Number(sample.batteryStatus)));
      fields++;
    }

    // on_battery is null when the UPS did not report upsOutputSource. Leave the field out
    // instead of storing "on mains".
    if (sample.onBattery != null) {
      p.booleanField("on_battery", Boolean(sample.onBattery));
      fields++;
    }

    // on_bypass: the load on raw mains with no protection. Separate from on_battery
    // (battery = protected but limited time; bypass = powered but unprotected).
    // Null-guarded like on_battery.
    if (sample.onBypass != null) {
      p.booleanField("on_bypass", Boolean(sample.onBypass));
      fields++;
    }
    p.timestamp(ts);

    // A point with no fields is invalid and would fail the whole write, so a UPS that
    // reported nothing usable is skipped.
    if (fields > 0) {
      writeClient.writePoint(p);
      await writeClient.flush();
    } else {
      console.warn(`[UPS_METRICS] device ${device.id}: no usable fields in sample — skipping write`);
    }
  } catch (err) {
    console.error("[UPS_METRICS] InfluxDB error:", err);
  }

  // ---- On-site backup copy (the most important stream during an outage) ----
  backupService.record("ups", {
    device_id: device.id,
    device_name: device.name,
    ip: device.ip,
    location: device.location,
    battery_charge_pct: sample.batteryChargePct ?? null,
    runtime_remaining_min: sample.runtimeRemainingMin ?? null,
    load_pct: sample.loadPct ?? null,
    input_voltage: sample.inputVoltage ?? null,
    output_voltage: sample.outputVoltage ?? null,
    battery_voltage: sample.batteryVoltage ?? null,
    on_battery: sample.onBattery ?? null,
    on_bypass: sample.onBypass ?? null,
    output_state: sample.outputState ?? null,
    battery_status: sample.batteryStatus ?? null,
    temperature: sample.temperature ?? null,
  });

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
        onBypass: sample.onBypass ?? null,
        // The raw state name, so the UI can say WHICH abnormal source is in use
        // rather than inferring it from two booleans.
        outputState: sample.outputState ?? null,
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
