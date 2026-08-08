import { useEffect, useState } from "react";
import type { FC, ReactNode } from "react";
import { useLiveSummary } from "../LiveSummaryContext";
import { useNotifications } from "../../context/NotificationContext";
import { SEVERITY_COLOR } from "../../components/notifications/notificationUtils";

// ── The tile catalog: every tile a user can put on the widget. Each is a tiny FC
// that reads the shared live hooks. The saved layout is just an ordered list of these
// ids (PipWidget / WidgetBuilder), so adding a tile later = one entry here. ──

// Grafana status colors (CLAUDE.md). Thresholds mirror Dashboard's helpers — which
// aren't exported — kept here so the PiP bundle doesn't import the whole Dashboard.
const GREEN = "#73BF69";
const ORANGE = "#FF780A";
const RED = "#F2495C";
const BLUE = "#5794F2";
const T_MUTED = "var(--gf-text-muted)";
const T_DIM = "var(--gf-text-dim)";

const tempColor = (t: number) => (t < 22 ? BLUE : t <= 27 ? GREEN : t <= 29 ? ORANGE : RED);
const humColor = (h: number) => (h < 30 || h > 70 ? ORANGE : GREEN);
const loadColor = (v: number) => (v >= 85 ? RED : v >= 65 ? ORANGE : GREEN);
const gasColor = (smoke: string) => (smoke === "DANGER" ? RED : smoke === "WARNING" ? ORANGE : GREEN);

export interface TileDef {
  id: string;
  label: string;
  group: "Environment" | "Servers" | "Network" | "UPS" | "Alerts" | "Aircon" | "General";
  span?: 1 | 2;
  Render: FC;
}

// ── shared tile chrome ──
function Shell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      className="flex flex-col gap-0.5 px-2.5 py-2 h-full"
      style={{ background: "var(--gf-panel)", border: "1px solid var(--gf-panel-border)", borderRadius: 2 }}
    >
      <span className="text-[8px] tracking-widest uppercase" style={{ color: T_MUTED }}>
        {label}
      </span>
      {children}
    </div>
  );
}
function Big({ children, color }: { children: ReactNode; color?: string }) {
  return (
    <span className="text-[15px] font-bold leading-none" style={{ color: color ?? "var(--gf-text-primary)" }}>
      {children}
    </span>
  );
}
const Dim = () => (
  <span className="text-[15px] font-bold leading-none" style={{ color: T_DIM }}>
    —
  </span>
);

// ── Environment ──
const TempTile: FC = () => {
  const { env } = useLiveSummary();
  return <Shell label="Temp">{env ? <Big color={tempColor(env.temperature)}>{env.temperature.toFixed(1)}°C</Big> : <Dim />}</Shell>;
};
const HumidityTile: FC = () => {
  const { env } = useLiveSummary();
  return <Shell label="Humidity">{env ? <Big color={humColor(env.humidity)}>{Math.round(env.humidity)}%</Big> : <Dim />}</Shell>;
};
const GasTile: FC = () => {
  const { env } = useLiveSummary();
  if (!env) return (
    <Shell label="Gas">
      <Dim />
    </Shell>
  );
  const c = gasColor(env.smokeStatus);
  return (
    <Shell label="Gas">
      <Big color={c}>
        {Math.round(env.gas)}
        <span className="text-[9px] font-normal"> ppm</span>
      </Big>
      <span className="text-[9px]" style={{ color: c }}>{env.smokeStatus}</span>
    </Shell>
  );
};

// ── Servers ──
const ServersTile: FC = () => {
  const { serversOnline, serversTotal, worstCpu, worstMem } = useLiveSummary();
  return (
    <Shell label="Servers">
      <div className="flex items-baseline gap-1">
        <Big color={serversTotal === 0 ? T_DIM : serversOnline < serversTotal ? ORANGE : GREEN}>
          {serversOnline}/{serversTotal}
        </Big>
        <span className="text-[9px]" style={{ color: T_MUTED }}>online</span>
      </div>
      <span className="text-[9px]" style={{ color: T_MUTED }}>
        worst CPU{" "}
        <b style={{ color: worstCpu != null ? loadColor(worstCpu) : T_DIM }}>{worstCpu != null ? `${worstCpu}%` : "—"}</b>
        {" · "}mem{" "}
        <b style={{ color: worstMem != null ? loadColor(worstMem) : T_DIM }}>{worstMem != null ? `${worstMem}%` : "—"}</b>
      </span>
    </Shell>
  );
};

// Per-server list — ONE line per server so it stays glanceable and bounded (no
// scrolling at realistic counts): status dot + name + exact cpu·mem + a single LOAD
// bar = the worst of the two (the signal that matters at a glance; full breakdown is
// one click away on the Dashboard). Problem-first sort (offline, then busiest) surfaces
// trouble at the top. Divider between rows; names follow the admin display label.
const worstLoad = (s: { cpu: number; memory: number }) => Math.max(s.cpu, s.memory);

const ServerListTile: FC = () => {
  const { servers } = useLiveSummary();
  const rows = [...servers].sort((a, b) => {
    const ao = a.status === "Offline";
    const bo = b.status === "Offline";
    if (ao !== bo) return ao ? -1 : 1;            // offline first
    if (!ao && worstLoad(b) !== worstLoad(a)) return worstLoad(b) - worstLoad(a); // busiest first
    return a.name.localeCompare(b.name);
  });

  return (
    <Shell label="Servers">
      {rows.length === 0 ? (
        <span className="text-[10px]" style={{ color: T_MUTED }}>No servers</span>
      ) : (
        <div className="flex flex-col mt-0.5">
          {/* column header (once) — kills the per-row labels */}
          <div className="flex items-center gap-1.5 pb-0.5">
            <span className="w-1.5 flex-shrink-0" />
            <span className="flex-1" />
            <span className="w-11 text-right text-[7px] tracking-wide whitespace-nowrap" style={{ color: T_DIM }}>CPU·MEM</span>
            <span className="w-12 text-center text-[7px] tracking-wide" style={{ color: T_DIM }}>LOAD</span>
          </div>
          {rows.map((s) => {
            const offline = s.status === "Offline";
            const worst = Math.min(worstLoad(s), 100);
            return (
              <div
                key={s.id}
                className="flex items-center gap-1.5 py-1"
                style={{ borderTop: "1px solid var(--gf-divider)" }}
              >
                <span className="h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ background: offline ? RED : GREEN }} />
                <span className="text-[10px] truncate flex-1" style={{ color: "var(--gf-text-primary)" }} title={s.name}>
                  {s.name}
                </span>
                {offline ? (
                  <span className="text-[8px]" style={{ color: RED }}>offline</span>
                ) : (
                  <>
                    <span className="w-11 text-right text-[8px] tabular-nums whitespace-nowrap">
                      <b style={{ color: loadColor(s.cpu) }}>{s.cpu}</b>
                      <span style={{ color: T_DIM }}>·</span>
                      <b style={{ color: loadColor(s.memory) }}>{s.memory}</b>
                    </span>
                    <div className="w-12 h-1.5 rounded-full overflow-hidden flex-shrink-0" style={{ background: "rgba(127,127,127,0.20)" }}>
                      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${worst}%`, background: loadColor(worst) }} />
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Shell>
  );
};

// ── Alerts ──
const AlertCountTile: FC = () => {
  const { openAlertCount } = useNotifications();
  return (
    <Shell label="Open alerts">
      <Big color={openAlertCount > 0 ? RED : GREEN}>{openAlertCount}</Big>
    </Shell>
  );
};
const LatestAlertTile: FC = () => {
  const { items } = useNotifications();
  const a = items[0];
  return (
    <Shell label="Latest alert">
      {a ? (
        <>
          <span className="text-[10px] font-semibold leading-tight" style={{ color: SEVERITY_COLOR[a.severity] ?? "var(--gf-text-primary)" }}>
            {a.title}
          </span>
          {a.deviceName && (
            <span className="text-[8px] truncate" style={{ color: T_DIM }}>{a.deviceName}</span>
          )}
        </>
      ) : (
        <span className="text-[10px]" style={{ color: T_MUTED }}>No alerts</span>
      )}
    </Shell>
  );
};

// ── UPS ──
// The one metric on this widget with a DEADLINE attached. An alert can tell you mains
// dropped; only this tells you how long you have left, which is the whole reason to
// have it on a glance surface. So "on battery" is the headline and everything else is
// subordinate to it: while discharging, runtime leads and is always red.
//
// Fleet-worst rather than per-unit — one UPS on battery is the story regardless of how
// many others are fine, and the widget has no room for a per-unit list at realistic
// counts. Drill into /ups for the breakdown.
const chargeColor = (pct: number) => (pct < 40 ? RED : pct < 70 ? ORANGE : GREEN);

const UpsTile: FC = () => {
  const { upsList, upsOnBattery, lowestCharge, lowestRuntime } = useLiveSummary();
  if (upsList.length === 0) {
    return (
      <Shell label="UPS">
        <span className="text-[10px]" style={{ color: T_MUTED }}>No UPS</span>
      </Shell>
    );
  }
  const onBattery = upsOnBattery > 0;
  const label = upsList.length > 1 ? `UPS · worst of ${upsList.length}` : "UPS";

  if (onBattery) {
    return (
      <Shell label={label}>
        <div className="flex items-baseline gap-1">
          <Big color={RED}>{lowestRuntime != null ? `${Math.round(lowestRuntime)}` : "—"}</Big>
          <span className="text-[9px]" style={{ color: RED }}>min left</span>
        </div>
        <span className="text-[9px] font-semibold" style={{ color: RED }}>
          ⚡ ON BATTERY{upsOnBattery > 1 ? ` ×${upsOnBattery}` : ""}
          {lowestCharge != null ? ` · ${Math.round(lowestCharge)}%` : ""}
        </span>
      </Shell>
    );
  }
  return (
    <Shell label={label}>
      <div className="flex items-baseline gap-1">
        <Big color={lowestCharge != null ? chargeColor(lowestCharge) : T_DIM}>
          {lowestCharge != null ? `${Math.round(lowestCharge)}%` : "—"}
        </Big>
        <span className="text-[9px]" style={{ color: T_MUTED }}>battery</span>
      </div>
      <span className="text-[9px]" style={{ color: T_MUTED }}>
        {lowestRuntime != null ? `${Math.round(lowestRuntime)} min runtime` : "on mains"}
      </span>
    </Shell>
  );
};

// ── Network (SNMP routers + MikroTik — both arrive on the shared networkMetrics) ──
// Counts PORTS, not devices: a router that answers SNMP while three buildings' links
// are down is "online" by device count and broken by any measure that matters.
const NetworkTile: FC = () => {
  const { routers, routersOnline, routersTotal, portsUp, portsTotal } = useLiveSummary();
  if (routersTotal === 0) {
    return (
      <Shell label="Network">
        <span className="text-[10px]" style={{ color: T_MUTED }}>No routers</span>
      </Shell>
    );
  }
  const routerDown = routersTotal - routersOnline;
  const portsDown = portsTotal - portsUp;
  const worstUtil = routers
    .filter((r) => r.status !== "Offline" && r.worstUtil != null)
    .reduce<number | null>((m, r) => (m == null || (r.worstUtil as number) > m ? (r.worstUtil as number) : m), null);

  return (
    <Shell label="Network">
      <div className="flex items-baseline gap-1">
        <Big color={routerDown > 0 ? RED : portsDown > 0 ? ORANGE : GREEN}>
          {portsUp}/{portsTotal}
        </Big>
        <span className="text-[9px]" style={{ color: T_MUTED }}>ports up</span>
      </div>
      <span className="text-[9px]" style={{ color: routerDown > 0 ? RED : T_MUTED }}>
        {routerDown > 0
          ? `${routerDown} of ${routersTotal} router${routersTotal > 1 ? "s" : ""} offline`
          : `${routersTotal} router${routersTotal > 1 ? "s" : ""} · peak link ${worstUtil != null ? `${Math.round(worstUtil)}%` : "—"}`}
      </span>
    </Shell>
  );
};

// ── Aircon ──
const AirconTile: FC = () => {
  const { airconsOn, airconsTotal } = useLiveSummary();
  return (
    <Shell label="Aircon">
      <div className="flex items-baseline gap-1">
        <Big color={airconsOn > 0 ? GREEN : T_MUTED}>
          {airconsOn}/{airconsTotal}
        </Big>
        <span className="text-[9px]" style={{ color: T_MUTED }}>on</span>
      </div>
    </Shell>
  );
};

// ── General ──
const phTime = () =>
  new Date().toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "2-digit", minute: "2-digit", hour12: false });
const ClockTile: FC = () => {
  const { connected } = useLiveSummary();
  const [now, setNow] = useState(phTime);
  useEffect(() => {
    const t = setInterval(() => setNow(phTime()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <Shell label="Time">
      <Big>{now}</Big>
      <span className="text-[8px]" style={{ color: connected ? GREEN : RED }}>
        {connected ? "● connected" : "● offline"}
      </span>
    </Shell>
  );
};

export const TILE_CATALOG: TileDef[] = [
  { id: "env.temp", label: "Temperature", group: "Environment", span: 1, Render: TempTile },
  { id: "env.humidity", label: "Humidity", group: "Environment", span: 1, Render: HumidityTile },
  { id: "env.gas", label: "Gas", group: "Environment", span: 1, Render: GasTile },
  { id: "servers.summary", label: "Servers summary", group: "Servers", span: 2, Render: ServersTile },
  { id: "servers.list", label: "Server list (names)", group: "Servers", span: 2, Render: ServerListTile },
  { id: "ups.summary", label: "UPS battery", group: "UPS", span: 1, Render: UpsTile },
  { id: "network.summary", label: "Network ports", group: "Network", span: 1, Render: NetworkTile },
  { id: "alerts.count", label: "Open alerts", group: "Alerts", span: 1, Render: AlertCountTile },
  { id: "alerts.latest", label: "Latest alert", group: "Alerts", span: 2, Render: LatestAlertTile },
  { id: "aircon.summary", label: "Aircon", group: "Aircon", span: 1, Render: AirconTile },
  { id: "meta.clock", label: "Clock", group: "General", span: 1, Render: ClockTile },
];

export const TILE_BY_ID = new Map(TILE_CATALOG.map((t) => [t.id, t]));

// Sensible default until the user customizes (Phase 4).
export const DEFAULT_LAYOUT = ["env.temp", "env.humidity", "env.gas", "alerts.count", "servers.list", "alerts.latest"];
