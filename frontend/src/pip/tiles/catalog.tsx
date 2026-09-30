import { useEffect, useState } from "react";
import type { FC, ReactNode } from "react";
import { useLiveSummary } from "../LiveSummaryContext";
import { useNotifications } from "../../context/NotificationContext";
import { SEVERITY_COLOR } from "../../components/notifications/notificationUtils";
import { STATUS } from "../../theme/gf";
const { green: GREEN, orange: ORANGE, red: RED, blue: BLUE } = STATUS;

// ── Tile catalog: every tile that can go on the widget. Each is a small component
// reading the shared live hooks. A saved layout is an ordered list of these ids, so
// adding a tile is one entry here. ──

// Grafana status colors (CLAUDE.md). Thresholds mirror Dashboard's helpers — which
// aren't exported — kept here so the PiP bundle doesn't import the whole Dashboard.
const T_MUTED = "var(--gf-text-muted)";
const T_DIM = "var(--gf-text-dim)";

const tempColor = (t: number) => (t < 22 ? BLUE : t <= 27 ? GREEN : t <= 29 ? ORANGE : RED);
const humColor = (h: number) => (h < 30 || h > 70 ? ORANGE : GREEN);
const loadColor = (v: number) => (v >= 85 ? RED : v >= 65 ? ORANGE : GREEN);
// `smoke` is normalised in LiveSummaryContext, so CRITICAL is the top band. Anything
// unrecognised falls through to green, which is why that normalisation matters.
const gasColor = (smoke: string) => (smoke === "CRITICAL" ? RED : smoke === "WARNING" ? ORANGE : GREEN);

export interface TileDef {
  id: string;
  label: string;
  // One line on what the tile shows, shown in the builder (a label alone does not tell
  // "Network ports" from "Router list").
  description?: string;
  group: "Environment" | "Servers" | "Network" | "UPS" | "Alerts" | "Aircon" | "General";
  span?: 1 | 2;
  Render: FC;
}

// Maximum tiles. Must match MAX_TILES in backend/services/widgetPrefsService.js; the
// server cuts off anything longer when saving.
export const MAX_TILES = 16;

// ── Shared tile frame ──
// `stale` = this tile's data source has gone quiet (see LiveSummaryContext). The value
// is dimmed and the label flagged in orange, since the last number is still useful but
// must not look current.
function Shell({ label, children, stale = false }: { label: string; children: ReactNode; stale?: boolean }) {
  return (
    <div
      className="flex flex-col gap-0.5 px-2.5 py-2 h-full"
      title={stale ? `${label}: no update recently — value may be out of date` : undefined}
      style={{
        background: "var(--gf-panel)",
        border: "1px solid var(--gf-panel-border)",
        borderRadius: 2,
        // Each reading is a raised chip (--gf-btn-shadow), so neighbours stand apart in the
        // dense grid. Not .gf-raise: tiles are not clickable. Works in the pop-out too, since
        // the stylesheets are copied into it (pip-widget.md §6.1).
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

// Per-server list, one line each: status dot, name, CPU·mem and one load bar (the worse
// of the two). Problems first (offline, then busiest). Names use the display label.
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
                  // The numbers lead the row. w-14 so "100·100" fits on one line at 11px.
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
// The one metric with a deadline: how long the battery lasts. "On battery" is the
// headline, and while discharging the runtime comes first, in red. Shows the worst UPS
// in the fleet (one on battery is the story); the full list is on /ups.
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

// ── Network (SNMP routers + MikroTik, both on networkMetrics) ──
// Counts ports, not devices: a router can answer while three buildings' links are down.
const NetworkTile: FC = () => {
  const { routers, routersOnline, routersTotal, portsUp, portsTotal, pingOnlyRouters, stale } = useLiveSummary();
  if (routersTotal === 0) {
    return (
      <Shell label="Network" stale={stale.network}>
        <span className="text-[10px]" style={{ color: T_MUTED }}>No routers</span>
      </Shell>
    );
  }
  const routerDown = routersTotal - routersOnline;
  // All routers are ping-only, so there are no ports and "0/0 ports up" would look like an
  // outage. Show the worst packet loss instead.
  const allPing = pingOnlyRouters === routersTotal;
  const worstLoss = routers
    .filter((r) => r.packetLossPct != null)
    .reduce<number | null>((w, r) => (w == null || (r.packetLossPct as number) > w ? (r.packetLossPct as number) : w), null);
  if (allPing) {
    return (
      <Shell label="Network" stale={stale.network}>
        <div className="flex items-baseline gap-1">
          <Big color={routerDown > 0 ? RED : worstLoss && worstLoss >= 20 ? RED : worstLoss ? ORANGE : GREEN}>
            {routerDown > 0 ? "offline" : worstLoss != null ? `${Math.round(worstLoss)}%` : "—"}
          </Big>
          {routerDown === 0 && worstLoss != null && (
            <span className="text-[9px]" style={{ color: T_MUTED }}>loss</span>
          )}
        </div>
        <span className="text-[9px]" style={{ color: routerDown > 0 ? RED : T_MUTED }}>
          {routerDown > 0
            ? `${routerDown} of ${routersTotal} router${routersTotal > 1 ? "s" : ""} offline`
            : `${routersTotal} router${routersTotal > 1 ? "s" : ""} · ping only`}
        </span>
      </Shell>
    );
  }
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
// One line per unit, like ServerListTile, problems first: for UPS that is on battery,
// then lowest runtime. Same text size as the server rows.
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
            const ping = r.mode === "ping";
            // A ping router has no ports, so its health is loss-then-latency. Showing
            // "0/0" beside real port counts would read as every link down.
            const loss = r.packetLossPct;
            const color = off
              ? RED
              : ping
                ? loss != null && loss >= 20 ? RED : loss ? ORANGE : GREEN
                : down > 0 ? ORANGE : GREEN;
            const right = off
              ? "offline"
              : ping
                ? loss != null && loss > 0
                  ? `${Math.round(loss)}% loss`
                  : r.latencyMs != null ? `${Math.round(r.latencyMs)} ms` : "—"
                : `${r.portsUp}/${r.portsTotal}`;
            return (
              <Row
                key={r.id}
                color={color}
                name={r.name}
                right={
                  <span className="text-[11px] tabular-nums flex-shrink-0" style={{ color }}>
                    {right}
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

// ── Per-device tiles ("ups.device:7" / "network.device:3") ──
// A saved layout may name a device that has been removed, so the tile shows a dim
// "Unavailable" rather than disappearing (remove it in the builder). Not marked stale,
// since "gone from the list" is a different condition.
function Unavailable({ label }: { label: string }) {
  return (
    <Shell label={label}>
      <span className="text-[10px]" style={{ color: T_DIM }}>Unavailable</span>
      <span className="text-[8px]" style={{ color: T_DIM }}>removed?</span>
    </Shell>
  );
}

const ServerDeviceTile: FC<{ deviceId: number }> = ({ deviceId }) => {
  const { servers, stale } = useLiveSummary();
  const s = servers.find((x) => x.id === deviceId);
  if (!s) return <Unavailable label={`Server #${deviceId}`} />;
  if (s.status === "Offline") {
    return (
      <Shell label={s.name} stale={stale.servers}>
        <Big color={RED}>offline</Big>
        <span className="text-[9px]" style={{ color: T_MUTED }}>no metrics</span>
      </Shell>
    );
  }
  // Maintenance is shown, since it means the device's alerts are paused ("muted", not
  // "quiet"). The numbers are still real.
  const maint = s.status === "Maintenance";
  // CPU is the headline and memory is on the sub-line. Both use the same load colours as
  // the Servers list.
  return (
    <Shell label={s.name} stale={stale.servers}>
      <div className="flex items-baseline gap-1">
        <Big color={loadColor(s.cpu)}>{Math.round(s.cpu)}%</Big>
        <span className="text-[9px]" style={{ color: T_MUTED }}>cpu</span>
      </div>
      <span className="text-[9px]" style={{ color: maint ? ORANGE : T_MUTED }}>
        {maint ? "maintenance · " : ""}mem{" "}
        <b style={{ color: loadColor(s.memory) }}>{Math.round(s.memory)}%</b>
      </span>
    </Shell>
  );
};

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
  // A ping-only router reports latency and loss and nothing else — so the tile leads
  // with those instead of a permanent "0/0 ports up", which reads as a dead device.
  if (r.mode === "ping") {
    const loss = r.packetLossPct;
    const bad = loss != null && loss >= 20;
    return (
      <Shell label={r.name} stale={stale.network}>
        <div className="flex items-baseline gap-1">
          <Big color={bad ? RED : loss ? ORANGE : GREEN}>
            {r.latencyMs != null ? Math.round(r.latencyMs) : "—"}
          </Big>
          <span className="text-[9px]" style={{ color: T_MUTED }}>ms</span>
        </div>
        <span className="text-[9px]" style={{ color: loss ? (bad ? RED : ORANGE) : T_MUTED }}>
          {loss != null && loss > 0 ? `ping · ${Math.round(loss)}% loss` : "ping · no loss"}
        </span>
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

// ── Per-device tile ids ────────────────────────────────────────────────────
// These pin one device, so the id carries which: "ups.device:7", "network.device:3". A
// suffix keeps the saved layout a plain list of strings (§3.2), so saving, validation,
// de-duplication and MAX_TILES all work unchanged. The backend checks the pattern only;
// a removed device's tile shows "Unavailable".
export const DEVICE_TILE_PREFIXES = ["ups.device", "network.device", "server.device"] as const;
export type DeviceTilePrefix = (typeof DEVICE_TILE_PREFIXES)[number];

// The device families that can be pinned individually. Named once so the regex, the
// parser and the id builder cannot drift apart when a fourth is added.
export type DeviceTileKind = "ups" | "network" | "server";

// `[1-9]\d*` rules out leading zeros, so "ups.device:07" cannot appear as a second
// copy of device 7.
const DEVICE_TILE_RE = /^(ups|network|server)\.device:([1-9]\d{0,9})$/;

export function parseDeviceTileId(id: string): { kind: DeviceTileKind; deviceId: number } | null {
  const m = DEVICE_TILE_RE.exec(id);
  if (!m) return null;
  const deviceId = Number(m[2]);
  if (!Number.isSafeInteger(deviceId) || deviceId <= 0) return null;
  return { kind: m[1] as DeviceTileKind, deviceId };
}

export const deviceTileId = (kind: DeviceTileKind, deviceId: number | string) =>
  `${kind}.device:${deviceId}`;

// The single lookup every renderer should use. Resolves a static catalog id OR a
// parameterised device id into something renderable; undefined = skip it.
export function resolveTile(id: string): TileDef | undefined {
  const stat = TILE_BY_ID.get(id);
  if (stat) return stat;
  const parsed = parseDeviceTileId(id);
  if (!parsed) return undefined;
  const { kind, deviceId } = parsed;
  // A lookup by kind instead of chained ternaries, so a new kind is not silently treated
  // as Network.
  const META = {
    ups: { label: `UPS #${deviceId}`, description: "One pinned UPS", group: "UPS" },
    network: { label: `Router #${deviceId}`, description: "One pinned router", group: "Network" },
    server: { label: `Server #${deviceId}`, description: "One pinned server", group: "Servers" },
  } as const;
  const RENDER = {
    ups: () => <UpsDeviceTile deviceId={deviceId} />,
    network: () => <NetDeviceTile deviceId={deviceId} />,
    server: () => <ServerDeviceTile deviceId={deviceId} />,
  } as const;
  return { id, ...META[kind], span: 1, Render: RENDER[kind] };
}

// Sensible default until the user customizes (Phase 4).
export const DEFAULT_LAYOUT = ["env.temp", "env.humidity", "env.gas", "alerts.count", "servers.list", "alerts.latest"];

// ─── Window sizing ────────────────────────────────────────────────────────────
// Estimates the pop-out size from the layout so a widget with many tiles does not need
// scrolling. requestWindow only takes an initial size, so this runs at open. An estimate:
// too small scrolls, too big leaves a little space. The numbers come from the Tailwind
// classes on Shell and PipWidget; update them if those change.
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
