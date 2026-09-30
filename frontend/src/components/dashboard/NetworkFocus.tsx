import { useEffect, useMemo, useState } from "react";
import type { ChartData } from "chart.js";
import { Line } from "react-chartjs-2";
import { api } from "../../api/api";
import { rangeSpanSec } from "../ui/RangePicker";
import type { RangeValue } from "../ui/RangePicker";
import { withGaps } from "../../utils/seriesGaps";
import { formatBps } from "../../utils/format";
import {
  FOCUS_CHART_H, ChartMessage, LegendDot,
  fmtTime, focusLineOptions, lineSeries, loadColor,
} from "./focusShared";

// ─── One router's throughput on the Dashboard ──────────────────────────────────
// Same idea as ServerFocus, for routers and the MikroTik: is this link getting busier?
// In and out are separate lines, since Ethernet is full-duplex and each direction can
// fill up on its own (the poller uses the busier direction for link_util). No fixed
// axis: throughput has no natural ceiling.

const IN_COLOR = "#5DCAA5";
const OUT_COLOR = "#D85A30";
// ICMP series: latency in blue, loss in red (any loss is a fault).
const LATENCY_COLOR = "#3CC8E8";
const LOSS_COLOR = "#F2495C";

export interface FocusNetDevice {
  id: number | string;
  name?: string | undefined;
  type?: string | undefined; // "router" | "mikrotik"
  status: string;
  cpuPercent?: number | null | undefined;
  memPercent?: number | null | undefined;
  connectedClients?: number | null | undefined;
  interfaces?: { name: string; locationLabel?: string; linkUp?: boolean; utilizationPct?: number | null }[] | undefined;
  // "ping" = registered without an SNMP community. It never has interfaces or byte
  // counters, so it shows latency/loss instead of an always-empty throughput chart.
  mode?: "snmp" | "ping" | undefined;
  latencyMs?: number | null | undefined;
  packetLossPct?: number | null | undefined;
}

interface Point {
  time: string;
  rx: number | null;
  tx: number | null;
  latency: number | null;
  loss: number | null;
}

// Kept in bytes per second as returned, and only scaled when displayed (formatBps).
// Converting to MB/s up front rounded a quiet link to 0.00 while the chart still moved.

export default function NetworkFocus({
  device,
  range,
  isDark,
}: {
  device: FocusNetDevice | null;
  range: RangeValue;
  isDark: boolean;
}) {
  const [history, setHistory] = useState<Point[]>([]);
  const [loading, setLoading] = useState(false);

  const deviceId = device?.id ?? null;
  // A MikroTik uses /api/mikrotik, but both endpoints use networkHistoryHandler and
  // return the same shape.
  const isMikrotik = device?.type === "mikrotik";
  // Decided here, not at render: it selects WHICH array the effect keeps.
  const isPing = device?.mode === "ping";

  useEffect(() => {
    if (deviceId == null) {
      setHistory([]);
      return;
    }
    let alive = true;
    setLoading(true);
    const id = Number(deviceId);
    const win = range.kind === "custom" ? { start: range.start, stop: range.stop } : undefined;
    const preset = range.kind === "custom" ? "" : range.preset;
    const req = isMikrotik
      ? api.getMikrotikHistory(id, preset, undefined, win)
      : api.getNetworkHistory(id, preset, undefined, win);

    req.then((r) => {
      if (!alive) return;
      setLoading(false);
      // Throughput and ICMP come back as separate arrays with their own timestamps (see
      // networkHistoryHandler). Only the series this device charts is used; mixing them
      // would put nulls in every other row and break the line.
      const tp: any[] = r.success && r.data ? r.data.history ?? [] : [];
      const ic: any[] = r.success && r.data ? r.data.icmp ?? [] : [];
      setHistory(
        isPing
          ? ic.map((p) => ({
              time: p.time, rx: null, tx: null,
              latency: p.latencyMs ?? null, loss: p.packetLossPct ?? null,
            }))
          : tp.map((p) => ({
              time: p.time, rx: p.rxBytesPerSec ?? null, tx: p.txBytesPerSec ?? null,
              latency: null, loss: null,
            })),
      );
    });

    // No live updates: `networkMetrics` carries cumulative counters, not rates, and at a
    // 30-60s poll it would only add one point.
    return () => { alive = false; };
  }, [deviceId, isMikrotik, isPing, range]);

  const spanSec = rangeSpanSec(range);

  // Breaks inserted wherever the poller stopped, so an unreachable router reads as a hole
  // rather than as a straight line across the outage.
  const { labels, inData, outData, latData, lossData, inNow, outNow, latNow, lossNow } = useMemo(() => {
    const rawIn = history.map((p) => p.rx);
    const rawOut = history.map((p) => p.tx);
    const rawLat = history.map((p) => p.latency);
    const rawLoss = history.map((p) => p.loss);
    const { labels: l, series } = withGaps(
      history.map((p) => Date.parse(p.time)),
      history.map((p) => fmtTime(p.time, spanSec)),
      [rawIn, rawOut, rawLat, rawLoss],
    );
    // The last value may be null when the last window had no reading for that field, so
    // fall back to the last non-null value.
    const lastReal = (a: (number | null)[]) => {
      for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i] as number;
      return null;
    };
    return {
      labels: l,
      inData: series[0]!,
      outData: series[1]!,
      latData: series[2]!,
      lossData: series[3]!,
      // The headline numbers read the ORIGINAL arrays: the gap-filled ones end in a null
      // whenever the series happens to close on a break.
      inNow: rawIn.at(-1) ?? null,
      outNow: rawOut.at(-1) ?? null,
      latNow: lastReal(rawLat),
      lossNow: lastReal(rawLoss),
    };
  }, [history, spanSec]);

  if (!device) {
    return <ChartMessage>Select a device above to see its traffic.</ChartMessage>;
  }

  const offline = device.status !== "Online";
  const pingMode = isPing;
  const dim = "var(--gf-text-dim)";
  const ifaces = device.interfaces ?? [];
  const busiest = ifaces
    .filter((i) => i.utilizationPct != null)
    .sort((a, b) => (b.utilizationPct ?? 0) - (a.utilizationPct ?? 0))[0];
  const portsUp = ifaces.filter((i) => i.linkUp === true).length;

  // A ping-only device gets its own two series, latency and loss, on one chart. No
  // fixed axis, since latency has no ceiling.
  const data: ChartData<"line"> = {
    labels,
    datasets: pingMode
      ? [
          lineSeries("Latency", latData, LATENCY_COLOR, true),
          lineSeries("Loss", lossData, LOSS_COLOR, true),
        ]
      : [
          lineSeries("In", inData, IN_COLOR, true),
          lineSeries("Out", outData, OUT_COLOR, true),
        ],
  };

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      {/* One status line instead of tiles: reachability, ports up and the busiest link. CPU
         and clients only exist on a MikroTik, so they only appear there. */}
      <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap text-[11px]" style={{ color: "var(--gf-text-muted)" }}>
        {pingMode ? (
          /* No ports to count. Lead with loss — the number that says whether this link
             is healthy — and name the mode so "no ports" reads as expected. */
          <>
            <span>
              <span
                className="font-semibold"
                style={{
                  color: offline ? "#FF780A"
                    : lossNow == null ? dim
                    : lossNow >= 20 ? "#F2495C"
                    : lossNow > 0 ? "#FF780A"
                    : "#73BF69",
                }}
              >
                {lossNow == null ? "—" : `${Math.round(lossNow)}%`}
              </span>{" "}
              packet loss
            </span>
            <span>
              · latency{" "}
              <span className="font-semibold" style={{ color: offline ? dim : "var(--gf-text-primary)" }}>
                {latNow == null ? "—" : `${Math.round(latNow)} ms`}
              </span>
            </span>
            <span style={{ color: dim }}>· ping only — no per-port data</span>
          </>
        ) : (
        <span>
          <span className="font-semibold" style={{ color: offline ? "#FF780A" : "#73BF69" }}>
            {portsUp}/{ifaces.length}
          </span>{" "}
          ports up
        </span>
        )}
        {!pingMode && busiest && (
          <span>
            · busiest {busiest.locationLabel || busiest.name}{" "}
            <span className="font-semibold" style={{ color: offline ? dim : loadColor(busiest.utilizationPct ?? 0) }}>
              {Math.round(busiest.utilizationPct ?? 0)}%
            </span>
          </span>
        )}
        {device.cpuPercent != null && (
          <span>
            · cpu{" "}
            <span className="font-semibold" style={{ color: offline ? dim : loadColor(device.cpuPercent) }}>
              {Math.round(device.cpuPercent)}%
            </span>
          </span>
        )}
        {device.connectedClients != null && <span>· {device.connectedClients} clients</span>}
        {offline && <span style={{ color: "#FF780A" }}>· unreachable — last known</span>}
      </div>

      {loading && history.length === 0 ? (
        <ChartMessage>Loading traffic…</ChartMessage>
      ) : history.length === 0 ? (
        <ChartMessage>
          {pingMode
            ? "No ping history stored for this range yet."
            : "No traffic stored for this range yet."}
        </ChartMessage>
      ) : (
        <div style={{ height: FOCUS_CHART_H }}>
          {/* The formatter follows the series, not the panel (formatBps would label 30 ms as
             "30 B/s"). Latency and loss share the axis, so the unit is on the legend. */}
          <Line
            data={data}
            options={
              pingMode
                ? focusLineOptions(isDark, { decimals: 0, min: 0 })
                : focusLineOptions(isDark, { format: formatBps })
            }
          />
        </div>
      )}

      {/* The legend carries the CURRENT value too, so removing the tiles didn't take the
          numbers with it — it just stopped spending a 2x2 grid on them. */}
      <div className="flex items-center gap-3 flex-wrap">
        {pingMode ? (
          <>
            <LegendDot
              color={LATENCY_COLOR}
              label="Latency"
              value={offline || latNow == null ? "—" : `${Math.round(latNow)} ms`}
            />
            <LegendDot
              color={LOSS_COLOR}
              label="Loss"
              value={offline || lossNow == null ? "—" : `${Math.round(lossNow)}%`}
            />
          </>
        ) : (
          <>
            <LegendDot color={IN_COLOR} label="In" value={offline ? "—" : formatBps(inNow)} />
            <LegendDot color={OUT_COLOR} label="Out" value={offline ? "—" : formatBps(outNow)} />
            {/* Latency and loss shown as badges, not lines: they are measured for SNMP and MikroTik
               routers too, but bytes/sec, ms and % cannot share an axis. Taken from the live
               device row (like ServerFocus), so they are current even on a 30-day range. */}
            <LegendDot
              color={LATENCY_COLOR}
              label="Latency"
              value={offline || device.latencyMs == null ? "—" : `${Math.round(device.latencyMs)} ms`}
              {...(offline || device.latencyMs == null
                ? {}
                : { valueColor: device.latencyMs > 150 ? "#FF780A" : "#73BF69" })}
            />
            <LegendDot
              color={LOSS_COLOR}
              label="Loss"
              value={offline || device.packetLossPct == null ? "—" : `${Math.round(device.packetLossPct)}%`}
              {...(offline || device.packetLossPct == null
                ? {}
                : {
                    // Same ladder as the ping branch's header and NetworkDetail's tile,
                    // so one reading is never green in one place and orange in another.
                    valueColor:
                      device.packetLossPct >= 20 ? "#F2495C"
                        : device.packetLossPct > 0 ? "#FF780A"
                        : "#73BF69",
                  })}
            />
          </>
        )}
      </div>
    </div>
  );
}
