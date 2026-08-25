import { useEffect, useState } from "react";
import type React from "react";

/**
 * `useState` that survives a page reload.
 *
 * localStorage (not sessionStorage) on purpose — it matches the sidebar's collapse/group
 * prefs and the theme toggle, so a choice also survives closing the tab. sessionStorage is
 * reserved for the auth token, which SHOULD die with the session.
 *
 * `isValid` guards the restored value. That matters more than it looks: a saved device id
 * or metric key can refer to something that has since been deleted, and restoring it
 * blindly renders an empty panel with no clue why. An invalid stored value falls back to
 * `initial` rather than being trusted.
 *
 * Every storage access is wrapped: private mode, a full quota, or a browser configured to
 * block site data all throw, and persistence is a convenience — never a reason for the
 * page to fail.
 *
 * Extracted from a local copy in `pages/Analytics.tsx` so the Dashboard could reuse it
 * rather than paste a second one. See audits/code-duplication-report-2026-08-25.md for why
 * a third copy would be the problem.
 */
export function usePersistedState<T>(
  key: string,
  initial: T,
  isValid?: (v: unknown) => boolean,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return initial;
      const parsed: unknown = JSON.parse(raw);
      if (isValid && !isValid(parsed)) return initial;
      return parsed as T;
    } catch {
      return initial; // corrupt JSON or storage disabled must never break the page
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode / quota — persistence is a convenience, not a requirement */
    }
  }, [key, value]);

  return [value, setValue];
}

/**
 * The Dashboard's "which device am I charting?" selection, remembered across reloads.
 *
 * Combines two rules that must not be separated:
 *
 *   1. REMEMBER what the user picked, so a refresh does not silently drop them back on
 *      whichever device happens to be first in the list.
 *   2. NEVER point at a device that is no longer there. A remembered id whose device has
 *      been removed — or which belongs to a list that has not loaded yet — falls back to
 *      the first available one, exactly as the previous auto-pick did.
 *
 * Rule 2 is why this is not just `usePersistedState`: without the liveness check, a
 * decommissioned router would be restored from storage forever and its panel would render
 * empty with nothing explaining it.
 *
 * Ids are handled as STRINGS because the device lists mix `number` (servers) and `string`
 * ids; the callers already convert at the picker boundary.
 */
export function usePersistedFocus(
  key: string,
  list: ReadonlyArray<{ id: string | number }>,
): [string | null, (id: string | null) => void] {
  const [id, setId] = usePersistedState<string | null>(
    key,
    null,
    (v) => v === null || typeof v === "string",
  );

  useEffect(() => {
    if (!list.length) {
      // Nothing to point at. Keep the stored id — the list may simply not have loaded
      // yet, and clearing it here would erase the user's choice on every refresh.
      return;
    }
    if (id === null || !list.some((d) => String(d.id) === id)) {
      setId(String(list[0]!.id));
    }
  }, [list, id, setId]);

  return [id, setId];
}

export default usePersistedState;
