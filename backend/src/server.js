import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import { handleConnection } from "../sockets/connectionHandler.js";
import { JWT_SECRET } from "../middleware/auth.js";
import db from "../config/mysql.js";
import agentService from "../services/agentService.js";
import notificationService from "../services/notificationService.js";

// import routes
import authRoutes from "../routes/auth.js";
import serverRoutes from "../routes/servers.js";
import agentRoutes from "../routes/agents.js";
import environmentRoutes from "../routes/environment.js";
import airconRoutes from "../routes/aircon.js";
import userRoutes from "../routes/users.js";
import alertRoutes from "../routes/alerts.js";
import reportRoutes from "../routes/reports.js";
import notificationRoutes from "../routes/notifications.js";

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, //15 mins
  max: 500, //~33 req/min per IP — headroom for multi-panel page loads (live data uses Socket.IO)
  standardHeaders: "draft-8",
  legacyHeaders: false,
   ipv6Subnet: 56,
  // Agent metric ingestion has its own (more generous) limiter in routes/servers.js.
  // Exempt it here so a busy fleet of agents never consumes the dashboard's budget.
  skip: (req) => req.method === "POST" && req.path === "/api/servers/metrics",
  handler: (req, res) => {
    res.status(429).json({ error: "Too many requests. Please try again later." });
  },
});

const app = express();
const server = http.createServer(app);

// F-05: restrict cross-origin access to the known dashboard origin(s).
// Override via WEB_ORIGIN in .env (comma-separated). ESP32 is a non-browser
// Socket.IO client, so CORS does not affect device connections.
// WEB_ORIGIN = comma-separated list of allowed dashboard origins, OR "*" to allow ANY
// origin (handy on a LAN whose IP changes). Unset OR blank falls back to the safe
// default below, so a missing/empty value never crashes the server or locks out the UI.
const WEB_ORIGIN =
  (process.env.WEB_ORIGIN ?? "").trim() ||
  "http://localhost:5173,http://192.168.100.9:5173";
const CORS_ORIGIN =
  WEB_ORIGIN === "*"
    ? true
    : WEB_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);

const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ["GET", "POST"]
  },
  allowEIO3: true, //bcz ESP32 uses Engine.IO v3
});

app.use("/uploads", express.static("uploads"));
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());
app.set("trust proxy", 1);
app.use(globalLimiter);

// F-01: authenticate every socket connection before events are registered
io.use(async (socket, next) => {
  // F-04: prefer the secret in the auth payload (sent in the WebSocket frame body,
  // not the URL) so it isn't captured in proxy/access logs. Query is kept only as a
  // fallback for the current EIO3 firmware until it migrates to the auth payload.
  const deviceKey = socket.handshake.auth?.deviceKey ?? socket.handshake.query?.deviceKey;

  // ESP32 device authentication via shared secret
  if (deviceKey) {
    const secret = process.env.DEVICE_SECRET;
    if (secret && deviceKey === secret) {
      socket.isDevice = true;
      return next();
    }
    return next(new Error("Invalid device key"));
  }

  // Browser client authentication via JWT
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("Unauthorized"));

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    //  reject sockets whose session has since been revoked/disabled.
    const [[user]] = await db.query(
      "SELECT status, token_version FROM users WHERE user_id = ? LIMIT 1",
      [decoded.id],
    );
    if (!user || user.status !== "active" || user.token_version !== decoded.tv) {
      return next(new Error("Session is no longer valid"));
    }
    socket.user = decoded;
    socket.isDevice = false;
    next();
  } catch {
    next(new Error("Invalid token"));
  }
});

// expose io so routes can emit to the ESP32
app.set("io", io);

// Hand the notification service the live Socket.IO server once, so any trigger
// (offline sweep, threshold checks, …) can raise + push notifications without
// threading `io` through every call.
notificationService.init(io);

// socket connections
io.on("connection", (socket) => {
  handleConnection(io, socket);
});

// routes
app.use("/api/auth", authRoutes);
app.use("/api/servers", serverRoutes);
app.use("/api/agents", agentRoutes);
app.use("/api/environment", environmentRoutes);
app.use("/api/aircon", airconRoutes);
app.use("/api/users", userRoutes);
app.use("/api/alerts", alertRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/notifications", notificationRoutes);

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
  console.log(`Server running on port ${PORT} (0.0.0.0 — all interfaces)`);
});

// Offline sweep — agents POST every ~10s and refresh last_seen; nothing else marks
// a server offline when its agent stops. Every 15s, flip stale approved servers to
// 'offline' and push the change live to dashboards (+ a device log). Without this
// the UI would keep showing a dead server as "Online" indefinitely.
const OFFLINE_SWEEP_MS = 15_000;
setInterval(async () => {
  try {
    const offlined = await agentService.sweepOffline();
    for (const o of offlined) {
      io.emit("serverStatus", { id: o.id, status: "Offline" });
      if (o.log) io.emit("deviceLog", o.log);
      // A server dropping offline is notification-worthy (bell + future email).
      await notificationService.raiseAlert({
        deviceId: o.id,
        type: "offline",
        title: "Server offline",
        message: o.name ? `${o.name} went offline — no metrics received` : (o.log?.message || `Server ${o.id} stopped reporting`),
        severity: "warning",
      });
    }
  } catch (err) {
    console.error("[OFFLINE_SWEEP] error:", err);
  }
}, OFFLINE_SWEEP_MS);
