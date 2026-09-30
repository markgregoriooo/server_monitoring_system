import { createContext, useCallback, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { usePictureInPicture } from "./usePictureInPicture";
import type { PictureInPicture } from "./usePictureInPicture";
import { useWidgetLayout } from "./useWidgetLayout";
import { useLiveSummary } from "./LiveSummaryContext";
import { estimateWidgetSize, WIDGET_WIDTH } from "./tiles/catalog";

// One PiP window shared across the app: the Header button opens and closes it, PipHost
// renders the widget into it.
const PipContext = createContext<PictureInPicture | null>(null);

export function PipProvider({ children }: { children: ReactNode }) {
  const pip = usePictureInPicture({ width: WIDGET_WIDTH, height: 300 });
  // PipProvider is mounted INSIDE both of these (see App.tsx), which is what lets the
  // window be sized to the layout the user actually saved.
  const { layout } = useWidgetLayout();
  const { servers, upsList, routers } = useLiveSummary();

  // Size the window to fit the layout instead of a fixed 340x300. requestWindow only
  // takes an initial size, so it is worked out on each open(). Must stay synchronous up to
  // pip.open (requestWindow has to be the first await, or the click no longer counts as a
  // user gesture). A width/height passed by the caller still wins.
  const open = useCallback(
    (opts?: { width?: number; height?: number }) => {
      const size = estimateWidgetSize(layout, {
        servers: servers.length,
        ups: upsList.length,
        routers: routers.length,
      });
      return pip.open({ ...size, ...opts });
    },
    [pip, layout, servers.length, upsList.length, routers.length],
  );

  const value = useMemo<PictureInPicture>(() => ({ ...pip, open }), [pip, open]);
  return <PipContext.Provider value={value}>{children}</PipContext.Provider>;
}

export function usePip(): PictureInPicture {
  const ctx = useContext(PipContext);
  if (!ctx) throw new Error("usePip must be used within PipProvider");
  return ctx;
}
