import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

// import socket cn
import { handleConnection } from "./sockets/connectionHandler.js";

// routes
import authRoutes from "./routes/auth.js";
import serverRoutes from "./routes/servers.js";
import environmentRoutes from "./routes/environment.js";
import airconRoutes from "./routes/aircon.js";
import userRoutes from "./routes/users.js";
import alertRoutes from "./routes/alerts.js";
import reportRoutes from "./routes/reports.js";

//mock data(for static only, just ignore)
import { servers } from "./data/db.js";

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  allowEIO3: true, //bcz ESP32 uses Engine.IO v3 
});


app.use(cors({ origin: "*" }));
app.use(express.json());

// socket connections
io.on("connection", (socket) => {
  handleConnection(io, socket);
});


// simulate SNMP metrics
setInterval(() => {
  const live = servers.map(s => ({
    ...s,
    cpu: Math.min(99, Math.max(5, s.cpu + Math.round((Math.random() - 0.5) * 6))),
    memory: Math.min(99, Math.max(10, s.memory + Math.round((Math.random() - 0.5) * 4)))
  }))
  io.emit("serverMetrics", { servers: live })
}, 5000);

app.use("/api/auth", authRoutes);
app.use("/api/servers", serverRoutes);
app.use("/api/environment", environmentRoutes);
app.use("/api/aircon", airconRoutes);
app.use("/api/users", userRoutes);
app.use("/api/alerts", alertRoutes);
app.use("/api/reports", reportRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" })
})

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on http://192.168.100.9:3000");
});
