import { useCallback, useEffect, useRef } from "react";
import type { LandingPhoto } from "./photos";

/**
 * The photo detail view, opened from PhotoGallery. Shows the image larger with a
 * fuller description.
 *
 * A proper dialog:
 *   role="dialog" + aria-modal   the page behind is treated as inert
 *   aria-labelledby              announced by its name
 *   Escape closes
 *   focus moves in on open       and back to the photo that opened it on close
 *   Tab cycles                   inside the dialog
 *   body scroll is locked        so the page does not scroll underneath
 * Arrow keys move between photos and wrap at both ends.
 */
export default function PhotoLightbox({
  photos,
  index,
  onClose,
  onNavigate,
}: {
  photos: LandingPhoto[];
  index: number;
  onClose: () => void;
  onNavigate: (next: number) => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  // Remember what had focus when this opened, so focus can go back there on close.
  const openerRef = useRef<HTMLElement | null>(null);

  const photo = photos[index];

  const go = useCallback(
    (step: number) => {
      if (photos.length < 2) return;
      onNavigate((index + step + photos.length) % photos.length);
    },
    [index, photos.length, onNavigate],
  );

  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    // Lock the page scroll, restoring the previous value afterwards (another component,
    // like the policy gate, may have set it).
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
        return;
      }
      if (e.key !== "Tab") return;

      // Focus cycle. Looked up on each keypress, since the buttons change with the photo.
      const focusables = panelRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      openerRef.current?.focus?.();
    };
  }, [onClose, go]);

  if (!photo) return null;

  const arrowBtn = (dir: -1 | 1, label: string) => (
    <button
      type="button"
      onClick={() => go(dir)}
      aria-label={label}
      title={label}
      className="gf-icon-btn flex"
      style={{ width: 32, height: 32 }}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ transform: dir === 1 ? "rotate(180deg)" : undefined }}
      >
        <path d="M15 18l-6-6 6-6" />
      </svg>
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6"
      style={{ background: "rgba(9,11,15,0.86)", backdropFilter: "blur(6px)" }}
      // Backdrop click closes. Guarded on the target being the backdrop ITSELF, or a
      // drag that starts on the image and releases outside would close it too.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="photo-lightbox-title"
    >
      <div
        ref={panelRef}
        className="w-full max-w-4xl max-h-full overflow-y-auto"
        style={{
          background: "var(--gf-panel)",
          border: "1px solid var(--gf-panel-border)",
          borderRadius: 2,
        }}
      >
        <img
          src={photo.src}
          alt={photo.alt}
          className="w-full object-contain"
          style={{ maxHeight: "58vh", display: "block", background: "var(--gf-bg)" }}
        />

        <div className="p-5 sm:p-6" style={{ borderTop: "1px solid var(--gf-divider)" }}>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h3
                id="photo-lightbox-title"
                className="text-[16px] sm:text-[18px] font-semibold leading-snug"
                style={{ color: "var(--gf-text-primary)" }}
              >
                {photo.title}
              </h3>
              <p
                className="text-[11px] tracking-[0.14em] uppercase mt-1.5"
                style={{ color: "var(--gf-accent-text)" }}
              >
                {photo.meta}
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {photos.length > 1 && arrowBtn(-1, "Previous photo")}
              {photos.length > 1 && arrowBtn(1, "Next photo")}
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label="Close"
                title="Close"
                className="gf-icon-btn flex"
                style={{ width: 32, height: 32 }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          <p
            className="text-[13.5px] sm:text-[14px] leading-relaxed mt-4"
            style={{ color: "var(--gf-text-muted)" }}
          >
            {photo.detail}
          </p>

          {photos.length > 1 && (
            <p className="text-[11.5px] mt-4" style={{ color: "var(--gf-text-dim)" }}>
              {index + 1} of {photos.length} · use ← → to move between photos
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
