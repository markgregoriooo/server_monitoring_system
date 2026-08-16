import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
  useSortable,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { useWidgetLayout } from "./useWidgetLayout";
import { usePip } from "./PipContext";
import PipWidget from "./PipWidget";
import { TILE_CATALOG, DEFAULT_LAYOUT, MAX_TILES, resolveTile, deviceTileId } from "./tiles/catalog";
import type { TileDef } from "./tiles/catalog";
import { useLiveSummary } from "./LiveSummaryContext";

// Settings → Customize Widget: drag-and-drop builder for the PiP widget layout. Edits a
// local `draft`; the live preview + (once supported) the open pop-out render it; Save
// persists via useWidgetLayout. Build big here, render small in the floating window.

const panel: React.CSSProperties = {
  background: "var(--gf-panel)",
  border: "1px solid var(--gf-panel-border)",
  borderRadius: 2,
  fontFamily: "'JetBrains Mono', monospace",
};

function GripIcon() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
      <circle cx="2" cy="2" r="1.2" /><circle cx="8" cy="2" r="1.2" />
      <circle cx="2" cy="7" r="1.2" /><circle cx="8" cy="7" r="1.2" />
      <circle cx="2" cy="12" r="1.2" /><circle cx="8" cy="12" r="1.2" />
    </svg>
  );
}

// Pins ONE device as its own tile. A dropdown rather than a "+" per unit: the campus
// can have a dozen routers, and that many rows would bury the handful of static tiles
// above them. Resets to the placeholder after each pick so it reads as an action
// ("add this one") rather than a setting ("the selected one").
function DevicePicker({
  placeholder,
  emptyLabel,
  options,
  onPick,
}: {
  placeholder: string;
  emptyLabel: string;
  options: { id: string; name: string }[];
  onPick: (id: string) => void;
}) {
  const none = options.length === 0;
  return (
    <select name="addWidget"
      value=""
      disabled={none}
      aria-label={placeholder}
      onChange={(e) => {
        if (e.target.value) onPick(e.target.value);
        e.target.value = "";
      }}
      className="gf-btn text-[12px] px-2 py-1.5 outline-none w-full"
      style={{
        color: none ? "var(--gf-text-dim)" : "var(--gf-text-primary)",
        cursor: none ? "default" : "pointer",
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      <option value="">{none ? emptyLabel : placeholder}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

function SortableRow({ id, label, onRemove }: { id: string; label: string; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{
        ...panel,
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
        background: isDragging ? "var(--gf-hover)" : "var(--gf-panel)",
        // While dragging, dnd-kit owns `transform`, so the class's :active nudge would
        // fight it. Lifting the shadow instead reads as the row being picked UP.
        boxShadow: isDragging ? "var(--gf-shadow)" : undefined,
      }}
      // Depth only — the row already has its own panel face, so .gf-raise (not .gf-btn)
      // gives it the same lift/press language as the buttons without recolouring it.
      className="gf-raise flex items-center gap-2 px-2 py-1.5"
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder"
        className="cursor-grab active:cursor-grabbing touch-none flex-shrink-0"
        style={{ color: "var(--gf-text-dim)" }}
      >
        <GripIcon />
      </button>
      <span className="flex-1 text-[12px] truncate" style={{ color: "var(--gf-text-primary)" }}>{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
        className="flex-shrink-0 transition-colors"
        style={{ color: "var(--gf-text-dim)" }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "#F2495C")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--gf-text-dim)")}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

export default function WidgetBuilder() {
  const { layout, save, saving, loading } = useWidgetLayout();
  const { supported: pipSupported, isOpen, open } = usePip();

  const [draft, setDraft] = useState<string[]>(layout);
  const [justSaved, setJustSaved] = useState(false);
  // Re-sync the draft when the saved layout changes externally (load reconcile / save).
  useEffect(() => setDraft(layout), [layout]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const dirty = JSON.stringify(draft) !== JSON.stringify(layout);
  const inDraft = useMemo(() => new Set(draft), [draft]);

  // Live device lists, so a specific unit can be pinned as its own tile. This is why
  // device picking lives HERE and not in the pop-out: React events don't fire on nodes
  // portaled into the PiP document (pip-widget.md §9), so a selector inside the widget
  // could never be clicked. Build big, render small.
  const { upsList, routers } = useLiveSummary();

  // Catalog grouped for the "Available tiles" column. Per-device tiles are NOT listed
  // here — they go in a dropdown under their group (see DevicePicker), because one "+"
  // row per unit would swamp the column on a campus with a dozen routers.
  const groups = useMemo(() => {
    const g = new Map<string, TileDef[]>();
    for (const t of TILE_CATALOG) {
      const arr = g.get(t.group) ?? [];
      arr.push(t);
      g.set(t.group, arr);
    }
    return [...g.entries()];
  }, []);

  // Pickable devices per group, minus whatever is already on the widget.
  const upsOptions = useMemo(
    () => upsList.map((u) => ({ id: deviceTileId("ups", u.id), name: u.name })).filter((o) => !inDraft.has(o.id)),
    [upsList, inDraft],
  );
  const routerOptions = useMemo(
    () => routers.map((r) => ({ id: deviceTileId("network", r.id), name: r.name })).filter((o) => !inDraft.has(o.id)),
    [routers, inDraft],
  );

  // Label for a saved id: static catalog first, then a live device's current name,
  // falling back to the raw id so a decommissioned device is still identifiable enough
  // to remove.
  const labelFor = (id: string): string => {
    const def = resolveTile(id);
    if (!def) return id;
    const ups = upsList.find((u) => deviceTileId("ups", u.id) === id);
    if (ups) return ups.name;
    const net = routers.find((r) => deviceTileId("network", r.id) === id);
    if (net) return net.name;
    return def.label;
  };

  const add = (id: string) => setDraft((d) => (d.includes(id) || d.length >= MAX_TILES ? d : [...d, id]));
  const removeTile = (id: string) => setDraft((d) => d.filter((x) => x !== id));
  // The available list toggles: clicking an added tile takes it back off. Previously an
  // added row was simply disabled, which left dead weight in the column and made the
  // "Your widget" list the only way to undo a misclick.
  const toggle = (id: string) => (inDraft.has(id) ? removeTile(id) : add(id));

  const full = draft.length >= MAX_TILES;

  // Search across label, description and group. At 13 static tiles plus a device per
  // router/UPS, scanning seven groups by eye is the slow part of building a layout.
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = (t: TileDef) =>
    !q ||
    t.label.toLowerCase().includes(q) ||
    (t.description ?? "").toLowerCase().includes(q) ||
    t.group.toLowerCase().includes(q);

  const visibleGroups = groups
    .map(([group, tiles]) => [group, tiles.filter(matches)] as [string, TileDef[]])
    // A group whose tiles are all filtered out still shows if its device picker is
    // relevant to the query, so searching "ups" never hides the UPS picker.
    .filter(([group, tiles]) => tiles.length > 0 || (!!q && group.toLowerCase().includes(q)));
  const nothingMatches = visibleGroups.length === 0;

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (over && active.id !== over.id) {
      setDraft((items) => arrayMove(items, items.indexOf(String(active.id)), items.indexOf(String(over.id))));
    }
  };

  const onSave = async () => {
    const ok = await save(draft);
    if (ok) {
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2500);
    }
  };

  return (
    <div className="p-5" style={panel}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="text-sm font-bold" style={{ color: "var(--gf-text-primary)" }}>Customize Widget</div>
        {dirty && (
          <span className="text-[9px] tracking-widest uppercase px-1.5 py-0.5 rounded-[2px]"
            style={{ color: "#FF780A", background: "rgba(255,120,10,0.12)" }}>● Unsaved</span>
        )}
      </div>
      <div className="text-[11px] mb-4" style={{ color: "var(--gf-text-muted)" }}>
        Pick tiles for your pop-out live widget and drag to reorder. Saved to your account.
        {!pipSupported && " (Pop-out itself needs Chrome or Edge.)"}
      </div>

      {loading ? (
        <div className="text-[11px] py-2" style={{ color: "var(--gf-text-dim)" }}>Loading…</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* ── Available tiles ── */}
          <div className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] tracking-widest uppercase" style={{ color: "var(--gf-text-muted)" }}>Available tiles</span>
              {/* Capacity is surfaced because the SERVER truncates at MAX_TILES; without
                  it a 17th tile would be added, saved, and silently dropped. */}
              <span
                className="text-[10px] tabular-nums px-1.5 py-0.5 rounded-[2px]"
                style={{
                  color: full ? "#FF780A" : "var(--gf-text-dim)",
                  background: full ? "rgba(255,120,10,0.12)" : "transparent",
                }}
              >
                {draft.length}/{MAX_TILES} added
              </span>
            </div>

            <input name="query"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tiles…"
              aria-label="Search available tiles"
              className="text-[12px] px-2 py-1.5 rounded-[2px] outline-none w-full"
              style={{
                background: "var(--gf-bg)",
                border: "1px solid var(--gf-panel-border)",
                color: "var(--gf-text-primary)",
                fontFamily: "'JetBrains Mono', monospace",
              }}
            />

            {nothingMatches && (
              <div className="text-[11px] px-2 py-3 text-center rounded-[2px]"
                style={{ color: "var(--gf-text-dim)", border: "1px dashed var(--gf-panel-border)" }}>
                Nothing matches “{query}”.
              </div>
            )}

            {visibleGroups.map(([group, tiles]) => {
              const addedInGroup = tiles.filter((t) => inDraft.has(t.id)).length;
              return (
              <div key={group} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[10px] tracking-widest uppercase" style={{ color: "var(--gf-text-muted)" }}>{group}</span>
                  {tiles.length > 0 && (
                    <span className="text-[9px] tabular-nums" style={{ color: "var(--gf-text-dim)" }}>
                      {addedInGroup}/{tiles.length}
                    </span>
                  )}
                </div>
                {/* Two-up on a phone, one-up once the three-column layout kicks in at
                    lg. On a narrow screen the whole builder stacks, so a single column
                    of tiles means every button spans the full viewport and the list
                    runs on for screens; at lg this column is already only a third of
                    the panel, where one-up is the right fit. Button height is unchanged
                    either way. */}
                <div className="grid grid-cols-2 lg:grid-cols-1 gap-1">
                {tiles.map((t) => {
                  const added = inDraft.has(t.id);
                  // At capacity, only REMOVING stays possible — an add that the server
                  // would silently drop must not look available.
                  const blocked = !added && full;
                  // Description rides in the TOOLTIP rather than a second line: it is
                  // genuinely useful when choosing, but a two-line button made the
                  // column roughly twice as tall for information you only need once.
                  const hint = blocked
                    ? `Widget is full (${MAX_TILES} tiles) — remove one first`
                    : added
                      ? "Click to remove"
                      : "Click to add";
                  return (
                    <button
                      key={t.id}
                      type="button"
                      disabled={blocked}
                      aria-pressed={added}
                      title={t.description ? `${t.description}\n${hint}` : hint}
                      onClick={() => toggle(t.id)}
                      className="gf-btn flex items-center justify-between gap-2 px-2 py-1.5 text-left w-full"
                      style={{ cursor: blocked ? "default" : "pointer" }}
                    >
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[12px] truncate" style={{ color: "var(--gf-text-primary)" }}>{t.label}</span>
                        {/* Span-2 tiles take a whole row; knowing that before you add
                            one is the difference between a tidy grid and a surprise. */}
                        {t.span === 2 && (
                          <span className="text-[8px] tracking-widest uppercase px-1 py-px rounded-[2px] flex-shrink-0"
                            style={{ color: "var(--gf-text-dim)", border: "1px solid var(--gf-panel-border)" }}>
                            wide
                          </span>
                        )}
                      </span>
                      <span className="text-[14px] leading-none flex-shrink-0"
                        style={{ color: added ? "#73BF69" : blocked ? "var(--gf-text-dim)" : "var(--gf-accent)" }}>
                        {added ? "✓" : "+"}
                      </span>
                    </button>
                  );
                })}
                </div>
                {/* Pin a single unit. Only under the two groups that have devices. */}
                {group === "UPS" && (
                  <DevicePicker
                    placeholder="+ Specific UPS…"
                    emptyLabel={upsList.length === 0 ? "No UPS registered" : "All UPS added"}
                    options={upsOptions}
                    onPick={add}
                  />
                )}
                {group === "Network" && (
                  <DevicePicker
                    placeholder="+ Specific router…"
                    emptyLabel={routers.length === 0 ? "No routers registered" : "All routers added"}
                    options={routerOptions}
                    onPick={add}
                  />
                )}
              </div>
              );
            })}
          </div>

          {/* ── Your widget (sortable) ── */}
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] tracking-widest uppercase" style={{ color: "var(--gf-text-muted)" }}>Your widget</span>
              {draft.length > 0 && (
                <span className="text-[9px] tabular-nums" style={{ color: "var(--gf-text-dim)" }}>
                  drag ⠿ to reorder
                </span>
              )}
            </div>
            {draft.length === 0 ? (
              <div className="text-[11px] px-2 py-4 text-center rounded-[2px]"
                style={{ color: "var(--gf-text-dim)", border: "1px dashed var(--gf-panel-border)" }}>
                No tiles yet — add some from the left.
              </div>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={draft} strategy={verticalListSortingStrategy}>
                  <div className="flex flex-col gap-1.5">
                    {draft.map((id) => (
                      <SortableRow key={id} id={id} label={labelFor(id)} onRemove={() => removeTile(id)} />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </div>

          {/* ── Live preview ── */}
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] tracking-widest uppercase" style={{ color: "var(--gf-text-muted)" }}>Preview</span>
              <span className="text-[9px] tabular-nums" style={{ color: "var(--gf-text-dim)" }}>actual size · 320×300</span>
            </div>
            {/* --gf-shadow is the FLOATING-panel shadow (the one modals use), not the
                button one: this box stands for a window that hovers over the desktop,
                so lifting it off the page is literal rather than decorative.
                max-w-full stops the fixed 320px from overflowing a narrow phone. */}
            <div
              className="self-start overflow-hidden max-w-full"
              style={{ width: 320, height: 300, ...panel, boxShadow: "var(--gf-shadow)" }}
            >
              <PipWidget layout={draft} />
            </div>
            <span className="text-[10px] leading-snug" style={{ color: "var(--gf-text-dim)" }}>
              Live data — this is exactly what pops out.
            </span>
          </div>
        </div>
      )}

      {/* ── Actions ── */}
      <div className="flex items-center gap-2 mt-4 flex-wrap">
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          className="gf-btn-primary text-[12px] px-3 py-1.5"
        >
          {saving ? "Saving…" : "Save layout"}
        </button>
        <button
          type="button"
          onClick={() => setDraft([...DEFAULT_LAYOUT])}
          className="gf-btn text-[12px] px-3 py-1.5"
          style={{ color: "var(--gf-text-muted)" }}
        >
          Reset to default
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => setDraft(layout)}
            className="text-[12px] px-3 py-1.5 transition-colors"
            style={{ color: "var(--gf-text-dim)", borderRadius: 2 }}
          >
            Discard changes
          </button>
        )}
        {pipSupported && !isOpen && (
          <button
            type="button"
            onClick={() => open()}
            className="gf-btn text-[12px] px-3 py-1.5 ml-auto"
            style={{ color: "var(--gf-text-primary)" }}
          >
            Pop out ▣
          </button>
        )}
        {justSaved && <span className="text-[11px]" style={{ color: "#73BF69" }}>✓ Saved</span>}
      </div>
    </div>
  );
}
