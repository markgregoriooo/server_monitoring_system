import { useLiveSummary } from "./LiveSummaryContext";
import { useWidgetLayout } from "./useWidgetLayout";
import { TILE_BY_ID } from "./tiles/catalog";
import type { TileDef } from "./tiles/catalog";

// Renders a layout (an ordered list of tile ids) into an auto-flow 2-col grid. Unknown
// ids are skipped so an old/edited layout never breaks. With no prop it renders the
// user's saved layout (useWidgetLayout); the Settings builder passes a draft for preview.
export default function PipWidget({ layout }: { layout?: string[] }) {
  const { connected } = useLiveSummary();
  const { layout: saved } = useWidgetLayout();
  const tiles = (layout ?? saved)
    .map((id) => TILE_BY_ID.get(id))
    .filter((t): t is TileDef => !!t);

  return (
    <div className="flex flex-col h-full w-full" style={{ background: "var(--gf-bg)", fontFamily: "'JetBrains Mono', monospace" }}>
      {/* header strip */}
      <div
        className="flex items-center gap-2 px-3 h-7 flex-shrink-0"
        style={{ background: "var(--gf-header)", borderBottom: "1px solid var(--gf-panel-border)" }}
      >
        <span className="relative flex h-1.5 w-1.5">
          {connected && (
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60" style={{ background: "#73BF69" }} />
          )}
          <span className="relative inline-flex rounded-full h-1.5 w-1.5" style={{ background: connected ? "#73BF69" : "#F2495C" }} />
        </span>
        <span className="text-[10px] font-semibold tracking-wide" style={{ color: "var(--gf-text-primary)" }}>
          CSPC-ICTU · Live
        </span>
      </div>

      {/* tiles */}
      <div className="flex-1 overflow-y-auto p-1.5">
        {tiles.length === 0 ? (
          <div className="h-full flex items-center justify-center text-[10px] px-4 text-center" style={{ color: "var(--gf-text-muted)" }}>
            No tiles selected. Customize your widget in Settings.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {tiles.map((t) => {
              const Render = t.Render;
              return (
                <div key={t.id} className={t.span === 2 ? "col-span-2" : ""}>
                  <Render />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
