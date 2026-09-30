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

// ─── One UPS's battery and load on the Dashboard ───────────────────────────────
// Shows whether the battery holds its charge over time and whether the load is
// creeping up. Battery % and load % share the 0-100 axis; runtime is in minutes, so it
// is shown as text. Battery charge is lower-is-worse, so it is coloured by its own
// bands (the seeded ups_charge rules: warning <= 50, critical <= 20).

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

  // Gaps wherever the poller stopped, so missing hours during a power event are not
  // drawn as a steady battery.
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
      {/* One status line. Power source comes first: "on battery" matters more than any other
         number here. Runtime stays as text (minutes, not a percentage). */}
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

      {/* Current values on the legend. Battery uses chargeColor (lower is worse); loadColor
         would show a nearly empty battery as green. */}
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
