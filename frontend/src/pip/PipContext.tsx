import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { usePictureInPicture } from "./usePictureInPicture";
import type { PictureInPicture } from "./usePictureInPicture";

// One PiP window instance shared across the app: the Header button opens/closes it,
// PipHost portals the widget into it. Both read this context so there's a single
// source of truth (mirrors how the app shares Auth/Notification state).
const PipContext = createContext<PictureInPicture | null>(null);

export function PipProvider({ children }: { children: ReactNode }) {
  const pip = usePictureInPicture({ width: 340, height: 300 });
  return <PipContext.Provider value={pip}>{children}</PipContext.Provider>;
}

export function usePip(): PictureInPicture {
  const ctx = useContext(PipContext);
  if (!ctx) throw new Error("usePip must be used within PipProvider");
  return ctx;
}
