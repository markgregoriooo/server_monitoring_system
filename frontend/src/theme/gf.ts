/**
 * The Grafana design tokens, in one place.
 *
 * Fourteen files declared their own local token literal mapping the same `--gf-*` CSS
 * variables. That was not a style problem — the copies had already drifted, and the
 * drift shipped a real defect:
 *
 *   `pages/Dashboard.tsx` wrote `accent: "#5794F2"` where the other thirteen wrote
 *   `accent: "var(--gf-accent)"`. Dashboard then used it as `color:` (Dashboard.tsx
 *   1099, 1268). On the LIGHT theme `--gf-accent` measures 2.76:1 against the page —
 *   below the 4.5:1 WCAG AA needs for body text — which is exactly why
 *   `--gf-accent-text` (#1F62E0, 4.92:1) exists and why the other pages carry an
 *   `accentText` key. A hardcoded hex cannot follow that split, so the Dashboard's
 *   accent type was unreadable on light in a way no other page was.
 *
 * Import `GF` instead of re-declaring the object. Every value is a `var(--gf-*)`
 * reference, never a literal hex, so the theme toggle keeps working.
 *
 * Surfaces vs type: use `accent` for backgrounds, borders and graphics; use
 * `accentText` whenever the colour lands on text. They are the same colour on dark
 * and deliberately different on light.
 *
 * See audits/code-duplication-report-2026-08-25.md — R-01.
 */
export const GF = {
  bg: "var(--gf-bg)",
  panel: "var(--gf-panel)",
  border: "var(--gf-panel-border)",
  divider: "var(--gf-divider)",
  header: "var(--gf-header)",
  textPrimary: "var(--gf-text-primary)",
  textMuted: "var(--gf-text-muted)",
  textDim: "var(--gf-text-dim)",
  hover: "var(--gf-hover)",
  hoverStrong: "var(--gf-hover-strong)",
  /** Surfaces, borders, graphics. NOT type — see accentText. */
  accent: "var(--gf-accent)",
  /** Accent that is legible as type in both themes. */
  accentText: "var(--gf-accent-text)",
  accentDim: "var(--gf-accent-dim)",
  /** One step below `panel` — code wells, inset blocks. */
  well: "var(--gf-bg)",
} as const;

/**
 * Status colours, from the table in CLAUDE.md.
 *
 * These hexes were re-declared as local consts in 20+ files (77 declarations, 256
 * literal occurrences). They are deliberately literal rather than `var(--gf-*)`:
 * several consumers paint them onto a <canvas>, which cannot resolve a CSS variable —
 * that is what `utils/canvasColor.resolveColor` exists for.
 *
 * CRITICAL (#E02F44) and DANGER (#F2495C) are different colours and are easy to
 * confuse. CRITICAL is the more severe of the two.
 */
export const STATUS = {
  /** NORMAL / Online */
  green: "#73BF69",
  /** WARNING */
  orange: "#FF780A",
  /** DANGER */
  red: "#F2495C",
  /** CRITICAL — more severe than `red`. */
  critical: "#E02F44",
  /** TOO_COLD, and the Grafana accent blue. */
  blue: "#5794F2",
} as const;

export type GfToken = keyof typeof GF;
export type StatusColor = keyof typeof STATUS;

export default GF;
