import { useState, useEffect, useRef } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";

interface Aircon {
  id: number;
  name: string;
  enabled: boolean;
  mode: string;
  fanMode: string;
  setTemp: number;
  uptime: string;
}

interface LogEntry {
  time: string;
  action: string;
  reason: string;
}

interface SensorData {
  temperature: number;
  humidity: number;
  timestamp: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tempColor(t: number | string): string {
  if (typeof t !== "number") return "#94a3b8";
  if (t >= 28) return "#E24B4A";
  if (t >= 25) return "#EF9F27";
  return "#73BF69";
}

function humColor(h: number | string): string {
  if (typeof h !== "number") return "#94a3b8";
  if (h >= 70) return "#E24B4A";
  if (h >= 55) return "#EF9F27";
  return "#73BF69";
}

// ─── GaugeCanvas ──────────────────────────────────────────────────────────────

function GaugeCanvas({
  value, unit, pct, color,
}: {
  value: string | number; unit: string; pct: number; color: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const w = c.width, h = c.height;
    const cx = w / 2, cy = h * 0.68, r = w * 0.36;
    const s = Math.PI * 0.8, e = Math.PI * 2.2;
    const f = s + (e - s) * Math.min(Math.max(pct, 0), 1);
    const sw = e - s;

    ctx.clearRect(0, 0, w, h);

    // bg track
    ctx.beginPath(); ctx.arc(cx, cy, r, s, e);
    ctx.strokeStyle = "rgba(128,128,128,0.15)";
    ctx.lineWidth = w * 0.07; ctx.lineCap = "round"; ctx.stroke();

    // threshold bands
    let prev = s;
    for (const [end, col] of [
      [0.5,  "rgba(115,191,105,0.15)"],
      [0.75, "rgba(239,159,39,0.15)"],
      [1.0,  "rgba(226,75,74,0.15)"],
    ] as [number, string][]) {
      const be = s + sw * end;
      ctx.beginPath(); ctx.arc(cx, cy, r, prev, be);
      ctx.strokeStyle = col; ctx.lineWidth = w * 0.07; ctx.lineCap = "butt"; ctx.stroke();
      prev = be;
    }

    // filled arc
    if (pct > 0) {
      ctx.beginPath(); ctx.arc(cx, cy, r, s, f);
      ctx.strokeStyle = color; ctx.lineWidth = w * 0.07; ctx.lineCap = "round"; ctx.stroke();
    }

    // value text
    ctx.fillStyle = color;
    ctx.font = `bold ${Math.round(r * 0.4)}px monospace`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(value), cx, cy - r * 0.08);

    // unit text
    ctx.fillStyle = "rgba(148,163,184,0.6)";
    ctx.font = `${Math.round(r * 0.22)}px monospace`;
    ctx.fillText(unit, cx, cy + r * 0.32);
  }, [pct, color, value, unit]);

  return (
    <canvas
      ref={ref}
      width={130}
      height={100}
      style={{ width: "100%", maxWidth: 130, height: "auto" }}
    />
  );
}

// ─── StatCell ─────────────────────────────────────────────────────────────────

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col bg-white dark:bg-[#0d1117] px-3 py-3 gap-1">
      <span className="text-[9px] font-mono text-slate-400 dark:text-slate-500 uppercase tracking-widest">{label}</span>
      <span className="text-lg font-bold font-mono leading-none text-slate-700 dark:text-slate-200">{value}</span>
    </div>
  );
}

// ─── AirconCard ───────────────────────────────────────────────────────────────

function AirconCard({
  ac, log, roomTemp, humidity,
}: {
  ac: Aircon;
  log: LogEntry[];
  roomTemp: number | string;
  humidity: number | string;
}) {
  const tempVal   = typeof roomTemp === "number" ? roomTemp.toFixed(1) : "--";
  const humVal    = typeof humidity === "number"  ? humidity.toFixed(1) : "--";
  const tempPct   = typeof roomTemp === "number" ? (roomTemp - 15) / 25 : 0;
  const humPct    = typeof humidity === "number"  ? humidity / 100       : 0;
  const tColor    = tempColor(roomTemp);
  const hColor    = humColor(humidity);

  // Determine overall room status
  const roomStatus =
    typeof roomTemp === "number" && roomTemp >= 28 ? "critical" :
    typeof roomTemp === "number" && roomTemp >= 25 ? "warm" : "normal";

  const statusLabel = { critical: "High Temp", warm: "Warm",   normal: "Normal" }[roomStatus];
  const statusStyle = {
    critical: "bg-red-100 dark:bg-red-500/10 border-red-300 dark:border-red-500/25 text-red-600 dark:text-red-400",
    warm:     "bg-amber-100 dark:bg-amber-500/10 border-amber-300 dark:border-amber-500/25 text-amber-600 dark:text-amber-400",
    normal:   "bg-green-100 dark:bg-green-500/10 border-green-300 dark:border-green-500/25 text-green-600 dark:text-green-400",
  }[roomStatus];

  return (
    <div className="flex flex-col rounded-xl border border-slate-200 dark:border-white/[0.08] overflow-hidden bg-white dark:bg-white/[0.02]">

      {/* ── Header ── */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-white/[0.08] bg-slate-50 dark:bg-white/[0.03]">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            {ac.enabled && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60" />}
            <span className={`relative inline-flex rounded-full h-2 w-2 ${ac.enabled ? "bg-green-400" : "bg-slate-400"}`} />
          </span>
          <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">{ac.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-mono font-semibold px-2 py-0.5 rounded-full border ${statusStyle}`}>
            {statusLabel}
          </span>
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
            ac.enabled
              ? "bg-slate-100 dark:bg-white/[0.04] border-slate-200 dark:border-white/[0.08] text-slate-600 dark:text-slate-300"
              : "bg-slate-100 dark:bg-white/[0.04] border-slate-200 dark:border-white/[0.08] text-slate-400 dark:text-slate-500"
          }`}>
            {ac.enabled ? "Online" : "Offline"}
          </span>
        </div>
      </div>

      {/* ── Gauges row — Room Temp + Humidity ── */}
      <div className="grid grid-cols-2 gap-px bg-slate-200 dark:bg-white/[0.06] border-b border-slate-200 dark:border-white/[0.08]">
        <div className="flex flex-col items-center bg-white dark:bg-[#0d1117] px-3 pt-3 pb-2 gap-1">
          <span className="text-[9px] font-mono text-slate-400 dark:text-slate-500 uppercase tracking-widest self-start">Room Temperature</span>
          <GaugeCanvas value={tempVal} unit="°C" pct={tempPct} color={tColor} />
        </div>
        <div className="flex flex-col items-center bg-white dark:bg-[#0d1117] px-3 pt-3 pb-2 gap-1">
          <span className="text-[9px] font-mono text-slate-400 dark:text-slate-500 uppercase tracking-widest self-start">Room Humidity</span>
          <GaugeCanvas value={humVal} unit="%H" pct={humPct} color={hColor} />
        </div>
      </div>

      {/* ── A/C stats row 1: State / Fan Mode / A/C Mode ── */}
      <div className="grid grid-cols-3 gap-px bg-slate-200 dark:bg-white/[0.06] border-b border-slate-200 dark:border-white/[0.08]">
        <StatCell label="State"    value={ac.enabled ? "on" : "off"} />
        <StatCell label="Fan Mode" value={ac.fanMode ?? "auto"} />
        <StatCell label="A/C Mode" value={ac.mode} />
      </div>

      {/* ── A/C stats row 2: Set Temp / Uptime ── */}
      <div className="grid grid-cols-2 gap-px bg-slate-200 dark:bg-white/[0.06] border-b border-slate-200 dark:border-white/[0.08]">
        <StatCell label="Set Temp" value={`${ac.setTemp} °C`} />
        <StatCell label="Uptime"   value={ac.uptime} />
      </div>

      {/* ── Activity log ── */}
      <div className="flex flex-col flex-1 p-4 gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-mono text-slate-400 dark:text-slate-600 tracking-widest uppercase">
            Activity Log
          </span>
          {log.length > 0 && (
            <span className="text-[9px] font-mono text-slate-400 dark:text-slate-600">
              {log.length} entries
            </span>
          )}
        </div>

        <div className="flex flex-col gap-1.5 overflow-y-auto max-h-48">
          {log.length === 0 ? (
            <div className="text-[10px] font-mono text-slate-400 dark:text-slate-600">No activity recorded.</div>
          ) : (
            log.slice(0, 8).map((entry, i) => {
              // Infer severity from action text
              const isCritical = entry.action.toLowerCase().includes("off") || entry.action.toLowerCase().includes("error");
              const isWarn     = entry.action.toLowerCase().includes("trigger") || entry.action.toLowerCase().includes("exceeded");
              const dotColor   = isCritical ? "bg-red-400" : isWarn ? "bg-amber-400" : "bg-blue-400";
              return (
                <div
                  key={i}
                  className="flex gap-2 items-start bg-slate-50 dark:bg-white/[0.02] rounded-lg px-2.5 py-2 border border-slate-100 dark:border-white/[0.05]"
                >
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1 ${dotColor}`} />
                  <span className="text-[9px] font-mono text-slate-400 dark:text-slate-600 flex-shrink-0 whitespace-nowrap pt-0.5">
                    {entry.time}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[10px] font-mono font-medium text-slate-600 dark:text-slate-300 truncate">{entry.action}</div>
                    <div className="text-[9px] font-mono text-slate-400 dark:text-slate-500">{entry.reason}</div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

    </div>
  );
}

// ─── Summary bar ──────────────────────────────────────────────────────────────

function SummaryBar({
  aircons, roomTemp, humidity,
}: {
  aircons: Aircon[]; roomTemp: number | string; humidity: number | string;
}) {
  const online = aircons.filter(a => a.enabled).length;
  const panels = [
    {
      label: "Units Online",
      value: `${online} / ${aircons.length}`,
      color: online === aircons.length ? "text-green-600 dark:text-green-400"
           : online === 0 ? "text-red-600 dark:text-red-400"
           : "text-amber-600 dark:text-amber-400",
    },
    {
      label: "Room Temp",
      value: typeof roomTemp === "number" ? `${roomTemp.toFixed(1)} °C` : "--",
      color: typeof roomTemp === "number" && roomTemp >= 28 ? "text-red-600 dark:text-red-400"
           : typeof roomTemp === "number" && roomTemp >= 25 ? "text-amber-600 dark:text-amber-400"
           : "text-cyan-600 dark:text-cyan-400",
    },
    {
      label: "Room Humidity",
      value: typeof humidity === "number" ? `${humidity.toFixed(1)} %` : "--",
      color: typeof humidity === "number" && humidity >= 70 ? "text-red-600 dark:text-red-400"
           : typeof humidity === "number" && humidity >= 55 ? "text-amber-600 dark:text-amber-400"
           : "text-sky-600 dark:text-sky-400",
    },
    {
      label: "Active Mode",
      value: aircons.find(a => a.enabled)?.mode ?? "—",
      color: "text-slate-700 dark:text-slate-200",
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {panels.map(p => (
        <div key={p.label} className="rounded-xl bg-slate-100 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08] p-4">
          <div className="text-[9px] font-mono text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1.5">{p.label}</div>
          <div className={`text-2xl font-bold font-mono leading-none ${p.color}`}>{p.value}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function AirConditioner() {
  const [aircons,  setAircons]  = useState<Aircon[]>([]);
  const [logs,     setLogs]     = useState<Record<number, LogEntry[]>>({});
  const [loading,  setLoading]  = useState<boolean>(true);
  const [roomTemp, setRoomTemp] = useState<number | string>("--");
  const [humidity, setHumidity] = useState<number | string>("--");

  useEffect(() => {
    api.getAircon().then((result) => {
      if (result.success && result.data) {
        const units: Aircon[] = Array.isArray(result.data.aircons)
          ? result.data.aircons
          : result.data.aircon
          ? [result.data.aircon]
          : [];
        setAircons(units);
        const logMap: Record<number, LogEntry[]> = {};
        units.forEach((u) => { logMap[u.id] = result.data.log ?? []; });
        setLogs(logMap);
      }
      setLoading(false);
    }).catch(() => setLoading(false));

    const handleLive = (data: SensorData) => {
      if (!data) return;
      setRoomTemp(data.temperature);
      setHumidity(data.humidity);
    };
    socket.on("sensorData", handleLive);

    socket.on("airconStatus", (data: { aircon: Aircon; entry?: LogEntry }) => {
      setAircons((prev) =>
        prev.map((a) => a.id === data.aircon.id ? { ...a, ...data.aircon } : a)
      );
      if (data.entry) {
        setLogs((prev) => ({
          ...prev,
          [data.aircon.id]: [data.entry!, ...(prev[data.aircon.id] ?? [])].slice(0, 50),
        }));
      }
    });

    return () => {
      socket.off("sensorData", handleLive);
      socket.off("airconStatus");
    };
  }, []);

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4 bg-white dark:bg-transparent">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-base font-bold text-slate-900 dark:text-white">Air Conditioner Monitor</div>
          <div className="text-[10px] text-slate-400 dark:text-slate-500 mt-0.5">
            Server Room · {aircons.length} unit{aircons.length !== 1 ? "s" : ""}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-400" />
          </span>
          <span className="text-[10px] text-slate-400 dark:text-slate-500">Live</span>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-16 text-slate-400 text-sm">Loading...</div>
      ) : (
        <>
          {/* Summary bar */}
          <SummaryBar aircons={aircons} roomTemp={roomTemp} humidity={humidity} />

          {/* Cards */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {aircons.map((ac) => (
              <AirconCard
                key={ac.id}
                ac={ac}
                log={logs[ac.id] ?? []}
                roomTemp={roomTemp}
                humidity={humidity}
              />
            ))}
          </div>
        </>
      )}

    </div>
  );
}