// ─── Colours that a <canvas> can actually use ───────────────────────────────────
//
// Canvas parses CSS colour STRINGS, but it knows nothing about the document — so a
// custom property is not a colour to it. That matters here because several stat tiles
// fall back to `var(--gf-text-muted)` whenever a metric has no reading (no devices
// registered, sensor offline, a gas value that hasn't arrived yet).
//
// The sparklines also built their translucent area fill by APPENDING hex digits to the
// colour (`color + "44"`), which silently assumes every caller passes a 6-digit hex.
//
// Put together those two assumptions produced `var(--gf-text-muted)44`, and
// `addColorStop` rejects an unparseable colour by THROWING. Canvas drawing runs inside a
// React effect, so the throw escaped the component and took the whole page down — a
// blank Dashboard, caused by a grey sparkline. It only appeared on ranges where some
// metric happened to have no data, which is why -7d looked fine and -24h did not.
//
// Import-free, like utils/envThresholds and utils/seriesGaps. It does read the document
// (that is the entire point of resolving a custom property), so it must run in a browser.

/** Last-resort colour if a custom property resolves to nothing — `--gf-text-muted` (dark). */
const FALLBACK = "#8E95A0";

/**
 * Resolve `var(--token)` / `var(--token, fallback)` against the document root.
 *
 * Anything that is already a literal colour is returned untouched, so this is safe to
 * call on every colour rather than only the ones suspected of being tokens.
 */
export function resolveColor(color: string): string {
  const raw = (color ?? "").trim();
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)$/.exec(raw);
  if (!m) return raw || FALLBACK;

  let value = "";
  try {
    value = getComputedStyle(document.documentElement).getPropertyValue(m[1]!).trim();
  } catch {
    /* no document (SSR / test) — fall through to the literal fallback below */
  }
  // A var() may itself name another var(); one hop is all this codebase uses.
  if (value.startsWith("var(")) return resolveColor(value);
  return value || (m[2] ?? "").trim() || FALLBACK;
}

/**
 * The same colour at a given alpha, as `rgba(...)`.
 *
 * Handles #rgb, #rrggbb, #rrggbbaa and rgb()/rgba() — every form this codebase produces,
 * plus the shapes a resolved custom property can come back as. An unrecognised colour is
 * returned opaque rather than throwing: a sparkline drawn in the wrong shade is a visual
 * nit, and one that takes the page down with it is not.
 */
export function alphaColor(color: string, alpha: number): string {
  const c = resolveColor(color);

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c);
  if (hex) {
    const h = hex[1]!;
    const full =
      h.length === 3
        ? h.split("").map((ch) => ch + ch).join("") // #abc → #aabbcc
        : h.slice(0, 6); // an existing alpha pair is replaced by the one asked for
    const n = parseInt(full, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  const rgb = /^rgba?\(\s*([^)]+)\)$/i.exec(c);
  if (rgb) {
    const parts = rgb[1]!.split(/[,/\s]+/).filter(Boolean).map(parseFloat);
    const [r, g, b] = parts;
    if ([r, g, b].every((v) => Number.isFinite(v))) {
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
  }

  return c;
}

export default { resolveColor, alphaColor };
