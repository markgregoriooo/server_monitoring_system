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
// `smoke` is normalised upstream in LiveSummaryContext, so CRITICAL is the top band. The
// fallthrough here is GREEN, which is why that normalisation is not cosmetic: an
// unrecognised status would paint a smoke event as clean air.
const gasColor = (smoke: string) => (smoke === "CRITICAL" ? RED : smoke === "WARNING" ? ORANGE : GREEN);

export interface TileDef {
  id: string;
  label: string;
  // One line on what the tile actually shows. Surfaced in the builder — a label alone
  // doesn't distinguish "Network ports" from "Router list", and picking blind means
  // adding a tile, popping out, and coming back to change it.
  description?: string;
  group: "Environment" | "Servers" | "Network" | "UPS" | "Alerts" | "Aircon" | "General";
  span?: 1 | 2;
  Render: FC;
}

// Widget capacity. MUST match MAX_TILES in backend/services/widgetPrefsService.js — the
// server truncates a longer layout on save, so without this the builder would let you
// add a 17th tile and silently lose it.
export const MAX_TILES = 16;

// ── shared tile chrome ──
// `stale` = this tile's data source has gone quiet (see LiveSummaryContext). It dims
// the reading and flags the label rather than hiding the value: the last known number
// is still useful, it just must not be mistaken for a current one. ORANGE, not red —
// "don't trust this" is a warning, not a failure, and red is already spoken for by
// genuine critical states inside the tiles.
function Shell({ label, children, stale = false }: { label: string; children: ReactNode; stale?: boolean }) {
  return (
    <div
      className="flex flex-col gap-0.5 px-2.5 py-2 h-full"
      title={stale ? `${label}: no update recently — value may be out of date` : undefined}
      style={{
        background: "var(--gf-panel)",
        border: "1px solid var(--gf-panel-border)",
        borderRadius: 2,
        // Each reading reads as a raised chip rather than a flat rectangle. The drop
        // shadow separates neighbours in a dense two-column grid, and the inset top
        // highlight (both come from --gf-btn-shadow) gives the surface a lit edge.
        //
        // Static, NOT .gf-raise: tiles aren't pressable, and eight of them each
        // brightening on hover would be noise in a 320px window. The token is only 2px
        // of blur, which is what keeps a grid of small chips from turning muddy.
        //
        // Resolves inside the pop-out too — the PiP document gets our stylesheets
        // cloned into it (pip-widget.md §6.1), so the --gf-* custom properties exist
        // there and follow the theme.
        boxShadow: "var(--gf-btn-shadow)",
      }}
    >
      <span className="flex items-center justify-between gap-1 min-w-0">
        <span className="text-[8px] tracking-widest uppercase truncate" style={{ color: stale ? ORANGE : T_MUTED }}>
          {label}
        </span>
        {stale && (
          <span className="text-[8px] tracking-widest uppercase flex-shrink-0" style={{ color: ORANGE }}>
            stale
          </span>
        )}
      </span>
      {/* Dimmed, not hidden — the last known value is still worth something, it just
          shouldn't read as live. */}
      <div className="flex flex-col gap-0.5 min-w-0" style={{ opacity: stale ? 0.45 : 1 }}>
        {children}
      </div>
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
  const { env, stale } = useLiveSummary();
  return <Shell label="Temp" stale={stale.env}>{env ? <Big color={tempColor(env.temperature)}>{env.temperature.toFixed(1)}°C</Big> : <Dim />}</Shell>;
};
const HumidityTile: FC = () => {
  const { env, stale } = useLiveSummary();
  return <Shell label="Humidity" stale={stale.env}>{env ? <Big color={humColor(env.humidity)}>{Math.round(env.humidity)}%</Big> : <Dim />}</Shell>;
};
const GasTile: FC = () => {
  const { env, stale } = useLiveSummary();
  if (!env) return (
    <Shell label="Gas" stale={stale.env}>
      <Dim />
    </Shell>
  );
  const c = gasColor(env.smokeStatus);
  return (
    <Shell label="Gas" stale={stale.env}>
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
  const { serversOnline, serversTotal, worstCpu, worstMem, stale } = useLiveSummary();
  return (
    <Shell label="Servers" stale={stale.servers}>
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
  const { servers, stale } = useLiveSummary();
  const rows = [...servers].sort((a, b) => {
    const ao = a.status === "Offline";
    const bo = b.status === "Offline";
    if (ao !== bo) return ao ? -1 : 1;            // offline first
    if (!ao && worstLoad(b) !== worstLoad(a)) return worstLoad(b) - worstLoad(a); // busiest first
    return a.name.localeCompare(b.name);
  });

  return (
    <Shell label="Servers" stale={stale.servers}>
      {rows.length === 0 ? (
        <span className="text-[10px]" style={{ color: T_MUTED }}>No servers</span>
      ) : (
        <div className="flex flex-col mt-0.5">
          {/* column header (once) — kills the per-row labels */}
          <div className="flex items-center gap-1.5 pb-0.5">
            <span className="w-1.5 flex-shrink-0" />
            <span className="flex-1" />
            <span className="w-14 text-right text-[8px] tracking-wide whitespace-nowrap" style={{ color: T_DIM }}>CPU·MEM</span>
            <span className="w-12 text-center text-[8px] tracking-wide" style={{ color: T_DIM }}>LOAD</span>
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
                  <span className="text-[10px]" style={{ color: RED }}>offline</span>
                ) : (
                  // The numbers ARE the measurement, so they lead the row — they were
                  // 8px, smaller than the server name beside them. w-14 (not w-11) so
                  // a double-digit pair like "100·100" still fits on one line at 11px.
                  <>
                    <span className="w-14 text-right text-[11px] tabular-nums whitespace-nowrap">
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
  const { upsList, upsOnBattery, lowestCharge, lowestRuntime, stale } = useLiveSummary();
  if (upsList.length === 0) {
    return (
      <Shell label="UPS" stale={stale.ups}>
        <span className="text-[10px]" style={{ color: T_MUTED }}>No UPS</span>
      </Shell>
    );
  }
  const onBattery = upsOnBattery > 0;
  const label = upsList.length > 1 ? `UPS · worst of ${upsList.length}` : "UPS";

  if (onBattery) {
    return (
      <Shell label={label} stale={stale.ups}>
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
    <Shell label={label} stale={stale.ups}>
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
  const { routers, routersOnline, routersTotal, portsUp, portsTotal, stale } = useLiveSummary();
  if (routersTotal === 0) {
    return (
      <Shell label="Network" stale={stale.network}>
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
    <Shell label="Network" stale={stale.network}>
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

// ── UPS / Network: every unit, named ──
// Same one-line-per-row shape as ServerListTile, and the same reason: bounded and
// glanceable at realistic counts without scrolling. Problem-first sort so trouble is
// always the top row — for UPS that ordering is on-battery, then lowest runtime, since
// a discharging unit outranks a merely low one that is still on mains.
// Type scale matches ServerListTile's rows on purpose — these sit in the same widget,
// and a UPS reading has no reason to be smaller than a server's.
function Row({ color, name, right }: { color: string; name: string; right: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 py-1" style={{ borderTop: "1px solid var(--gf-divider)" }}>
      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
      <span className="text-[10px] truncate flex-1" style={{ color: "var(--gf-text-primary)" }} title={name}>{name}</span>
      {right}
    </div>
  );
}

const UpsListTile: FC = () => {
  const { upsList, stale } = useLiveSummary();
  const rows = [...upsList].sort((a, b) => {
    const ab = a.onBattery === true, bb = b.onBattery === true;
    if (ab !== bb) return ab ? -1 : 1;                       // discharging first
    const ar = a.runtimeMin ?? Infinity, br = b.runtimeMin ?? Infinity;
    if (ar !== br) return ar - br;                           // least runtime next
    return a.name.localeCompare(b.name);
  });
  return (
    <Shell label="UPS" stale={stale.ups}>
      {rows.length === 0 ? (
        <span className="text-[10px]" style={{ color: T_MUTED }}>No UPS</span>
      ) : (
        <div className="flex flex-col">
          {rows.map((u) => {
            const off = u.status === "Offline";
            const batt = u.onBattery === true;
            const color = off ? T_DIM : batt ? RED : u.chargePct != null ? chargeColor(u.chargePct) : T_MUTED;
            return (
              <Row
                key={u.id}
                color={color}
                name={u.name}
                right={
                  <span className="text-[11px] tabular-nums flex-shrink-0" style={{ color }}>
                    {off ? "offline" : batt ? `⚡ ${u.runtimeMin != null ? `${Math.round(u.runtimeMin)}m` : "—"}` : u.chargePct != null ? `${Math.round(u.chargePct)}%` : "—"}
                  </span>
                }
              />
            );
          })}
        </div>
      )}
    </Shell>
  );
};

const NetworkListTile: FC = () => {
  const { routers, stale } = useLiveSummary();
  const rows = [...routers].sort((a, b) => {
    const ao = a.status === "Offline", bo = b.status === "Offline";
    if (ao !== bo) return ao ? -1 : 1;                                   // offline first
    const ad = a.portsTotal - a.portsUp, bd = b.portsTotal - b.portsUp;
    if (ad !== bd) return bd - ad;                                       // most ports down next
    return a.name.localeCompare(b.name);
  });
  return (
    <Shell label="Routers" stale={stale.network}>
      {rows.length === 0 ? (
        <span className="text-[10px]" style={{ color: T_MUTED }}>No routers</span>
      ) : (
        <div className="flex flex-col">
          {rows.map((r) => {
            const off = r.status === "Offline";
            const down = r.portsTotal - r.portsUp;
            const color = off ? RED : down > 0 ? ORANGE : GREEN;
            return (
              <Row
                key={r.id}
                color={color}
                name={r.name}
                right={
                  <span className="text-[11px] tabular-nums flex-shrink-0" style={{ color }}>
                    {off ? "offline" : `${r.portsUp}/${r.portsTotal}`}
                  </span>
                }
              />
            );
          })}
        </div>
      )}
    </Shell>
  );
};

// ── Per-device tiles (parameterised ids: "ups.device:7" / "network.device:3") ──
// The one place tile ids stop being a fixed vocabulary. A saved layout may name a
// device that has since been decommissioned, so both renderers must handle "not in
// the live list" — they show a dim Unavailable rather than vanishing, because a tile
// silently disappearing looks like a bug, while this points at the fix (remove it in
// the builder).
// Not marked stale: "this device is gone from the list" is a different condition from
// "its stream went quiet", and flagging both at once would just muddy the signal.
function Unavailable({ label }: { label: string }) {
  return (
    <Shell label={label}>
      <span className="text-[10px]" style={{ color: T_DIM }}>Unavailable</span>
      <span className="text-[8px]" style={{ color: T_DIM }}>removed?</span>
    </Shell>
  );
}

const UpsDeviceTile: FC<{ deviceId: number }> = ({ deviceId }) => {
  const { upsList, stale } = useLiveSummary();
  const u = upsList.find((x) => x.id === deviceId);
  if (!u) return <Unavailable label={`UPS #${deviceId}`} />;
  if (u.status === "Offline") {
    return (
      <Shell label={u.name} stale={stale.ups}>
        <Big color={RED}>offline</Big>
        <span className="text-[9px]" style={{ color: T_MUTED }}>not responding</span>
      </Shell>
    );
  }
  if (u.onBattery === true) {
    return (
      <Shell label={u.name} stale={stale.ups}>
        <div className="flex items-baseline gap-1">
          <Big color={RED}>{u.runtimeMin != null ? Math.round(u.runtimeMin) : "—"}</Big>
          <span className="text-[9px]" style={{ color: RED }}>min left</span>
        </div>
        <span className="text-[9px] font-semibold" style={{ color: RED }}>
          ⚡ ON BATTERY{u.chargePct != null ? ` · ${Math.round(u.chargePct)}%` : ""}
        </span>
      </Shell>
    );
  }
  return (
    <Shell label={u.name} stale={stale.ups}>
      <div className="flex items-baseline gap-1">
        <Big color={u.chargePct != null ? chargeColor(u.chargePct) : T_DIM}>
          {u.chargePct != null ? `${Math.round(u.chargePct)}%` : "—"}
        </Big>
        <span className="text-[9px]" style={{ color: T_MUTED }}>battery</span>
      </div>
      <span className="text-[9px]" style={{ color: T_MUTED }}>
        {u.loadPct != null ? `load ${Math.round(u.loadPct)}%` : "on mains"}
        {u.runtimeMin != null ? ` · ${Math.round(u.runtimeMin)} min` : ""}
      </span>
    </Shell>
  );
};

const NetDeviceTile: FC<{ deviceId: number }> = ({ deviceId }) => {
  const { routers, stale } = useLiveSummary();
  const r = routers.find((x) => x.id === deviceId);
  if (!r) return <Unavailable label={`Router #${deviceId}`} />;
  if (r.status === "Offline") {
    return (
      <Shell label={r.name} stale={stale.network}>
        <Big color={RED}>offline</Big>
        <span className="text-[9px]" style={{ color: T_MUTED }}>unreachable</span>
      </Shell>
    );
  }
  const down = r.portsTotal - r.portsUp;
  return (
    <Shell label={r.name} stale={stale.network}>
      <div className="flex items-baseline gap-1">
        <Big color={down > 0 ? ORANGE : GREEN}>{r.portsUp}/{r.portsTotal}</Big>
        <span className="text-[9px]" style={{ color: T_MUTED }}>ports up</span>
      </div>
      <span className="text-[9px]" style={{ color: T_MUTED }}>
        {r.type === "mikrotik" ? "MikroTik" : "SNMP"}
        {r.worstUtil != null ? ` · peak ${Math.round(r.worstUtil)}%` : ""}
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
  { id: "env.temp", label: "Temperature", description: "Server-room temp, zone-coloured", group: "Environment", span: 1, Render: TempTile },
  { id: "env.humidity", label: "Humidity", description: "Relative humidity %", group: "Environment", span: 1, Render: HumidityTile },
  { id: "env.gas", label: "Gas", description: "MQ-2 ppm + smoke band", group: "Environment", span: 1, Render: GasTile },
  { id: "servers.summary", label: "Servers summary", description: "Online count + worst CPU/mem", group: "Servers", span: 2, Render: ServersTile },
  { id: "servers.list", label: "Server list", description: "Each server by name, busiest first", group: "Servers", span: 2, Render: ServerListTile },
  { id: "ups.summary", label: "UPS battery", description: "Worst charge/runtime of all UPS", group: "UPS", span: 1, Render: UpsTile },
  { id: "ups.list", label: "UPS list", description: "Each UPS by name, on-battery first", group: "UPS", span: 2, Render: UpsListTile },
  { id: "network.summary", label: "Network ports", description: "Ports up across all routers", group: "Network", span: 1, Render: NetworkTile },
  { id: "network.list", label: "Router list", description: "Each router by name, offline first", group: "Network", span: 2, Render: NetworkListTile },
  { id: "alerts.count", label: "Open alerts", description: "Count of unresolved incidents", group: "Alerts", span: 1, Render: AlertCountTile },
  { id: "alerts.latest", label: "Latest alert", description: "Newest alert + which device", group: "Alerts", span: 2, Render: LatestAlertTile },
  { id: "aircon.summary", label: "Aircon", description: "How many AC units are on", group: "Aircon", span: 1, Render: AirconTile },
  { id: "meta.clock", label: "Clock", description: "Local time + connection state", group: "General", span: 1, Render: ClockTile },
];

export const TILE_BY_ID = new Map(TILE_CATALOG.map((t) => [t.id, t]));

// ── Parameterised tile ids ────────────────────────────────────────────────────
// Everything above is a fixed vocabulary. These two are not: they pin ONE device,
// so the id carries which — "ups.device:7", "network.device:3".
//
// Why an id suffix rather than, say, a per-tile settings object: the saved layout is
// deliberately just an ordered array of strings (§3.2), and keeping it that way means
// persistence, validation, dedupe and the MAX_TILES cap all keep working untouched.
// The backend validates these by PATTERN and never needs to know which device ids
// exist — a decommissioned device's tile simply renders "Unavailable", which is the
// same forward-compatible behaviour unknown ids already had.
export const DEVICE_TILE_PREFIXES = ["ups.device", "network.device"] as const;
export type DeviceTilePrefix = (typeof DEVICE_TILE_PREFIXES)[number];

// `[1-9]\d*` — no leading zeros, so "ups.device:07" is rejected rather than accepted as
// a SECOND distinct string for device 7, which would slip past the layout's dedupe and
// render the same unit twice.
const DEVICE_TILE_RE = /^(ups|network)\.device:([1-9]\d{0,9})$/;

export function parseDeviceTileId(id: string): { kind: "ups" | "network"; deviceId: number } | null {
  const m = DEVICE_TILE_RE.exec(id);
  if (!m) return null;
  const deviceId = Number(m[2]);
  if (!Number.isSafeInteger(deviceId) || deviceId <= 0) return null;
  return { kind: m[1] as "ups" | "network", deviceId };
}

export const deviceTileId = (kind: "ups" | "network", deviceId: number | string) =>
  `${kind}.device:${deviceId}`;

// The single lookup every renderer should use. Resolves a static catalog id OR a
// parameterised device id into something renderable; undefined = skip it.
export function resolveTile(id: string): TileDef | undefined {
  const stat = TILE_BY_ID.get(id);
  if (stat) return stat;
  const parsed = parseDeviceTileId(id);
  if (!parsed) return undefined;
  const { kind, deviceId } = parsed;
  return {
    id,
    label: kind === "ups" ? `UPS #${deviceId}` : `Router #${deviceId}`,
    description: kind === "ups" ? "One pinned UPS" : "One pinned router",
    group: kind === "ups" ? "UPS" : "Network",
    span: 1,
    Render: () => (kind === "ups" ? <UpsDeviceTile deviceId={deviceId} /> : <NetDeviceTile deviceId={deviceId} />),
  };
}

// Sensible default until the user customizes (Phase 4).
export const DEFAULT_LAYOUT = ["env.temp", "env.humidity", "env.gas", "alerts.count", "servers.list", "alerts.latest"];

// ─── Window sizing ────────────────────────────────────────────────────────────
// The pop-out used to open at a fixed 340x300 whatever the layout was, so a widget
// with ten tiles had to be scrolled — which defeats a glance surface, and contradicts
// the whole reason servers.list is one line per server.
//
// requestWindow only takes an INITIAL size, so this is computed at open time rather
// than reactively. It is deliberately an ESTIMATE: list tiles grow with how many
// devices exist, and the true height depends on text wrapping we can't measure before
// paint. Being wrong is safe in both directions — the tile grid is overflow-y-auto, so
// an under-estimate scrolls (the old behaviour) and an over-estimate leaves a little
// empty space. Numbers below are derived from the actual Tailwind classes on Shell and
// PipWidget; if those paddings change, these drift.
export const WIDGET_WIDTH = 340; // fixed: the grid is always 2 columns

const HEADER_H = 28; // PipWidget header strip (h-7)
const PAD_V = 12; // tile container p-1.5, top + bottom
const GAP = 6; // grid gap-1.5 between rows
const STAT_H = 56; // Shell py-2 + 8px label + 15px Big + a 9px sub-line
const LIST_HEAD = 29; // Shell padding-top + label row
const LIST_COLHEAD = 12; // servers.list only — its once-off CPU·MEM/LOAD header
const LIST_ROW = 22; // one device row (py-1 + ~14px content)
const SHELL_PAD_B = 8; // Shell padding-bottom
const MIN_H = 200;
const MAX_H = 640; // past this, scrolling is the better answer than a tall window

export interface DeviceCounts {
  servers: number;
  ups: number;
  routers: number;
}

// Rows are clamped to >= 1 because an empty list still renders its "No servers" line.
function tileHeight(id: string, c: DeviceCounts): number {
  if (id === "servers.list") return LIST_HEAD + LIST_COLHEAD + Math.max(1, c.servers) * LIST_ROW + SHELL_PAD_B;
  if (id === "ups.list") return LIST_HEAD + Math.max(1, c.ups) * LIST_ROW + SHELL_PAD_B;
  if (id === "network.list") return LIST_HEAD + Math.max(1, c.routers) * LIST_ROW + SHELL_PAD_B;
  return STAT_H;
}

// Packs the layout the way the CSS grid does — span-1 tiles pair up, span-2 take a
// whole row — then sums the row heights. A row of two tiles is as tall as the taller.
export function estimateWidgetSize(layout: string[], counts: DeviceCounts): { width: number; height: number } {
  const rows: number[] = [];
  let pending: number | null = null; // a span-1 tile waiting for its partner

  for (const id of layout) {
    const def = resolveTile(id);
    if (!def) continue; // unknown id — skipped at render too
    const h = tileHeight(def.id, counts);
    if (def.span === 2) {
      if (pending != null) {
        rows.push(pending);
        pending = null;
      }
      rows.push(h);
    } else if (pending == null) {
      pending = h;
    } else {
      rows.push(Math.max(pending, h));
      pending = null;
    }
  }
  if (pending != null) rows.push(pending);

  const content = rows.reduce((a, b) => a + b, 0) + Math.max(0, rows.length - 1) * GAP;
  const height = Math.min(MAX_H, Math.max(MIN_H, Math.round(HEADER_H + PAD_V + content)));
  return { width: WIDGET_WIDTH, height };
}
