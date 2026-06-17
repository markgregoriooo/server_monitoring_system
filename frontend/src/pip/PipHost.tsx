import { createPortal } from "react-dom";
import { usePip } from "./PipContext";
import PipWidget from "./PipWidget";

// Shell-level owner of the PiP window's content — the sibling of ToastHost. When a
// window is open it portals the widget into pipWindow.document.body, so the content
// stays inside the main React tree (live socket/contexts) while rendering in another
// window. Phase 2 renders the live PipWidget with the default layout; Phase 3 will
// feed it the user's saved layout.
export default function PipHost() {
  const { pipWindow } = usePip();
  if (!pipWindow) return null;
  return createPortal(<PipWidget />, pipWindow.document.body);
}
