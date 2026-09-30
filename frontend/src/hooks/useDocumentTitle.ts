import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { documentTitleFor } from "../pageTitles";

/**
 * Keep the browser tab titled after the current page. Called once, high in the tree.
 * The <title> in index.html only shows before React mounts.
 */
export function useDocumentTitle(): void {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = documentTitleFor(pathname);
  }, [pathname]);
}
