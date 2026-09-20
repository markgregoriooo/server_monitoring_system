import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/**
 * Remember where the window was scrolled on each route, and put it back on return.
 *
 * The browser keeps ONE document scroll position, and a client-side navigation does not
 * reset it. `/login` and `/privacy` both scroll the document (each is a plain
 * `min-h-screen` page, unlike the signed-in shell where <main> owns the scrolling), so
 * reading the privacy notice to the bottom and pressing "Back to sign in" dropped the
 * sign-in page in at the notice's offset — a page the user had never scrolled, opened
 * somewhere in its middle.
 *
 * ⚠️ Not React Router's `<ScrollRestoration />`: that only works under a data router
 * (`createBrowserRouter`), and this app mounts a plain `<BrowserRouter>` in main.tsx.
 *
 * Offsets are per PATH and per tab (in memory, not sessionStorage) — a reload is a fresh
 * read of a document and belongs at the top. A path never visited restores to 0, which is
 * why opening the notice for the first time still lands on its title rather than wherever
 * the sign-in page happened to be.
 *
 * On the signed-in routes this is a no-op: the shell is `h-screen overflow-hidden`, so
 * `window.scrollY` is always 0 there and both the save and the restore write zero.
 */

/** Per-path window offsets for this tab. */
const offsets = new Map<string, number>();

/** How long to keep reaching for a saved offset while the page is still growing. */
const RESTORE_BUDGET_MS = 600;

export function useScrollMemory() {
  const { pathname } = useLocation();
  /* The listener below is registered ONCE and reads the current path from here rather than
     from its closure. A scroll event that lands mid-navigation — including the one our own
     restore provokes — would otherwise file the incoming page's offset under the outgoing
     page's key, quietly destroying the position this hook exists to keep. */
  const pathRef = useRef(pathname);
  const restoringRef = useRef(false);

  useEffect(() => {
    const onScroll = () => {
      if (restoringRef.current) return;
      offsets.set(pathRef.current, window.scrollY);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    pathRef.current = pathname;
    const target = offsets.get(pathname) ?? 0;
    restoringRef.current = true;

    let frame = 0;
    const deadline = performance.now() + RESTORE_BUDGET_MS;

    /* Aim for the saved offset, and keep aiming while the document is still too SHORT to
       hold it. The sign-in page is image-heavy (the landing gallery), so at the moment of
       the restore it can be a fraction of its final height — `scrollTo` then clamps to the
       current bottom and the offset is silently lost, which looks exactly like the bug
       being fixed. Each attempt scrolls as far as it currently can, so the page is never
       left sitting at the previous route's offset while we wait. */
    const attempt = () => {
      const maxScroll = Math.max(
        0,
        document.documentElement.scrollHeight - window.innerHeight,
      );
      window.scrollTo(0, Math.min(target, maxScroll));
      if (maxScroll < target && performance.now() < deadline) {
        frame = requestAnimationFrame(attempt);
      } else {
        restoringRef.current = false;
      }
    };
    attempt();

    return () => {
      cancelAnimationFrame(frame);
      restoringRef.current = false;
    };
  }, [pathname]);
}
