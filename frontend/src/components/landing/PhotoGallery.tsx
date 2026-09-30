import { useState } from "react";
import { LANDING_PHOTOS, suppliedPhotos, type LandingPhoto } from "./photos";
import Reveal from "./Reveal";
import PhotoLightbox from "./PhotoLightbox";

/**
 * The hardware photos, the only photographs on the page (the rest is drawn in code).
 *
 * While photos are missing:
 *   dev   → labelled placeholders with the shot brief
 *   build → empty slots are dropped, and the section is hidden if none are filled
 *
 * Add photos in ./photos.ts; nothing to change here.
 */

function Placeholder({ photo, index }: { photo: LandingPhoto; index: number }) {
  return (
    <div
      className="flex flex-col justify-between h-full p-4"
      style={{
        aspectRatio: "3 / 2",
        background: "var(--gf-bg)",
        border: "1px dashed var(--gf-btn-border)",
        borderRadius: 2,
      }}
    >
      <div>
        <div
          className="inline-flex items-center gap-1.5 px-1.5 py-0.5 mb-2.5"
          style={{
            fontSize: 10,
            letterSpacing: "0.16em",
            color: "var(--gf-accent-text)",
            border: "1px solid var(--gf-accent)",
            borderRadius: 2,
          }}
        >
          PHOTO SLOT {index + 1}
        </div>
        <p
          className="font-semibold"
          style={{ fontSize: 13.5, color: "var(--gf-text-primary)", lineHeight: 1.4 }}
        >
          {photo.caption}
        </p>
        <p className="mt-2" style={{ fontSize: 12, lineHeight: 1.55, color: "var(--gf-text-muted)" }}>
          {photo.brief}
        </p>
      </div>
      <p className="mt-3" style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--gf-text-dim)" }}>
        Drop the file in <code>public/landing/</code>, then set{" "}
        <code style={{ color: "var(--gf-accent-text)" }}>src</code> for{" "}
        <code>{photo.id}</code> in <code>components/landing/photos.ts</code>.
      </p>
    </div>
  );
}

export default function PhotoGallery() {
  // Which photo the lightbox is showing; null = closed. The INDEX rather than the
  // photo, because the lightbox pages left and right through the list.
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const supplied = suppliedPhotos();
  // import.meta.env.DEV is compiled to a literal by Vite, so the placeholder
  // branch and its copy are dropped from the production bundle entirely.
  const showPlaceholders = import.meta.env.DEV;

  if (supplied.length === 0 && !showPlaceholders) return null;

  const items = showPlaceholders ? LANDING_PHOTOS : supplied;
  // The lightbox pages through photos, so it only gets the ones that have an image
  // (not dev placeholders).
  const openable = items.filter((p) => p.src.trim() !== "");

  return (
    <section className="px-4 sm:px-6 py-16 sm:py-20" style={{ borderTop: "1px solid var(--gf-divider)" }}>
      <div className="max-w-7xl mx-auto">
        <Reveal>
          <div className="mb-8 max-w-2xl">
            <p
              className="text-[12px] tracking-[0.22em] uppercase mb-3"
              style={{ color: "var(--gf-accent-text)" }}
            >
              Deployed
            </p>
            <h2
              className="text-[24px] sm:text-[28px] font-semibold leading-snug"
              style={{ color: "var(--gf-text-primary)" }}
            >
              Running in the ICTU server room
            </h2>
            <p className="text-[14px] leading-relaxed mt-2.5" style={{ color: "var(--gf-text-muted)" }}>
              The sensor node, the rack it watches, and the infrared transmitter that drives the air
              conditioning. Not a reference design — the hardware this system was built around.
            </p>
          </div>
        </Reveal>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((photo, i) => (
            <Reveal key={photo.id} delay={i * 70} className="h-full">
              {photo.src ? (
                // A real <button> around the card, so it works from the keyboard and the caption is
                // clickable too.
                <button
                  type="button"
                  onClick={() => setOpenIndex(openable.findIndex((x) => x.id === photo.id))}
                  aria-label={`${photo.caption} — open details`}
                  className="gf-panel overflow-hidden h-full w-full flex flex-col text-left group"
                  style={{ cursor: "zoom-in" }}
                >
                  <div className="relative w-full overflow-hidden" style={{ aspectRatio: "3 / 2" }}>
                    <img
                      src={photo.src}
                      alt={photo.alt}
                      loading="lazy"
                      decoding="async"
                      className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
                      style={{ display: "block" }}
                    />
                    {/* Affordance. Without something appearing on hover a photo in a grid
                        reads as decoration, and nobody clicks decoration. */}
                    <span
                      aria-hidden="true"
                      className="absolute inset-0 flex items-end justify-end p-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100"
                      style={{ background: "linear-gradient(to top, rgba(9,11,15,0.55), transparent 55%)" }}
                    >
                      <span
                        className="flex items-center justify-center"
                        style={{
                          width: 26,
                          height: 26,
                          borderRadius: 2,
                          background: "var(--gf-glass)",
                          border: "1px solid var(--gf-glass-border)",
                          color: "#fff",
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
                          <circle cx="11" cy="11" r="7" />
                          <path d="M20 20l-3.2-3.2M11 8v6M8 11h6" />
                        </svg>
                      </span>
                    </span>
                  </div>
                  <span
                    className="px-3 py-2.5 flex-1 block"
                    style={{
                      fontSize: 12.5,
                      lineHeight: 1.4,
                      // Space for two lines whether needed or not, so one wrapping caption does not make
                      // its card taller than the others.
                      minHeight: 55,
                      color: "var(--gf-text-muted)",
                      borderTop: "1px solid var(--gf-divider)",
                    }}
                  >
                    {photo.caption}
                  </span>
                </button>
              ) : (
                <Placeholder photo={photo} index={i} />
              )}
            </Reveal>
          ))}
        </div>
      </div>

      {openIndex !== null && openIndex >= 0 && (
        <PhotoLightbox
          photos={openable}
          index={openIndex}
          onClose={() => setOpenIndex(null)}
          onNavigate={setOpenIndex}
        />
      )}
    </section>
  );
}
