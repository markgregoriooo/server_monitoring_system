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
import analyticsAlerts from "../services/analyticsAlerts.js";
import esp32Monitor from "../services/esp32Monitor.js";
import snmpPollerService from "../services/snmpPollerService.js";
import mikrotikPollerService from "../services/mikrotikPollerService.js";
import backupService from "../services/backupService.js";
import reportService from "../services/reportService.js";
import auditService from "../services/auditService.js";
import socketSessions from "../services/socketSessions.js";

// import routes
import authRoutes from "../routes/auth.js";
import policyRoutes from "../routes/policy.js";
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
import widgetLayoutRoutes from "../routes/widgetLayout.js";
import historyRoutes from "../routes/history.js";
import analyticsRoutes from "../routes/analytics.js";

// Surface missing auth config at BOOT rather than at the first sign-in attempt.
// Login is Google-only, so an unset client id/secret means nobody can get into
// the dashboard at all — far cheaper to learn here than from an opaque 401 in
// the middle of a deployment.
//
// Deliberately a loud warning, NOT process.exit: the ingest paths (ESP32 sockets,
// Go agents) don't need Google, and killing a monitoring backend would stop data
// collection over a problem that only blocks the UI.
const REQUIRED_AUTH_ENV = ["JWT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"];
const missingAuthEnv = REQUIRED_AUTH_ENV.filter((k) => !(process.env[k] ?? "").trim());
if (missingAuthEnv.length > 0) {
  console.error(
    `[CONFIG] Missing in backend/.env: ${missingAuthEnv.join(", ")}.\n` +
      "[CONFIG] Google sign-in will fail for EVERY user until these are set " +
      "(the backend does not reload .env — restart after editing).",
  );
}

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, //15 mins
  max: 500, //~33 req/min per IP — headroom for multi-panel page loads (live data uses Socket.IO)
  standardHeaders: "draft-8",
  legacyHeaders: false,
   ipv6Subnet: 56,
  // Agent metric ingestion has its own (more generous) limiter in routes/servers.js.
  // Exempt it here so a busy fleet of agents never consumes the dashboard's budget.
  // Covers /metrics AND /metrics/batch — a fleet reconnecting after an outage
  // backfills in a burst, which is exactly when the dashboard is being watched.
  skip: (req) => req.method === "POST" && req.path.startsWith("/api/servers/metrics"),
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
app.set("trust proxy", 2);
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
  } catch (err) {
    // Same reasoning as middleware/auth.js: the client gets a bare "Invalid token",
    // the log gets the actual cause. A rejected handshake surfaces in the browser as
    // an opaque 403 on /socket.io/, which says nothing about why.
    console.warn(`[AUTH] socket handshake rejected — ${err.name}: ${err.message}`);
    next(new Error("Invalid token"));
  }
});

// expose io so routes can emit to the ESP32
app.set("io", io);

// Live-socket session revocation. `io.use` above authenticates ONCE, at the
// handshake, and never re-checks — so without this a socket opened with a valid
// token keeps streaming after the account is disabled or its tokens revoked.
socketSessions.init(io);

// Hand the notification service the live Socket.IO server once, so any trigger
// (offline sweep, threshold checks, …) can raise + push notifications without
// threading `io` through every call.
notificationService.init(io);
alertsService.init(io); // so acknowledge/resolve + auto-resolve can broadcast alertUpdated
reportService.init(io); // so a background report build can push reportUpdated when done

// ESP32 liveness. Seeds from the newest InfluxDB reading so a restart doesn't forget
// whether the sensor was alive (and so a box with no hardware attached stays quiet).
esp32Monitor.init(io).catch((e) =>
  console.error("[ESP32] liveness init failed:", e.message),
);

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
app.use("/api/policy", policyRoutes);
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
app.use("/api/widget-layout", widgetLayoutRoutes);
app.use("/api/history", historyRoutes);
app.use("/api/analytics", analyticsRoutes);

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

// ESP32 liveness sweep — the environment sensor's equivalent of the offline sweep
// above. The ESP32 has no `devices` row (so last_seen can't cover it) and pushes
// `sensorData` every ~3s; this flips it Offline once those stop, raising a room-level
// alert so a dead sensor can't masquerade as a calm room. Recovery is handled by the
// reading itself (esp32Monitor.markSeen), not here, so it's instant.
const ESP32_SWEEP_MS = 10_000;
setInterval(() => esp32Monitor.sweep(), ESP32_SWEEP_MS);

// Predictive alerting — turn the forecasts into real alerts. Without this the analytics
// is pull-only: a disk projected to fill in three days reaches nobody unless someone has
// the Analytics page open. Runs on its own (slow) cadence because each pass is several
// Flux queries over weeks of history, and a multi-week regression does not move between
// two agent posts. First run is delayed so MySQL/InfluxDB are warm and a restart doesn't
// stampede the DB. See services/analyticsAlerts.js.
const ANALYTICS_ALERT_INTERVAL_MS =
  (Number(process.env.ANALYTICS_ALERT_INTERVAL_H) || 6) * 60 * 60 * 1000;
const ANALYTICS_ALERT_DELAY_MS = 60_000;
const runAnalyticsAlerts = async () => {
  try {
    const raised = await analyticsAlerts.runForecastAlerts();
    if (raised) console.log(`[analytics-alerts] ${raised} forecast alert(s) raised/refreshed`);
  } catch (err) {
    console.error("[analytics-alerts] error:", err.message);
  }
};
setTimeout(() => {
  runAnalyticsAlerts();
  setInterval(runAnalyticsAlerts, ANALYTICS_ALERT_INTERVAL_MS);
}, ANALYTICS_ALERT_DELAY_MS);

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

// Report retention — reports write a CSV + PDF to BACKUP_DIR-adjacent local disk
// (backend/reports/), so without this they accumulate on the SD/USB drive forever.
// Purges the row AND both files. Default is longer than the alerts one: a report is
// something a person deliberately generated. Same startup + daily cadence.
const REPORT_RETENTION_DAYS = Number(process.env.REPORT_RETENTION_DAYS) || 90;
const runReportPurge = async () => {
  try {
    const purged = await reportService.purgeOld(REPORT_RETENTION_DAYS);
    if (purged) console.log(`[reports] purged ${purged} report(s) older than ${REPORT_RETENTION_DAYS}d`);
  } catch (err) {
    console.error("[reports] purge error:", err.message);
  }
};
runReportPurge();
setInterval(runReportPurge, PURGE_INTERVAL_MS);

// Audit-trail retention — system_logs is the table with ip_address + user_agent in
// it, i.e. the most personal data the schema holds, and it was the one table with
// no purge at all. The Privacy Notice commits to a retention period; this is what
// makes that commitment true. Longer default than alerts/reports on purpose: an
// audit trail is what you go looking for months after an incident.
const SYSTEM_LOG_RETENTION_DAYS = Number(process.env.SYSTEM_LOG_RETENTION_DAYS) || 365;
const runAuditPurge = async () => {
  try {
    const purged = await auditService.purgeOld(SYSTEM_LOG_RETENTION_DAYS);
    if (purged) console.log(`[audit] purged ${purged} log row(s) older than ${SYSTEM_LOG_RETENTION_DAYS}d`);
  } catch (err) {
    console.error("[audit] purge error:", err.message);
  }
};
runAuditPurge();
setInterval(runAuditPurge, PURGE_INTERVAL_MS);

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
