import { useState } from "react";

interface ThresholdField {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  color: string;
  accent: string;
}

interface InfoItem {
  label: string;
  value: string;
}

export default function Settings() {
  const [serverIp, setServerIp] = useState<string>("localhost");
  const [serverPort, setServerPort] = useState<string>("3000");
  const [alertTemp, setAlertTemp] = useState<number>(28);
  const [alertHum, setAlertHum] = useState<number>(80);
  const [saved, setSaved] = useState<boolean>(false);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const inputClass = "w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white text-sm font-mono outline-none focus:border-blue-500/50 transition";
  const labelClass = "text-xs text-slate-400 font-semibold mb-1.5 block";

  const thresholdFields: ThresholdField[] = [
    { label: "Max Temperature Alert (°C)", value: alertTemp, onChange: setAlertTemp, min: 20, max: 40, color: "text-red-400", accent: "#ef4444" },
    { label: "Max Humidity Alert (%)", value: alertHum, onChange: setAlertHum, min: 50, max: 100, color: "text-blue-400", accent: "#4a90e2" },
  ];

  const infoItems: InfoItem[] = [
    { label: "System Name", value: "CSPC-ICTU Server Monitor" },
    { label: "Version", value: "v1.0.0" },
    { label: "Frontend", value: "React 18 + Vite + Tailwind CSS" },
    { label: "Backend", value: "Node.js + Express.js + Socket.IO" },
    { label: "Database", value: "MySQL · InfluxDB (Time-Series)" },
    { label: "Sensor", value: "DHT11 via ESP32" },
  ];

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4 bg-white dark:bg-transparent">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Connection */}
        <div className="rounded-xl bg-slate-100 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08] p-5">
          <div className="text-sm font-bold text-slate-900 dark:text-white mb-4">Backend Connection</div>

          <div className="flex flex-col gap-4">
            <div>
              <label className={labelClass}>Server IP / Hostname</label>
              <input
                value={serverIp}
                onChange={e => setServerIp(e.target.value)}
                placeholder="localhost"
                className={inputClass}
              />
            </div>

            <div>
              <label className={labelClass}>Server Port</label>
              <input
                value={serverPort}
                onChange={e => setServerPort(e.target.value)}
                placeholder="5000"
                className={inputClass}
              />
            </div>

            <div className="px-3 py-2.5 rounded-lg bg-slate-100 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.06]">
              <div className="text-[10px] text-slate-500 font-mono mb-1">API BASE URL</div>
              <div className="text-xs text-cyan-600 dark:text-cyan-400 font-mono">
                http://{serverIp}:{serverPort}/api
              </div>
            </div>
          </div>
        </div>

        {/* Thresholds */}
        <div className="rounded-xl bg-slate-100 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08] p-5">
          <div className="text-sm font-bold text-slate-900 dark:text-white mb-4">Alert Thresholds</div>

          <div className="flex flex-col gap-5">
            {thresholdFields.map(field => (
              <div key={field.label}>
                <div className="flex justify-between mb-2">
                  <span className="text-xs text-slate-500 dark:text-slate-400">{field.label}</span>
                  <span className={`text-sm font-bold font-mono ${field.color}`}>{field.value}</span>
                </div>

                <input
                  type="range"
                  min={field.min}
                  max={field.max}
                  value={field.value}
                  onChange={e => field.onChange(+e.target.value)}
                  className="w-full"
                  style={{ accentColor: field.accent }}
                />
              </div>
            ))}
          </div>
        </div>

        {/* System Info */}
        <div className="rounded-xl bg-slate-100 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08] p-5">
          <div className="text-sm font-bold text-slate-900 dark:text-white mb-4">System Information</div>

          <div className="flex flex-col gap-0">
            {infoItems.map(item => (
              <div
                key={item.label}
                className="flex justify-between py-2.5 border-b border-slate-200 dark:border-white/[0.05] last:border-0"
              >
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {item.label}
                </span>

                <span className="text-xs text-slate-900 dark:text-white font-semibold font-mono text-right max-w-[60%]">
                  {item.value}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Save */}
        <div className="rounded-xl bg-slate-100 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08] p-5 flex flex-col gap-4 justify-between">
          <div>
            <div className="text-sm font-bold text-slate-900 dark:text-white mb-2">Save Changes</div>

            <div className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              Changes to connection settings take effect on next reload. Alert thresholds apply immediately.
            </div>
          </div>

          <button
            onClick={handleSave}
            className={`py-3 rounded-xl text-white font-bold text-sm border-none cursor-pointer transition-all duration-300
            ${saved
                ? "bg-gradient-to-r from-green-700 to-green-500 shadow-[0_4px_14px_rgba(34,197,94,0.25)]"
                : "bg-gradient-to-r from-blue-700 to-blue-500 shadow-[0_4px_14px_rgba(26,86,196,0.25)] hover:opacity-90"
              }`}
          >
            {saved ? "✓ Saved!" : "Save Settings"}
          </button>
        </div>

      </div>
    </div>
  );

}