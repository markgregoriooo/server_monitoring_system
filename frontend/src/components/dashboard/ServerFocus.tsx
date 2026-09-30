import { useEffect, useMemo, useState } from "react";
import type { ChartData } from "chart.js";
import { Line } from "react-chartjs-2";
import { api } from "../../api/api";
import { socket } from "../../socket/socket";
import { rangeSpanSec } from "../ui/RangePicker";
import type { RangeValue } from "../ui/RangePicker";
import { withGaps } from "../../utils/seriesGaps";
import {
  FOCUS_CHART_H, ChartMessage, LegendDot,
  fmtTime, focusLineOptions, lineSeries, loadColor,
} from "./focusShared";

// ─── One server's key numbers on the Dashboard ───────────────────────────
// The quick view; ServerDetail has the full charts, volumes, specs and log. CPU,
// memory and disk share one 0-100% axis so it is easy to see which is climbing; three
// auto-scaled charts would make small and large changes look the same. Throughput is
// in bytes, so it is not on the % axis.

// Same colours as ServerDetail, so "blue is CPU" holds on both pages.
const CPU_COLOR = "#378ADD";
const MEM_COLOR = "#7F77DD";
const DISK_COLOR = "#EF9F27";

export interface FocusServer {
  id: number;
  name: string;
  status: string;
  cpu: number;
  memory: number;
  diskUsed: number;
  uptime: string;
  ip?: string | undefined;
}

interface Point {
  time: string;
  cpu: number | null;
  mem: number | null;
  disk: number | null;
  netSent: number | null;
  netRecv: number | null;
}

export default function ServerFocus({
  server,
  range,
  isDark,
}: {
  server: FocusServer | null;
  range: RangeValue;
  isDark: boolean;
}) {
  const [history, setHistory] = useState<Point[]>([]);
  const [loading, setLoading] = useState(false);

  const serverId = server?.id ?? null;

  // Seed from InfluxDB, then tail the live socket. `alive` guards the async landing after
  // a fast re-select — otherwise picking A then B could paint A's history under B's name.
  useEffect(() => {
    if (serverId == null) {
      setHistory([]);
      return;
    }
    let alive = true;
    setLoading(true);
    const req =
      range.kind === "custom"
        ? api.getServerHistory(serverId, "", { start: range.start, stop: range.stop })
        : api.getServerHistory(serverId, range.preset);

    req.then((r) => {
      if (!alive) return;
      setLoading(false);
      const rows: any[] = r.success && r.data ? r.data.history ?? [] : [];
      setHistory(
        rows.map((p) => ({
          time: p.time,
          cpu: p.cpu_percent ?? null,
          mem: p.mem_percent ?? null,
          disk: p.disk_percent ?? null,
          netSent: p.net_bytes_sent ?? null,
          netRecv: p.net_bytes_recv ?? null,
        })),
      );
    });

    // Live tail. Capped so a dashboard left open for hours can't grow without bound —
    // the seeded range is what defines the window, not however long the tab has been up.
    const onMetrics = (data: { server?: any }) => {
      const sv = data?.server;
      if (!sv || Number(sv.id) !== serverId) return;
      setHistory((prev) => [
        ...prev.slice(-720),
        {
          time: sv.timestamp ?? new Date().toISOString(),
          cpu: sv.cpuPercent ?? null,
          mem: sv.memPercent ?? null,
          disk: sv.diskPercent ?? null,
          netSent: sv.netBytesSent ?? null,
          netRecv: sv.netBytesRecv ?? null,
        },
      ]);
    };
    socket.on("serverMetrics", onMetrics);
    return () => {
      alive = false;
      socket.off("serverMetrics", onMetrics);
    };
  }, [serverId, range]);

  const spanSec = rangeSpanSec(range);

  // Gaps wherever the agent stopped reporting, so an outage shows as a hole. `?? null`,
  // not `?? 0`: a missing value is not 0% CPU.
  const { labels, cpuData, memData, diskData } = useMemo(() => {
    const times = history.map((p) => Date.parse(p.time));
    const { labels: l, series } = withGaps(
      times,
      history.map((p) => fmtTime(p.time, spanSec)),
      [
        history.map((p) => p.cpu ?? null),
        history.map((p) => p.mem ?? null),
        history.map((p) => p.disk ?? null),
      ],
    );
    return { labels: l, cpuData: series[0]!, memData: series[1]!, diskData: series[2]! };
  }, [history, spanSec]);

  if (!server) {
    return <ChartMessage>Select a server above to see its trend.</ChartMessage>;
  }

  const offline = server.status !== "Online";

  const data: ChartData<"line"> = {
    labels,
    datasets: [
      lineSeries("CPU", cpuData, CPU_COLOR, true),
      lineSeries("Memory", memData, MEM_COLOR),
      lineSeries("Disk", diskData, DISK_COLOR),
    ],
  };

  // Status colour. Maintenance is BLUE rather than red — a server parked for a planned
  // reboot is not a fault, and painting it like one hides real outages in a sea of red.
  const statusColor =
    server.status === "Online" ? "#73BF69" : server.status === "Maintenance" ? "#5794F2" : "#F2495C";

  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      {/* Status line (state, uptime, address), same shape as the Network and UPS panels. */}
      <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap text-[11px]" style={{ color: "var(--gf-text-muted)" }}>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: statusColor }} />
          <span className="font-semibold" style={{ color: statusColor }}>{server.status}</span>
        </span>
        {server.ip && <span>· {server.ip}</span>}
        <span>· up {server.uptime}</span>
        {offline && <span style={{ color: "#FF780A" }}>· showing last known</span>}
      </div>

      {loading && history.length === 0 ? (
        <ChartMessage>Loading history…</ChartMessage>
      ) : history.length === 0 ? (
        <ChartMessage>No history stored for this range yet.</ChartMessage>
      ) : (
        <div style={{ height: FOCUS_CHART_H }}>
          <Line data={data} options={focusLineOptions(isDark, { unit: "%", min: 0, max: 100 })} />
        </div>
      )}

      {/* Current values on the legend, taken from the live server row so they stay current
         even when the last chart point is minutes old. */}
      <div className="flex items-center gap-3 flex-wrap">
        <LegendDot
          color={CPU_COLOR} label="CPU"
          value={offline ? "—" : `${server.cpu}%`}
          valueColor={offline ? "var(--gf-text-dim)" : loadColor(server.cpu)}
        />
        <LegendDot
          color={MEM_COLOR} label="Memory"
          value={offline ? "—" : `${server.memory}%`}
          valueColor={offline ? "var(--gf-text-dim)" : loadColor(server.memory)}
        />
        <LegendDot
          color={DISK_COLOR} label="Disk"
          value={offline ? "—" : `${server.diskUsed}%`}
          valueColor={offline ? "var(--gf-text-dim)" : loadColor(server.diskUsed)}
        />
      </div>
    </div>
  );
}
