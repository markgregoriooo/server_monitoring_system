import { useState, useEffect } from "react";
import type { ChartOptions } from "chart.js";
import "../chart/ChartConfig";
import { Line } from "react-chartjs-2";
import StatusBadge from "../components/ui/StatusBadge";
import { api } from "../api/api";
import { socket } from "../socket/socket";

interface Server {
  id: number;
  name: string;
  status: string;
  cpu: number;
  memory: number;
  uptime: string;
}

interface Alert {
  id: number;
  type: string;
  title: string;
  desc: string;
  time: string;
}

interface SensorData {
  temperature: number;
  timestamp: string;
}

function Gauge({ value, color }: { value: number; color: string }) {
  const r = 26, cx = 36, cy = 36, circ = 2 * Math.PI * r;
  const dash = (value / 100) * circ * 0.75;
  const offset = -(circ * 0.125);

  return (
    <svg width="72" height="72" viewBox="0 0 72 72" className="flex-shrink-0">
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="5" strokeDasharray={`${circ * 0.75} ${circ * 0.25}`} strokeDashoffset={offset} strokeLinecap="round" />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="5" strokeDasharray={`${dash} ${circ - dash}`} strokeDashoffset={offset} strokeLinecap="round" />
      <text x={cx} y={cy + 5} textAnchor="middle" fill="white" fontSize="11" fontWeight="700" fontFamily="monospace">{value}%</text>
    </svg>
  );
}

function MiniBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="w-12 sm:w-16 h-1.5 bg-white/10 rounded-full overflow-hidden">
      <div className="h-full rounded-full transition-all" style={{ width: `${value}%`, background: color }} />
    </div>
  );
}

export default function Dashboard() {

  const [servers, setServers] = useState<Server[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [liveTemp, setLiveTemp] = useState<number | string>("--");
  const [chartTemps, setChartTemps] = useState<number[]>([]);
  const [chartLabels, setChartLabels] = useState<string[]>([]);
  const [acOn, setAcOn] = useState<boolean>(true);
  const [acMode, setAcMode] = useState<string>("Auto");
  const [acTemp, setAcTemp] = useState<number>(24);

  useEffect(() => {

    api.getServers().then((result) => {
      if (result.success && result.data) setServers(result.data.servers);
    });

    api.getAlerts().then((result) => {
      if (result.success && result.data) setAlerts(result.data.alerts);
    });

    api.getAircon().then((result) => {
      if (result.success && result.data) {
        setAcOn(result.data.aircon.enabled);
        setAcMode(result.data.aircon.mode);
        setAcTemp(result.data.aircon.setTemp);
      }
    });

    const handleSensor = (data: SensorData) => {
      setLiveTemp(data.temperature);

      const time = new Date(data.timestamp).toLocaleTimeString("en-PH", {
        hour: "2-digit",
        minute: "2-digit"
      });

      setChartLabels(p => [...p.slice(-300), time]);
      setChartTemps(p => [...p.slice(-300), data.temperature]);
    };

    const handleMetrics = (data: { servers: Server[] }) => {
      setServers(data.servers);
    };

    socket.on("sensorData", handleSensor);
    socket.on("serverMetrics", handleMetrics);

    return () => {
      socket.off("sensorData", handleSensor);
      socket.off("serverMetrics", handleMetrics);
    };
  }, []);

  const cpuAvg = servers.length
    ? Math.round(servers.reduce((a, s) => a + s.cpu, 0) / servers.length)
    : 0;

  const memAvg = servers.length
    ? Math.round(servers.reduce((a, s) => a + s.memory, 0) / servers.length)
    : 0;

  const maxTemp = chartTemps.length ? Math.max(...chartTemps) + 2 : 35;

  const tempChartData = {
    labels: chartLabels,
    datasets: [{
      data: chartTemps,
      borderColor: "#00d4ff",
      backgroundColor: "rgba(0,212,255,0.08)",
      pointBackgroundColor: "#00d4ff",
      borderWidth: 2,
      pointRadius: 2,
      fill: true,
      tension: 0.4
    }],
  };

  const chartOptions: ChartOptions<"line"> = {
    responsive: true,
    animation: false,
    interaction: {
      mode: "nearest" as const,
      intersect: false
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "rgba(7,14,28,0.95)",
        borderColor: "rgba(0,212,255,0.3)",
        borderWidth: 1,
        titleColor: "rgba(180,200,240,0.6)",
        bodyColor: "#fff",
        padding: 8
      }
    },
    elements: {
      point: {
        radius: 1
      }
    },
    scales: {
      x: {
        grid: { color: "rgba(255,255,255,0.04)" },
        border: {
          display: false
        },
        ticks: {
          color: "rgba(180,200,240,0.35)",
          font: { size: 8, family: "monospace" },
          maxTicksLimit: 5
        }
      },
      y: {
        grid: { color: "rgba(255,255,255,0.04)" },
        border: {
          display: false
        },
        ticks: {
          color: "rgba(180,200,240,0.35)",
          font: { size: 8, family: "monospace" }
        },
        min: 15,
        max: maxTemp
      }
    }
  };

  const handleAcToggle = async () => {
    try {
      const d: any = await api.toggleAircon();
      setAcOn(d.aircon.enabled);
    } catch { }
  };

  const handleAcMode = async (m: string) => {
    try {
      const d: any = await api.setAirconMode(m);
      setAcMode(d.aircon.mode);
    } catch { }
  };

  const handleAcTemp = async (t: number) => {
    try {
      const d: any = await api.setAirconTemp(t);
      setAcTemp(d.aircon.setTemp);
    } catch { }
  };


  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4">

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="relative overflow-hidden rounded-xl bg-white/[0.03] border border-white/[0.08] p-4">
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-cyan-400 to-sky-600" />
          <div className="text-xs text-slate-400 font-semibold mb-2">Room Temperature</div>
          <div className="text-3xl font-bold text-white font-mono">{liveTemp} <span className="text-base text-white/40">°C</span></div>
          <div className="text-xs text-green-400 font-semibold mt-2">● Live</div>
        </div>
        <div className="relative overflow-hidden rounded-xl bg-white/[0.03] border border-white/[0.08] p-4">
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-blue-400 to-blue-700" />
          <div className="text-xs text-slate-400 font-semibold mb-1">CPU Usage</div>
          <div className="flex items-center gap-2"><Gauge value={cpuAvg} color="#4a90e2" /><div><div className="text-xl font-bold text-white font-mono">{cpuAvg}%</div><div className="text-xs text-yellow-400">Avg</div></div></div>
        </div>
        <div className="relative overflow-hidden rounded-xl bg-white/[0.03] border border-white/[0.08] p-4">
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-yellow-400 to-yellow-600" />
          <div className="text-xs text-slate-400 font-semibold mb-1">Memory Usage</div>
          <div className="flex items-center gap-2"><Gauge value={memAvg} color="#f5c400" /><div><div className="text-xl font-bold text-white font-mono">{memAvg}%</div><div className="text-xs text-yellow-400">Avg</div></div></div>
        </div>
        <div className="relative overflow-hidden rounded-xl bg-white/[0.03] border border-white/[0.08] p-4">
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-green-400 to-green-700" />
          <div className="text-xs text-slate-400 font-semibold mb-2">Server Status</div>
          <div className="flex items-center gap-2 mb-1"><span className="w-3 h-3 rounded-full bg-green-400 shadow-[0_0_8px_#4ade80]" /><span className="text-2xl font-bold text-green-400">Online</span></div>
          <div className="text-xs text-slate-400">{servers.length}/{servers.length} Servers</div>
        </div>
      </div>

      {/* Chart + AC */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-xl bg-white/[0.03] border border-white/[0.08] p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-bold text-white">Temperature (Live)</div>
            <div className="bg-cyan-400/10 border border-cyan-400/30 rounded-md px-3 py-1 text-cyan-400 font-mono font-bold text-sm">{liveTemp} °C</div>
          </div>
          <Line data={tempChartData} options={chartOptions} />
        </div>

        <div className="rounded-xl bg-white/[0.03] border border-white/[0.08] p-4 flex flex-col gap-3">
          <div className="text-sm font-bold text-white">Air Conditioner</div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">Power</span>
            <button onClick={handleAcToggle} className={`px-3 py-1.5 rounded-full text-xs font-bold border-none cursor-pointer transition-all ${acOn ? "bg-gradient-to-r from-green-700 to-green-500 text-white" : "bg-white/10 text-white"}`}>{acOn ? "✓ ON" : "OFF"}</button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {["Cool", "Auto", "Fan"].map(m => (
              <button key={m} onClick={() => handleAcMode(m)} className={`py-2 rounded-lg text-xs font-semibold cursor-pointer transition-all border ${acMode === m ? "bg-gradient-to-br from-blue-600 to-blue-700 text-white border-blue-500/50" : "bg-white/[0.04] text-slate-400 border-white/[0.07] hover:text-white"}`}>{m}</button>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-400">Target</span>
            <div className="flex items-center gap-2">
              <button onClick={() => handleAcTemp(Math.max(16, acTemp - 1))} className="w-7 h-7 rounded-full bg-white/10 border border-white/15 text-white cursor-pointer hover:bg-white/20 transition">−</button>
              <span className="text-lg font-bold text-white font-mono w-14 text-center">{acTemp} °C</span>
              <button onClick={() => handleAcTemp(Math.min(30, acTemp + 1))} className="w-7 h-7 rounded-full bg-white/10 border border-white/15 text-white cursor-pointer hover:bg-white/20 transition">+</button>
            </div>
          </div>
          <button onClick={handleAcToggle} className="mt-auto py-3 rounded-xl bg-gradient-to-r from-red-700 to-red-500 text-white font-bold text-sm cursor-pointer border-none hover:opacity-90 transition">🔒 Turn Off</button>
        </div>
      </div>

      {/* Servers + Alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-xl bg-white/[0.03] border border-white/[0.08] p-4">
          <div className="text-sm font-bold text-white mb-3">Server Metrics</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead><tr>{["Server", "Status", "CPU", "Memory", "Uptime"].map(h => <th key={h} className="text-left px-3 py-2 text-[10px] text-slate-500 font-semibold tracking-widest border-b border-white/[0.07]">{h}</th>)}</tr></thead>
              <tbody>
                {servers.map((s, i) => (
                  <tr key={s.id} className={i % 2 === 0 ? "bg-white/[0.015]" : ""}>
                    <td className="px-3 py-2.5 text-white font-semibold text-xs">{s.name}</td>
                    <td className="px-3 py-2.5"><StatusBadge status={s.status} /></td>
                    <td className="px-3 py-2.5"><div className="flex items-center gap-2"><span className="font-mono font-bold text-white text-xs w-8">{s.cpu}%</span><MiniBar value={s.cpu} color={s.cpu > 70 ? "#ef4444" : s.cpu > 50 ? "#f5c400" : "#4ade80"} /></div></td>
                    <td className="px-3 py-2.5"><div className="flex items-center gap-2"><span className="font-mono font-bold text-white text-xs w-8">{s.memory}%</span><MiniBar value={s.memory} color={s.memory > 80 ? "#ef4444" : s.memory > 60 ? "#f5c400" : "#4ade80"} /></div></td>
                    <td className="px-3 py-2.5 text-slate-400 text-xs">{s.uptime}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="rounded-xl bg-white/[0.03] border border-white/[0.08] p-4">
          <div className="text-sm font-bold text-white mb-3">Alerts</div>
          <div className="flex flex-col gap-2">
            {alerts.map(a => (
              <div key={a.id} className={`flex items-start gap-2.5 p-2.5 rounded-lg border ${a.type === "warning" ? "bg-amber-500/5 border-amber-500/15" : "bg-blue-500/5 border-blue-500/15"}`}>
                <span className="text-base flex-shrink-0">{a.type === "warning" ? "⚠️" : "ℹ️"}</span>
                <div className="flex-1 min-w-0"><div className="text-xs font-semibold text-white">{a.title}</div><div className="text-[10px] text-slate-400 mt-0.5">{a.desc}</div></div>
                <div className="text-[10px] text-slate-500 font-mono flex-shrink-0">{a.time}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
