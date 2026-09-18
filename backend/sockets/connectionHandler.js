import { sensorHandler }        from "../handlers/sensorHandler.js";
import { offlineDataHandler }   from "../handlers/offlineDataHandler.js";
import { sendSensorHistory }    from "../handlers/querySensorHistoryHandler.js";
import airconService            from "../services/airconService.js";
import alertRulesService        from "../services/alertRulesService.js";
import esp32Monitor             from "../services/esp32Monitor.js";
import gasSensorService         from "../services/gasSensorService.js";

export const handleConnection = (io, socket) => {
  console.log("Client connected:", socket.id, socket.isDevice ? "[ESP32]" : "[browser]");

  // ESP32 joins the "devices" room so backend routes can push to it via io.to("devices")
  if (socket.isDevice) {
    socket.join("devices");
    airconService.getChannelConfig()
      .then(config => socket.emit("irConfig", config))
      .catch(err => console.error("[irConfig push error]", err));
    // Push configurable alarm thresholds so the device's LED/buzzer/status match the
    // dashboard's Alert Rules (re-pushed on every rule change, see routes/alertRules.js).
    alertRulesService.getRoomThresholds()
      .then(cfg => socket.emit("envConfig", cfg))
      .catch(err => console.error("[envConfig push error]", err));
    // Push the auto-cooling IR zone boundaries (getIRZone) so the device fires IR at the
    // dashboard's configured thresholds (re-pushed on change, see routes/aircon.js).
    airconService.getDeviceIRConfig()
      .then(cfg => socket.emit("acConfig", cfg))
      .catch(err => console.error("[acConfig push error]", err));
    // Which MQ-2 channels are actually wired. Same one-boolean-per-channel shape as
    // `irConfig`, so the firmware reuses the parser it already has rather than learning a
    // second. An unwired ADC pin floats and reads NOISE, not zero, so a channel stays unread
    // until an admin asserts the hardware exists — the same reason enabledChannels[] starts
    // false for unwired IR pins. Re-pushed on change; see routes/gasSensors.js.
    gasSensorService.getDeviceConfig()
      .then(cfg => socket.emit("gasConfig", cfg))
      .catch(err => console.error("[gasConfig push error]", err));
  } else if (socket.user?.id) {
    // Browser: join a per-user room so notifications can target this user across
    // all their open tabs (io.to(`user:<id>`).emit("notification", …)).
    socket.join(`user:${socket.user.id}`);
  }

  registerEvents(io, socket);
};

const registerEvents = (io, socket) => {
  // browser clients only — query sensor history
  socket.on("changeRange", (range) => {
    if (socket.isDevice) return;
    handleChangeRange(socket, range);
  });

  /* ESP32 device only — which ADC pin each gas channel sits on (sent on every connect).
     The device is the only thing that knows this, so it tells us rather than the dashboard
     holding a second copy of MQ2_PINS[] that goes stale the day the board is re-pinned.
     A reload() follows because the cached rows carry `gpio`, and the map only just arrived. */
  socket.on("gasSensorMap", async (data) => {
    if (!socket.isDevice) return;
    try {
      await gasSensorService.setPinMap(data?.sensors ?? []);
      await gasSensorService.reload();
      io.emit("gasSensorsUpdated", { sensors: gasSensorService.cached() });
    } catch (err) {
      console.error("[gasSensorMap] reload failed:", err);
    }
    console.log("[GAS] Pin map received:", gasSensorService.getPinMap());
  });

  // ESP32 device only — GPIO channel map (sent on every connect)
  socket.on("irChannelMap", (data) => {
    if (!socket.isDevice) return;
    airconService.setChannelMap(data?.channels ?? []);
    // Forward to all browser clients so the Add Aircon modal updates live
    io.emit("irChannelMap", { channels: airconService.getChannelMap() });
    console.log("[IR] Channel map received:", airconService.getChannelMap());
  });

  // ESP32 device only — auto IR fired; sync aircon_state and notify browsers
  socket.on("irFired", async (data) => {
    if (!socket.isDevice) return;
    try {
      const result = await airconService.applyAutoIR(data);
      if (result) {
        io.emit("airconAutoUpdate", {
          setTemp: result.setTemp,
          action: result.action,
          deviceIds: result.deviceIds,
        });
      }
    } catch (err) {
      console.error("[irFired handler error]", err);
    }
  });

  // ESP32 device only — result of a clean-air (Ro) calibration. Forwarded to browsers so
  // the Recalibrate button can report whether the new baseline was accepted, instead of
  // being fire-and-forget. `ok:false` means the device measured an out-of-range value and
  // kept its previous baseline.
  socket.on("gasCalibrated", (data) => {
    if (!socket.isDevice) return;
    console.log("[CAL] ESP32 reported:", data);
    io.emit("gasCalibrated", data);
  });

  // ESP32 device only — live sensor data
  socket.on("sensorData", (data) => {
    if (!socket.isDevice) return;
    // `mq2_1_ppm` / `mq2_2_ppm` are still SENT and still handled — they are what a backend
    // that has not been updated reads, and the only shape pre-cutover history is stored in.
    // They are just not worth PRINTING: `gas_ppm` already carries every channel, so logging
    // both shapes shows the same two numbers twice and invites the reader to wonder which is
    // authoritative (it is the array). Dropped from the line only, never from the payload.
    const { mq2_1_ppm, mq2_2_ppm, ...shown } = data ?? {};
    console.log("sensorData received:", shown);
    handleSensorData(socket, data);
  });

  // ESP32 device only — replay of readings buffered to the micro SD during an outage.
  // Deliberately NOT logged per row: a replay is a burst (a two-hour outage is ~240
  // rows arriving back to back), and dumping each one buries the rest of the log at
  // exactly the moment someone is reading it to find out what happened. The handler
  // logs one summary line per burst instead.
  socket.on("offlineData", (data) => {
    if (!socket.isDevice) return;
    handleOfflineData(socket, data);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    // The ESP32 dropping is immediate proof the room is unmonitored — flip it offline
    // now rather than waiting out the staleness window. No-op while another device
    // socket is still in the room (see esp32Monitor.markDisconnected).
    if (socket.isDevice) esp32Monitor.markDisconnected(io, socket.id);
  });
};

const handleChangeRange = (socket, range) => {
  // Deliberately NOT de-duplicated against the last requested range. The socket outlives
  // page navigation, so a "same range as last time" check silently dropped the request a
  // freshly-mounted page makes to fill its chart — leave Environment and come back, or
  // open the Dashboard after Environment, and the history never arrived. The pages emit
  // this once on mount and once per range change, so answering every time is cheap.
  socket.lastRange = range;
  console.log("Range changed:", range);
  try {
    sendSensorHistory(socket, range);
  } catch (err) {
    console.error("[socket:changeRange] handler threw —", err?.stack ?? err);
  }
};

// ─── Async socket handlers must not be able to kill the process ───────────────
//
// Socket.IO does not await a handler and has nowhere to send a rejection, so an async
// handler invoked fire-and-forget leaks an unhandled rejection — and Node 22 terminates
// the process on one (verified: exit code 1). `sensorData` arrives every ~3 s from the
// ESP32, so a single transient DB or InfluxDB blip inside it would have taken the whole
// backend down, stopping every alarm in the system.
//
// src/server.js now has a process-level net that logs and exits deliberately. This is
// the layer that stops it getting that far: one bad reading is logged and dropped, and
// the next one three seconds later is handled normally. Losing one sample is the correct
// trade for a telemetry stream; losing the backend is not.
//
// See audits/error-handling-report-2026-08-25.md — E-03.
const guard = (name, fn) => (socket, payload) => {
  try {
    const r = fn(socket, payload);
    if (r && typeof r.then === "function") {
      r.catch((err) => console.error(`[socket:${name}] handler rejected —`, err?.stack ?? err));
    }
  } catch (err) {
    // A synchronous throw before the first await lands here, not in the .catch above.
    console.error(`[socket:${name}] handler threw —`, err?.stack ?? err);
  }
};

const handleSensorData   = guard("sensorData", (socket, data) => sensorHandler(socket, data));
const handleOfflineData  = guard("offlineData", (socket, data) => offlineDataHandler(socket, data));
