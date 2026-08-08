import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import { useAuth } from "../context/AuthContext";

// One live summary, subscribed ONCE here and shared via context, so any number of
// widget tiles read the same state without each opening its own socket listeners.
// Consumes the exact streams the Dashboard already gets (sensorData / serverMetrics /
// serverStatus / serverRemoved / airconStatus) — see pages/Dashboard.tsx.

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
}

const LiveSummaryContext = createContext<LiveSummary | null>(null);

// REST rows and socket payloads carry the same field names for these, so one mapper
// serves both paths (see UpsMonitoring.mapUps / NetworkMonitoring.mapNet).
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

// `fallbackType` is used only when the payload omits `type` — the SNMP list endpoint
// doesn't stamp one, while the shared networkMetrics event always does.
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

  useEffect(() => {
    if (!user) {
      setEnv(null);
      setServers([]);
      setAircons([]);
      setUpsList([]);
      setRouters([]);
      return;
    }
    let alive = true;

    const seedServers = () =>
      api.getServers().then((r) => {
        if (alive && r.success && r.data) setServers((r.data.servers ?? []) as ServerLive[]);
      });
    seedServers();

    // UPS + routers are POLLED server-side (60s SNMP / 30s RouterOS), so unlike the
    // push streams there may be a long wait before the first event. Seed from REST so
    // a freshly-opened widget shows real values immediately instead of dashes.
    // MikroTiks come from their own endpoint but merge into the same `routers` list —
    // they share the networkMetrics/networkStatus events downstream.
    const seedUps = () =>
      api.getUpsDevices().then((r) => {
        if (alive && r.success && r.data) setUpsList(((r.data.ups ?? r.data.devices ?? []) as any[]).map(mapUps));
      });
    const seedRouters = () =>
      Promise.all([api.getNetworkDevices(), api.getMikrotikDevices()]).then(([net, mk]) => {
        if (!alive) return;
        const rows: NetLive[] = [];
        if (net.success && net.data) rows.push(...((net.data.devices ?? []) as any[]).map((d) => mapNet(d, "router")));
        if (mk.success && mk.data) rows.push(...((mk.data.devices ?? []) as any[]).map((d) => mapNet(d, "mikrotik")));
        setRouters(rows);
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
    const onSensor = (d: any) =>
      setEnv({
        temperature: d.temperature,
        humidity: d.humidity,
        gas: Math.max(Number(d.mq2_1_ppm ?? 0), Number(d.mq2_2_ppm ?? 0)),
        smokeStatus: d.smoke_status ?? "NORMAL",
        envStatus: d.environment_status ?? "NORMAL",
        updatedAt: Date.now(),
      });

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
    };
    // Unreachable → zero the live values rather than leaving the last-known charge on
    // screen, which would read as a healthy UPS that simply stopped being polled.
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
        // A payload without `interfaces` (e.g. a connection edit, which re-emits the
        // device) must not wipe the port counts, so only take the port fields when this
        // sample actually carried them.
        next[idx] = dev.interfaces
          ? { ...row, ...incoming }
          : { ...row, name: incoming.name, status: incoming.status, type: incoming.type };
        return next;
      });
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onNetStatus = (d: any) =>
      setRouters((prev) =>
        prev.map((r) =>
          r.id === Number(d?.id)
            ? d?.status === "Offline"
              ? { ...r, status: "Offline", portsUp: 0, worstUtil: null }
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
  }, [user]);

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
    };
  }, [connected, env, servers, aircons, upsList, routers]);

  return <LiveSummaryContext.Provider value={value}>{children}</LiveSummaryContext.Provider>;
}

export function useLiveSummary(): LiveSummary {
  const ctx = useContext(LiveSummaryContext);
  if (!ctx) throw new Error("useLiveSummary must be used within LiveSummaryProvider");
  return ctx;
}
