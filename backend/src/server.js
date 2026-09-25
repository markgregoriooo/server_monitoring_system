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

// The IP fallback must go through `ipKeyGenerator`, not `req.ip`. Returning a raw IP
// silently discards the ipv6Subnet setting below, and an attacker with any IPv6 /64 could
// then rotate addresses for unlimited budget — which is the whole reason that option is set.
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
  // Agent traffic has its own limiters in routes/servers.js. The heartbeat alone is a
  // post every 2s per server — through the global IP budget it would exhaust it for
  // everyone behind the same address (the campus NAT, or the tunnel) within minutes.
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


// `.trim() ||` rather than `??`: nullish coalescing only catches an ABSENT
// variable, and the common case is a PRESENT but empty one — `TRUST_PROXY=`
// sitting in a .env copied from .env.example. That empty string failed the
// digit test below and reached Express as a string, which it reads as a list
// of trusted IPs, so proxy-addr threw `invalid IP address:` and the process
// died at boot, over and over, before it served a single request. Documented
// as "blank = 2" all along; now that is also what it does.
const TRUST_PROXY = (process.env.TRUST_PROXY ?? "").trim() || "2";
app.set("trust proxy", /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);
const TRUST_PROXY_HOPS = /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : 0;

app.use(globalLimiter);

// Explicit request-body cap. This was `express.json()` — which does apply a 100kb
// default, but an INHERITED default is not a decision: nothing recorded that the
// batch endpoint's 60-sample cap has to keep fitting inside it, so the two limits
// could drift apart in a release note. Stated here, and referenced from the batch
// handler's MAX_BATCH. No `express.urlencoded` is mounted on purpose — every client
// (dashboard, Go agent, ESP32) speaks JSON, so a form parser would be attack surface
// with no consumer.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "100kb" }));

// ─── Handshake attempt budget ─────────────────────────────────────────────────
//
// The global Express limiter CANNOT see this path: Socket.IO answers /socket.io/ on
// the HTTP server directly and the Express app is never invoked, so the one endpoint
// that accepts DEVICE_SECRET had no attempt limit while every HTTP credential path
// had one. Counts REJECTED handshakes only — see services/handshakeLimiter.js for
// why a plain connection cap would lock out the whole campus instead.
// See audits/api-infra-security-2026-08-25.md — A-04.
const HANDSHAKE_MAX_FAILURES = Number(process.env.SOCKET_HANDSHAKE_MAX_FAILURES) || 50;
const handshakeLimiter = createHandshakeLimiter({
  windowMs: 15 * 60 * 1000,
  maxFailures: HANDSHAKE_MAX_FAILURES,
});

// Constant-time equality against DEVICE_SECRET.
//
// `timingSafeEqual` throws when the two buffers differ in length, so the length is
// compared first — which means length itself is still not constant-time. That is
// unavoidable without hashing both sides, and is not the part worth protecting:
// config/env.js enforces a 24-character floor, so the length is a known property of the
// deployment rather than a secret. What this removes is the byte-by-byte prefix oracle.
//
// Returns false when the variable is unset, preserving the previous `secret && …`
// behaviour: no configured secret means no device can authenticate.
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

  // ESP32 device authentication via shared secret.
  //
  // Compared in constant time. `===` on a secret leaks its length and a prefix through
  // timing — the same reason installKeyService.matchesLegacyKey has always used
  // timingSafeEqual for the very same class of value, and the two comparisons should
  // not disagree about how careful to be. The handshake limiter makes the attack
  // expensive rather than impossible; this makes it uninformative. Lengths are checked
  // first because timingSafeEqual THROWS on a length mismatch.
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
    // Refuse a session that has already outlived its absolute ceiling. jwt.verify has
    // only established that THIS TOKEN is unexpired; a token minted just under the cap
    // is still signature-valid for an hour afterwards, and without this check it could
    // open a fresh long-lived socket during that window — re-arming the very thing the
    // sweep was just taught to close. Checked here as well as in the sweep so the
    // connection is never established, rather than established and dropped up to
    // SOCKET_REVOKE_SWEEP_MS later.
    if (sessionPastHardLimit(decoded)) {
      return reject("Session is no longer valid", "session past its absolute age cap");
    }
    socket.user = decoded;
    socket.isDevice = false;
    // Clear the budget: a working dashboard, agent or ESP32 must never accumulate
    // its way into a block on an address shared by everyone behind nginx or the NAT.
    handshakeLimiter.recordSuccess(peer);
    next();
  } catch (err) {
    // Same reasoning as middleware/auth.js: the client gets a bare "Invalid token",
    // the log gets the actual cause. A rejected handshake surfaces in the browser as
    // an opaque 403 on /socket.io/, which says nothing about why.
    console.warn(
      `[AUTH] socket handshake rejected from ${peer} — ${err.name}: ${describeError(err)}`,
    );
    reject("Invalid token", err.name);
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
// Threshold bands live in memory. Start them from the alerts that are still open, or an
// alert left open across a restart could never auto-resolve (see alertsService.seedBands).
alertsService.seedBands().catch((e) => console.error("[alerts] band seeding failed:", e.message));
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
// Which MQ-2 channels are wired and what each is called. Loaded once and cached: it is read
// on EVERY 3s reading to resolve labels and gate ingest, and a per-reading SELECT would put
// the smoke path in front of the same 10-connection pool the pollers and dashboard share.
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
// 5s, not 15s. This interval is PURE LATENCY on top of the heartbeat window: the
// window decides when a server counts as gone, and then the sweep decides how long
// after that anybody hears about it. At 15s a 30s window could take 45s to surface,
// a third of the delay being nothing but the gap between two ticks of a query that
// costs one indexed lookup. See services/reachabilitySweep.js for the other half —
// a host that stops answering ICMP no longer waits for the window at all.
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

// Heartbeat sweep — agents send an empty heartbeat every 2s, so a server that
// dies is noticed after SERVER_HEARTBEAT_TIMEOUT_SEC (6s) instead of the 30s metric
// window above. Every second, because this interval is pure latency on top of that
// timeout, and the check itself is an in-memory map scan — no query unless something
// actually went quiet. Older agents never heartbeat and stay on the sweep above.
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

// Fast offline detection: one ICMP echo per online device every few seconds, which
// can only mark a device DOWN (recovery stays with the full poll that owns it). This
// is what makes an outage surface in seconds instead of at the next SNMP walk.
reachabilitySweep.init(io);

// Fast UPS power watch: output source + battery status every 5s, and an immediate full
// poll the moment either changes — so mains failing is reported in seconds, not at the
// next 60s poll. See services/upsPowerWatch.js.
upsPowerWatch.init(io);

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
