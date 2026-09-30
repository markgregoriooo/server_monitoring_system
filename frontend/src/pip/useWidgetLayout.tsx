import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api/api";
import { useAuth } from "../context/AuthContext";
import { DEFAULT_LAYOUT, resolveTile } from "./tiles/catalog";

// The user's widget layout, shared by the PiP window and the Settings builder, so a save
// shows in the open window right away. The backend holds it (GET/PUT
// /api/widget-layout); localStorage caches it for the first paint.

const CACHE_KEY = "cspc_pip_layout";

function readCache(): string[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((id) => typeof id === "string") : null;
  } catch {
    return null;
  }
}
function writeCache(layout: string[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(layout));
  } catch {
    /* private mode / quota — non-fatal */
  }
}
// Drop ids this build does not know. Uses resolveTile, not TILE_BY_ID, since per-device
// ids ("ups.device:7") are not in that map and would otherwise be deleted.
const known = (layout: string[]) => layout.filter((id) => !!resolveTile(id));

interface WidgetLayoutCtx {
  layout: string[];
  loading: boolean;
  saving: boolean;
  save: (next: string[]) => Promise<boolean>;
  reset: () => Promise<boolean>;
}

const Ctx = createContext<WidgetLayoutCtx | null>(null);

export function WidgetLayoutProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [layout, setLayout] = useState<string[]>(() => known(readCache() ?? DEFAULT_LAYOUT));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Reconcile with the server on login (cache already gave us a first paint).
  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    api.getWidgetLayout().then((r) => {
      if (!alive) return;
      if (r.success && r.data && Array.isArray(r.data.tiles)) {
        const tiles = known(r.data.tiles);
        setLayout(tiles);
        writeCache(tiles);
      }
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [user]);

  const save = useCallback(async (next: string[]) => {
    const tiles = known(next);
    setLayout(tiles); // optimistic
    writeCache(tiles);
    setSaving(true);
    const r = await api.saveWidgetLayout(tiles);
    setSaving(false);
    return r.success;
  }, []);

  const reset = useCallback(() => save([...DEFAULT_LAYOUT]), [save]);

  const value = useMemo(() => ({ layout, loading, saving, save, reset }), [layout, loading, saving, save, reset]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWidgetLayout() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWidgetLayout must be used within WidgetLayoutProvider");
  return ctx;
}
