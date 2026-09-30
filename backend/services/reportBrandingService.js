import fs from "node:fs";
import path from "node:path";
import db from "../config/mysql.js";
import { BACKEND_ROOT } from "../config/env.js";
import {
  DEFAULT_PAPER_SIZE,
  DEFAULT_SIGNATORIES,
  normalizeSignatories,
  normalizePaperSize,
  sniffImageType,
  logoFileName,
  sanitizeFileName,
  LOGO_SLOTS,
  MAX_LOGO_BYTES,
} from "./reportTemplate.js";
import { badRequest } from "../utils/httpError.js";

// ─── Report branding and template defaults ──────────────────────
// The rules are in reportTemplate.js (tested). This part reads and writes the MySQL
// `settings` table and the logo files. ICTU wanted to change their own logos, so an
// admin uploads them from the dashboard and later reports use them.

// Uploaded logos are runtime data, kept apart from assets/branding/ (the bundled
// defaults in git). An upload never changes the working tree, and the bundled
// default is always there to fall back to.
const BRANDING_DIR = path.resolve(BACKEND_ROOT, "branding");
const BUNDLED_DIR = path.resolve(BACKEND_ROOT, "assets/branding");

// The committed fallbacks, per slot. Named here rather than probed, so a stray file
// dropped into assets/branding/ can never become the letterhead by accident.
const BUNDLED = { cspc: "cspc-logo.png", ictu: "ictu-logo.jpg" };

fs.mkdirSync(BRANDING_DIR, { recursive: true });

// ─── Settings ────────────────────────────────────────────────────────────────
// Key/value `settings` table. Cached in memory and reloaded after each change, since
// it is read on every report build and changes rarely.
const KEYS = {
  paperSize: "report.paper_size",
  unitName: "report.unit_name",
  signatories: "report.signatories",
  logo: (slot) => `report.logo_${slot}`,
  // The original name of the uploaded file, for display only (stored under a fixed name).
  logoName: (slot) => `report.logo_${slot}_name`,
};

/**
 * The unit line on the letterhead (the large bold line, e.g. "COLLEGE of COMPUTER
 * STUDIES"). Configurable because the unit filing reports may change. The renderer
 * fits the font size to the text.
 */
export const DEFAULT_UNIT_NAME = "INFORMATION AND COMMUNICATIONS TECHNOLOGY UNIT";

/** Letterheads are set in caps and one line; anything longer is a mistake, not a name. */
export const MAX_UNIT_NAME = 120;

let cache = null;

async function load() {
  const [rows] = await db.query(
    "SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'report.%'",
  );
  cache = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value ?? ""]));
  return cache;
}

async function settings() {
  return cache ?? (await load());
}

/** Force a reload on the next read, e.g. after the row was fixed directly in SQL. */
export function invalidate() {
  cache = null;
}

/**
 * The default paper size. Never throws: normalizePaperSize turns a bad value back
 * into Folio, so reports still generate.
 */
export async function defaultPaperSize() {
  try {
    const s = await settings();
    return normalizePaperSize(s[KEYS.paperSize]);
  } catch (err) {
    // The DB being unreachable is already fatal further up the build; do not let it
    // fail HERE, where the only consequence is which page size we assume.
    console.error("[branding] could not read paper size, using default:", err.message);
    return DEFAULT_PAPER_SIZE;
  }
}

/**
 * Set the default paper size. Validated by the caller (routes/reports.js) so a bad
 * value is a 400 rather than a silent fold to Folio.
 */
export async function setDefaultPaperSize(value, userId) {
  const key = normalizePaperSize(value);
  await upsert(KEYS.paperSize, key, userId);
  return key;
}

/**
 * The letterhead's unit line. Falls back to the default when unset or unreadable — an
 * empty line where an institution's name belongs looks like a broken document.
 */
export async function unitName() {
  try {
    const s = await settings();
    const v = String(s[KEYS.unitName] ?? "").trim();
    return v || DEFAULT_UNIT_NAME;
  } catch (err) {
    console.error("[branding] could not read unit name, using default:", err.message);
    return DEFAULT_UNIT_NAME;
  }
}

export async function setUnitName(value, userId) {
  // Blank is meaningful: it clears the override and restores the default, which is how
  // an admin undoes a change without having to retype the original.
  const v = String(value ?? "").trim().slice(0, MAX_UNIT_NAME);
  await upsert(KEYS.unitName, v, userId);
  return v || DEFAULT_UNIT_NAME;
}

/**
 * The signature block: how many lines, their labels and any fixed names. The default
 * is Prepared by / Noted by / Approved by (confirmed by ICTU), configurable because
 * different documents need different signers. Never throws; a bad value falls back
 * to the default.
 */
export async function signatories() {
  try {
    const s = await settings();
    return normalizeSignatories(s[KEYS.signatories]);
  } catch (err) {
    console.error("[branding] could not read signatories, using default:", err.message);
    return [...DEFAULT_SIGNATORIES];
  }
}

/**
 * Replace the signature block. Stored as JSON in the one settings row rather than as a
 * table: it is a short ordered list edited as a whole, never queried by part.
 */
export async function setSignatories(list, userId) {
  const clean = normalizeSignatories(list);
  await upsert(KEYS.signatories, JSON.stringify(clean), userId);
  return clean;
}

async function upsert(key, value, userId) {
  await db.query(
    `INSERT INTO settings (setting_key, setting_value, updated_by)
          VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
                             updated_by    = VALUES(updated_by),
                             updated_at    = CURRENT_TIMESTAMP`,
    [key, value, userId ?? null],
  );
  invalidate();
}

// ─── Logos ───────────────────────────────────────────────────────────────────

/**
 * Absolute path to the logo for a slot, or null. Order: uploaded → bundled → none.
 * Checks the uploaded file exists, since a database restore without BRANDING_DIR
 * would point at a missing file.
 *
 * @param {"cspc"|"ictu"} slot
 * @returns {Promise<string|null>}
 */
export async function logoPath(slot) {
  if (!LOGO_SLOTS.includes(slot)) return null;
  try {
    const s = await settings();
    const uploaded = String(s[KEYS.logo(slot)] ?? "").trim();
    if (uploaded) {
      // basename() strips any path that reached the column by some route other than
      // saveLogo — the value is only ever supposed to be a filename.
      const abs = path.join(BRANDING_DIR, path.basename(uploaded));
      if (fs.existsSync(abs)) return abs;
    }
  } catch (err) {
    console.error("[branding] could not read logo setting:", err.message);
  }
  const fallback = path.join(BUNDLED_DIR, BUNDLED[slot]);
  return fs.existsSync(fallback) ? fallback : null;
}

/**
 * Save an uploaded logo and make it the active one for its slot.
 *
 * @param {"cspc"|"ictu"} slot
 * @param {Buffer} buffer raw image bytes
 * @param {number} userId who uploaded it (recorded on the settings row)
 * @returns {Promise<{slot: string, file: string, kind: string, bytes: number}>}
 */
export async function saveLogo(slot, buffer, userId, originalName = "") {
  if (!LOGO_SLOTS.includes(slot)) throw badRequest("Unknown logo slot.");
  if (!buffer?.length) throw badRequest("No image was uploaded.");
  if (buffer.length > MAX_LOGO_BYTES) {
    throw badRequest(`Image is too large (max ${Math.round(MAX_LOGO_BYTES / 1024 / 1024)} MB).`);
  }

  // By CONTENT, never by the declared type or filename — see sniffImageType.
  const kind = sniffImageType(buffer);
  if (!kind) throw badRequest("Only PNG or JPEG images are supported (SVG cannot be embedded in a PDF).");

  const file = logoFileName(slot, kind);
  const abs = path.join(BRANDING_DIR, file);

  // Write the file before updating the settings row, so the row never points at a
  // file that does not exist yet.
  fs.writeFileSync(abs, buffer);

  // Uploading a PNG over a previous JPEG leaves the old file orphaned — the filename
  // carries the extension. Remove the sibling so BRANDING_DIR holds one file per slot.
  for (const other of ["png", "jpg"]) {
    const stale = path.join(BRANDING_DIR, `${slot}-logo.${other}`);
    if (stale !== abs && fs.existsSync(stale)) {
      try {
        fs.unlinkSync(stale);
      } catch {
        // Not worth failing an upload that already succeeded — the settings row
        // decides which file is live, so a leftover is inert.
      }
    }
  }

  await upsert(KEYS.logo(slot), file, userId);
  const original = sanitizeFileName(originalName);
  // Written even when blank, so replacing a named upload with an unnamed one does not
  // leave the previous file's name showing against the new image.
  await upsert(KEYS.logoName(slot), original, userId);
  return { slot, file, kind, bytes: buffer.length, originalName: original };
}

/** Go back to the bundled logo for a slot, and delete the uploaded file. */
export async function clearLogo(slot, userId) {
  if (!LOGO_SLOTS.includes(slot)) throw badRequest("Unknown logo slot.");
  const s = await settings();
  const current = String(s[KEYS.logo(slot)] ?? "").trim();
  if (current) {
    const abs = path.join(BRANDING_DIR, path.basename(current));
    try {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch (err) {
      console.error("[branding] could not delete logo file:", err.message);
    }
  }
  await upsert(KEYS.logo(slot), "", userId);
  await upsert(KEYS.logoName(slot), "", userId);
  return { slot, file: null, originalName: "" };
}

/**
 * What the dashboard's branding panel renders: the active default and, per slot,
 * whether the mark is ICTU's own upload or the bundled placeholder.
 */
export async function describe() {
  const s = await settings();
  const slots = {};
  for (const slot of LOGO_SLOTS) {
    const file = String(s[KEYS.logo(slot)] ?? "").trim();
    const abs = file ? path.join(BRANDING_DIR, path.basename(file)) : null;
    const uploaded = Boolean(abs && fs.existsSync(abs));
    let updatedAt = null;
    if (uploaded) {
      try {
        updatedAt = fs.statSync(abs).mtime.toISOString();
      } catch {
        updatedAt = null;
      }
    }
    slots[slot] = {
      uploaded,
      file: uploaded ? file : null,
      // Falls back to the stored name for marks uploaded before this was recorded.
      originalName: uploaded ? String(s[KEYS.logoName(slot)] ?? "").trim() || file : null,
      updatedAt,
      // Names the fallback outright, so the panel can say "showing the bundled
      // placeholder" rather than leaving an admin to guess whose logo they are seeing.
      bundled: BUNDLED[slot],
    };
  }
  return {
    paperSize: normalizePaperSize(s[KEYS.paperSize]),
    unitName: String(s[KEYS.unitName] ?? "").trim() || DEFAULT_UNIT_NAME,
    unitNameDefault: DEFAULT_UNIT_NAME,
    signatories: normalizeSignatories(s[KEYS.signatories]),
    logos: slots,
  };
}

export default {
  defaultPaperSize,
  setDefaultPaperSize,
  unitName,
  setUnitName,
  signatories,
  setSignatories,
  logoPath,
  saveLogo,
  clearLogo,
  describe,
  invalidate,
};
