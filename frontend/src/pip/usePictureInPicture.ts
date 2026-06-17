import { useCallback, useEffect, useRef, useState } from "react";

// ── Document Picture-in-Picture ────────────────────────────────────────────────
// Chromium-only (Chrome/Edge 116+) and not yet in TS's DOM lib, so we declare the
// slice of the API we touch. This is the "Google Meet pop-out" API — a real,
// always-on-top window with its own (initially blank) document. We render React
// into it via createPortal (see PipHost), so it stays in the main app's React tree
// and keeps live socket/context access. The only thing that doesn't cross the
// document boundary is CSS — so on open we clone the stylesheets + theme class.

interface DocumentPiPOptions {
  width?: number;
  height?: number;
}
interface DocumentPiP {
  requestWindow(options?: DocumentPiPOptions): Promise<Window>;
  window: Window | null;
}
declare global {
  interface Window {
    documentPictureInPicture?: DocumentPiP;
  }
}

// Feature-detect once. Note: also requires a secure context (HTTPS or localhost).
export const pipSupported =
  typeof window !== "undefined" && "documentPictureInPicture" in window;

export interface PictureInPicture {
  supported: boolean;
  isOpen: boolean;
  pipWindow: Window | null;
  open: (opts?: DocumentPiPOptions) => Promise<void>;
  close: () => void;
}

// Clone every <style> / <link rel="stylesheet"> from the main document into the PiP
// document, in order. All our theming is CSS custom props on :root (--gf-*) +
// Tailwind utilities, so this makes the whole design system work inside the widget.
function cloneStyles(win: Window) {
  const nodes = document.querySelectorAll('style, link[rel="stylesheet"]');
  nodes.forEach((node) => win.document.head.appendChild(node.cloneNode(true)));
}

export function usePictureInPicture(defaultSize?: DocumentPiPOptions): PictureInPicture {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  // Ref mirror so close()/unmount cleanup never depend on the state value.
  const winRef = useRef<Window | null>(null);

  const open = useCallback(
    async (opts?: DocumentPiPOptions) => {
      if (!pipSupported) return;
      // Only one PiP window is allowed per browser — focus the existing one instead.
      const existing = window.documentPictureInPicture!.window;
      if (existing) {
        existing.focus();
        return;
      }
      // requestWindow MUST be the first thing we await so the user gesture survives.
      const win = await window.documentPictureInPicture!.requestWindow({
        width: opts?.width ?? defaultSize?.width ?? 340,
        height: opts?.height ?? defaultSize?.height ?? 300,
      });

      cloneStyles(win);
      // Mirror the dark/light class (set on <html> by ThemeContext) onto the PiP root.
      win.document.documentElement.className = document.documentElement.className;
      // Base the body so it reads as one of our panels even before content paints.
      Object.assign(win.document.body.style, {
        margin: "0",
        height: "100vh", // so the widget's h-full fills the window
        background: "var(--gf-bg)",
        color: "var(--gf-text-primary)",
        fontFamily: "'JetBrains Mono', monospace",
      });

      // The window can close from the user/X too — keep our state honest.
      win.addEventListener("pagehide", () => {
        winRef.current = null;
        setPipWindow(null);
      });

      winRef.current = win;
      setPipWindow(win);
    },
    [defaultSize],
  );

  const close = useCallback(() => {
    winRef.current?.close();
  }, []);

  // Keep the PiP root's theme class in sync if the user toggles dark/light while open.
  useEffect(() => {
    if (!pipWindow) return;
    const html = document.documentElement;
    const obs = new MutationObserver(() => {
      pipWindow.document.documentElement.className = html.className;
    });
    obs.observe(html, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, [pipWindow]);

  // Never leak a floating window when the app unmounts.
  useEffect(() => () => winRef.current?.close(), []);

  return { supported: pipSupported, isOpen: pipWindow !== null, pipWindow, open, close };
}
