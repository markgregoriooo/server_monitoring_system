import { sensorHandler }        from "../handlers/sensorHandler.js";
import { offlineDataHandler }   from "../handlers/offlineDataHandler.js";
import { sendSensorHistory }    from "../handlers/querySensorHistoryHandler.js";
import airconService            from "../services/airconService.js";
import alertRulesService        from "../services/alertRulesService.js";
import esp32Monitor             from "../services/esp32Monitor.js";
import gasSensorService         from "../services/gasSensorService.js";
import { registerConsoleEvents } from "./consoleHandler.js";

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
    // Which MQ-2 channels are wired, in the same shape as `irConfig`. An unwired ADC
    // pin floats and reads noise, so a channel is only read once an admin enables it.
    // Re-pushed on change (routes/gasSensors.js).
    gasSensorService.getDeviceConfig()
      .then(cfg => socket.emit("gasConfig", cfg))
      .catch(err => console.error("[gasConfig push error]", err));
  } else if (socket.user?.id) {
    // Browser: join a per-user room so notifications can target this user across
    // all their open tabs (io.to(`user:<id>`).emit("notification", …)).
    socket.join(`user:${socket.user.id}`);
    // Server Console web terminal (admin-only, checked per open).
    registerConsoleEvents(socket);
  }

  registerEvents(io, socket);
};

const registerEvents = (io, socket) => {
  // browser clients only — query sensor history
  socket.on("changeRange", (range) => {
    if (socket.isDevice) return;
    handleChangeRange(socket, range);
  });

  /* ESP32 only: the ADC pin of each gas channel, sent on every connect. Only the
     device knows this. reload() follows because the cached rows carry `gpio`. */
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

  // ESP32 only: result of a clean-air (Ro) calibration, forwarded to browsers.
  // ok:false means the value was out of range and the old baseline was kept.
  socket.on("gasCalibrated", (data) => {
    if (!socket.isDevice) return;
    console.log("[CAL] ESP32 reported:", data);
    io.emit("gasCalibrated", data);
  });

  // ESP32 device only — live sensor data
  socket.on("sensorData", (data) => {
    if (!socket.isDevice) return;
    // mq2_1_ppm / mq2_2_ppm are still sent for older backends and history; they are
    // left out of the log line only because gas_ppm already has every channel.
    const { mq2_1_ppm, mq2_2_ppm, ...shown } = data ?? {};
    console.log("sensorData received:", shown);
    handleSensorData(socket, data);
  });

  // ESP32 only: readings buffered on the SD card during an outage. Not logged per
  // row (a replay can be hundreds of rows); the handler logs one summary line.
  socket.on("offlineData", (data) => {
    if (!socket.isDevice) return;
    handleOfflineData(socket, data);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    // The ESP32 disconnecting means the room is unmonitored, so mark it offline now.
    // No-op while another device socket is still connected.
    if (socket.isDevice) esp32Monitor.markDisconnected(io, socket.id);
  });
};

const handleChangeRange = (socket, range) => {
  // Not de-duplicated: the socket outlives page navigation, so a newly mounted page
  // must get its history even if the range is the same as last time.
  socket.lastRange = range;
  console.log("Range changed:", range);
  try {
    sendSensorHistory(socket, range);
  } catch (err) {
    console.error("[socket:changeRange] handler threw —", err?.stack ?? err);
  }
};

// ─── Async socket handlers must not crash the process ────────────────────────
// Socket.IO does not await handlers, and Node 22 exits on an unhandled rejection.
// One DB or InfluxDB error inside `sensorData` would stop the whole backend. This
// logs and drops the failed event instead. See audits/error-handling-report-2026-08-25.md (E-03).
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
