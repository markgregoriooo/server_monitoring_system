// ─── Report template rules ───────────────────────────────
// How a generated report must look, per ICTU's answers to the 2026-08-26 template
// questionnaire (reports-client-questionnaire.md). No imports, so it is unit-tested.

// ─── Paper size ──────────────────────────────────────────────────────────────
// ICTU: "Dynamic (long - default)". Chosen per report; the default is long bond.
// Sizes are in points (72 per inch). pdfkit has no name for Folio, so all three are
// given as numbers. Folio (long bond) is 8.5 x 13 in, not 8.5 x 14 (US Legal).
export const PAPER_SIZES = {
  a4: { label: "A4", size: [595.28, 841.89], inches: "8.27 x 11.69 in" },
  letter: { label: "Letter", size: [612, 792], inches: "8.5 x 11 in" },
  folio: { label: "Folio (long bond)", size: [612, 936], inches: "8.5 x 13 in" },
};

/** The size used when nobody has chosen one. ICTU's stated default. */
export const DEFAULT_PAPER_SIZE = "folio";

/** Valid keys, for route validation and the UI's picker. */
export const PAPER_SIZE_KEYS = Object.keys(PAPER_SIZES);

/**
 * Turn any value into a supported paper-size key. Falls back to Folio instead of
 * throwing, so a bad stored setting cannot stop reports. The route checks user
 * input strictly (routes/reports.js).
 *
 * @param {unknown} value
 * @returns {string} a key of PAPER_SIZES
 */
export function normalizePaperSize(value) {
  const key = String(value ?? "").trim().toLowerCase();
  return Object.hasOwn(PAPER_SIZES, key) ? key : DEFAULT_PAPER_SIZE;
}

/**
 * The pdfkit `size` value for a paper-size key.
 * @param {unknown} value
 * @returns {[number, number]}
 */
export function paperDimensions(value) {
  return PAPER_SIZES[normalizePaperSize(value)].size;
}

// ─── Philippine time ─────────────────────────────────────────────────────────
// ICTU asked for Philippine time. Data stays in UTC and is converted only for display.
// A fixed +8 offset is correct: the Philippines has had no daylight saving since 1978.
export const PH_OFFSET_MINUTES = 8 * 60;

const pad = (n, w = 2) => String(n).padStart(w, "0");

/**
 * Format a time as Philippine time: `2026-08-28 14:35:02 PHT`. Sortable, fixed width,
 * and the zone is stated.
 *
 * @param {Date|number|string|null|undefined} value
 * @param {{ seconds?: boolean }} [opts] omit seconds for a date-only context
 * @returns {string} "" when the input is not a usable instant
 */
export function formatPH(value, opts = {}) {
  if (value === null || value === undefined || value === "") return "";
  const dt = value instanceof Date ? value : new Date(value);
  const ms = dt.getTime();
  if (!Number.isFinite(ms)) return "";

  // Shift the time, then read it with the UTC getters. The local getters would add the
  // server's own offset as well (and only look right on a machine set to UTC).
  const shifted = new Date(ms + PH_OFFSET_MINUTES * 60_000);
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
  const secs = opts.seconds === false ? "" : `:${pad(shifted.getUTCSeconds())}`;
  return `${date} ${time}${secs} PHT`;
}

/**
 * The Philippine calendar year a time falls in, used for the control number. 07:30 on
 * January 1 in Manila is still December 31 in UTC.
 *
 * @param {Date|number|string} value
 * @returns {number}
 */
export function philippineYear(value) {
  const dt = value instanceof Date ? value : new Date(value);
  const ms = dt.getTime();
  if (!Number.isFinite(ms)) return new Date().getUTCFullYear();
  return new Date(ms + PH_OFFSET_MINUTES * 60_000).getUTCFullYear();
}

// ─── Control / reference number ──────────────────────────────────────────────
// Format from ICTU's sample: ICTU-ENV-2026-001. Each type has a fixed three-letter
// code, written out here rather than derived from the type name, so renaming a type
// never changes the numbers of filed reports.
export const TYPE_CODE = {
  environment: "ENV",
  server: "SRV",
  network: "NET",
  ups: "UPS",
  alerts: "ALR",
  aircon: "AIR",
  forecast: "FCT",
};

/** Unknown types get a neutral code rather than "UNDEFINED" in a filed document. */
export const FALLBACK_TYPE_CODE = "GEN";

/**
 * Build a control number.
 *
 * @param {string} type   a reports.type value
 * @param {number} year   Philippine calendar year
 * @param {number} seq    1-based sequence within (type, year)
 * @returns {string} e.g. "ICTU-SRV-2026-001"
 */
export function referenceNo(type, year, seq) {
  const code = TYPE_CODE[type] ?? FALLBACK_TYPE_CODE;
  const n = Number(seq);
  // Padded to three digits like the sample, and allowed to grow past 999 instead of
  // starting over at 001.
  const seqText = Number.isInteger(n) && n > 0 ? pad(n, 3) : "001";
  return `ICTU-${code}-${year}-${seqText}`;
}

// ─── Signature block ─────────────────────────────────────────────────────────
// ICTU confirmed Prepared by / Noted by / Approved by and asked for it to be
// configurable (number of lines and names), since different documents need
// different signers.

/**
 * Maximum signature lines on one report: two full rows of three. More would make the
 * columns too narrow to sign.
 */
export const MAX_SIGNATORIES = 6;

/** Longest role label / name. Both are one short line on a page. */
export const MAX_SIGNATORY_TEXT = 60;

/**
 * The default block: Prepared by and Approved by.
 *
 * ICTU's answer was all three (Prepared / Noted / Approved); the default was set to
 * two on 2026-08-28 at the project team's request (noted in
 * reports-client-questionnaire.md). "Noted by" is one "Add line" away, and a saved
 * block always overrides this default.
 *
 * `auto` fills the line with whoever generated the report. The approver is left blank,
 * since nobody has approved anything when the PDF is created.
 */
export const DEFAULT_SIGNATORIES = [
  { role: "Prepared by:", name: "", auto: true },
  { role: "Approved by:", name: "", auto: false },
];

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_SIGNATORY_TEXT);

/**
 * Turn stored or submitted config into a usable signature block. Never throws and
 * always returns at least one line, so a bad settings value cannot stop reports.
 * The route checks user input separately.
 *
 * @param {unknown} input array, JSON string, or anything else
 * @returns {{role: string, name: string, auto: boolean}[]}
 */
export function normalizeSignatories(input) {
  let list = input;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return [...DEFAULT_SIGNATORIES];
    }
  }
  if (!Array.isArray(list)) return [...DEFAULT_SIGNATORIES];

  const out = [];
  for (const entry of list) {
    if (out.length >= MAX_SIGNATORIES) break;
    if (!entry || typeof entry !== "object") continue;
    const role = clean(entry.role);
    // A line with no role is not a signature block — it is an empty column that still
    // takes a third of the width.
    if (!role) continue;
    out.push({ role, name: clean(entry.name), auto: entry.auto === true });
  }
  return out.length ? out : [...DEFAULT_SIGNATORIES];
}

/**
 * Fill in the names the system knows; keep the rest as the admin set them.
 *
 * @param {{role: string, name: string, auto: boolean}[]} list
 * @param {string} generatorName who generated the report
 * @returns {{role: string, name: string}[]} ready to draw
 */
export function resolveSignatories(list, generatorName) {
  return normalizeSignatories(list).map(({ role, name, auto }) => ({
    role,
    // An explicit name always wins over `auto`: if an admin typed someone in, they
    // meant that person, and silently overwriting it would be the more surprising rule.
    name: name || (auto ? clean(generatorName) : ""),
  }));
}

/**
 * Signature columns per row: at most three on a portrait page. Four becomes 2+2,
 * not 3+1.
 *
 * @param {number} count
 * @returns {number}
 */
export function signatoriesPerRow(count) {
  const n = Math.max(1, Math.min(MAX_SIGNATORIES, Number(count) || 1));
  if (n <= 3) return n;
  return Math.ceil(n / Math.ceil(n / 3));
}

// ─── Letterhead logo uploads ─────────────────────────────────────────────────
// ICTU wanted to be able to change the logos themselves.

/**
 * Largest logo accepted, in bytes. pdfkit embeds the image at full size in every PDF,
 * so a huge upload would make every report large.
 */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** Marks the renderer can place. */
export const LOGO_SLOTS = ["cspc", "ictu"];

/**
 * Identify an image by its first bytes, not by the Content-Type or filename (both
 * can be faked). pdfkit only supports PNG and JPEG; anything else would make every
 * later report fail. SVG is refused because it can carry script.
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {"png"|"jpeg"|null} null = not an image we will store
 */
export function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  const b = buf;
  // \x89 P N G \r \n \x1a \n
  if (
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return "png";
  }
  // SOI + the first marker byte. Every JPEG variant (JFIF, Exif, raw) starts FF D8 FF.
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  return null;
}

/** Longest original filename kept for display. Longer than any real one; a cap only. */
export const MAX_ORIGINAL_NAME = 120;

/**
 * Clean the uploaded file's original name for display (the file itself is stored as
 * `<slot>-logo.<ext>`). Only a label, but still reduced to a base name, with control
 * characters removed (including RTL/LTR overrides) and the length capped.
 *
 * @param {unknown} raw
 * @returns {string} "" when nothing usable remains
 */
export function sanitizeFileName(raw) {
  let s = String(raw ?? "");
  // Basename, for both separators — the browser sends a bare name, but a scripted
  // client sends whatever it likes.
  s = s.split(/[\\/]/).pop() ?? "";
  // Strip C0/C1 controls and the Unicode bidi overrides.
  s = s.replace(/[ --‪-‮⁦-⁩]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  // A name made only of dots is not a name.
  if (/^\.+$/.test(s)) return "";
  return s.slice(0, MAX_ORIGINAL_NAME);
}

/**
 * The file name for an uploaded logo. Fixed per slot, so a new upload replaces the
 * old file. Nothing from the user goes into the path: the slot is checked against
 * LOGO_SLOTS and the extension comes from sniffImageType.
 *
 * @param {string} slot "cspc" | "ictu"
 * @param {"png"|"jpeg"} kind
 * @returns {string|null} null when the slot is not one we know
 */
export function logoFileName(slot, kind) {
  if (!LOGO_SLOTS.includes(slot)) return null;
  if (kind !== "png" && kind !== "jpeg") return null;
  return `${slot}-logo.${kind === "jpeg" ? "jpg" : "png"}`;
}

export default {
  PAPER_SIZES,
  PAPER_SIZE_KEYS,
  DEFAULT_PAPER_SIZE,
  MAX_LOGO_BYTES,
  LOGO_SLOTS,
  sniffImageType,
  logoFileName,
  sanitizeFileName,
  MAX_ORIGINAL_NAME,
  MAX_SIGNATORIES,
  MAX_SIGNATORY_TEXT,
  DEFAULT_SIGNATORIES,
  normalizeSignatories,
  resolveSignatories,
  signatoriesPerRow,
  normalizePaperSize,
  paperDimensions,
  PH_OFFSET_MINUTES,
  formatPH,
  philippineYear,
  TYPE_CODE,
  FALLBACK_TYPE_CODE,
  referenceNo,
};
