import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import { useAuth } from "../context/AuthContext";
import { normalizeStatus } from "../utils/envThresholds";

// One live summary, subscribed once here and shared through context, so widget tiles
// do not each open their own socket listeners. Uses the same streams as the Dashboard
// (sensorData / serverMetrics / serverStatus / serverRemoved / airconStatus).

export interface EnvLive {
  temperature: number;
  humidity: number;
  gas: number; // max of the two MQ-2 sensors (ppm)
  smokeStatus: string;
  envStatus: string;
  updatedAt: number;
}
export interface ServerLive {
  id: number;
  name: string;
  status: string;
  cpu: number;
  memory: number;
}
export interface AirconLive {
  id: number;
  name?: string;
  enabled: boolean;
  mode?: string;
}
// One UPS. `onBattery` is the field that matters most on a glance surface: it means
// mains is gone and `runtimeMin` is a countdown, not a steady-state reading.
export interface UpsLive {
  id: number;
  name: string;
  status: string;
  chargePct: number | null;
  runtimeMin: number | null;
  loadPct: number | null;
  onBattery: boolean | null;
}
// One router — SNMP or MikroTik. `type` is carried so a tile can tell them apart;
// both arrive on the SAME `networkMetrics` event (the collectors share it).
export interface NetLive {
  id: number;
  name: string;
  type: string; // "router" | "mikrotik"
  status: string;
  portsUp: number;
  portsTotal: number;
  worstUtil: number | null;
  // How this router is collected. "ping" = no SNMP community, so it has NO ports and
  // never will — its 0/0 is not a fault, and a tile must not paint it as one.
  mode: "snmp" | "ping";
  latencyMs: number | null;   // ICMP, present in both modes
  packetLossPct: number | null;
}

export interface LiveSummary {
  connected: boolean;
  env: EnvLive | null;
  servers: ServerLive[];
  aircons: AirconLive[];
  upsList: UpsLive[];
  routers: NetLive[];
  // derived conveniences
  serversOnline: number;
  serversTotal: number;
  worstCpu: number | null;
  worstMem: number | null;
  airconsOn: number;
  airconsTotal: number;
  // UPS: the worst case across the fleet, since one unit on battery is the headline
  // regardless of how many are healthy.
  upsOnBattery: number;
  lowestCharge: number | null;
  lowestRuntime: number | null;
  // Routers: ports are what actually carry traffic, so count those rather than devices.
  routersOnline: number;
  routersTotal: number;
  portsUp: number;
  portsTotal: number;
  // Ping-only routers among them. A tile showing "0/0 ports" for these would read as
  // three dead links rather than as three devices that have no ports to report.
  pingOnlyRouters: number;
  // Per stream: nothing heard for a suspiciously long time. A stream that has never
  // sent data is empty, not stale; the tiles already show "No UPS" / "—".
  stale: Record<StreamKey, boolean>;
}

// ─── Staleness ────────────────────────────────────────────────────────────────
// The connection dot shows the socket, not each source. If a collector dies while the
// socket stays up (the SNMP poller crashing, the ESP32 dropping off), nothing reports
// it and a tile would keep showing its last value. So each stream has its own
// timeout, a generous multiple of its normal interval (one missed sample is normal).
// Device failures are covered elsewhere; this catches a collector that is gone.
export type StreamKey = "env" | "servers" | "ups" | "network";

const STALE_AFTER_MS: Record<StreamKey, number> = {
  env: 60_000, // ESP32 pushes every ~3s
  servers: 210_000, // Go agents push every 10s by default, but -interval is PER AGENT
  //                   and 60s is a supported setting — 3x that, plus slack
  ups: 240_000, // SNMP poll ~60s
  network: 240_000, // SNMP ~60s / RouterOS ~30s
};

// How often staleness is re-evaluated. It cannot be derived on render alone: the whole
// point is detecting that NOTHING arrived, so without a tick the flag would never flip.
const STALE_TICK_MS = 10_000;

const LiveSummaryContext = createContext<LiveSummary | null>(null);

// REST rows and socket payloads use the same field names, so one mapper serves both
// (see UpsMonitoring.mapUps / NetworkMonitoring.mapNet).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapUps(r: any): UpsLive {
  return {
    id: Number(r.id),
    name: r.name ?? "—",
    status: r.status ?? "Offline",
    chargePct: r.batteryChargePct ?? null,
    runtimeMin: r.runtimeRemainingMin ?? null,
    loadPct: r.loadPct ?? null,
    onBattery: r.onBattery ?? null,
  };
}

// `fallbackType` is only used when the payload has no `type` (the SNMP list endpoint
// does not set one; networkMetrics always does).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapNet(r: any, fallbackType = "router"): NetLive {
  const ifaces: any[] = Array.isArray(r.interfaces) ? r.interfaces : [];
  const utils = ifaces
    .filter((i) => i.linkUp && i.utilizationPct != null && Number.isFinite(Number(i.utilizationPct)))
    .map((i) => Number(i.utilizationPct));
  return {
    id: Number(r.id),
    name: r.name ?? "—",
    type: r.type ?? fallbackType,
    status: r.status ?? "Offline",
    portsUp: ifaces.filter((i) => i.linkUp).length,
    portsTotal: ifaces.length,
    worstUtil: utils.length ? Math.max(...utils) : null,
    mode: r.mode === "ping" ? "ping" : "snmp",
    latencyMs: r.latencyMs ?? null,
    packetLossPct: r.packetLossPct ?? null,
  };
}

export function LiveSummaryProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [connected, setConnected] = useState(socket.connected);
  const [env, setEnv] = useState<EnvLive | null>(null);
  const [servers, setServers] = useState<ServerLive[]>([]);
  const [aircons, setAircons] = useState<AirconLive[]>([]);
  const [upsList, setUpsList] = useState<UpsLive[]>([]);
  const [routers, setRouters] = useState<NetLive[]>([]);
  // Last time each stream sent anything. null = nothing yet (empty, not stale). A REST
  // seed counts, so a newly opened widget does not look stale until the first push.
  const [lastAt, setLastAt] = useState<Record<StreamKey, number | null>>({
    env: null,
    servers: null,
    ups: null,
    network: null,
  });
  const mark = useCallback((k: StreamKey) => setLastAt((p) => ({ ...p, [k]: Date.now() })), []);

  // Re-evaluate on a timer: staleness is the ABSENCE of events, so nothing else would
  // ever trigger the re-render that flips the flag.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), STALE_TICK_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!user) {
      setEnv(null);
      setServers([]);
      setAircons([]);
      setUpsList([]);
      setRouters([]);
      // Logging out must clear the clocks too, or signing back in would show every
      // stream stale until its first sample arrives.
      setLastAt({ env: null, servers: null, ups: null, network: null });
      return;
    }
    let alive = true;

    const seedServers = () =>
      api.getServers().then((r) => {
        if (alive && r.success && r.data) {
          setServers((r.data.servers ?? []) as ServerLive[]);
          mark("servers");
        }
      });
    seedServers();

    // UPS and routers are polled (60s SNMP / 30s RouterOS), so the first event may take a
    // while. Seed from REST so a new widget shows values right away. MikroTiks come from
    // their own endpoint but go into the same `routers` list.
    const seedUps = () =>
      api.getUpsDevices().then((r) => {
        if (alive && r.success && r.data) {
          setUpsList(((r.data.ups ?? r.data.devices ?? []) as any[]).map(mapUps));
          mark("ups");
        }
      });
    const seedRouters = () =>
      Promise.all([api.getNetworkDevices(), api.getMikrotikDevices()]).then(([net, mk]) => {
        if (!alive) return;
        const rows: NetLive[] = [];
        if (net.success && net.data) rows.push(...((net.data.devices ?? []) as any[]).map((d) => mapNet(d, "router")));
        if (mk.success && mk.data) rows.push(...((mk.data.devices ?? []) as any[]).map((d) => mapNet(d, "mikrotik")));
        setRouters(rows);
        mark("network");
      });
    seedUps();
    seedRouters();
    api.getAircon().then((r) => {
      if (!alive || !r.success || !r.data) return;
      const units: AirconLive[] = Array.isArray(r.data.aircons)
        ? r.data.aircons
        : r.data.aircon
          ? [r.data.aircon]
          : [];
      setAircons(units);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onSensor = (d: any) => {
      setEnv({
        temperature: d.temperature,
        humidity: d.humidity,
        gas: Math.max(Number(d.mq2_1_ppm ?? 0), Number(d.mq2_2_ppm ?? 0)),
        // Folds the legacy DANGER spelling into CRITICAL — the tiles colour by an exact
        // match and fall through to green, so an unmapped status reads as "all clear".
        smokeStatus: normalizeStatus(d.smoke_status) ?? "NORMAL",
        envStatus: normalizeStatus(d.environment_status) ?? "NORMAL",
        updatedAt: Date.now(),
      });
      mark("env");
    };

    // serverMetrics arrives as a single-server update: { server: {...} }. Merge by id.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onMetrics = (data: any) => {
      const sv = data?.server;
      if (!sv) return;
      const incoming: ServerLive = {
        id: Number(sv.id),
        name: sv.name ?? "—",
        status: sv.status ?? "Online",
        cpu: Math.round(sv.cpuPercent ?? 0),
        memory: Math.round(sv.memPercent ?? 0),
      };
      setServers((prev) => {
        const idx = prev.findIndex((s) => s.id === incoming.id);
        if (idx === -1) return [...prev, incoming];
        const next = [...prev];
        next[idx] = { ...next[idx], ...incoming };
        return next;
      });
      mark("servers");
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onStatus = (d: any) =>
      setServers((prev) =>
        prev.map((s) =>
          s.id === Number(d?.id)
            ? d.status === "Offline"
              ? { ...s, status: "Offline", cpu: 0, memory: 0 }
              : { ...s, status: d.status }
            : s,
        ),
      );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onRemoved = (d: any) => setServers((prev) => prev.filter((s) => s.id !== Number(d?.id)));

    // Admin renamed a server → update its label live in the widget too.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onRenamed = (d: any) =>
      setServers((prev) => prev.map((s) => (s.id === Number(d?.id) ? { ...s, name: d.name } : s)));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onAircon = (d: any) => {
      const a = d?.aircon;
      if (!a) return;
      setAircons((prev) =>
        prev.some((x) => x.id === a.id) ? prev.map((x) => (x.id === a.id ? { ...x, ...a } : x)) : [...prev, a],
      );
    };

    // ── UPS (SNMP poll, ~60s) ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onUps = (d: any) => {
      const u = d?.ups;
      if (!u) return;
      const incoming = mapUps(u);
      setUpsList((prev) => {
        const idx = prev.findIndex((x) => x.id === incoming.id);
        if (idx === -1) return [...prev, incoming];
        const next = [...prev];
        next[idx] = { ...next[idx], ...incoming };
        return next;
      });
      mark("ups");
    };
    // Unreachable: clear the live values instead of leaving the last charge, which would
    // look like a healthy UPS.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onUpsStatus = (d: any) =>
      setUpsList((prev) =>
        prev.map((u) =>
          u.id === Number(d?.id)
            ? d?.status === "Offline"
              ? { ...u, status: "Offline", chargePct: null, runtimeMin: null, loadPct: null, onBattery: null }
              : { ...u, status: d?.status }
            : u,
        ),
      );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onUpsRemoved = (d: any) => setUpsList((prev) => prev.filter((u) => u.id !== Number(d?.id)));

    // ── Routers: SNMP *and* MikroTik both arrive here (shared collector events) ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onNet = (d: any) => {
      const dev = d?.device;
      if (!dev) return;
      const incoming = mapNet(dev);
      setRouters((prev) => {
        const idx = prev.findIndex((x) => x.id === incoming.id);
        const row = idx === -1 ? undefined : prev[idx];
        if (!row) return [...prev, incoming];
        const next = [...prev];
        // A payload without `interfaces` (e.g. after a connection edit) must not clear the port
        // counts, so only take port fields when the sample has them.
        next[idx] = dev.interfaces
          ? { ...row, ...incoming }
          : { ...row, name: incoming.name, status: incoming.status, type: incoming.type };
        return next;
      });
      mark("network");
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onNetStatus = (d: any) =>
      setRouters((prev) =>
        prev.map((r) =>
          r.id === Number(d?.id)
            ? d?.status === "Offline"
              // Latency goes null (nothing measured) and loss goes to 100 (nothing came back), as in
              // icmpPing's down result; 0 ms would look falsely good.
              ? { ...r, status: "Offline", portsUp: 0, worstUtil: null, latencyMs: null, packetLossPct: 100 }
              : { ...r, status: d?.status }
            : r,
        ),
      );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onNetRemoved = (d: any) => setRouters((prev) => prev.filter((r) => r.id !== Number(d?.id)));

    const onConnect = () => {
      setConnected(true);
      // re-sync lists after a reconnect so nothing is stale. Matters more for the
      // POLLED sources: a missed push can be a full minute from being corrected.
      seedServers();
      seedUps();
      seedRouters();
    };
    const onDisconnect = () => setConnected(false);

    socket.on("sensorData", onSensor);
    socket.on("serverMetrics", onMetrics);
    socket.on("serverStatus", onStatus);
    socket.on("serverRemoved", onRemoved);
    socket.on("serverRenamed", onRenamed);
    socket.on("airconStatus", onAircon);
    socket.on("upsMetrics", onUps);
    socket.on("upsStatus", onUpsStatus);
    socket.on("upsRemoved", onUpsRemoved);
    socket.on("networkMetrics", onNet);
    socket.on("networkStatus", onNetStatus);
    socket.on("networkRemoved", onNetRemoved);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    setConnected(socket.connected);

    return () => {
      alive = false;
      socket.off("sensorData", onSensor);
      socket.off("serverMetrics", onMetrics);
      socket.off("serverStatus", onStatus);
      socket.off("serverRemoved", onRemoved);
      socket.off("serverRenamed", onRenamed);
      socket.off("airconStatus", onAircon);
      socket.off("upsMetrics", onUps);
      socket.off("upsStatus", onUpsStatus);
      socket.off("upsRemoved", onUpsRemoved);
      socket.off("networkMetrics", onNet);
      socket.off("networkStatus", onNetStatus);
      socket.off("networkRemoved", onNetRemoved);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
    // `mark` is a stable useCallback, so this still re-subscribes only on login/logout.
  }, [user, mark]);

  // A stream with no data yet is not stale (it is empty); only one that was reporting and
  // then went quiet counts.
  const isStale = useCallback(
    (k: StreamKey) => {
      const at = lastAt[k];
      return at != null && nowTick - at > STALE_AFTER_MS[k];
    },
    [lastAt, nowTick],
  );

  const value = useMemo<LiveSummary>(() => {
    const online = servers.filter((s) => s.status !== "Offline");
    // Only reachable units carry a meaningful reading — an offline UPS reports null,
    // and including it would drag "lowest charge" to a number nobody measured.
    const upsOnline = upsList.filter((u) => u.status !== "Offline");
    const charges = upsOnline.map((u) => u.chargePct).filter((v): v is number => v != null);
    const runtimes = upsOnline.map((u) => u.runtimeMin).filter((v): v is number => v != null);
    return {
      connected,
      env,
      servers,
      aircons,
      upsList,
      routers,
      serversOnline: online.length,
      serversTotal: servers.length,
      worstCpu: online.length ? Math.max(...online.map((s) => s.cpu)) : null,
      worstMem: online.length ? Math.max(...online.map((s) => s.memory)) : null,
      airconsOn: aircons.filter((a) => a.enabled).length,
      airconsTotal: aircons.length,
      upsOnBattery: upsList.filter((u) => u.onBattery === true).length,
      lowestCharge: charges.length ? Math.min(...charges) : null,
      lowestRuntime: runtimes.length ? Math.min(...runtimes) : null,
      routersOnline: routers.filter((r) => r.status !== "Offline").length,
      routersTotal: routers.length,
      portsUp: routers.reduce((n, r) => n + r.portsUp, 0),
      portsTotal: routers.reduce((n, r) => n + r.portsTotal, 0),
      pingOnlyRouters: routers.filter((r) => r.mode === "ping").length,
      stale: {
        env: isStale("env"),
        servers: isStale("servers"),
        ups: isStale("ups"),
        network: isStale("network"),
      },
    };
  }, [connected, env, servers, aircons, upsList, routers, isStale]);

  return <LiveSummaryContext.Provider value={value}>{children}</LiveSummaryContext.Provider>;
}

export function useLiveSummary(): LiveSummary {
  const ctx = useContext(LiveSummaryContext);
  if (!ctx) throw new Error("useLiveSummary must be used within LiveSummaryProvider");
  return ctx;
}
