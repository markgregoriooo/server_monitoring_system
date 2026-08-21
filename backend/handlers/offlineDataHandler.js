import { writeClient, Point } from "../config/influx.js";
import backupService from "../services/backupService.js";
import { parseDeviceTime } from "../services/backfillTime.js";

// Backfill of readings the ESP32 buffered to its micro SD while the socket was down,
// replayed a few rows at a time once the backend is reachable again (firmware:
// sdFlushStep). Same fields as sensorHandler, but three things differ, and each of
// them is the reason this is a separate handler rather than a flag on that one:
//
//   - the timestamp comes from the DEVICE, not from us. Live points are stamped with
//     `new Date()` because the reading arrives within milliseconds of being taken;
//     a backfilled one was taken minutes or hours ago and only the ESP32 knows when.
//   - no broadcast. This is history, not news — pushing it at the dashboard would
//     redraw the live tiles with a reading from the middle of the outage.
//   - no alert evaluation. The room has already been whatever it was; raising a
//     smoke alert now, for air that cleared an hour ago, would be a false alarm with
//     a real siren attached.
//
// It is also not re-gated by envPersistPolicy: the firmware already applied the same
// deadband rules before writing each row (SD_HEARTBEAT_MS / SD_DEADBAND_*), so every
// row that arrives here is one a connected device would have stored anyway.

// Timestamp parsing and the plausibility gates live in services/backfillTime.js —
// pure, and unit-tested, because a dead RTC coin cell produces a WELL-FORMED wrong
// date (the firmware's build date) that would otherwise be written as history.

// A replay is a burst — a two-hour outage is ~240 rows arriving back to back. The old
// implementation awaited a flush PER ROW, i.e. 240 round trips to InfluxDB for data
// that has already waited two hours. Batch instead: let the write client accumulate and
// flush once the burst goes quiet. Rows are still durable within a second of arriving.
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
    typeof data.mq2_1_ppm          !== "number" ||
    typeof data.mq2_2_ppm          !== "number" ||
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
    // Each reason points at a different fix, so they are not collapsed into one line:
    // "no-clock" and "stale" both mean go and check the coin cell, "future" means the
    // RTC was set wrong, "unparseable" means the row itself is damaged.
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

  const point = new Point("sensor_environment")
    .floatField("temperature", data.temperature)
    .floatField("humidity",    data.humidity)
    .floatField("mq2_1_ppm",   data.mq2_1_ppm)
    .floatField("mq2_2_ppm",   data.mq2_2_ppm)
    .floatField("heat_index",  data.heat_index)
    .tag("smoke_status",       data.smoke_status)
    .tag("temp_status",        data.temp_status)
    .tag("environment_status", data.environment_status)
    .timestamp(timestamp);   // ← the device's RTC time, not now

  try {
    writeClient.writePoint(point);
    pending++;
    scheduleFlush();
  } catch (error) {
    console.error("[OFFLINE] InfluxDB write error:", error);
    return;
  }

  // Mirror into the on-site NDJSON backup, exactly as sensorHandler does for a live
  // reading. Without this the backup would hold a gap precisely across the outage —
  // the stretch it is least able to reconstruct from anywhere else, and the one the
  // SD buffer was added to cover. `ts` overrides the default "now" that record()
  // stamps, so the line carries the time the reading was TAKEN; the file it lands in
  // is still today's, which is honest — that is when the backend learned of it.
  backupService.record("env", {
    ts: timestamp.toISOString(),
    backfilled: true,
    temperature: data.temperature,
    humidity: data.humidity,
    mq2_1_ppm: data.mq2_1_ppm,
    mq2_2_ppm: data.mq2_2_ppm,
    heat_index: data.heat_index,
    smoke_status: data.smoke_status,
    temp_status: data.temp_status,
    environment_status: data.environment_status,
  });
}
