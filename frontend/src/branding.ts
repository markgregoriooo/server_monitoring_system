// Central place for all user-facing branding (system name, subtitle, tagline,
// logo text). Values come from frontend/.env (VITE_* — Vite embeds them at BUILD
// time, so restart `npm run dev` after editing .env). Each falls back to the
// CSPC-ICTU defaults, so the UI shows correct names even with no .env present.
const env = import.meta.env;

export const BRAND = {
  /** Short system name, e.g. sidebar logo text + breadcrumb section + browser tab. */
  name:     env.VITE_APP_NAME?.trim()     || "CSPC-ICTU",
  /** Full institution name (spelled-out CSPC-ICTU) — shown on the login screen + sidebar tooltip. */
  fullName: env.VITE_APP_FULL_NAME?.trim() || "Camarines Sur Polytechnic Colleges Information and Communications Technology Unit",
  /** Small line under the name in the sidebar brand block. */
  subtitle: env.VITE_APP_SUBTITLE?.trim() || "MONITORING",
  /** Long descriptive line on the login screen. */
  tagline:  env.VITE_APP_TAGLINE?.trim()  || "SERVER ENVIRONMENT MONITORING & CONTROL SYSTEM",
  /** Initials shown in the small square logo mark when no image is used. */
  logoText: env.VITE_LOGO_TEXT?.trim()    || "CC",
  /** Optional logo image served from public/ (e.g. "/logo.png"). Empty = use logoText. */
  logoSrc:  env.VITE_LOGO_SRC?.trim()     || "",
} as const;
