// ─── Colours a <canvas> can use ───────────────────────────────────
// Canvas cannot read CSS variables, and some tiles fall back to
// `var(--gf-text-muted)` when there is no reading. The sparklines also made their fill
// by appending hex digits (`color + "44"`). Together that produced
// `var(--gf-text-muted)44`, addColorStop threw, and the whole page went blank. No
// imports; reads the document, so it runs in the browser.

/** Last-resort colour if a custom property resolves to nothing — `--gf-text-muted` (dark). */
const FALLBACK = "#8E95A0";

/**
 * Resolve `var(--token)` / `var(--token, fallback)` against the document root. A literal
 * colour is returned as is, so it is safe to call on any colour.
 */
export function resolveColor(color: string, hops = 0): string {
  const raw = (color ?? "").trim();
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)$/.exec(raw);
  if (!m) return raw || FALLBACK;

  let value = "";
  try {
    value = getComputedStyle(document.documentElement).getPropertyValue(m[1]!).trim();
  } catch {
    /* no document (SSR / test) — fall through to the literal fallback below */
  }
  // A var() may name another var(); one level is all this app uses. Limited anyway, so a
  // circular definition cannot loop forever and hang the tab.
  if (value.startsWith("var(") && hops < 4) return resolveColor(value, hops + 1);
  return value || (m[2] ?? "").trim() || FALLBACK;
}

/**
 * The same colour at a given alpha, as `rgba(...)`. Handles #rgb, #rrggbb, #rrggbbaa and
 * rgb()/rgba(). An unknown colour is returned opaque instead of throwing.
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
