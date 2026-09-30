import { useEffect } from "react";
import { createPortal } from "react-dom";
import { usePip } from "./PipContext";
import PipWidget from "./PipWidget";

// Renders the widget into the PiP window (next to ToastHost in the shell). It portals
// into pipWindow.document.body, so the content stays in the main React tree (live
// socket and contexts) while showing in the other window.
export default function PipHost() {
  const { pipWindow } = usePip();

  // Clicking anywhere in the widget brings the main window forward. A native listener,
  // since React events do not reach a portal in another document. See pip-widget.md §9.
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
