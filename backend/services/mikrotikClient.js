// ─── RouterOS API client (MikroTik) ────────────────────────────────
// Wraps node-routeros, loaded lazily so the backend still starts without it (the
// MikroTik then shows offline). Install with:
//   cd backend && npm install node-routeros
//
// Returns the same sample shape as snmpPollerService.collectRouter(), so the
// poller passes it to writeNetworkSample(); MikroTik also fills cpuPercent,
// memPercent and connectedClients.

import { readFileSync } from "fs";
import { describeError } from "../utils/httpError.js";

// Returns null for an unreadable field, so the sample omits it rather than
// storing a wrong zero. N-03.
const numOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Returns 0n on a parse failure, which counterDelta would read as a counter reset
// (like a reboot). Throwing would fail the whole poll over one field, so it still
// returns 0n but logs it once. See audits/error-flow-report-2026-08-25.md (F-03).
let bigParseFailureReported = false;
function toBig(v) {
  try {
    return BigInt(String(v ?? "0").trim() || "0");
  } catch (err) {
    if (!bigParseFailureReported) {
      bigParseFailureReported = true;
      console.warn(
        `[MIKROTIK] unparseable counter value ${JSON.stringify(v)} — treating as 0. ` +
          `Traffic for this interval will read as a counter reset, not as real zero traffic. (${err.message})`,
      );
    }
    return 0n;
  }
}

// RouterOS uptime is like "1w2d3h4m5s" — parse to seconds.
function parseUptime(s) {
  if (!s) return null;
  const m = String(s).match(/(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  if (!m) return null;
  const [, w, d, h, mi, sec] = m.map((x) => Number(x || 0));
  return w * 604800 + d * 86400 + h * 3600 + mi * 60 + sec;
}

// "1Gbps" / "100Mbps" / "10Gbps" → Mbit/s
function parseSpeed(rate) {
  if (!rate) return 0;
  const m = String(rate).match(/([\d.]+)\s*([GMK]?)bps/i);
  if (!m) return 0;
  const val = Number(m[1]);
  const unit = (m[2] || "M").toUpperCase();
  return unit === "G" ? val * 1000 : unit === "K" ? val / 1000 : val;
}

function parseCount(res) {
  // count-only returns [{ ret: "12" }] (or "count")
  const row = Array.isArray(res) ? res[0] : res;
  const v = row?.ret ?? row?.count;
  return numOrNull(v);
}

// ─── API-SSL (port 8729) ────────────────────────────────────────────────────────
// RouterOS ships a self-signed certificate, so strict checking fails on a stock
// router. By default the connection is encrypted but the certificate is not
// verified. Set MIKROTIK_TLS_VERIFY=true after installing a CA-signed certificate
// (and MIKROTIK_TLS_CA for a private CA).
function tlsOptions() {
  const verify = String(process.env.MIKROTIK_TLS_VERIFY ?? "").toLowerCase() === "true";
  const opts = { rejectUnauthorized: verify };
  const caPath = (process.env.MIKROTIK_TLS_CA ?? "").trim();
  if (verify && caPath) {
    try {
      opts.ca = readFileSync(caPath);
    } catch (err) {
      console.error("[MIKROTIK] cannot read MIKROTIK_TLS_CA:", describeError(err));
    }
  }
  return opts;
}

async function openApi(conn) {
  let RouterOSAPI;
  try {
    ({ RouterOSAPI } = await import("node-routeros"));
  } catch {
    throw new Error(
      "node-routeros not installed — run `npm install node-routeros` in backend/",
    );
  }
  const api = new RouterOSAPI({
    host: conn.host,
    user: conn.user,
    password: conn.password,
    port: conn.port || 8728,
    timeout: Math.max(1, Math.ceil((conn.timeout || 5000) / 1000)), // node-routeros uses seconds
    tls: conn.tls ? tlsOptions() : undefined,
  });
  // Crash guard. node-routeros's onError emits 'error' and then destroy(), which
  // removes all listeners; if destroying the socket raises another error, nobody is
  // listening and the whole backend process crashes. So a listener is re-attached
  // after destroy.
  api.on("error", () => {});
  const connecting = api.connect(); // creates api.connector synchronously
  const connector = api.connector;
  if (connector) {
    const keepAlive = () => {};
    connector.on("error", keepAlive);
    const originalRemoveAll = connector.removeAllListeners.bind(connector);
    connector.removeAllListeners = (...args) => {
      const result = originalRemoveAll(...args);
      connector.on("error", keepAlive); // re-arm so step 3 always has a listener
      return result;
    };
  }
  await connecting;
  return api;
}

// Physical ports only: /interface/print also lists bridge, wlan, vlan, pppoe and
// lo, which are not buildings. In order of preference:
//   1. names from /interface/ethernet/print (the physical ports)
//   2. the `type` column on /interface/print ("ether", "bridge", "wlan", ...)
//   3. unfiltered, so a RouterOS version quirk never blanks the page
function physicalOnly(ifaces, ethNames) {
  const all = Array.isArray(ifaces) ? ifaces : [];
  if (ethNames && ethNames.size) {
    const kept = all.filter((i) => ethNames.has(i.name));
    if (kept.length) return kept;
  }
  const byType = all.filter((i) => String(i.type ?? "").startsWith("ether"));
  return byType.length ? byType : all;
}

function shape(res, ifaces, speeds, connectedClients, ethNames, clientsByIface = {}) {
  const totalMem = numOrNull(res?.["total-memory"]);
  const freeMem = numOrNull(res?.["free-memory"]);
  const memPercent =
    totalMem && freeMem != null ? Math.max(0, Math.min(100, ((totalMem - freeMem) / totalMem) * 100)) : null;

  const interfaces = physicalOnly(ifaces, ethNames).map((i) => ({
    name: i.name ?? "",
    rxBytes: toBig(i["rx-byte"]),
    txBytes: toBig(i["tx-byte"]),
    rxErrors: numOrNull(i["rx-error"]) ?? 0,
    txErrors: numOrNull(i["tx-error"]) ?? 0,
    // Carrier and admin state are kept separate, so a port disabled on purpose is not
    // reported like a cable coming out. linkAlertPolicy uses both.
    linkUp: i.running === "true",
    adminUp: i.disabled !== "true",
    speedMbps: speeds[i.name] ?? 0,
    // null (not 0) when the topology can't attribute clients to this port, so the UI
    // can show "—" rather than claiming zero devices are connected.
    clients: clientsByIface[i.name] ?? null,
  }));

  return {
    reachable: true,
    uptimeSeconds: parseUptime(res?.uptime),
    cpuPercent: numOrNull(res?.["cpu-load"]),
    memPercent,
    connectedClients,
    version: res?.version ?? null,
    boardName: res?.["board-name"] ?? null,
    interfaces,
  };
}

// Poll one MikroTik over the API. Throws on a connection failure (the poller marks
// it offline). Returns the shared sample shape with raw byte counters.
export async function collect(conn) {
  const api = await openApi(conn);
  try {
    const resArr = await api.write("/system/resource/print"); // it gets cpu, mem, version, board, uptime
    const res = Array.isArray(resArr) ? resArr[0] : resArr;
    // Some RouterOS versions (several v6 releases) reject `=stats=` and throw, which
    // would mark a working router offline. Try it, then fall back to a plain print.
    let ifaces;
    try {
      ifaces = await api.write("/interface/print", ["=stats="]); // all interfaces + RX/TX bytes, errors
    } catch (err) {
      console.warn("[MIKROTIK] /interface/print =stats= rejected, retrying without it:", err?.message ?? err);
      ifaces = await api.write("/interface/print");
    }

    // Per-port link speed (for utilization_pct). The same call gives the list of
    // physical ports used by physicalOnly().
    const speeds = {};
    const ethNames = new Set();
    try {
      const eth = await api.write("/interface/ethernet/print"); // it gets port speeds, e.g. Ether1 1Gbps -> 1000mbps
      for (const e of Array.isArray(eth) ? eth : []) {
        if (e.name) ethNames.add(e.name);
        speeds[e.name] = parseSpeed(e.rate || e.speed);
      }
    } catch {
      /* not all interfaces are ethernet */
    }

    // Connected clients = bound DHCP leases (if the MikroTik runs DHCP). Gives the total
    // and, when each port has its own DHCP server, a per-port count (lease → server →
    // interface). On one flat bridged network all leases belong to the bridge.
    let connectedClients = null;
    let clientsByIface = {};
    try {
      const leases = await api.write("/ip/dhcp-server/lease/print", ["?status=bound"]);
      const rows = Array.isArray(leases) ? leases : [];
      connectedClients = rows.length;

      const servers = await api.write("/ip/dhcp-server/print");
      const serverIface = {};
      for (const s of Array.isArray(servers) ? servers : []) {
        if (s.name && s.interface) serverIface[s.name] = s.interface;
      }
      for (const l of rows) {
        const iface = serverIface[l.server];
        if (!iface) continue;
        clientsByIface[iface] = (clientsByIface[iface] ?? 0) + 1;
      }
    } catch {
      // No DHCP server on this router, or the lease list is unreadable — fall back to
      // the cheap count-only total rather than losing the metric entirely.
      try {
        const c = await api.write("/ip/dhcp-server/lease/print", ["?status=bound", "=count-only="]);
        connectedClients = parseCount(c);
      } catch {
        /* leave null */
      }
      clientsByIface = {};
    }

    return shape(res, ifaces, speeds, connectedClients, ethNames, clientsByIface);
  } finally {
    try {
      api.close();
    } catch {
      /* ignore */
    }
  }
}

// Lightweight identity read used by the "Test connection" admin action.
export async function testConnection(conn) {
  const api = await openApi(conn);
  try {
    const resArr = await api.write("/system/resource/print");
    const res = Array.isArray(resArr) ? resArr[0] : resArr;
    return { version: res?.version ?? null, boardName: res?.["board-name"] ?? null };
  } finally {
    try {
      api.close();
    } catch {
      /* ignore */
    }
  }
}

export default { collect, testConnection };
