// ─── RouterOS API client (live MikroTik reads) ────────────────────────────────
//
// Thin wrapper over `node-routeros`, LAZY-loaded so the app still starts if the
// dependency isn't installed yet (the MikroTik just reports offline). Install with:
//   cd backend && npm install node-routeros
//
// Returns the SAME sample shape snmpPollerService.collectRouter() produces, so the
// poller can hand it straight to writeNetworkSample() (shared with the SNMP path) —
// except MikroTik fills cpuPercent / memPercent / connectedClients (SNMP leaves null).
//
// ⚠️ The exact RouterOS command words/props below are best-effort and should be
//    confirmed against the dev MikroTik in Phase 2 (see mikrotik-dev-setup.md).

import { readFileSync } from "fs";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function toBig(v) {
  try {
    return BigInt(String(v ?? "0").trim() || "0");
  } catch {
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
  return num(v);
}

// ─── API-SSL (port 8729) ────────────────────────────────────────────────────────
// RouterOS ships a SELF-SIGNED certificate, so strict verification fails against a
// stock router — an empty `{}` (Node's defaults) rejects the handshake, which made the
// use_tls flag effectively unusable. Default to not verifying the chain: the connection
// is still ENCRYPTED, which is the point on a management LAN, we just can't prove the
// peer's identity. Set MIKROTIK_TLS_VERIFY=true once you've installed a CA-signed
// certificate on the router (and point MIKROTIK_TLS_CA at the CA file if it's private).
function tlsOptions() {
  const verify = String(process.env.MIKROTIK_TLS_VERIFY ?? "").toLowerCase() === "true";
  const opts = { rejectUnauthorized: verify };
  const caPath = (process.env.MIKROTIK_TLS_CA ?? "").trim();
  if (verify && caPath) {
    try {
      opts.ca = readFileSync(caPath);
    } catch (err) {
      console.error("[MIKROTIK] cannot read MIKROTIK_TLS_CA:", err.message);
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
  await api.connect();
  return api;
}

// Physical ports only. `/interface/print` returns EVERY logical interface — bridge,
// wlan, vlan, pppoe, lo — so a 5-port router reports 7+ rows and the dashboard invents
// "buildings" that aren't ports at all. In this feature one building = one PHYSICAL
// port, so anything virtual is noise.
//
// Preference order:
//   1. names from /interface/ethernet/print — the definitive list of physical ports
//   2. the `type` column on /interface/print (values like "ether", "bridge", "wlan")
//   3. unfiltered — never blank the page because of a RouterOS-version quirk
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
  const totalMem = num(res?.["total-memory"]);
  const freeMem = num(res?.["free-memory"]);
  const memPercent =
    totalMem && freeMem != null ? Math.max(0, Math.min(100, ((totalMem - freeMem) / totalMem) * 100)) : null;

  const interfaces = physicalOnly(ifaces, ethNames).map((i) => ({
    name: i.name ?? "",
    rxBytes: toBig(i["rx-byte"]),
    txBytes: toBig(i["tx-byte"]),
    rxErrors: num(i["rx-error"]) ?? 0,
    txErrors: num(i["tx-error"]) ?? 0,
    linkUp: i.running === "true" && i.disabled !== "true",
    speedMbps: speeds[i.name] ?? 0,
    // null (not 0) when the topology can't attribute clients to this port, so the UI
    // can show "—" rather than claiming zero devices are connected.
    clients: clientsByIface[i.name] ?? null,
  }));

  return {
    reachable: true,
    uptimeSeconds: parseUptime(res?.uptime),
    cpuPercent: num(res?.["cpu-load"]),
    memPercent,
    connectedClients,
    version: res?.version ?? null,
    boardName: res?.["board-name"] ?? null,
    interfaces,
  };
}

// Poll one MikroTik over the RouterOS API. Throws on a connection failure (the
// poller treats that as "offline"). Returns the shared network sample shape
// (raw cumulative byte counters; the poller derives utilization_pct).
export async function collect(conn) {
  const api = await openApi(conn);
  try {
    const resArr = await api.write("/system/resource/print"); // it gets cpu, mem, version, board, uptime
    const res = Array.isArray(resArr) ? resArr[0] : resArr;
    // `=stats=` asks for the byte/error counters, but not every RouterOS build accepts
    // it as an API attribute (notably several v6 releases) and a rejected word THROWS —
    // which would fail the entire poll and flip the router Offline even though it is
    // perfectly reachable. Try it, then fall back to a plain print.
    let ifaces;
    try {
      ifaces = await api.write("/interface/print", ["=stats="]); // all interfaces + RX/TX bytes, errors
    } catch (err) {
      console.warn("[MIKROTIK] /interface/print =stats= rejected, retrying without it:", err?.message ?? err);
      ifaces = await api.write("/interface/print");
    }

    // Best-effort per-port link speed (for utilization_pct). This same call also gives
    // the definitive list of PHYSICAL ports, which physicalOnly() uses to drop bridge /
    // wlan / vlan rows from /interface/print.
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

    // Connected clients = bound DHCP leases (only if the MikroTik runs DHCP).
    // Two levels: the device TOTAL, plus a per-interface breakdown when the topology
    // allows it. Each lease names its DHCP `server`, and each DHCP server binds to one
    // `interface` — so server→interface + leases-per-server gives clients-per-port.
    // That only resolves when each port has its own DHCP server / subnet; on one flat
    // bridged network every lease belongs to the bridge and there is nothing to split.
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
