import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { documentTitleFor } from "../pageTitles";

/**
 * Keep the browser tab named after the page you are on.
 *
 * Called once, high enough in the tree to see every route. The static <title> in
 * index.html is only what the tab reads before React mounts; from the first render
 * onwards this owns it.
 */
export function useDocumentTitle(): void {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = documentTitleFor(pathname);
  }, [pathname]);
}
