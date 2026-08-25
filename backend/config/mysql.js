import "./env.js";
import mysql from "mysql2";

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  port: process.env.DB_PORT || 3306,
  // connectTimeout covers CONNECTING only — it is not a query timeout. mysql2 has no
  // per-query timeout option, so a slow query holds its pool connection until the server
  // answers. See services that need one: they must pass their own guard.
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

const db = pool.promise();

export default db;


