// ─── Report template rules — PURE, import-free ───────────────────────────────
//
// Everything ICTU specified about how a generated report must LOOK, kept away from
// the I/O so `npm test` can pin it with no MySQL, no InfluxDB and no .env — the same
// split as serverMetricUtils / historyRange / analyticsMath / availabilityMath.
//
// Source: ICTU's answers on the 2026-08-26 template questionnaire (photographed and
// transcribed in reports-client-questionnaire.md).

// ─── Paper size ──────────────────────────────────────────────────────────────
//
// ICTU: "Dynamic (long - default)". They pick per report; the default is Long bond.
//
// Sizes are in POINTS (72 per inch), which is pdfkit's unit. A4 and Letter have pdfkit
// name constants, but Folio does not — "long bond" is a Philippine office size with no
// entry in pdfkit's table, so it is given explicitly. Expressing all three the same way
// keeps one code path in the renderer instead of a name-or-array branch.
//
// ⚠️ FOLIO IS 8.5 x 13 in, not 8.5 x 14 (that is US Legal). Philippine "long bond" is
// the 13in sheet; using Legal would leave an inch of dead space at the foot of every
// page and misplace the signature block on a printed copy.
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
 * Coerce anything into a supported paper-size key.
 *
 * Falls back rather than throwing: an unrecognised value in a settings row (hand-edited,
 * or left over from an older release) must not take report generation down. The ROUTE
 * validates user input strictly — see routes/reports.js — so a rejection still reaches
 * whoever typed it, while a bad stored default degrades to Folio and keeps working.
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
//
// ICTU: print Philippine time, not UTC.
//
// Every store here is UTC — InfluxDB points, MySQL timestamps, the JWT claims — and that
// stays true. This converts at the LAST possible moment, for display in a document a
// person reads, and nothing upstream changes.
//
// A fixed offset is normally a bug waiting for a DST transition. It is exactly right
// here: the Philippines has observed no daylight saving since 1978 and PST/PHT has been a
// flat UTC+8 throughout. Doing this with Intl and a zone name would be more code, would
// depend on the host's ICU data being present and current, and would produce the identical
// answer for every timestamp this system can hold.
export const PH_OFFSET_MINUTES = 8 * 60;

const pad = (n, w = 2) => String(n).padStart(w, "0");

/**
 * Format an instant as Philippine wall-clock time.
 *
 * Shape is `2026-08-28 14:35:02 PHT` — sortable left-to-right, unambiguous about the
 * zone, and the same width in every cell so a column of them lines up. The zone suffix
 * is not decoration: the same report may be read beside a dashboard that renders in the
 * viewer's own locale, and a bare timestamp gives a reader no way to tell which they are
 * looking at.
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

  // Shift the instant, then read it back with the *UTC* getters. Using the local
  // getters would add the SERVER's offset on top of the shift — correct only on a
  // machine already set to UTC, which is exactly the kind of bug that survives every
  // test run on a developer laptop set to Manila.
  const shifted = new Date(ms + PH_OFFSET_MINUTES * 60_000);
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  const time = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
  const secs = opts.seconds === false ? "" : `:${pad(shifted.getUTCSeconds())}`;
  return `${date} ${time}${secs} PHT`;
}

/**
 * The Philippine calendar year an instant falls in.
 *
 * Used for the reference number, and it must be the PH year rather than the UTC one:
 * a report generated at 07:30 on January 1 in Manila is still 2025-12-31 in UTC, and
 * numbering it under the previous year would misfile the first document of the year.
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
//
// ICTU: "Advisable to have." Shape follows the sample in their own questionnaire,
// ICTU-ENV-2026-001.
//
// Three letters per type, fixed forever once a document has been filed under one — these
// codes are part of a reference an institution may cite years later, so they are pinned
// here rather than derived from the type string (which would silently re-letter every
// past report the day someone renames a type).
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
  // Zero-padded to three, matching ICTU's sample — and allowed to grow past it rather
  // than wrapping. A four-digit year of reports is unlikely here, but a number that
  // silently restarts at 001 would be worse than one that reads 1000.
  const seqText = Number.isInteger(n) && n > 0 ? pad(n, 3) : "001";
  return `ICTU-${code}-${year}-${seqText}`;
}

// ─── Signature block ─────────────────────────────────────────────────────────
//
// ICTU confirmed Prepared by / Noted by / Approved by, then asked for the block to be
// CONFIGURABLE — how many lines, and whose names. Different documents go up different
// chains, and a fixed three would be wrong for both a one-signature internal note and a
// four-signature accreditation submission.

/**
 * Most signature lines one report may carry.
 *
 * Six is two full rows of three. Past that the columns are narrower than a signature,
 * so the cap is a layout limit rather than an arbitrary one.
 */
export const MAX_SIGNATORIES = 6;

/** Longest role label / name. Both are one short line on a page. */
export const MAX_SIGNATORY_TEXT = 60;

/**
 * The block a fresh install gets: **Prepared by** and **Approved by**.
 *
 * ⚠️ ICTU's questionnaire answer was all THREE — Prepared / Noted / Approved. The
 * default was narrowed to two on 2026-08-28 at the project team's instruction, on the
 * reasoning that most reports go straight from preparer to approver and the middle line
 * is the one usually left blank. "Noted by:" is not gone: it is one press of Add line
 * away, and any install that had three keeps three, because a stored block always wins
 * over this constant.
 *
 * Recorded rather than quietly changed — see reports-client-questionnaire.md, because a
 * default that differs from the client's written answer is worth being able to point at.
 *
 * `auto` on the first line means "fill with whoever generated this report" — the system
 * knows that, and it is the one name that differs on every document. The approver is
 * blank by design: nobody has approved anything at the moment a PDF is written, and
 * printing a name there would assert an approval that has not happened.
 */
export const DEFAULT_SIGNATORIES = [
  { role: "Prepared by:", name: "", auto: true },
  { role: "Approved by:", name: "", auto: false },
];

const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_SIGNATORY_TEXT);

/**
 * Coerce stored or submitted config into a usable signature block.
 *
 * Total by design — never throws, always returns at least one line. This is read on
 * every build, and a settings row someone hand-edited into nonsense must not be able to
 * stop reports generating. Callers that need to REJECT bad input (the route) check the
 * result against what was sent.
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
 * Fill in the names the SYSTEM knows, leaving the rest as the admin set them.
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
 * How many signature columns per row.
 *
 * Three is the widest that still leaves room to sign on a portrait page. Four splits
 * 2+2 rather than 3+1, because a lone trailing column reads as a mistake.
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
//
// ICTU: the logo must be theirs to change — "what if they change logo".

/**
 * Largest logo we accept, in bytes.
 *
 * Generous next to what is needed (assets/branding/README.md asks for 400-600px wide)
 * but small enough that it cannot be used as arbitrary storage. It matters more than it
 * looks: pdfkit embeds the file at its FULL pixel size into every PDF it generates, so an
 * 8 MB upload would be paid again on every report anyone ever downloads.
 */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

/** Marks the renderer can place. */
export const LOGO_SLOTS = ["cspc", "ictu"];

/**
 * Identify an image by its LEADING BYTES, never by the declared Content-Type or the
 * filename.
 *
 * Both of those are attacker-chosen, and this path ends in a file written to disk that is
 * later fed to pdfkit and embedded in a document staff open. Two things follow:
 *
 *  - pdfkit supports PNG and JPEG only (README: "SVG is NOT supported"). A mislabelled
 *    file would be accepted, stored, and then throw inside build() — which is
 *    fire-and-forget, so every future report would silently land in `failed` with the
 *    cause being an upload made days earlier.
 *  - SVG is refused outright rather than "not supported yet". It is XML with script in
 *    it, and the moment anything renders branding in a browser it becomes stored XSS.
 *    A raster-only rule has no such edge.
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
 * Clean an uploaded file's ORIGINAL name for display.
 *
 * The stored file is always `<slot>-logo.<ext>` (see logoFileName) so uploads replace
 * rather than accumulate — but that means the panel showed a name the admin never chose,
 * and could not tell "the seal we sent in March" from "the new one". This keeps the name
 * they recognise, purely as a label.
 *
 * ⚠️ Display-only, and never used to build a path. It is still stripped to a basename
 * and de-fanged, because a value that is only *currently* display-only is one refactor
 * away from being joined to a directory:
 *
 *   - any directory part is dropped (`..\..\.env` becomes `.env`)
 *   - control characters go, including the RTL/LTR overrides used to make `exe.gnp`
 *     render as `png.exe` in a UI
 *   - length is capped
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
 * The on-disk filename for an uploaded mark.
 *
 * Fixed per slot, so an upload REPLACES the previous file instead of accumulating one
 * per upload in a directory nothing ever prunes. Nothing user-supplied reaches the path —
 * the slot is checked against LOGO_SLOTS and the extension comes from sniffImageType —
 * which is what keeps a filename like `../../.env` from being expressible at all.
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
