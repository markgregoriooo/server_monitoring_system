import "./env.js";
import mysql from "mysql2";

// ─── Credential sanity check ─────────────────────────────────────────────────
//
// Warn, not throw. An unreachable database is a startup failure the pool already
// reports; a WEAK one connects perfectly and is invisible forever, so the only moment
// anybody will see this is boot.
//
// Two conditions, because they matter for different reasons:
//   • empty DB_PASSWORD — the account authenticates anyone who can reach port 3306.
//     This host holds JWT_SECRET, MIKROTIK_ENC_KEY and the AES-GCM ciphertext those
//     keys open, so "it is only on the LAN" is the same LAN the monitored devices and
//     the Go agents sit on.
//   • DB_USER=root — the XAMPP default. The backend needs SELECT/INSERT/UPDATE/DELETE
//     on one schema and nothing else; running as root means an injection or a stray
//     migration can DROP any database on the server. deployment-guide.md §4.2 creates
//     `cspc_app` for exactly this reason.
//
// Deliberately NOT fatal: a fresh XAMPP install is the documented starting point for
// development, and refusing to boot would block the first run of the system before
// there is anything to protect.
{
  const dbUser = (process.env.DB_USER ?? "").trim();
  const dbPassword = process.env.DB_PASSWORD ?? "";
  if (dbPassword === "") {
    console.warn(
      `[CONFIG] DB_PASSWORD is empty — the MySQL account '${dbUser || "(unset)"}' accepts any ` +
        "connection that can reach the server. Set a password before this host is reachable " +
        "by anything but localhost. See deployment-guide.md §4.2.",
    );
  }
  if (dbUser === "root") {
    console.warn(
      "[CONFIG] DB_USER is 'root' — the backend needs DML on one schema, not administrative " +
        "rights over every database on the server. Create a least-privilege user " +
        "(deployment-guide.md §4.2) before deployment.",
    );
  }
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  port: process.env.DB_PORT || 3306,
  // connectTimeout covers CONNECTING only — it is not a query timeout. mysql2 has no
  // per-query timeout option, so a slow query would hold its pool connection until the
  // server answered. That is now bounded SERVER-side instead — see the statement timeout
  // installed on every new connection below.
  connectTimeout: 10000,
  // Explicit at the previous silent default. Three very different workloads share this
  // pool — the SNMP/MikroTik pollers, the Go agents' metric POSTs, and every dashboard
  // request — and with queueLimit: 0 exhaustion QUEUES rather than errors, so it appears
  // as "the dashboard is slow", never as a pool error in the log.
  // Raise via DB_POOL_SIZE once there is load data; do not guess.
  // See audits/resilience-report-2026-08-25.md — S-03.
  connectionLimit: Number(process.env.DB_POOL_SIZE) || 10,
  queueLimit: 0
});

// ─── Server-side statement timeout ───────────────────────────────────────────
//
// There was no query timeout at EITHER layer: mysql2 has no per-query option, and the
// server's own limit was off (verified: `MAX_STATEMENT_TIME = 0.000000`). So one runaway
// query — a report over a huge period, a missing index after a schema change, a lock
// wait — held one of only `connectionLimit` connections indefinitely. With
// `queueLimit: 0` the pool then QUEUES rather than erroring, so the symptom is "the
// dashboard is slow", never an error anyone can search for. Enough of those and the
// pollers and agent ingest stall behind them: a monitoring system that stops monitoring
// because of a slow SELECT.
//
// Applied per connection because the pool creates them lazily and mysql2 has no
// "run this on connect" option. `max_statement_time` is MariaDB (SECONDS, float);
// `max_execution_time` is MySQL 5.7+ (MILLISECONDS) and applies to SELECTs only. Both
// are attempted and failures are ignored, so this works on either server and degrades
// to the previous behaviour on anything that supports neither.
//
// ⚠️ Deliberately generous. This is a backstop against a query that will never finish,
// not a performance budget — the analytics job legitimately runs multi-second Flux-backed
// work against MySQL, and a tight cap would turn a slow report into a failed one.
// See audits/database-security-2026-08-25.md — DB-02.
const STATEMENT_TIMEOUT_SEC = Number(process.env.DB_STATEMENT_TIMEOUT_SEC) || 30;

pool.on("connection", (conn) => {
  // Fire-and-forget on purpose: a server that rejects the variable must not stop the
  // connection being used. The callback swallows the error rather than crashing the pool.
  conn.query(`SET SESSION max_statement_time = ${Number(STATEMENT_TIMEOUT_SEC)}`, () => {});
  conn.query(`SET SESSION max_execution_time = ${Number(STATEMENT_TIMEOUT_SEC) * 1000}`, () => {});
});

const db = pool.promise();

export default db;


