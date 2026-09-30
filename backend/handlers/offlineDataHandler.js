import { writeClient, Point } from "../config/influx.js";
import backupService from "../services/backupService.js";
import gasSensorService from "../services/gasSensorService.js";
import { normalizeGas, worstGas, legacyFields } from "../services/gasReadings.js";
import { parseDeviceTime } from "../services/backfillTime.js";

// Backfill of readings the ESP32 saved to its SD card while the socket was down,
// replayed a few rows at a time after reconnecting (firmware: sdFlushStep).
// Differences from sensorHandler:
//   - the timestamp comes from the device, since only it knows when the reading
//     was taken;
//   - no broadcast: it is history, not a live reading;
//   - no alerts: raising a smoke alarm now for air that cleared an hour ago would
//     be a false alarm.
// Not filtered by envPersistPolicy; the firmware applied the same rules when it
// wrote each row.

// Timestamp parsing and range checks are in services/backfillTime.js (tested). A
// dead RTC battery gives a valid-looking but wrong date.

// A replay can be hundreds of rows. Instead of flushing per row, let the write
// client batch them and flush once the burst goes quiet.
const FLUSH_DEBOUNCE_MS = 1000;
let flushTimer = null;
let pending = 0;
let rejected = 0;

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    const n = pending;
    const bad = rejected;
    pending = 0;
    rejected = 0;
    try {
      await writeClient.flush();
      if (n > 0) {
        console.log(
          `[OFFLINE] Backfilled ${n} buffered reading(s) to InfluxDB` +
            (bad ? ` (${bad} rejected)` : ""),
        );
      } else if (bad > 0) {
        console.warn(`[OFFLINE] Replay produced nothing usable — ${bad} row(s) rejected.`);
      }
    } catch (error) {
      console.error("[OFFLINE] InfluxDB flush error:", error);
    }
  }, FLUSH_DEBOUNCE_MS);
}

export async function offlineDataHandler(socket, data) {
  if (
    !data ||
    typeof data.temperature        !== "number" ||
    typeof data.humidity           !== "number" ||
    // Gas is not required; how many channels a row has depends on the firmware that
    // wrote it. Same as sensorHandler.

    typeof data.heat_index         !== "number" ||
    typeof data.smoke_status       !== "string" ||
    typeof data.temp_status        !== "string" ||
    typeof data.environment_status !== "string" ||
    typeof data.timestamp          !== "string"
  ) {
    console.log("[OFFLINE] Invalid payload:", data);
    rejected++;
    return;
  }

  const { at: timestamp, reason } = parseDeviceTime(data.timestamp);
  if (!timestamp) {
    // Each reason needs a different fix: "no-clock" and "stale" mean check the RTC
    // battery, "future" means the RTC was set wrong, "unparseable" means a damaged row.
    console.warn(
      `[OFFLINE] Dropped a buffered row — ${reason} ("${String(data.timestamp).slice(0, 32)}"). ` +
        (reason === "no-clock" || reason === "stale"
          ? "Check the DS3231 coin cell: without it the ESP32 cannot date an outage."
          : "Backfill is stored under the DEVICE's clock, so a wrong one cannot be accepted."),
    );
    rejected++;
    scheduleFlush();   // so an all-rejected burst still reports itself
    return;
  }

  // Same normalisation as the live path, so replayed readings land in the same
  // per-sensor series. Rows from the two-sensor firmware only have the legacy fields.
  const gas = normalizeGas(data, gasSensorService.enabledChannels());
  const legacy = legacyFields(gas);

  const point = new Point("sensor_environment")
    .floatField("temperature", data.temperature)
    .floatField("humidity",    data.humidity)
    .floatField("heat_index",  data.heat_index)
    .tag("smoke_status",       data.smoke_status)
    .tag("temp_status",        data.temp_status)
    .tag("environment_status", data.environment_status)
    .timestamp(timestamp);   // ← the device's RTC time, not now
  if (legacy.mq2_1_ppm != null) point.floatField("mq2_1_ppm", legacy.mq2_1_ppm);
  if (legacy.mq2_2_ppm != null) point.floatField("mq2_2_ppm", legacy.mq2_2_ppm);
  const worst = worstGas(gas);
  if (worst) point.floatField("gas_ppm", worst.ppm);

  try {
    writeClient.writePoint(point);
    for (const g of gas) {
      writeClient.writePoint(
        new Point("sensor_gas")
          .tag("channel", String(g.channel))
          .floatField("ppm", g.ppm)
          .timestamp(timestamp),
      );
    }
    pending++;
    scheduleFlush();
  } catch (error) {
    console.error("[OFFLINE] InfluxDB write error:", error);
    return;
  }

  // Also write the reading to the on-site backup, like sensorHandler, so the backup
  // has no gap over the outage. `ts` is when the reading was taken; the file is
  // today's because that is when the backend received it.
  backupService.record("env", {
    ts: timestamp.toISOString(),
    backfilled: true,
    temperature: data.temperature,
    humidity: data.humidity,
    ...legacy,
    gas,
    heat_index: data.heat_index,
    smoke_status: data.smoke_status,
    temp_status: data.temp_status,
    environment_status: data.environment_status,
  });
}
