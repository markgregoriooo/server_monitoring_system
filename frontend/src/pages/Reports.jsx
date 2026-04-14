import { useState, useEffect } from "react";
import { api } from "../api/api";
import { useAuth } from "../context/AuthContext";

export default function Reports() {
  const { user } = useAuth();
  const [reports, setReports]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [generating, setGenerating] = useState(false);
  const canGenerate = ["super_admin","it_staff"].includes(user?.role);

  useEffect(() => {
    api.getReports().then(d => { setReports(d.reports); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const d = await api.generateReport("On-Demand Report", "Environment");
      setReports(p => [d.report, ...p]);
    } catch {}
    setGenerating(false);
  };

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-base font-bold text-white">Reports</div>
        {canGenerate && (
          <button onClick={handleGenerate} disabled={generating}
            className="px-4 py-2 rounded-lg bg-gradient-to-r from-blue-700 to-blue-500 text-white font-semibold text-sm
              border-none cursor-pointer hover:opacity-90 transition disabled:opacity-60">
            {generating ? "Generating..." : "+ Generate Report"}
          </button>
        )}
      </div>
      <div className="rounded-xl bg-white/[0.03] border border-white/[0.08] p-4">
        {loading ? (
          <div className="text-center py-8 text-slate-500 text-sm">Loading...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  {["#","Title","Type","Date","Status","Action"].map(h => (
                    <th key={h} className="text-left px-3 py-2 text-[10px] text-slate-500 font-semibold tracking-widest border-b border-white/[0.07] whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {reports.map((r, i) => (
                  <tr key={r.id} className={i%2===0?"bg-white/[0.015]":""}>
                    <td className="px-3 py-3 font-mono text-slate-500 text-xs">{String(r.id).padStart(2,"0")}</td>
                    <td className="px-3 py-3 text-white font-semibold text-xs">{r.title}</td>
                    <td className="px-3 py-3">
                      <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-500/10 border border-blue-500/25 text-blue-400">{r.type}</span>
                    </td>
                    <td className="px-3 py-3 font-mono text-slate-400 text-xs whitespace-nowrap">{r.date}</td>
                    <td className="px-3 py-3">
                      <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border
                        ${r.status==="Generated"?"bg-green-500/10 border-green-500/25 text-green-400":"bg-amber-500/10 border-amber-500/25 text-amber-400"}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <button className="px-3 py-1 rounded-md border border-white/10 bg-white/[0.05] text-slate-400 text-xs cursor-pointer hover:text-white transition">
                        ↓ Download
                      </button>
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
