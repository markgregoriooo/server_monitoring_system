import { sensorHandler } from "../handlers/sensorHandler.js";
import { sendSensorHistory } from "../handlers/querySensorHistoryHandler.js";

export const handleConnection = (io, socket) => {
  console.log("Client connected:", socket.id);

  registerEvents(io, socket);

};

const registerEvents = (io, socket) => {

  socket.on("changeRange", (range) => {
    handleChangeRange(socket, range);
  });
  // get sensor data from (esp&sensor) 
  socket.on("sensorData", (data) => {
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
