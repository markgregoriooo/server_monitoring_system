import React from "react";

export default function StatusBadge({ status }) {
  const online = status === "Online";
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border
      ${online
        ? "bg-green-500/10 border-green-500/30 text-green-400"
        : "bg-red-500/10 border-red-500/30 text-red-400"
      }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${online ? "bg-green-400 shadow-[0_0_5px_#4ade80]" : "bg-red-400"}`} />
      ↓ {status}
    </span>
  );
}
