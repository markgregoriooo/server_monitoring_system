import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import jwt from "jsonwebtoken";
import { handleConnection } from "../sockets/connectionHandler.js";
import { JWT_SECRET, fetchSessionRow, sessionIsLive } from "../middleware/auth.js";
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
import { describeError } from "../utils/httpError.js";

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

// Size this from what ONE DASHBOARD LOAD actually costs, not from a feel for what
// "a lot of requests" is. The old value was 500/15min with a comment claiming headroom
// for multi-panel page loads; it did not have it, and the failure mode is ugly — every
// panel 429s at once and the Dashboard renders empty, which reads as a crash rather than
// as a limit being hit.
//
// The real arithmetic, counted off the network log of a single Dashboard mount:
//   ~19 requests   AuthContext (/auth/me), NotificationContext (notifications, alerts/
//                  count, agents/pending, users/pending), useRoomThresholds, useWidget-
//                  Layout, Dashboard (servers, ups, network, mikrotik, aircon, alerts,
//                  sensor-status) and LiveSummaryContext — which re-fetches five of the
//                  same endpoints for the PiP widget.
//   x2             React StrictMode double-invokes effects IN DEV.
//   + ~10          the socket `connect` handler re-runs several of those on every
//                  (re)connect, including after each Vite HMR reload.
// So one dev page load is 50-70 requests, and every file save reloads the page. 500 was
// roughly eight loads — a few minutes of work — after which the whole UI went blank.
//
// This is a LAN dashboard for a handful of ICTU staff, so the limiter is here to stop a
// script hammering the API, not to ration normal use. Override per deployment with
// RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MIN.
const RATE_WINDOW_MIN = Number(process.env.RATE_LIMIT_WINDOW_MIN) || 15;
const RATE_MAX = Number(process.env.RATE_LIMIT_MAX) || 3000;
const RATE_IPV6_SUBNET = 56;

// Budget per USER where we can tell who is asking, per IP only where we cannot.
//
// Keying on IP alone is a self-inflicted denial of service here: every ICTU staffer sits
// behind the same campus NAT, so the dashboard would hand them ONE shared budget and the
// first person to hard-refresh a few times would lock out everyone else — during a demo,
// or during the incident they all opened the dashboard to look at.
//
// The token is VERIFIED, not merely decoded. `jwt.decode` would let anyone mint a token
// claiming any `id`: either a fresh budget on demand, or someone else's budget deliberately
// exhausted. Verification is an HMAC over a short string, so the cost is negligible next to
// the query the request is about to make. authMiddleware verifies again per route — this
// runs before it (the limiter is global, and some routes are public), and duplicating a
// microsecond of HMAC is the right trade against threading auth state through the limiter.
//
// The IP fallback must go through `ipKeyGenerator`, not `req.ip`. Returning a raw IP
// silently discards the ipv6Subnet setting below, and an attacker with any IPv6 /64 could
// then rotate addresses for unlimited budget — which is the whole reason that option is set.
function userOrIpKey(req) {
  const header = req.headers["authorization"];
  if (header?.startsWith("Bearer ")) {
    try {
      const { id } = jwt.verify(header.slice(7), JWT_SECRET, { algorithms: ["HS256"] });
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
  // No `ipv6Subnet` here on purpose: express-rate-limit IGNORES it whenever a custom
  // keyGenerator is set, and warned about the contradiction at every boot
  // (ERR_ERL_IPV6SUBNET_OR_KEYGENERATOR). userOrIpKey applies RATE_IPV6_SUBNET itself
  // via ipKeyGenerator, so the grouping is real — it was just declared twice, once
  // where it did nothing.
  keyGenerator: userOrIpKey,
  // Agent metric ingestion has its own (more generous) limiter in routes/servers.js.
  // Exempt it here so a busy fleet of agents never consumes the dashboard's budget.
  // Covers /metrics AND /metrics/batch — a fleet reconnecting after an outage
  // backfills in a burst, which is exactly when the dashboard is being watched.
  skip: (req) => req.method === "POST" && req.path.startsWith("/api/servers/metrics"),
  // Log it. A 429 is invisible from the server side otherwise, and from the browser it
  // looks like a broken page rather than a limit — every panel simply has no data.
  handler: (req, res) => {
    // Log the KEY, not just the IP: `u:7` vs `ip:…` is the difference between one user
    // burning their own budget and unauthenticated traffic burning a shared one.
    console.warn(
      `[RATE] 429 ${req.method} ${req.originalUrl} key=${userOrIpKey(req)} ip=${req.ip} ` +
        `— over ${RATE_MAX} requests in ${RATE_WINDOW_MIN}min. Raise RATE_LIMIT_MAX if this is normal use.`,
    );
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
  // F-04: keep the shared secret out of the URL — a query string is written verbatim
  // into proxy and access logs, a header and a frame body are not. Three sources, in
  // descending preference:
  //   auth payload   — browsers and any Socket.IO v3+ client
  //   x-device-key   — the ESP32, which speaks EIO3 and so has no `auth` payload
  //   query string   — DEPRECATED, only reached by firmware predating 2026-08-16.
  // Drop the query fallback once every ESP32 in the field has been reflashed; until
  // then removing it would silently strand an un-updated box.
  const deviceKey =
    socket.handshake.auth?.deviceKey ??
    socket.handshake.headers?.["x-device-key"] ??
    socket.handshake.query?.deviceKey;

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
    //  reject sockets whose session has since been revoked/disabled. Same predicate
    //  the HTTP middleware and the revocation sweep use — see middleware/auth.js.
    if (!sessionIsLive(await fetchSessionRow(decoded.id), decoded.tv)) {
      return next(new Error("Session is no longer valid"));
    }
    socket.user = decoded;
    socket.isDevice = false;
    next();
  } catch (err) {
    // Same reasoning as middleware/auth.js: the client gets a bare "Invalid token",
    // the log gets the actual cause. A rejected handshake surfaces in the browser as
    // an opaque 403 on /socket.io/, which says nothing about why.
    console.warn(`[AUTH] socket handshake rejected — ${err.name}: ${describeError(err)}`);
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

// ─── Central error handler ────────────────────────────────────────────────────
//
// `message` used to be set from `err.message` for EVERY status, including 5xx —
// directly under a comment claiming "5xx stays generic so unexpected internals aren't
// leaked". Only `error` was gated. So an unexpected failure sent its raw text to the
// client: a mysql2 error carries the SQL state and table name
// ("ER_NO_SUCH_TABLE: Table 'cspc.reports' doesn't exist"), and a filesystem error
// carries an absolute server path. The client never read `message` either — api.ts's
// handleError reads `data.error` — so it was leakage with no consumer.
app.use((err, req, res, _next) => {
  const status = err.status || 500;

  // Log the FULL error server-side regardless — that is where the detail belongs.
  // 4xx are expected (bad input, wrong role) so they log at warn without a stack;
  // 5xx are not, and the stack is the whole point.
  if (status >= 500) {
    console.error(`[ERR] ${status} ${req.method} ${req.originalUrl}`, err);
  } else {
    console.warn(`[ERR] ${status} ${req.method} ${req.originalUrl} — ${describeError(err)}`);
  }

  // WHICH messages cross the wire.
  //
  // Two ways an error can be safe to show: a 4xx status (validation, not found, wrong
  // role — the message was written for a user), or an explicit `expose: true`, which is
  // how a DELIBERATE 5xx says "this text is for the operator". Gating on the status range
  // ALONE swallowed exactly those: `ServiceUnavailable` and reportService's
  // "Email is not configured on this server (SMTP_USER / SMTP_PASS)." both reached the
  // admin as a bare "Internal Server Error", which is the opposite of their purpose.
  // See audits/solid-report-2026-08-25.md — L-01.
  const showMessage = err.expose === true || (status >= 400 && status < 500);
  const body = showMessage
    ? { error: err.message, message: err.message }
    : { error: "Internal Server Error", message: "Internal Server Error" };

  res.status(status).json(body);
});


// ─── Graceful shutdown ────────────────────────────────────────────────────────
//
// Owned here, at the composition root, rather than by whichever service happened to
// register a signal handler first. backupService used to do it and called
// process.exit(0) straight after its flush, so server.close() never ran and in-flight
// responses were cut mid-write.
//
// Order matters. The on-site backup is the thing that must survive a power event, and a
// UPS low-battery SIGTERM gives seconds, not minutes — so the SYNCHRONOUS flush goes
// first, before anything that can block. Everything after it is best-effort.
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

  // 3. Hard cap. A held-open socket (an idle keep-alive, a long poll) would otherwise
  //    keep server.close() pending forever — and on a dying UPS there is no forever.
  //    unref() so this timer alone never keeps the process alive.
  setTimeout(() => {
    console.warn("[shutdown] close timed out — exiting anyway");
    process.exit(0);
  }, 3000).unref();
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

// ─── Process-level safety net ─────────────────────────────────────────────────
//
// Node 22 terminates the process on an unhandled rejection (the default has been
// `--unhandled-rejections=throw` since Node 15). Verified on this machine: a
// fire-and-forget async call that rejects exits with code 1.
//
// That matters because several hot paths ARE fire-and-forget by design — the socket
// handlers (`sensorData` arrives every ~3s from the ESP32), the report builder, and the
// audit writes. Any one of them rejecting used to take the whole backend down, which on
// a monitoring system means the alarms stop with it.
//
// These handlers do NOT swallow the error. They make sure it is written down — with the
// context needed to find it — before the process goes. Restart is left to the process
// supervisor, which is the right owner: a process that keeps running after an unknown
// exception is in an unknown state.
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

const PORT = process.env.PORT || 3000;

// ─── HTTP server timeouts ─────────────────────────────────────────────────────
//
// Node's defaults were in force: requestTimeout 300 s, headersTimeout 60 s,
// keepAliveTimeout 5 s. Two problems with that here.
//
// 1. A request held open for FIVE MINUTES occupies a socket and, if it is mid-query, a
//    MySQL pool connection — of which there are only 10, shared by the pollers, the
//    agent POSTs and every dashboard request (see S-03). Nothing this API does
//    legitimately takes minutes: reports are built asynchronously and answered 202.
//
// 2. keepAliveTimeout must be LONGER than the reverse proxy's. nginx defaults to
//    75 s; with Node closing an idle connection at 5 s, nginx can hand a request to a
//    socket Node is closing and return a 502 the logs cannot explain. The deployment
//    puts this behind a proxy (deployment-guide.md), so the ordering matters.
//    headersTimeout must exceed keepAliveTimeout or Node warns and clamps.
server.requestTimeout = Number(process.env.HTTP_REQUEST_TIMEOUT_MS) || 60_000;
server.headersTimeout = Number(process.env.HTTP_HEADERS_TIMEOUT_MS) || 90_000;
server.keepAliveTimeout = Number(process.env.HTTP_KEEPALIVE_TIMEOUT_MS) || 80_000;

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
    console.error("[analytics-alerts] error:", describeError(err));
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
    console.error("[notifications] purge error:", describeError(err));
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
    console.error("[reports] purge error:", describeError(err));
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
    console.error("[audit] purge error:", describeError(err));
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
