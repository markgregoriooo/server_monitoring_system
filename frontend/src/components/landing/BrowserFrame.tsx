import type { ReactNode } from "react";

/**
 * Browser chrome around a visual, so a recreated panel reads as "a screen of the
 * product" rather than as decoration floating on the page.
 *
 * Deliberately understated: three dots, a URL pill, a hairline. No macOS gloss,
 * no perspective tilt, no drop-shadow bloom. The dashboard inside is dense and
 * dark; ornate chrome around it competes with the thing it is framing.
 *
 * The URL is the REAL deployment hostname — a small honesty: the address someone will
 * actually type. It is the live one, not an illustration, so it has to move when the
 * deployment does: `monitoring.cspc.edu.ph` was the address ICTU was going to publish,
 * and the system now runs on `monitoring.cspc-ictu.stream` behind a Cloudflare Tunnel
 * (`cloudflare-tunnel-setup.md`).
 *
 * ⚠️ Change it here and the walkthrough (LoginTutorial) and the animation (DemoReel)
 * both follow — neither passes `url`, and a frame showing an address that does not resolve
 * is worse than no address at all.
 */
export default function BrowserFrame({
  children,
  url = "monitoring.cspc-ictu.stream",
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
