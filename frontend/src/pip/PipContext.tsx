import { createContext, useCallback, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { usePictureInPicture } from "./usePictureInPicture";
import type { PictureInPicture } from "./usePictureInPicture";
import { useWidgetLayout } from "./useWidgetLayout";
import { useLiveSummary } from "./LiveSummaryContext";
import { estimateWidgetSize, WIDGET_WIDTH } from "./tiles/catalog";

// One PiP window instance shared across the app: the Header button opens/closes it,
// PipHost portals the widget into it. Both read this context so there's a single
// source of truth (mirrors how the app shares Auth/Notification state).
const PipContext = createContext<PictureInPicture | null>(null);

export function PipProvider({ children }: { children: ReactNode }) {
  const pip = usePictureInPicture({ width: WIDGET_WIDTH, height: 300 });
  // PipProvider is mounted INSIDE both of these (see App.tsx), which is what lets the
  // window be sized to the layout the user actually saved.
  const { layout } = useWidgetLayout();
  const { servers, upsList, routers } = useLiveSummary();

  // Size the window to fit the layout instead of always opening at 340x300 and making
  // the user scroll a glance surface. requestWindow only accepts an INITIAL size, so
  // this is computed per open() call rather than tracked reactively.
  //
  // Stays SYNCHRONOUS up to pip.open: requestWindow has to be the first thing awaited
  // or the user gesture is spent and the browser refuses the window. estimateWidgetSize
  // is pure arithmetic, so nothing here yields.
  //
  // An explicit width/height from the caller still wins — spreading opts last keeps
  // this an inferred default, not an override.
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
