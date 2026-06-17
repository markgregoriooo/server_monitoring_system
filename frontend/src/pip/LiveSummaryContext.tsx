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

export interface LiveSummary {
  connected: boolean;
  env: EnvLive | null;
  servers: ServerLive[];
  aircons: AirconLive[];
  // derived conveniences
  serversOnline: number;
  serversTotal: number;
  worstCpu: number | null;
  worstMem: number | null;
  airconsOn: number;
  airconsTotal: number;
}

const LiveSummaryContext = createContext<LiveSummary | null>(null);

export function LiveSummaryProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [connected, setConnected] = useState(socket.connected);
  const [env, setEnv] = useState<EnvLive | null>(null);
  const [servers, setServers] = useState<ServerLive[]>([]);
  const [aircons, setAircons] = useState<AirconLive[]>([]);

  useEffect(() => {
    if (!user) {
      setEnv(null);
      setServers([]);
      setAircons([]);
      return;
    }
    let alive = true;

    const seedServers = () =>
      api.getServers().then((r) => {
        if (alive && r.success && r.data) setServers((r.data.servers ?? []) as ServerLive[]);
      });
    seedServers();
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onAircon = (d: any) => {
      const a = d?.aircon;
      if (!a) return;
      setAircons((prev) =>
        prev.some((x) => x.id === a.id) ? prev.map((x) => (x.id === a.id ? { ...x, ...a } : x)) : [...prev, a],
      );
    };

    const onConnect = () => {
      setConnected(true);
      seedServers(); // re-sync lists after a reconnect so nothing is stale
    };
    const onDisconnect = () => setConnected(false);

    socket.on("sensorData", onSensor);
    socket.on("serverMetrics", onMetrics);
    socket.on("serverStatus", onStatus);
    socket.on("serverRemoved", onRemoved);
    socket.on("airconStatus", onAircon);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    setConnected(socket.connected);

    return () => {
      alive = false;
      socket.off("sensorData", onSensor);
      socket.off("serverMetrics", onMetrics);
      socket.off("serverStatus", onStatus);
      socket.off("serverRemoved", onRemoved);
      socket.off("airconStatus", onAircon);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
    };
  }, [user]);

  const value = useMemo<LiveSummary>(() => {
    const online = servers.filter((s) => s.status !== "Offline");
    return {
      connected,
      env,
      servers,
      aircons,
      serversOnline: online.length,
      serversTotal: servers.length,
      worstCpu: online.length ? Math.max(...online.map((s) => s.cpu)) : null,
      worstMem: online.length ? Math.max(...online.map((s) => s.memory)) : null,
      airconsOn: aircons.filter((a) => a.enabled).length,
      airconsTotal: aircons.length,
    };
  }, [connected, env, servers, aircons]);

  return <LiveSummaryContext.Provider value={value}>{children}</LiveSummaryContext.Provider>;
}

export function useLiveSummary(): LiveSummary {
  const ctx = useContext(LiveSummaryContext);
  if (!ctx) throw new Error("useLiveSummary must be used within LiveSummaryProvider");
  return ctx;
}
