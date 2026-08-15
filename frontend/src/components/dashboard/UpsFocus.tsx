import { useEffect, useMemo, useState } from "react";
import type { ChartData } from "chart.js";
import { Line } from "react-chartjs-2";
import { api } from "../../api/api";
import { rangeSpanSec } from "../ui/RangePicker";
import type { RangeValue } from "../ui/RangePicker";
import { withGaps } from "../../utils/seriesGaps";
import {
  FOCUS_CHART_H, ChartMessage, LegendDot,
  fmtTime, focusLineOptions, lineSeries, loadColor,
} from "./focusShared";

// ─── One UPS's battery and load, on the Dashboard ───────────────────────────────
//
// The third focus panel. The device list above answers "is it on mains", which is the
// alarm; this answers the question that comes before it — is the battery holding its
// charge over weeks, and is the load creeping up towards the capacity that determines
// how long that battery lasts.
//
// Battery % and load % share the 0-100 axis. Runtime is MINUTES, a different unit whose
// numbers are an order of magnitude apart from a percentage, so it stays a tile — putting
// "18 min" on a 0-100 axis beside "97%" invites reading the runtime as a percentage.
//
// Battery charge is inverted in meaning versus every other metric on this Dashboard:
// LOWER is worse. loadColor is higher-is-worse, so charge is coloured by its own bands
// (matching the seeded ups_charge rules: warning <= 50, critical <= 20) rather than by
// passing it through a helper that would paint a nearly-flat battery green.

const CHARGE_COLOR = "#73BF69";
const LOAD_COLOR = "#EF9F27";

export interface FocusUpsDevice {
  id: number | string;
  name?: string | undefined;
  status: string;
  batteryChargePct: number | null;
  runtimeRemainingMin?: number | null | undefined;
  loadPct?: number | null | undefined;
  onBattery: boolean | null;
}

interface Point {
  time: string;
  charge: number | null;
  load: number | null;
  runtime: number | null;
}

/** Lower-is-worse, mirroring the seeded `ups_charge` rules (<=50 warning, <=20 critical). */
function chargeColor(pct: number | null | undefined) {
  if (pct == null) return "var(--gf-text-dim)";
  if (pct <= 20) return "#E02F44";
  if (pct <= 50) return "#FF780A";
  return "#73BF69";
}

export default function UpsFocus({
  device,
  range,
  isDark,
}: {
  device: FocusUpsDevice | null;
  range: RangeValue;
  isDark: boolean;
}) {
  const [history, setHistory] = useState<Point[]>([]);
  const [loading, setLoading] = useState(false);

  const deviceId = device?.id ?? null;

  useEffect(() => {
    if (deviceId == null) {
      setHistory([]);
      return;
    }
    let alive = true;
    setLoading(true);
    const id = Number(deviceId);
    const req =
      range.kind === "custom"
        ? api.getUpsHistory(id, "", { start: range.start, stop: range.stop })
        : api.getUpsHistory(id, range.preset);

    req.then((r) => {
      if (!alive) return;
      setLoading(false);
      const rows: any[] = r.success && r.data ? r.data.history ?? [] : [];
      setHistory(
        rows.map((p) => ({
          time: p.time,
          charge: p.batteryChargePct ?? null,
          load: p.loadPct ?? null,
          runtime: p.runtimeRemainingMin ?? null,
        })),
      );
    });
    return () => { alive = false; };
  }, [deviceId, range]);

  const spanSec = rangeSpanSec(range);

  // Breaks inserted wherever the poller stopped. This matters most here: a UPS that stops
  // answering during a power event is exactly when the line must NOT be drawn straight
  // across the missing hours as though the battery held steady through them.
  const { labels, chargeData, loadData } = useMemo(() => {
    const { labels: l, series } = withGaps(
      history.map((p) => Date.parse(p.time)),
      history.map((p) => fmtTime(p.time, spanSec)),
      [history.map((p) => p.charge ?? null), history.map((p) => p.load ?? null)],
    );
    return { labels: l, chargeData: series[0]!, loadData: series[1]! };
  }, [history, spanSec]);

  if (!device) {
    return <ChartMessage>Select a UPS above to see its battery trend.</ChartMessage>;
  }

  const offline = device.status !== "Online";
  const dim = "var(--gf-text-dim)";
  const onBattery = device.onBattery === true;

  const data: ChartData<"line"> = {
    labels,
    datasets: [
      lineSeries("Battery", chargeData, CHARGE_COLOR, true),
      lineSeries("Load", loadData, LOAD_COLOR),
    ],
  };

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      {/* Tiles replaced by one line, same as the other two panels. Power SOURCE leads it:
          "on battery" outranks every other number here, because mains is gone and the
          clock is running however full the pack currently reads. Runtime stays as text
          rather than joining the chart — it is minutes, and putting "18" on a 0-100 axis
          beside "97%" invites reading the backup time as a percentage. */}
      <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap text-[11px]" style={{ color: "var(--gf-text-muted)" }}>
        {onBattery ? (
          <span className="font-semibold" style={{ color: "#E02F44" }}>ON BATTERY</span>
        ) : offline ? (
          <span style={{ color: "#FF780A" }}>unreachable — last known</span>
        ) : (
          <span style={{ color: "#73BF69" }}>on mains</span>
        )}
        {device.runtimeRemainingMin != null && (
          <span>
            ·{" "}
            <span
              className="font-semibold"
              style={{ color: offline ? dim : device.runtimeRemainingMin <= 10 ? "#E02F44" : "#73BF69" }}
            >
              {Math.round(device.runtimeRemainingMin)} min
            </span>{" "}
            backup
          </span>
        )}
      </div>

      {loading && history.length === 0 ? (
        <ChartMessage>Loading battery history…</ChartMessage>
      ) : history.length === 0 ? (
        <ChartMessage>No UPS history stored for this range yet.</ChartMessage>
      ) : (
        <div style={{ height: FOCUS_CHART_H }}>
          <Line data={data} options={focusLineOptions(isDark, { unit: "%", min: 0, max: 100 })} />
        </div>
      )}

      {/* Current values ride on the legend, so dropping the tiles didn't drop the numbers.
          Battery is coloured lower-is-worse (chargeColor) — it is the one metric on this
          Dashboard inverted from all the others, and loadColor would paint a nearly-flat
          pack green. */}
      <div className="flex items-center gap-3 flex-wrap">
        <LegendDot
          color={CHARGE_COLOR}
          label="Battery"
          value={offline || device.batteryChargePct == null ? "—" : `${Math.round(device.batteryChargePct)}%`}
          valueColor={offline ? dim : chargeColor(device.batteryChargePct)}
        />
        <LegendDot
          color={LOAD_COLOR}
          label="Load"
          value={offline || device.loadPct == null ? "—" : `${Math.round(device.loadPct)}%`}
          {...(offline || device.loadPct == null ? { valueColor: dim } : { valueColor: loadColor(device.loadPct) })}
        />
      </div>
    </div>
  );
}
