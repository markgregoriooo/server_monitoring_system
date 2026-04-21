import { useState, useEffect } from "react";
import "../chart/ChartConfig";
import { Line } from "react-chartjs-2";
import { socket } from "../socket/socket";
import type { ChartOptions, ChartData } from "chart.js";

type RangeType = "-30m" | "-1h" | "-24h";

interface SensorData {
  temperature: number;
  humidity: number;
  timestamp: string;
}

interface HistoryData {
  time: string;
  temperature: number;
  humidity: number;
}

const chartOptions = (color: string, min: number, max: number, unit: string): ChartOptions<"line"> => ({
  responsive: true,
  animation: false,
  interaction: {
    mode: "nearest",
    intersect: false
  },
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: "rgba(7,14,28,0.95)",
      borderColor: `${color}44`,
      borderWidth: 1,
      titleColor: "rgba(180,200,240,0.6)",
      bodyColor: "#fff",
      padding: 8,
      callbacks: {
        label: (ctx) => ` ${ctx.parsed.y} ${unit}`
      }
    }
  },
  scales: {
    x: {
      grid: { color: "rgba(255,255,255,0.04)" },
      border: { display: false },
      ticks: {
        color: "rgba(180,200,240,0.35)",
        font: { size: 8, family: "monospace" },
        maxTicksLimit: 7
      }
    },
    y: {
      grid: { color: "rgba(255,255,255,0.04)" },
      border: { display: false },
      ticks: {
        color: "rgba(180,200,240,0.35)",
        font: { size: 8, family: "monospace" }
      },
      min,
      max
    }
  }
});

function LiveBadge() {
  return (
    <span className="flex items-center gap-1.5 text-[9px] font-mono text-green-400/75">
      <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
      LIVE
    </span>
  );
}

export default function Environment() {
  const [labels, setLabels] = useState<string[]>([]);
  const [temps, setTemps] = useState<number[]>([]);
  const [hums, setHums] = useState<number[]>([]);
  const [liveTemp, setLiveTemp] = useState<number | string>("--");
  const [liveHum, setLiveHum] = useState<number | string>("--");
  const [range, setRange] = useState<RangeType>("-1h");

  useEffect(() => {
    const handleHistory = (history: HistoryData[]) => {
      if (!history || history.length === 0) return;

      const lbls = history.map(r =>
        new Date(r.time).toLocaleTimeString("en-PH", {
          hour: "2-digit",
          minute: "2-digit"
        })
      );

      const tempsArr = history.map(r => r.temperature);
      const humsArr = history.map(r => r.humidity);

      let limit = 50;
      if (range === "-30m") limit = 300;
      if (range === "-1h") limit = 600;
      if (range === "-24h") limit = 1000;

      setLabels(lbls.slice(-limit));
      setTemps(tempsArr.slice(-limit));
      setHums(humsArr.slice(-limit));

      const last = history[history.length - 1];

      setLiveTemp(last?.temperature ?? "--");
      setLiveHum(last?.humidity ?? "--");
    };

    const handleLive = (data: SensorData) => {
      if (!data) return;

      const time = new Date(data.timestamp).toLocaleTimeString("en-PH", {
        hour: "2-digit",
        minute: "2-digit"
      });

      setLiveTemp(data.temperature);
      setLiveHum(data.humidity);

      setLabels(p => [...p.slice(-999), time]);
      setTemps(p => [...p.slice(-999), data.temperature]);
      setHums(p => [...p.slice(-999), data.humidity]);
    };

    socket.on("sensorHistory", handleHistory);
    socket.on("sensorData", handleLive);

    socket.emit("changeRange", range);

    return () => {
      socket.off("sensorHistory", handleHistory);
      socket.off("sensorData", handleLive);
    };
  }, [range]);

  const changeRange = (r: RangeType) => {
    setRange(r);
    socket.emit("changeRange", r);
  };

  const tempData: ChartData<"line"> = {
    labels,
    datasets: [
      {
        data: temps,
        borderColor: "#4a90e2",
        backgroundColor: "rgba(0,212,255,0.07)",
        borderWidth: 2,
        pointRadius: 2,
        fill: true,
        tension: 0.4
      }
    ]
  };

  const humData: ChartData<"line"> = {
    labels,
    datasets: [
      {
        data: hums,
        borderColor: "#4a90e2",
        backgroundColor: "rgba(74,144,226,0.07)",
        borderWidth: 2,
        pointRadius: 2,
        fill: true,
        tension: 0.4
      }
    ]
  };

  const peakTemp = temps.length ? Math.max(...temps).toFixed(1) : "--";
  const minTemp = temps.length ? Math.min(...temps).toFixed(1) : "--";

  const kpis = [
    { label: "Current Temp", value: `${liveTemp} °C`, color: "text-cyan-400", accent: "from-cyan-400 to-sky-600" },
    { label: "Current Humidity", value: `${liveHum} %`, color: "text-blue-400", accent: "from-blue-400 to-blue-700" },
    { label: "Peak Temp", value: `${peakTemp} °C`, color: "text-yellow-400", accent: "from-yellow-400 to-yellow-700" },
    { label: "Min Temp", value: `${minTemp} °C`, color: "text-green-400", accent: "from-green-400 to-green-700" }
  ];

  const maxTemp = temps.length ? Math.max(...temps) + 2 : 35;
  const maxHum = hums.length ? Math.max(...hums) + 2 : 100;

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4">
      <div className="text-base font-bold text-white">Environment Monitoring</div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpis.map(item => (
          <div key={item.label} className="relative overflow-hidden rounded-xl bg-white/[0.03] border border-white/[0.08] p-4">
            <div className={`absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r ${item.accent}`} />
            <div className="text-xs text-slate-400 font-semibold mb-2">{item.label}</div>
            <div className={`text-2xl font-bold font-mono ${item.color}`}>{item.value}</div>
          </div>
        ))}
      </div>

      <div className="flex gap-2 mb-2">
        {["-30m", "-1h", "-24h"].map(r => (
          <button
            key={r}
            className={`px-3 py-1 text-xs font-mono rounded ${range === r ? "bg-green-500 text-white" : "bg-white/5 text-slate-300"}`}
            onClick={() => changeRange(r as RangeType)}
          >
            {r}
          </button>
        ))}
      </div>

      <div className="rounded-xl bg-white/[0.03] border border-white/[0.08] p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-bold text-white">Temperature · °C</div>
          <LiveBadge />
        </div>
        <Line data={tempData} options={chartOptions("#00d4ff", 15, maxTemp, "°C")} />
      </div>

      <div className="rounded-xl bg-white/[0.03] border border-white/[0.08] p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-bold text-white">Humidity · %RH</div>
          <LiveBadge />
        </div>
        <Line data={humData} options={chartOptions("#4a90e2", 40, maxHum, "%")} />
      </div>
    </div>
  );
}
