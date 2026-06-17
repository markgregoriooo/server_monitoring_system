import { createPortal } from "react-dom";
import { usePip } from "./PipContext";

// Shell-level owner of the PiP window's content — the sibling of ToastHost. When a
// window is open it portals the widget into pipWindow.document.body, so the content
// stays inside the main React tree (live socket/contexts) while rendering in another
// window. Phase 1 renders a styled placeholder to prove the design system crosses the
// document boundary (stylesheet clone + theme class). Phases 2–4 swap in PipWidget.
export default function PipHost() {
  const { pipWindow } = usePip();
  if (!pipWindow) return null;
  return createPortal(<PipPlaceholder />, pipWindow.document.body);
}

function PipPlaceholder() {
  return (
    <div
      className="flex flex-col h-screen w-screen"
      style={{ background: "var(--gf-bg)", fontFamily: "'JetBrains Mono', monospace" }}
    >
      {/* header strip */}
      <div
        className="flex items-center gap-2 px-3 h-8 flex-shrink-0"
        style={{ background: "var(--gf-header)", borderBottom: "1px solid var(--gf-panel-border)" }}
      >
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60" style={{ background: "#73BF69" }} />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ background: "#73BF69" }} />
        </span>
        <span className="text-[10px] font-semibold tracking-wide" style={{ color: "var(--gf-text-primary)" }}>
          CSPC-ICTU · Live
        </span>
      </div>

      {/* body */}
      <div className="flex-1 flex flex-col items-center justify-center gap-2 px-4 text-center">
        <span className="text-[11px] font-semibold" style={{ color: "var(--gf-text-primary)" }}>
          Live widget
        </span>
        <span className="text-[10px] leading-relaxed" style={{ color: "var(--gf-text-muted)" }}>
          Pop-out is working. Tiles arrive next — you'll choose what shows here.
        </span>
        <span
          className="mt-1 text-[9px] tracking-widest uppercase px-2 py-1 rounded-[2px]"
          style={{ color: "var(--gf-accent)", background: "var(--gf-accent-dim)" }}
        >
          Phase 1 · plumbing
        </span>
      </div>
    </div>
  );
}
