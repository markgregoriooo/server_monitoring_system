import { useEffect } from "react";
import { createPortal } from "react-dom";
import { usePip } from "./PipContext";
import PipWidget from "./PipWidget";

// Shell-level owner of the PiP window's content — the sibling of ToastHost. When a
// window is open it portals the widget into pipWindow.document.body, so the content
// stays inside the main React tree (live socket/contexts) while rendering in another
// window. It renders PipWidget, which reads the user's saved layout.
export default function PipHost() {
  const { pipWindow } = usePip();

  // Click-through: clicking anywhere in the floating widget brings the main app window
  // forward ("jump back"). Uses a NATIVE listener, not React onClick — React 18 event
  // delegation doesn't reach a portal in a separate document. See pip-widget.md §9.
  useEffect(() => {
    if (!pipWindow) return;
    const onClick = () => {
      try {
        window.focus();
      } catch {
        /* best-effort — some browsers restrict cross-window focus */
      }
    };
    pipWindow.addEventListener("click", onClick);
    return () => pipWindow.removeEventListener("click", onClick);
  }, [pipWindow]);

  if (!pipWindow) return null;
  return createPortal(<PipWidget />, pipWindow.document.body);
}
