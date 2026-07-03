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
import alertRulesService from "../services/alertRulesService.js";
import alertsService from "../services/alertsService.js";
import snmpPollerService from "../services/snmpPollerService.js";
import mikrotikPollerService from "../services/mikrotikPollerService.js";
import backupService from "../services/backupService.js";

// import routes
import authRoutes from "../routes/auth.js";
import serverRoutes from "../routes/servers.js";
import agentRoutes from "../routes/agents.js";
import networkRoutes from "../routes/network.js";
import upsRoutes from "../routes/ups.js";
import mikrotikRoutes from "../routes/mikrotik.js";
import environmentRoutes from "../routes/environment.js";
import airconRoutes from "../routes/aircon.js";
import userRoutes from "../routes/users.js";
import alertRoutes from "../routes/alerts.js";
import reportRoutes from "../routes/reports.js";
import notificationRoutes from "../routes/notifications.js";
import alertRuleRoutes from "../routes/alertRules.js";

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
// exposedHeaders lets the browser READ our sliding-session renewal header
// (cross-origin responses hide custom headers from JS unless listed here).
app.use(cors({ origin: CORS_ORIGIN, exposedHeaders: ["X-Renewed-Token"] }));
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
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
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
alertsService.init(io); // so acknowledge/resolve + auto-resolve can broadcast alertUpdated

// On-site backup writer — mirrors every ingested sample (env/server/router/UPS) to
// rotating NDJSON files on BACKUP_DIR (a micro SD / USB drive on the backend, or a
// local folder). An independent copy that survives a DB wipe + a power outage.
backupService.init();

// Warm the configurable-threshold cache so the first metric POST evaluates against
// rules without a cold DB read (getEffectiveRules also lazy-loads as a fallback).
alertRulesService.reload().catch((e) =>
  console.error("[alert-rules] initial load failed:", e.message),
);

// socket connections
io.on("connection", (socket) => {
  handleConnection(io, socket);
});

// routes
app.use("/api/auth", authRoutes);
app.use("/api/servers", serverRoutes);
app.use("/api/agents", agentRoutes);
app.use("/api/network", networkRoutes);
app.use("/api/ups", upsRoutes);
app.use("/api/mikrotik", mikrotikRoutes);
app.use("/api/environment", environmentRoutes);
app.use("/api/aircon", airconRoutes);
app.use("/api/users", userRoutes);
app.use("/api/alerts", alertRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/alert-rules", alertRuleRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" })
})

// error handler
app.use((err, req, res, next) => {
  console.error(err);

  const status = err.status || 500;

  // Surface intentional (4xx) messages to the client — the frontend reads `error`.
  // 5xx stays generic so unexpected internals aren't leaked.
  const body = { message: err.message || "Internal Server Error" };
  if (status >= 400 && status < 500) body.error = err.message;

  res.status(status).json(body);
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

// Notification retention — purge alerts (and, via cascade, their per-user feed
// rows) older than NOTIFY_RETENTION_DAYS so the tables don't grow unbounded.
// Runs at startup and daily.
const RETENTION_DAYS = Number(process.env.NOTIFY_RETENTION_DAYS) || 30;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const runNotificationPurge = async () => {
  try {
    const purged = await notificationService.purgeOld(RETENTION_DAYS);
    if (purged) console.log(`[notifications] purged ${purged} alert(s) older than ${RETENTION_DAYS}d`);
  } catch (err) {
    console.error("[notifications] purge error:", err.message);
  }
};
runNotificationPurge();
setInterval(runNotificationPurge, PURGE_INTERVAL_MS);

// SNMP poller — pulls metrics from routers (IF-MIB) + UPS units (UPS-MIB) on a
// timer (the pull mirror of the push-based Go agents). Self-gating: pollAll loads
// the router/ups devices each cycle and is a near-no-op (one empty SELECT) until
// such a device is registered, so this is harmless when none exist yet.
const SNMP_POLL_INTERVAL_MS = Number(process.env.SNMP_POLL_INTERVAL_MS) || 60_000;
setInterval(() => {
  snmpPollerService.pollAll(io).catch((err) => console.error("[SNMP_POLLER] error:", err));
}, SNMP_POLL_INTERVAL_MS);

// MikroTik poller — pulls metrics from the one campus router over the RouterOS API
// (data source B; pull mirror of the Go agents). Same self-gating as the SNMP poller:
// a near-no-op (one SELECT) until a device_type='mikrotik' row with credentials exists.
const MIKROTIK_POLL_INTERVAL_MS = Number(process.env.MIKROTIK_POLL_INTERVAL_MS) || 30_000;
setInterval(() => {
  mikrotikPollerService.pollAll(io).catch((err) => console.error("[MIKROTIK_POLLER] error:", err));
}, MIKROTIK_POLL_INTERVAL_MS);
