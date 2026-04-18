import { useState, useEffect } from "react";
import { api } from "../api/api.js";

interface LogEntry {
  time: string;
  action: string;
  reason: string;
}

export default function AirControl() {
  const [acOn, setAcOn] = useState<boolean>(true);
  const [acMode, setAcMode] = useState<string>("Auto");
  const [acTemp, setAcTemp] = useState<number>(24);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    api.getAircon()
      .then((d: any) => {
        setAcOn(d.aircon.enabled);
        setAcMode(d.aircon.mode);
        setAcTemp(d.aircon.setTemp);
        setLog(d.log);
      })
      .catch(() => {});
  }, []);

  const toggle = async () => {
    setLoading(true);
    try {
      const d: any = await api.toggleAircon();
      setAcOn(d.aircon.enabled);
      setLog((p) => [d.entry, ...p]);
    } catch {}
    setLoading(false);
  };

  const changeMode = async (m: string) => {
    try {
      const d: any = await api.setAirconMode(m);
      setAcMode(d.aircon.mode);
      setLog((p) => [d.entry, ...p]);
    } catch {}
  };

  const changeTemp = async (t: number) => {
    try {
      const d: any = await api.setAirconTemp(t);
      setAcTemp(d.aircon.setTemp);
      setLog((p) => [d.entry, ...p]);
    } catch {}
  };

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4">
      <div className="text-base font-bold text-white">Air Conditioner Control</div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        <div className="rounded-xl bg-white/[0.03] border border-white/[0.08] p-5 flex flex-col gap-4">
          <div className="text-sm font-bold text-white">Control Panel</div>

          <div className={`flex items-center justify-between p-3 rounded-xl border ${
            acOn ? "bg-green-500/[0.08] border-green-500/20" : "bg-red-500/[0.08] border-red-500/20"
          }`}>
            <div>
              <div className={`text-sm font-bold ${acOn ? "text-green-400" : "text-red-400"}`}>
                Air Conditioner is {acOn ? "ON" : "OFF"}
              </div>

              <div className="text-xs text-slate-400 mt-0.5">
                Mode: {acMode} · Target: {acTemp}°C
              </div>
            </div>

            <button
              onClick={toggle}
              disabled={loading}
              className={`px-4 py-2 rounded-full text-sm font-bold border-none cursor-pointer transition-all disabled:opacity-60 ${
                acOn
                  ? "bg-gradient-to-r from-green-700 to-green-500 text-white"
                  : "bg-white/10 text-white"
              }`}
            >
              {acOn ? "✓ ON" : "OFF"}
            </button>
          </div>

          <div>
            <div className="text-xs text-slate-400 mb-2">Operating Mode</div>

            <div className="grid grid-cols-3 gap-2">
              {["Cool", "Auto", "Fan"].map((m) => (
                <button
                  key={m}
                  onClick={() => changeMode(m)}
                  className={`py-3 rounded-xl text-sm font-semibold cursor-pointer transition-all border ${
                    acMode === m
                      ? "bg-gradient-to-br from-blue-600 to-blue-700 text-white border-blue-500/50"
                      : "bg-white/[0.04] text-slate-400 border-white/[0.07] hover:text-white"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-xs text-slate-400 mb-3">Target Temperature</div>

            <div className="flex items-center justify-center gap-6">
              <button
                onClick={() => changeTemp(Math.max(16, acTemp - 1))}
                className="w-10 h-10 rounded-full bg-white/10 border border-white/15 text-white text-xl cursor-pointer hover:bg-white/20 transition flex items-center justify-center"
              >
                −
              </button>

              <div className="text-5xl font-bold text-cyan-400 font-mono">
                {acTemp}
                <span className="text-2xl text-white/40"> °C</span>
              </div>

              <button
                onClick={() => changeTemp(Math.min(30, acTemp + 1))}
                className="w-10 h-10 rounded-full bg-white/10 border border-white/15 text-white text-xl cursor-pointer hover:bg-white/20 transition flex items-center justify-center"
              >
                +
              </button>
            </div>
          </div>

          <button
            onClick={toggle}
            disabled={loading}
            className="py-3 rounded-xl bg-gradient-to-r from-red-700 to-red-500 text-white font-bold text-sm cursor-pointer border-none hover:opacity-90 transition mt-auto disabled:opacity-60"
          >
            🔒 Turn Off
          </button>
        </div>

        <div className="rounded-xl bg-white/[0.03] border border-white/[0.08] p-5">
          <div className="text-sm font-bold text-white mb-3">Control Log</div>

          <div className="flex flex-col gap-2 overflow-y-auto max-h-80">
            {log.map((entry, i) => (
              <div
                key={i}
                className="flex gap-3 p-3 rounded-lg bg-white/[0.025] border border-white/[0.06]"
              >
                <div className="font-mono text-[10px] text-slate-500 flex-shrink-0 pt-0.5">
                  {entry.time}
                </div>

                <div>
                  <div className="text-xs font-semibold text-white">
                    {entry.action}
                  </div>

                  <div className="text-[10px] text-slate-400 mt-0.5">
                    {entry.reason}
                  </div>
                </div>
              </div>
            ))}
          </div>

        </div>

      </div>
    </div>
  );
}
