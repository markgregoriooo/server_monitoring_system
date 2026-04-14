import { writeClient, Point } from '../config/influx.js';

export async function sensorHandler(socket, data) {

  const now = Date.now();

  // initialize if not exists
  if (!socket.lastEmitTime) {
    socket.lastEmitTime = 0;
  }
  // throttle: allow only every 1 second
  if (now - socket.lastEmitTime < 1000) {
    return; // ignore spam or extra data
  }

  socket.lastEmitTime = now;

  // sensor data validationn
  if (
    !data ||
    typeof data.temperature !== "number" ||
    typeof data.humidity !== "number"
  ) {
    console.log("Invalid sensor payload:", data);
    return;
  }

  const timestamp = new Date();

  console.log(
    "Temp:", data.temperature,
    "°C | Humidity:", data.humidity, "%"
  );


  //  Create InfluxDB Point/data record
  const point = new Point("sensor_readings")
    .tag("sensor", "DHT11")
    .floatField("temperature", data.temperature)
    .floatField("humidity", data.humidity)
    .timestamp(timestamp);


  //  Write to InfluxDB
  try {
    writeClient.writePoint(point);
    await writeClient.flush();
    console.log("Saved to InfluxDB");
  }
  catch (error) {
    console.error("InfluxDB Error:", error);
  }


  try {
    //send sensor data
    socket.broadcast.volatile.emit("sensorData", {
      deviceId: data.deviceId || socket.id,
      temperature: data.temperature,
      humidity: data.humidity,
      timestamp
    });
  } catch (error) {
    console.error("Emit error:", err);
  }


}
