import { useState, useEffect } from "react";
import StatusBadge from "../components/ui/StatusBadge";
import { api } from "../api/api";
import { socket } from "../socket/socket";

interface Server {
  id: string;
  name: string;
  ip: string;
  status: string;
  cpu: number;
  memory: number;
  uptime: string;
}

interface MiniBarProps {
  value: number;
  color: string;
}

function MiniBar({ value, color }: MiniBarProps) {
  return (
    <div className="w-16 h-1.5 bg-white/10 rounded-full overflow-hidden">
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${value}%`, background: color }}
      />
    </div>
  );
}

export default function ServerMetrics() {
  const [servers, setServers] = useState<Server[]>([]);

  useEffect(() => {
    api
      .getServers()
      .then((d: { servers: Server[] }) => setServers(d.servers))
      .catch(() => {});

    socket.on("serverMetrics", (data: { servers: Server[] }) =>
      setServers(data.servers)
    );

    return () => {
      socket.off("serverMetrics");
    };
  }, []);

  const cpuAvg = servers.length
    ? Math.round(servers.reduce((a, s) => a + s.cpu, 0) / servers.length)
    : 0;

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4">
      <div className="text-base font-bold text-white">
        Server Metrics Overview
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {[
          { label: "Total Servers", value: servers.length, color: "text-blue-400" },
          { label: "Online", value: servers.filter(s => s.status === "Online").length, color: "text-green-400" },
          { label: "Avg CPU Load", value: `${cpuAvg}%`, color: "text-yellow-400" },
        ].map(item => (
          <div
            key={item.label}
            className="rounded-xl bg-white/[0.03] border border-white/[0.08] p-4"
          >
            <div className="text-xs text-slate-400 font-semibold mb-2">
              {item.label}
            </div>
            <div className={`text-3xl font-bold font-mono ${item.color}`}>
              {item.value}
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-xl bg-white/[0.03] border border-white/[0.08] p-4">
        <div className="text-sm font-bold text-white mb-3">Live Server List</div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                {["Server", "IP Address", "Status", "CPU", "Memory", "Uptime"].map(h => (
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
              {servers.map((s, i) => (
                <tr key={s.id} className={i % 2 === 0 ? "bg-white/[0.015]" : ""}>
                  <td className="px-3 py-3 text-white font-semibold text-xs">
                    {s.name}
                  </td>

                  <td className="px-3 py-3 font-mono text-slate-400 text-xs">
                    {s.ip}
                  </td>

                  <td className="px-3 py-3">
                    <StatusBadge status={s.status} />
                  </td>

                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-white text-xs w-8">
                        {s.cpu}%
                      </span>
                      <MiniBar
                        value={s.cpu}
                        color={s.cpu > 70 ? "#ef4444" : s.cpu > 50 ? "#f5c400" : "#4ade80"}
                      />
                    </div>
                  </td>

                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-white text-xs w-8">
                        {s.memory}%
                      </span>
                      <MiniBar
                        value={s.memory}
                        color={s.memory > 80 ? "#ef4444" : s.memory > 60 ? "#f5c400" : "#4ade80"}
                      />
                    </div>
                  </td>

                  <td className="px-3 py-3 text-slate-400 text-xs whitespace-nowrap">
                    {s.uptime}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}