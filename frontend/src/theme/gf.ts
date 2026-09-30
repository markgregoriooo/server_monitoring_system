/**
 * The Grafana design tokens, in one place. Import `GF` instead of declaring your own;
 * every value is a `var(--gf-*)`, so the theme toggle works.
 *
 * Use `accent` for backgrounds, borders and graphics, and `accentText` for text. They
 * are the same in dark mode; in light mode `accent` is too pale for text (2.76:1), so
 * `accentText` (#1F62E0, 4.92:1) is used.
 * See audits/code-duplication-report-2026-08-25.md (R-01).
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
 * Status colours, from the table in CLAUDE.md. Literal hexes rather than
 * `var(--gf-*)`, because some are drawn on a <canvas>, which cannot read CSS variables
 * (see `utils/canvasColor.resolveColor`). CRITICAL (#E02F44) is more severe than DANGER
 * (#F2495C).
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
