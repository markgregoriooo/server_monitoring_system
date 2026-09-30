import "./env.js";
import mysql from "mysql2";

// ─── Credential check ───────────────────────────────────────────────────────
// Warn at boot about an empty DB_PASSWORD or DB_USER=root. The backend only needs
// SELECT/INSERT/UPDATE/DELETE on one schema (deployment-guide.md §4.2 creates a
// limited user). A warning, not an error, so a fresh XAMPP dev setup still starts.
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
  // connectTimeout only covers connecting. Query time is limited server-side by the
  // statement timeout set on each connection below.
  connectTimeout: 10000,
  // Shared by the pollers, agent POSTs and dashboard requests. With queueLimit 0 an
  // exhausted pool queues instead of erroring, which shows up as a slow dashboard.
  // Raise with DB_POOL_SIZE if needed. See audits/resilience-report-2026-08-25.md (S-03).
  connectionLimit: Number(process.env.DB_POOL_SIZE) || 10,
  queueLimit: 0
});

// ─── Server-side statement timeout ───────────────────────────────────────────
// mysql2 has no per-query timeout and the server limit was off, so one runaway
// query could hold a pool connection forever. Set on every new connection:
// max_statement_time (MariaDB, seconds) and max_execution_time (MySQL, ms). Errors
// are ignored so it works on either server. The limit is generous on purpose; it
// stops queries that never finish, not slow reports.
// See audits/database-security-2026-08-25.md (DB-02).
const STATEMENT_TIMEOUT_SEC = Number(process.env.DB_STATEMENT_TIMEOUT_SEC) || 30;

pool.on("connection", (conn) => {
  // Not awaited: a server that rejects the variable must not break the connection.
  conn.query(`SET SESSION max_statement_time = ${Number(STATEMENT_TIMEOUT_SEC)}`, () => {});
  conn.query(`SET SESSION max_execution_time = ${Number(STATEMENT_TIMEOUT_SEC) * 1000}`, () => {});
});

const db = pool.promise();

export default db;


