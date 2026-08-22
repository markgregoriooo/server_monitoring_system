// Central place for all user-facing branding (system name, subtitle, tagline,
// logo text). Values come from frontend/.env (VITE_* — Vite embeds them at BUILD
// time, so restart `npm run dev` after editing .env). Each falls back to the
// CSPC-ICTU defaults, so the UI shows correct names even with no .env present.
const env = import.meta.env;

export const BRAND = {
  /** Short system name, e.g. sidebar logo text + breadcrumb section + browser tab. */
  name:     env.VITE_APP_NAME?.trim()     || "CSPC-ICTU",
  /** Full institution name (spelled-out CSPC-ICTU) — shown on the login screen + sidebar tooltip. */
  fullName: env.VITE_APP_FULL_NAME?.trim() || "Camarines Sur Polytechnic Colleges – Information and Communications Technology Unit",
  /** Small line under the name in the sidebar brand block. */
  subtitle: env.VITE_APP_SUBTITLE?.trim() || "MONITORING",
  /** Long descriptive line on the login screen. */
  tagline:  env.VITE_APP_TAGLINE?.trim()  || "SERVER INFRASTRUCTURE MONITORING SYSTEM",
  /** Initials shown in the small square logo mark when no image is used. */
  logoText: env.VITE_LOGO_TEXT?.trim()    || "CC",
  /** Optional logo image served from public/ (e.g. "/logo.png"). Empty = use logoText. */
  logoSrc:  env.VITE_LOGO_SRC?.trim()     || "",
  /** Release string in the login footer (Grafana puts its version there too). */
  version:  env.VITE_APP_VERSION?.trim()  || "v1.0.0",
  /** Support mailbox linked from the login footer. Empty = the link is omitted. */
  supportEmail: env.VITE_SUPPORT_EMAIL?.trim() || "ictusupport@cspc.edu.ph",

  /* ── Footer contact block ──────────────────────────────────────────────────
     Every field below is OPTIONAL and the footer omits any that is blank, so an
     unset value leaves a tidy gap rather than an empty label. That is deliberate:
     a footer is where an institution's real-world details go, and a placeholder
     like "123 Main St" reaching a live page is worse than no address at all.

     ⚠️ `campus` ships with a default that needs CONFIRMING before go-live. The
     others ship blank because inventing a phone number or a room is worse than
     leaving it out. Set them in frontend/.env (VITE_*) — Vite inlines them at
     BUILD time, so restart the dev server after editing. */

  /** Office responsible for the system. Shown as the contact's name. */
  supportUnit:
    env.VITE_SUPPORT_UNIT?.trim() || "ICT Unit — Help Desk",
  /** ⚠️ CONFIRM before go-live. Campus / city line under the contact. */
  campus: env.VITE_CAMPUS?.trim() || "Camarines Sur Polytechnic Colleges",
  /** Optional street or building line. Blank = omitted. */
  addressLine: env.VITE_ADDRESS_LINE?.trim() || "",
  /** Optional telephone. Blank = omitted. Include the area code. */
  supportPhone: env.VITE_SUPPORT_PHONE?.trim() || "",
  /** Optional office hours line, e.g. "Mon–Fri, 8:00–17:00". Blank = omitted. */
  supportHours: env.VITE_SUPPORT_HOURS?.trim() || "",
} as const;
