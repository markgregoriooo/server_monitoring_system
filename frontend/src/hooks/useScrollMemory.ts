import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/**
 * Remember each route's window scroll position and restore it on return.
 *
 * /login and /privacy scroll the document, and the browser keeps one scroll position
 * across client-side navigation, so going back from the notice opened the sign-in page
 * halfway down. React Router's `<ScrollRestoration />` needs a data router, and this
 * app uses `<BrowserRouter>`.
 *
 * Positions are kept per path, in memory; a reload starts at the top, and a page never
 * visited starts at 0. On signed-in routes this does nothing (<main> scrolls there,
 * not the window).
 */

/** Per-path window offsets for this tab. */
const offsets = new Map<string, number>();

/** How long to keep reaching for a saved offset while the page is still growing. */
const RESTORE_BUDGET_MS = 600;

export function useScrollMemory() {
  const { pathname } = useLocation();
  /* The listener is registered once and reads the current path from a ref, so a scroll
     event during navigation is not saved under the wrong page. */
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

    /* Keep trying while the page is still too short to reach the saved position (the
       sign-in page grows as images load); each attempt scrolls as far as it can. */
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
