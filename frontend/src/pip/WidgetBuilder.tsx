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
import { TILE_CATALOG, TILE_BY_ID, DEFAULT_LAYOUT } from "./tiles/catalog";
import type { TileDef } from "./tiles/catalog";

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
      }}
      className="flex items-center gap-2 px-2 py-1.5"
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

  // Catalog grouped for the "Available tiles" column.
  const groups = useMemo(() => {
    const g = new Map<string, TileDef[]>();
    for (const t of TILE_CATALOG) {
      const arr = g.get(t.group) ?? [];
      arr.push(t);
      g.set(t.group, arr);
    }
    return [...g.entries()];
  }, []);

  const add = (id: string) => setDraft((d) => (d.includes(id) ? d : [...d, id]));
  const removeTile = (id: string) => setDraft((d) => d.filter((x) => x !== id));

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
            <div className="text-[10px] tracking-widest uppercase" style={{ color: "var(--gf-text-muted)" }}>Available tiles</div>
            {groups.map(([group, tiles]) => (
              <div key={group} className="flex flex-col gap-1">
                <div className="text-[9px] tracking-widest uppercase" style={{ color: "var(--gf-text-dim)" }}>{group}</div>
                {tiles.map((t) => {
                  const added = inDraft.has(t.id);
                  return (
                    <button
                      key={t.id}
                      type="button"
                      disabled={added}
                      onClick={() => add(t.id)}
                      className="flex items-center justify-between gap-2 px-2 py-1.5 text-left transition-colors"
                      style={{ ...panel, opacity: added ? 0.5 : 1, cursor: added ? "default" : "pointer" }}
                      onMouseEnter={(e) => { if (!added) e.currentTarget.style.background = "var(--gf-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "var(--gf-panel)"; }}
                    >
                      <span className="text-[12px] truncate" style={{ color: "var(--gf-text-primary)" }}>{t.label}</span>
                      <span className="text-[14px] leading-none flex-shrink-0" style={{ color: added ? "#73BF69" : "var(--gf-accent)" }}>
                        {added ? "✓" : "+"}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* ── Your widget (sortable) ── */}
          <div className="flex flex-col gap-2">
            <div className="text-[10px] tracking-widest uppercase" style={{ color: "var(--gf-text-muted)" }}>Your widget</div>
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
                      <SortableRow key={id} id={id} label={TILE_BY_ID.get(id)?.label ?? id} onRemove={() => removeTile(id)} />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </div>

          {/* ── Live preview ── */}
          <div className="flex flex-col gap-2">
            <div className="text-[10px] tracking-widest uppercase" style={{ color: "var(--gf-text-muted)" }}>Preview</div>
            <div className="self-start overflow-hidden" style={{ width: 320, height: 300, ...panel }}>
              <PipWidget layout={draft} />
            </div>
          </div>
        </div>
      )}

      {/* ── Actions ── */}
      <div className="flex items-center gap-2 mt-4 flex-wrap">
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          className="text-[12px] px-3 py-1.5 transition-opacity"
          style={{ background: "var(--gf-accent)", color: "#fff", borderRadius: 2, opacity: !dirty || saving ? 0.5 : 1 }}
        >
          {saving ? "Saving…" : "Save layout"}
        </button>
        <button
          type="button"
          onClick={() => setDraft([...DEFAULT_LAYOUT])}
          className="text-[12px] px-3 py-1.5 transition-colors"
          style={{ border: "1px solid var(--gf-panel-border)", color: "var(--gf-text-muted)", borderRadius: 2 }}
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
            className="text-[12px] px-3 py-1.5 ml-auto transition-colors"
            style={{ border: "1px solid var(--gf-panel-border)", color: "var(--gf-text-primary)", borderRadius: 2 }}
          >
            Pop out ▣
          </button>
        )}
        {justSaved && <span className="text-[11px]" style={{ color: "#73BF69" }}>✓ Saved</span>}
      </div>
    </div>
  );
}
