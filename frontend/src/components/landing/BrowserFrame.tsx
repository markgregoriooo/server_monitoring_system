import type { ReactNode } from "react";

/**
 * Browser chrome around a visual, so a recreated panel looks like a screen of the
 * product. Kept plain: three dots, a URL pill, a hairline.
 *
 * The URL is the real address people will type: `datacenter.cspc.edu.ph`, the hostname
 * ICTU publishes for the deployed system (deployment-guide.md §6). The Cloudflare Tunnel
 * address (`monitoring.cspc-ictu.stream`) is development/defense only and is not shown.
 * LoginTutorial and DemoReel use this default.
 */
export default function BrowserFrame({
  children,
  url = "datacenter.cspc.edu.ph",
  className = "",
}: {
  children: ReactNode;
  url?: string;
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden ${className}`}
      style={{
        background: "var(--gf-panel)",
        border: "1px solid var(--gf-panel-border)",
        borderRadius: 3,
        boxShadow: "var(--gf-shadow)",
      }}
    >
      {/* chrome bar */}
      <div
        className="flex items-center gap-2 px-3"
        style={{
          height: 30,
          background: "var(--gf-header)",
          borderBottom: "1px solid var(--gf-divider)",
        }}
      >
        <div className="flex items-center gap-1.5 shrink-0" aria-hidden="true">
          {["#E5484D", "#F5A623", "#4CC38A"].map((c) => (
            <span
              key={c}
              className="block rounded-full"
              style={{ width: 8, height: 8, background: c, opacity: 0.75 }}
            />
          ))}
        </div>
        <div
          className="flex-1 min-w-0 text-center truncate"
          style={{
            fontSize: 9.5,
            letterSpacing: "0.04em",
            color: "var(--gf-text-dim)",
            background: "var(--gf-bg)",
            border: "1px solid var(--gf-divider)",
            borderRadius: 2,
            padding: "2.5px 8px",
          }}
        >
          {url}
        </div>
        {/* Balances the traffic lights so the URL pill sits optically centred. */}
        <div className="shrink-0" style={{ width: 30 }} aria-hidden="true" />
      </div>

      {children}
    </div>
  );
}
