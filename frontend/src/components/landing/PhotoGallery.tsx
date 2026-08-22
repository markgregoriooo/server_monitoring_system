import { LANDING_PHOTOS, suppliedPhotos, type LandingPhoto } from "./photos";
import Reveal from "./Reveal";

/**
 * The hardware strip — the only part of this page that is a photograph.
 *
 * Everything else is drawn in code, which is right for dashboards (it animates,
 * it follows the theme, it leaks no hostnames) and wrong for hardware: a drawn
 * ESP32 is a diagram, and a diagram proves nothing about a box that is actually
 * mounted on a wall in the ICTU server room. This section is where the system
 * stops being a description of itself.
 *
 * Behaviour while the photos are still being taken:
 *   dev   → labelled placeholders with the shot brief, so a missing photo is
 *           visible to whoever is building rather than silently absent
 *   build → the slot is dropped, and the whole section disappears if nothing has
 *           been supplied yet. An empty frame on a public page reads as a broken
 *           image, which is worse than the section simply not being there.
 *
 * Add photos in ./photos.ts — no changes needed here.
 */

function Placeholder({ photo, index }: { photo: LandingPhoto; index: number }) {
  return (
    <div
      className="flex flex-col justify-between p-4"
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
  const supplied = suppliedPhotos();
  // import.meta.env.DEV is compiled to a literal by Vite, so the placeholder
  // branch and its copy are dropped from the production bundle entirely.
  const showPlaceholders = import.meta.env.DEV;

  if (supplied.length === 0 && !showPlaceholders) return null;

  const items = showPlaceholders ? LANDING_PHOTOS : supplied;

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
            <Reveal key={photo.id} delay={i * 70}>
              {photo.src ? (
                <figure className="gf-panel overflow-hidden">
                  <img
                    src={photo.src}
                    alt={photo.alt}
                    loading="lazy"
                    decoding="async"
                    className="w-full object-cover"
                    style={{ aspectRatio: "3 / 2", display: "block" }}
                  />
                  <figcaption
                    className="px-3 py-2.5"
                    style={{
                      fontSize: 12.5,
                      color: "var(--gf-text-muted)",
                      borderTop: "1px solid var(--gf-divider)",
                    }}
                  >
                    {photo.caption}
                  </figcaption>
                </figure>
              ) : (
                <Placeholder photo={photo} index={i} />
              )}
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
