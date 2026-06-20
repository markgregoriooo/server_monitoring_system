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
    tls: conn.tls ? {} : undefined,
  });
  await api.connect();
  return api;
}

function shape(res, ifaces, speeds, connectedClients) {
  const totalMem = num(res?.["total-memory"]);
  const freeMem = num(res?.["free-memory"]);
  const memPercent =
    totalMem && freeMem != null ? Math.max(0, Math.min(100, ((totalMem - freeMem) / totalMem) * 100)) : null;

  const interfaces = (Array.isArray(ifaces) ? ifaces : []).map((i) => ({
    name: i.name ?? "",
    rxBytes: toBig(i["rx-byte"]),
    txBytes: toBig(i["tx-byte"]),
    rxErrors: num(i["rx-error"]) ?? 0,
    txErrors: num(i["tx-error"]) ?? 0,
    linkUp: i.running === "true" && i.disabled !== "true",
    speedMbps: speeds[i.name] ?? 0,
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
    const resArr = await api.write("/system/resource/print");
    const res = Array.isArray(resArr) ? resArr[0] : resArr;
    const ifaces = await api.write("/interface/print", ["=stats="]);

    // Best-effort per-port link speed (for utilization_pct).
    const speeds = {};
    try {
      const eth = await api.write("/interface/ethernet/print");
      for (const e of Array.isArray(eth) ? eth : []) speeds[e.name] = parseSpeed(e.rate || e.speed);
    } catch {
      /* not all interfaces are ethernet */
    }

    // Connected clients = bound DHCP leases (only if the MikroTik runs DHCP).
    let connectedClients = null;
    try {
      const leases = await api.write("/ip/dhcp-server/lease/print", ["?status=bound", "=count-only="]);
      connectedClients = parseCount(leases);
    } catch {
      /* DHCP not on this router → leave null */
    }

    return shape(res, ifaces, speeds, connectedClients);
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
