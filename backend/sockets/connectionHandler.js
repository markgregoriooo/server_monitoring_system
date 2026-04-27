import { sensorHandler } from "../handlers/sensorHandler.js";
import { sendSensorHistory } from "../handlers/querySensorHistoryHandler.js";

// const deviceRequestMap = new Map();

// const checkDeviceRateLimit = (deviceId) => {
//   const now = Date.now();

//   if (!deviceRequestMap.has(deviceId)) {
//     deviceRequestMap.set(deviceId, []);
//   }

//   const timestamps = deviceRequestMap.get(deviceId);

//   // keep only last 60 seconds
//   const recent = timestamps.filter(ts => now - ts < 60000);

//   // update stored timestamps
//   deviceRequestMap.set(deviceId, recent);

//   if (recent.length >= 60) {
//     return false; // limit exceeded
//   }

//   // add current request
//   recent.push(now);
//   deviceRequestMap.set(deviceId, recent);

//   return true;
// };


export const handleConnection = (io, socket) => {
  console.log("Client connected:", socket.id);

  registerEvents(io, socket);

};

const registerEvents = (io, socket) => {
  //
  socket.on("changeRange", (range) => {
    handleChangeRange(socket, range);
  });

  // get sensor data from (esp&sensor) 
  socket.on("sensorData", (data) => {
    // const deviceId = data.deviceId;

    // if (!deviceId) {
    //   console.warn("Missing deviceId");
    //   return;
    // }

    // const allowed = checkDeviceRateLimit(deviceId);

    // if (!allowed) {
    //   console.warn("⚠️ Device sending too fast:", deviceId);

    //   //  Soft handling (DO NOT disconnect)
    //   return; // ignore excess data
    // }


    console.log("sensorData received:", data);
    handleSensorData(socket, data);
  });

  socket.on("disconnect", () => {
    handleDisconnect(socket);
  });
};

const handleChangeRange = (socket, range) => {
  if (socket.lastRange === range) return;

  socket.lastRange = range;
  console.log("Range changed:", range);
  sendSensorHistory(socket, range); //get history
};

const handleSensorData = (socket, data) => {
  sensorHandler(socket, data); //pass sensor data(the data ffrom esp) to handler
};

const handleDisconnect = (socket) => {
  console.log("Client disconnected:", socket.id);
};
