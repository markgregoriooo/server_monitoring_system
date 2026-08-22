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

// ─── One router's throughput, on the Dashboard ──────────────────────────────────
//
// The sibling of ServerFocus for routers and the MikroTik. The device list above was
// already good at "which box, and is it up"; what it could not answer is "is this link
// getting busier", which is the question that precedes a saturated uplink.
//
// IN and OUT are separate lines rather than a total, because Ethernet is full-duplex and
// the two directions saturate independently — a summed line hides an uplink that is
// maxed inbound while idle outbound. Same reasoning the SNMP poller uses when it takes
// the BUSIER DIRECTION for link_util rather than the sum (services/snmpUtils.js).
//
// Unlike the server chart there is NO fixed axis: throughput has no natural ceiling, so
// pinning one would either flatten a busy link or leave a quiet one drawing along the
// floor. Utilisation-against-capacity is the tile's job, where the port's speed is known.

const IN_COLOR = "#5DCAA5";
const OUT_COLOR = "#D85A30";
// ICMP series. Latency reuses the humidity/"link quality" blue used elsewhere for a
// measured-not-alarming reading; loss takes the danger red, because any loss at all is
// a fault (see the seeded router_loss rule — 0% is healthy on every link).
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
  // "ping" = registered without an SNMP community (ISP-owned CPE). Such a router has no
  // interfaces and no byte counters — EVER — so the throughput chart below would sit on
  // "No traffic stored for this range yet" permanently, which reads as a broken feed
  // rather than as a device that has no traffic data to give.
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

// Values stay in BYTES PER SECOND, exactly as the endpoint returns them, and are scaled
// only at the moment of display (formatBps).
//
// They used to be converted to MB/s up front and rounded to three decimals. On a campus
// router that idles in the tens of KB/s, every point rounded to 0.00 — so the legend read
// "In 0.00 MB/s" while the chart, auto-scaled to that tiny range, drew a clearly moving
// line. Two contradictory claims from one number, and the wrong one is the one people
// trust. Converting late means the unit can follow the magnitude.

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
  // A MikroTik is polled over the RouterOS API and lives behind /api/mikrotik, but both
  // endpoints are served by networkHistoryHandler and return the identical shape — only
  // the route differs.
  const isMikrotik = device?.type === "mikrotik";

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
      const rows: any[] = r.success && r.data ? r.data.history ?? [] : [];
      setHistory(
        rows.map((p) => ({
          time: p.time,
          rx: p.rxBytesPerSec ?? null,
          tx: p.txBytesPerSec ?? null,
          latency: p.latencyMs ?? null,
          loss: p.packetLossPct ?? null,
        })),
      );
    });

    // No live tail here. `networkMetrics` carries the poller's CUMULATIVE counters, not a
    // rate, so appending one would mean re-deriving the throughput on the client — and at
    // a 30-60s poll cadence that whole second implementation buys a single extra point.
    return () => { alive = false; };
  }, [deviceId, isMikrotik, range]);

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
    // `.at(-1)` on the raw arrays can still be null when the last window had no reading
    // for that field — the two measurements are merged as a UNION, so a throughput row
    // may carry no ICMP value and vice versa. Fall back to the last non-null.
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
  const pingMode = device.mode === "ping";
  const dim = "var(--gf-text-dim)";
  const ifaces = device.interfaces ?? [];
  const busiest = ifaces
    .filter((i) => i.utilizationPct != null)
    .sort((a, b) => (b.utilizationPct ?? 0) - (a.utilizationPct ?? 0))[0];
  const portsUp = ifaces.filter((i) => i.linkUp === true).length;

  // A ping device gets its OWN two series. Latency and loss share a chart because both
  // are "how healthy is this link" and neither has a unit the other would distort at
  // this scale — a link at 30 ms and 0% sits low on both, and either one climbing is
  // the thing worth seeing. Deliberately NOT a fixed 0-100 axis: latency has no ceiling
  // and pinning one would flatten every real change.
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
      {/* The tile grid is gone — this panel is the chart now. What the tiles carried that
          a throughput chart cannot say is folded into this one line: reachability, ports
          up, and the busiest link, which is the number that precedes a saturated uplink.
          CPU and client count exist only on a MikroTik (the SNMP poller cannot read them),
          so they appear only when they are real rather than as a misleading 0. */}
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
          {/* The formatter has to follow the SERIES, not the panel: formatBps on a
              latency series would label 30 ms as "30 B/s". Loss and latency share the
              axis, so the unit is left off the tick and carried by the legend instead —
              "30" reads fine against a legend that says ms, whereas a hardcoded "ms"
              would be wrong for the loss line. */}
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
          </>
        )}
      </div>
    </div>
  );
}
