import express from "express";
import path from "path";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
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

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const forwarded = req.headers["x-forwarded-for"];
    const ip = forwarded ? forwarded.split(",")[0].trim() : req.ip;
    return ipKeyGenerator(ip);
  },
  handler: (req, res) => {
    res.status(429).json({ error: "Too many requests. Please try again later." });
  },
});

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  allowEIO3: true, //bcz ESP32 uses Engine.IO v3 
});

app.use("/uploads", express.static("uploads"));
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(globalLimiter);

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

// error handler
app.use((err, req, res, next) => {
  console.error(err);

  const status = err.status || 500;

  res.status(status).json({
    message: err.message || "Internal Server Error",
  });
});


const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on http://192.168.100.9:3000");
});
