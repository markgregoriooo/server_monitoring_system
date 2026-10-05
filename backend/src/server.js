import express from "express";
import http from "http";
import crypto from "node:crypto";
import cors from "cors";
import { Server } from "socket.io";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import jwt from "jsonwebtoken";
import { handleConnection } from "../sockets/connectionHandler.js";
import {
  JWT_SECRET,
  JWT_VERIFY_OPTS,
  fetchSessionRow,
  sessionIsLive,
  sessionPastHardLimit,
} from "../middleware/auth.js";
import { securityHeaders } from "../middleware/securityHeaders.js";
import { createHandshakeLimiter, clientIpFrom } from "../services/handshakeLimiter.js";
import agentService from "../services/agentService.js";
import notificationService from "../services/notificationService.js";
import alertRulesService from "../services/alertRulesService.js";
import alertsService from "../services/alertsService.js";
import analyticsAlerts from "../services/analyticsAlerts.js";
import esp32Monitor from "../services/esp32Monitor.js";
import snmpPollerService from "../services/snmpPollerService.js";
import mikrotikPollerService from "../services/mikrotikPollerService.js";
import reachabilitySweep from "../services/reachabilitySweep.js";
import upsPowerWatch from "../services/upsPowerWatch.js";
import backupService from "../services/backupService.js";
import gasSensorService from "../services/gasSensorService.js";
import reportService from "../services/reportService.js";
import auditService from "../services/auditService.js";
import deviceLogs from "../services/deviceLogs.js";
import socketSessions from "../services/socketSessions.js";

// import routes
import authRoutes from "../routes/auth.js";
import policyRoutes from "../routes/policy.js";
import serverConsoleRoutes from "../routes/serverConsole.js";
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
import gasSensorRoutes from "../routes/gasSensors.js";
import { describeError } from "../utils/httpError.js";


const RATE_WINDOW_MIN = Number(process.env.RATE_LIMIT_WINDOW_MIN) || 15;
const RATE_MAX = Number(process.env.RATE_LIMIT_MAX) || 3000;
const RATE_IPV6_SUBNET = 56;

// Use ipKeyGenerator, not req.ip: a raw IP ignores the ipv6Subnet setting and any
// IPv6 /64 could rotate addresses for unlimited requests.
function userOrIpKey(req) {
  const header = req.headers["authorization"];
  if (header?.startsWith("Bearer ")) {
    try {
      const { id } = jwt.verify(header.slice(7), JWT_SECRET, JWT_VERIFY_OPTS);
      if (id != null) return `u:${id}`;
    } catch {
      /* absent, expired or forged — fall through to the IP budget */
    }
  }
  return `ip:${ipKeyGenerator(req.ip, RATE_IPV6_SUBNET)}`;
}

const globalLimiter = rateLimit({
  windowMs: RATE_WINDOW_MIN * 60 * 1000,
  max: RATE_MAX,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  // Agent traffic has its own limiters in routes/servers.js. A heartbeat every 2s per
  // server would use up the shared IP budget for everyone behind the campus NAT.
  skip: (req) =>
    req.method === "POST" &&
    (req.path.startsWith("/api/servers/metrics") ||
      req.path === "/api/servers/heartbeat" ||
      req.path === "/api/servers/shutdown"),
  handler: (req, res) => {
    console.warn(
      `[RATE] 429 ${req.method} ${req.originalUrl} key=${userOrIpKey(req)} ip=${req.ip} ` +
        `— over ${RATE_MAX} requests in ${RATE_WINDOW_MIN}min. Raise RATE_LIMIT_MAX if this is normal use.`,
    );
    res.status(429).json({ error: "Too many requests. Please try again later." });
  },
});

const app = express();
const server = http.createServer(app);

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
  allowRequest: (req, done) => {
    const isJsonp = /[?&]j=/.test(req.url ?? "");
    if (isJsonp) {
      return done(3, false);
    }
    return done(null, true);
  },
  maxHttpBufferSize: Number(process.env.SOCKET_MAX_PAYLOAD_BYTES) || 1e6,
});

// Security response headers, BEFORE the routes and before the limiter: a 429 or a
// 404 is not exempt from being framed or MIME-sniffed. See middleware/securityHeaders.js.
app.disable("x-powered-by");
app.use(securityHeaders());
// exposedHeaders lets the browser READ our sliding-session renewal header
// (cross-origin responses hide custom headers from JS unless listed here).
app.use(cors({ origin: CORS_ORIGIN, exposedHeaders: ["X-Renewed-Token"] }));


// `.trim() ||` instead of `??` so an empty TRUST_PROXY= also falls back to 2. An
// empty string reached Express as a list of IPs and crashed the backend at boot.
const TRUST_PROXY = (process.env.TRUST_PROXY ?? "").trim() || "2";
app.set("trust proxy", /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);
const TRUST_PROXY_HOPS = /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : 0;

app.use(globalLimiter);

// Request body limit. The batch endpoint's MAX_BATCH is sized to fit inside it.
// No urlencoded parser: every client sends JSON.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "100kb" }));

// ─── Handshake attempt limit ─────────────────────────────────────────────────
// The Express limiter never sees /socket.io/, so failed Socket.IO handshakes are
// counted here. Only rejections count; see services/handshakeLimiter.js.
// See audits/api-infra-security-2026-08-25.md (A-04).
const HANDSHAKE_MAX_FAILURES = Number(process.env.SOCKET_HANDSHAKE_MAX_FAILURES) || 50;
const handshakeLimiter = createHandshakeLimiter({
  windowMs: 15 * 60 * 1000,
  maxFailures: HANDSHAKE_MAX_FAILURES,
});

// Constant-time comparison against DEVICE_SECRET. timingSafeEqual throws on a length
// mismatch, so lengths are compared first (the length is not secret; env.js enforces
// at least 24). Returns false when no secret is configured.
function matchesDeviceSecret(provided) {
  const expected = process.env.DEVICE_SECRET;
  if (!expected || typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// F-01: authenticate every socket connection before events are registered
io.use(async (socket, next) => {
  // Resolved with the SAME trusted-hop count Express uses, so this agrees with the
  // `req.ip` every other limiter and the audit trail see.
  const peer = clientIpFrom(
    socket.handshake.headers,
    socket.handshake.address,
    TRUST_PROXY_HOPS,
  );
  if (handshakeLimiter.isBlocked(peer)) {
    console.warn(
      `[RATE] socket handshake blocked from ${peer} — over ${HANDSHAKE_MAX_FAILURES} ` +
        `failed attempts/15min (retry in ${handshakeLimiter.retryAfterSec(peer)}s)`,
    );
    return next(new Error("Too many failed connection attempts"));
  }
  const reject = (message, why) => {
    const fails = handshakeLimiter.recordFailure(peer);
    if (fails === HANDSHAKE_MAX_FAILURES) {
      // Log the moment the budget runs out, once. A credential being ground against
      // this endpoint is otherwise a quiet line in a stream of reconnect noise.
      console.warn(`[RATE] socket handshake budget exhausted for ${peer} — ${why}`);
    }
    return next(new Error(message));
  };
  // Device key sources, in order: the auth payload, the x-device-key header (the ESP32,
  // which has no auth payload), and the query string. The query string ends up in
  // access logs and is deprecated; remove it once every ESP32 has been reflashed.
  const deviceKey =
    socket.handshake.auth?.deviceKey ??
    socket.handshake.headers?.["x-device-key"] ??
    socket.handshake.query?.deviceKey;

  // ESP32 authentication with the shared secret, compared in constant time. The
  // handshake limiter makes guessing expensive; this makes it give nothing away.
  if (deviceKey) {
    if (matchesDeviceSecret(deviceKey)) {
      socket.isDevice = true;
      handshakeLimiter.recordSuccess(peer);
      return next();
    }
    return reject("Invalid device key", "bad device key");
  }

  // Browser client authentication via JWT
  const token = socket.handshake.auth?.token;
  if (!token) return reject("Unauthorized", "no credential presented");

  try {
    const decoded = jwt.verify(token, JWT_SECRET, JWT_VERIFY_OPTS);
    //  reject sockets whose session has since been revoked/disabled. Same predicate
    //  the HTTP middleware and the revocation sweep use — see middleware/auth.js.
    if (!sessionIsLive(await fetchSessionRow(decoded.id), decoded.tv)) {
      return reject("Session is no longer valid", "revoked/disabled session");
    }
    // Refuse a session that is past its absolute cap. A token issued just before the cap
    // is still valid for an hour, and must not be able to open a new socket.
    if (sessionPastHardLimit(decoded)) {
      return reject("Session is no longer valid", "session past its absolute age cap");
    }
    socket.user = decoded;
    socket.isDevice = false;
    // Same address req.ip would give; the console's audit rows record it.
    socket.clientIp = peer;
    // Clear the budget: a working dashboard, agent or ESP32 must never accumulate
    // its way into a block on an address shared by everyone behind nginx or the NAT.
    handshakeLimiter.recordSuccess(peer);
    next();
  } catch (err) {
    // The client just gets "Invalid token"; the log gets the real cause.
    console.warn(
      `[AUTH] socket handshake rejected from ${peer} — ${err.name}: ${describeError(err)}`,
    );
    reject("Invalid token", err.name);
  }
});

// expose io so routes can emit to the ESP32
app.set("io", io);

// Re-checks open sockets. io.use only authenticates at the handshake, so without
// this a socket keeps streaming after the account is disabled or revoked.
socketSessions.init(io);

// Give the notification service the Socket.IO server once, so any trigger can raise
// and push notifications without passing `io` around.
notificationService.init(io);
alertsService.init(io); // so acknowledge/resolve + auto-resolve can broadcast alertUpdated
// Threshold bands live in memory. Start them from the alerts that are still open, or an
// alert left open across a restart could never auto-resolve (see alertsService.seedBands).
alertsService.seedBands().catch((e) => console.error("[alerts] band seeding failed:", e.message));
reportService.init(io); // so a background report build can push reportUpdated when done

// ESP32 liveness. Seeds from the newest InfluxDB reading so a restart doesn't forget
// whether the sensor was alive (and so a box with no hardware attached stays quiet).
esp32Monitor.init(io).catch((e) =>
  console.error("[ESP32] liveness init failed:", e.message),
);

// On-site backup: every ingested sample is also written to NDJSON files in BACKUP_DIR.
backupService.init();
// Gas channel config (wired / label), cached because it is read on every reading.
gasSensorService.init();

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
app.use("/api/servers", serverConsoleRoutes); // /:id/console — Quick Actions over SSH
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
app.use("/api/gas-sensors", gasSensorRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" })
})

// Central error handler
app.use((err, req, res, _next) => {
  const status = err.status || 500;

  // Always log the full error. 4xx are expected and log without a stack; 5xx log the stack.
  if (status >= 500) {
    console.error(`[ERR] ${status} ${req.method} ${req.originalUrl}`, err);
  } else {
    console.warn(`[ERR] ${status} ${req.method} ${req.originalUrl} — ${describeError(err)}`);
  }

  // Send the message to the client for a 4xx or when the error is marked
  // `expose: true` (e.g. "Email is not configured on this server").
  // See audits/solid-report-2026-08-25.md (L-01).
  const showMessage = err.expose === true || (status >= 400 && status < 500);
  const body = showMessage
    ? { error: err.message, message: err.message }
    : { error: "Internal Server Error", message: "Internal Server Error" };

  res.status(status).json(body);
});


// ─── Graceful shutdown ────────────────────────────────────────────────────────
// A UPS low-battery SIGTERM gives only seconds, so the synchronous backup flush runs
// first. Everything after it is best-effort.
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return; // a second Ctrl+C must not re-enter
  shuttingDown = true;
  console.log(`[shutdown] ${sig} — flushing and closing`);

  // 1. Buffered samples → disk. Synchronous and first: this is the copy that exists
  //    precisely for the case where the power is going away.
  try {
    backupService.flushSync();
  } catch (err) {
    console.error("[shutdown] backup flush failed:", err?.message ?? err);
  }

  // 2. Stop accepting new work and let in-flight responses finish.
  server.close(() => {
    console.log("[shutdown] http closed");
    process.exit(0);
  });

  // 3. Hard cap: an idle keep-alive socket could keep server.close() waiting forever.
  //    unref() so the timer alone does not keep the process alive.
  setTimeout(() => {
    console.warn("[shutdown] close timed out — exiting anyway");
    process.exit(0);
  }, 3000).unref();
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

// ─── Process-level safety net ─────────────────────────────────────────────────
// Node 22 exits on an unhandled rejection. Several paths are fire-and-forget
// (socket handlers, report builds, audit writes), so make sure the error is logged
// with context before the process exits. The service manager restarts it.
process.on("unhandledRejection", (reason, promise) => {
  console.error("[FATAL] Unhandled promise rejection — the process will exit.");
  console.error("  reason:", reason instanceof Error ? reason.stack : reason);
  console.error("  promise:", promise);
  // Re-throw so the default behaviour (and the uncaughtException handler below) runs,
  // rather than silently continuing in an unknown state.
  throw reason;
});

process.on("uncaughtException", (err, origin) => {
  console.error(`[FATAL] Uncaught exception (origin: ${origin}) — the process will exit.`);
  console.error(err?.stack ?? err);
  // backupService's 'exit' listener DOES fire on this path, so buffered samples still
  // reach the micro SD before we go.
  process.exit(1);
});

const PORT = process.env.PORT || 3001;

// ─── HTTP server timeouts ─────────────────────────────────────────────────────
// Node's 300s request timeout could hold a socket and a DB connection for minutes;
// nothing here should take that long (reports are built in the background).
// keepAliveTimeout must be longer than the proxy's (nginx: 75s), or nginx can reuse
// a socket Node is closing and return a 502. headersTimeout must exceed keepAliveTimeout.
server.requestTimeout = Number(process.env.HTTP_REQUEST_TIMEOUT_MS) || 60_000;
server.headersTimeout = Number(process.env.HTTP_HEADERS_TIMEOUT_MS) || 90_000;
server.keepAliveTimeout = Number(process.env.HTTP_KEEPALIVE_TIMEOUT_MS) || 80_000;

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT} (0.0.0.0 — all interfaces)`);
  });

// Offline sweep: flips approved servers whose agent stopped posting to 'offline'
// and pushes it to the dashboards. Runs every 5s because the interval adds directly
// to how late an outage is reported. See also services/reachabilitySweep.js.
const OFFLINE_SWEEP_MS = 5_000;
setInterval(async () => {
  try {
    // announceOffline lives in agentService so the fast ICMP sweep raises the exact
    // same alert instead of a second, subtly different one.
    await agentService.announceOffline(io, await agentService.sweepOffline());
  } catch (err) {
    console.error("[OFFLINE_SWEEP] error:", err);
  }
}, OFFLINE_SWEEP_MS);

// Heartbeat sweep: agents send an empty heartbeat every 2s, so a dead server is
// noticed after SERVER_HEARTBEAT_TIMEOUT_SEC (6s). An in-memory check, run every
// second. Older agents without heartbeats rely on the sweep above.
const HEARTBEAT_SWEEP_MS = 1_000;
let heartbeatSweeping = false;
setInterval(async () => {
  if (heartbeatSweeping) return;
  heartbeatSweeping = true;
  try {
    await agentService.announceOffline(io, await agentService.sweepHeartbeats());
  } catch (err) {
    console.error("[HEARTBEAT_SWEEP] error:", err);
  } finally {
    heartbeatSweeping = false;
  }
}, HEARTBEAT_SWEEP_MS);

// Fast offline detection: one ping per online device every few seconds. It only
// marks devices down; recovery is left to the full poll.
reachabilitySweep.init(io);

// Fast UPS power watch: checks output source and battery status every 5s and runs a
// full poll as soon as either changes. See services/upsPowerWatch.js.
upsPowerWatch.init(io);

// ESP32 liveness: the ESP32 has no devices row, so this flips it offline and raises
// a room alert once readings stop. Recovery happens on the next reading.
const ESP32_SWEEP_MS = 10_000;
setInterval(() => esp32Monitor.sweep(), ESP32_SWEEP_MS);

// Predictive alerting: turns forecasts into real alerts. Runs slowly because each pass
// queries weeks of history; the first run is delayed so the databases are warm.
// See services/analyticsAlerts.js.
const ANALYTICS_ALERT_INTERVAL_MS =
  (Number(process.env.ANALYTICS_ALERT_INTERVAL_H) || 6) * 60 * 60 * 1000;
const ANALYTICS_ALERT_DELAY_MS = 60_000;
const runAnalyticsAlerts = async () => {
  try {
    const raised = await analyticsAlerts.runForecastAlerts();
    if (raised) console.log(`[analytics-alerts] ${raised} forecast alert(s) raised/refreshed`);
  } catch (err) {
    console.error("[analytics-alerts] error:", describeError(err));
  }
};
setTimeout(() => {
  runAnalyticsAlerts();
  setInterval(runAnalyticsAlerts, ANALYTICS_ALERT_INTERVAL_MS);
}, ANALYTICS_ALERT_DELAY_MS);

// Alert retention: purge alerts (and their per-user feed rows) older than
// NOTIFY_RETENTION_DAYS. Runs at startup and daily.
const RETENTION_DAYS = Number(process.env.NOTIFY_RETENTION_DAYS) || 30;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const runNotificationPurge = async () => {
  try {
    const purged = await notificationService.purgeOld(RETENTION_DAYS);
    if (purged) console.log(`[notifications] purged ${purged} alert(s) older than ${RETENTION_DAYS}d`);
  } catch (err) {
    console.error("[notifications] purge error:", describeError(err));
  }
};
runNotificationPurge();
setInterval(runNotificationPurge, PURGE_INTERVAL_MS);

// Report retention: deletes old report rows and their CSV/PDF files
// (REPORT_RETENTION_DAYS). Runs at startup and daily.
const REPORT_RETENTION_DAYS = Number(process.env.REPORT_RETENTION_DAYS) || 90;
const runReportPurge = async () => {
  try {
    const purged = await reportService.purgeOld(REPORT_RETENTION_DAYS);
    if (purged) console.log(`[reports] purged ${purged} report(s) older than ${REPORT_RETENTION_DAYS}d`);
  } catch (err) {
    console.error("[reports] purge error:", describeError(err));
  }
};
runReportPurge();
setInterval(runReportPurge, PURGE_INTERVAL_MS);

// Device-event retention — the last log table without one. Same daily cadence as the
// others; see services/deviceLogs.purgeOld for why 90 days.
const DEVICE_LOG_RETENTION_DAYS = Number(process.env.DEVICE_LOG_RETENTION_DAYS) || 90;
const runDeviceLogPurge = async () => {
  try {
    const purged = await deviceLogs.purgeOld(DEVICE_LOG_RETENTION_DAYS);
    if (purged) console.log(`[device_logs] purged ${purged} row(s) older than ${DEVICE_LOG_RETENTION_DAYS}d`);
  } catch (err) {
    console.error("[device_logs] purge error:", describeError(err));
  }
};
runDeviceLogPurge();
setInterval(runDeviceLogPurge, PURGE_INTERVAL_MS);

// Audit log retention: system_logs holds IP addresses and user agents. The Privacy
// Notice promises a retention period (SYSTEM_LOG_RETENTION_DAYS); this enforces it.
const SYSTEM_LOG_RETENTION_DAYS = Number(process.env.SYSTEM_LOG_RETENTION_DAYS) || 365;
const runAuditPurge = async () => {
  try {
    const purged = await auditService.purgeOld(SYSTEM_LOG_RETENTION_DAYS);
    if (purged) console.log(`[audit] purged ${purged} log row(s) older than ${SYSTEM_LOG_RETENTION_DAYS}d`);
  } catch (err) {
    console.error("[audit] purge error:", describeError(err));
  }
};
runAuditPurge();
setInterval(runAuditPurge, PURGE_INTERVAL_MS);

// SNMP poller for routers (IF-MIB) and UPS units (UPS-MIB). Does almost nothing until
// such a device is registered.
const SNMP_POLL_INTERVAL_MS = Number(process.env.SNMP_POLL_INTERVAL_MS) || 60_000;
setInterval(() => {
  snmpPollerService.pollAll(io).catch((err) => console.error("[SNMP_POLLER] error:", err));
}, SNMP_POLL_INTERVAL_MS);

// MikroTik poller over the RouterOS API. Does almost nothing until a MikroTik with
// credentials is registered.
const MIKROTIK_POLL_INTERVAL_MS = Number(process.env.MIKROTIK_POLL_INTERVAL_MS) || 30_000;
setInterval(() => {
  mikrotikPollerService.pollAll(io).catch((err) => console.error("[MIKROTIK_POLLER] error:", err));
}, MIKROTIK_POLL_INTERVAL_MS);
