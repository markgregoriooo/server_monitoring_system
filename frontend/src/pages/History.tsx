import { useState, useEffect } from "react";
import { api } from "../api/api";

type FilterType = "all" | "temp" | "humidity";

interface HistoryLog {
  date: string;
  avgTemp: number;
  maxTemp: number;
  minTemp: number;
  avgHum: number;
  events: number;
}

export default function History() {
  const [logs, setLogs] = useState<HistoryLog[]>([]);
  const [filter, setFilter] = useState<FilterType>("all");
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    api.getHistoryLogs()
      .then((d: { logs: HistoryLog[] }) => {
        setLogs(d.logs);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-base font-bold text-white">History Logs</div>
        <div className="flex gap-2">
          {[
            { key: "all", label: "All" },
            { key: "temp", label: "Temperature" },
            { key: "humidity", label: "Humidity" }
          ].map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key as FilterType)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer transition-all
                ${
                  filter === f.key
                    ? "bg-blue-500/20 border-blue-500/40 text-blue-400"
                    : "bg-white/[0.04] border-white/[0.07] text-slate-400 hover:text-white"
                }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl bg-white/[0.03] border border-white/[0.08] p-4">
        {loading ? (
          <div className="text-center py-8 text-slate-500 text-sm">
            Loading...
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  {[
                    "Date",
                    "Avg Temp",
                    "Max Temp",
                    "Min Temp",
                    "Avg Humidity",
                    "Events"
                  ].map(h => (
                    <th
                      key={h}
                      className="text-left px-3 py-2 text-[10px] text-slate-500 font-semibold tracking-widest border-b border-white/[0.07] whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {logs.map((row, i) => (
                  <tr
                    key={i}
                    className={i % 2 === 0 ? "bg-white/[0.015]" : ""}
                  >
                    <td className="px-3 py-3 font-mono text-white text-xs whitespace-nowrap">
                      {row.date}
                    </td>
                    <td className="px-3 py-3 font-mono font-bold text-cyan-400 text-xs">
                      {row.avgTemp} °C
                    </td>
                    <td className="px-3 py-3 font-mono font-bold text-red-400 text-xs">
                      {row.maxTemp} °C
                    </td>
                    <td className="px-3 py-3 font-mono font-bold text-green-400 text-xs">
                      {row.minTemp} °C
                    </td>
                    <td className="px-3 py-3 font-mono font-bold text-blue-400 text-xs">
                      {row.avgHum} %
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border
                        ${
                          row.events > 0
                            ? "bg-amber-500/10 border-amber-500/25 text-amber-400"
                            : "bg-green-500/10 border-green-500/25 text-green-400"
                        }`}
                      >
                        {row.events} event{row.events !== 1 ? "s" : ""}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
