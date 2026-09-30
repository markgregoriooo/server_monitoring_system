import { useEffect, useState } from "react";
import type React from "react";

/**
 * `useState` that survives a page reload.
 *
 * Uses localStorage, like the sidebar and theme settings; sessionStorage is only for
 * the auth token. `isValid` checks the restored value (a saved device may have been
 * deleted) and falls back to `initial`. All storage access is wrapped in try/catch,
 * since private mode or blocked storage throws.
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
 * The Dashboard's selected device, remembered across reloads. Restores the saved
 * choice, but falls back to the first available device if the saved one no longer
 * exists or the list has not loaded. Ids are strings because the lists mix numbers
 * (servers) and strings.
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
