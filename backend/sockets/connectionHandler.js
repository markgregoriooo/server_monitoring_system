import { sensorHandler }        from "../handlers/sensorHandler.js";
import { offlineDataHandler }   from "../handlers/offlineDataHandler.js";
import { sendSensorHistory }    from "../handlers/querySensorHistoryHandler.js";
import airconService            from "../services/airconService.js";

export const handleConnection = (io, socket) => {
  console.log("Client connected:", socket.id, socket.isDevice ? "[ESP32]" : "[browser]");

  // ESP32 joins the "devices" room so backend routes can push to it via io.to("devices")
  if (socket.isDevice) {
    socket.join("devices");
    airconService.getChannelConfig()
      .then(config => socket.emit("irConfig", config))
      .catch(err => console.error("[irConfig push error]", err));
  }

  registerEvents(io, socket);
};

const registerEvents = (io, socket) => {
  // browser clients only — query sensor history
  socket.on("changeRange", (range) => {
    if (socket.isDevice) return;
    handleChangeRange(socket, range);
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

  // ESP32 device only — live sensor data
  socket.on("sensorData", (data) => {
    if (!socket.isDevice) return;
    console.log("sensorData received:", data);
    handleSensorData(socket, data);
  });

  // ESP32 device only — offline SD card flush
  socket.on("offlineData", (data) => {
    if (!socket.isDevice) return;
    console.log("offlineData received:", data);
    handleOfflineData(socket, data);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
};

const handleChangeRange = (socket, range) => {
  if (socket.lastRange === range) return;
  socket.lastRange = range;
  console.log("Range changed:", range);
  sendSensorHistory(socket, range);
};

const handleSensorData   = (socket, data) => sensorHandler(socket, data);
const handleOfflineData  = (socket, data) => offlineDataHandler(socket, data);
