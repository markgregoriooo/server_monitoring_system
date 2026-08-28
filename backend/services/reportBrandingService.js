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

// ─── Report branding & template defaults — the I/O half ──────────────────────
//
// The rules live in reportTemplate.js (pure, tested). This is the part that touches
// MySQL `settings` and the filesystem.
//
// ICTU asked for the letterhead logo to be THEIRS to change — "what if they change
// logo" — so the mark can no longer be a file only a developer with repo access can
// replace. An admin uploads one from the dashboard and every report generated after
// that carries it.

// Uploaded marks are RUNTIME DATA and live apart from assets/branding/, which is
// source material committed to git (a fresh clone must be able to render a report
// before anyone has uploaded anything). Keeping them separate means:
//   - an upload never dirties the working tree, so it cannot be lost to a `git checkout`
//   - the bundled default is always intact to fall back to
//   - `git status` after a deployment is still meaningful
const BRANDING_DIR = path.resolve(BACKEND_ROOT, "branding");
const BUNDLED_DIR = path.resolve(BACKEND_ROOT, "assets/branding");

// The committed fallbacks, per slot. Named here rather than probed, so a stray file
// dropped into assets/branding/ can never become the letterhead by accident.
const BUNDLED = { cspc: "cspc-logo.png", ictu: "ictu-logo.jpg" };

fs.mkdirSync(BRANDING_DIR, { recursive: true });

// ─── Settings ────────────────────────────────────────────────────────────────
// `settings` is a key/value table that shipped in v13 and had never held a row.
//
// Cached in memory and reloaded on every mutation, the same shape alertRulesService
// uses: this is read on EVERY report build and changes a few times a year, so a query
// per build would be pure overhead on a pool of ten shared connections.
const KEYS = {
  paperSize: "report.paper_size",
  unitName: "report.unit_name",
  signatories: "report.signatories",
  logo: (slot) => `report.logo_${slot}`,
  // The name the admin actually uploaded, kept alongside the fixed stored filename.
  // Display only — the panel showed "cspc-logo.png", a name nobody chose, which made
  // "the seal we sent in March" and "the new one" look identical.
  logoName: (slot) => `report.logo_${slot}_name`,
};

/**
 * The unit line on the letterhead — the large bold line where CSPC's own stationery
 * reads "COLLEGE of COMPUTER STUDIES".
 *
 * Configurable rather than hardcoded because the sample ICTU supplied carries a
 * different unit to the one filing these reports, and whoever files them next may be a
 * third. The renderer auto-fits the type size, so a longer or shorter name both sit
 * correctly without anyone touching the layout.
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

/**
 * Force a reload on the next read.
 *
 * Exported because the settings row can also change from outside this process — a DBA
 * fixing a bad value by hand is the documented way several other things in this codebase
 * get repaired.
 */
export function invalidate() {
  cache = null;
}

/**
 * The admin-chosen default paper size.
 *
 * Never throws and never returns something pdfkit cannot use: normalizePaperSize folds
 * an unreadable or hand-edited value back to Folio. A report must still generate when
 * the settings row is wrong.
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
 * The configured signature block — how many lines, their labels, and any fixed names.
 *
 * ICTU confirmed Prepared by / Noted by / Approved by and then asked for it to be
 * configurable: different documents go up different chains, and a fixed three is wrong
 * for both a one-signature internal note and a four-signature accreditation submission.
 *
 * Never throws. normalizeSignatories folds an unreadable row back to the default, so a
 * hand-edited settings value cannot stop reports generating.
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
 * Absolute path to the mark the renderer should draw for a slot, or null if there
 * isn't one.
 *
 * Resolution order is uploaded → bundled → nothing. The `existsSync` on the uploaded
 * file is not paranoia: the settings row and the file are two pieces of state that can
 * drift (a restore from a DB dump that did not carry BRANDING_DIR is the obvious way),
 * and falling back to the committed mark is far better than a letterhead that silently
 * loses its logo.
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
 * Store an uploaded mark and make it the active one for its slot.
 *
 * @param {"cspc"|"ictu"} slot
 * @param {Buffer} buffer raw image bytes
 * @param {number} userId who uploaded it (audit trail on the settings row)
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

  // Written before the settings row is updated. The other order would point the column
  // at a file that does not exist yet, and a build landing in that window would fall
  // back to the bundled mark with nothing to say why.
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

/**
 * Revert a slot to the bundled mark.
 *
 * The uploaded FILE is deleted too. Keeping it would leave an image on disk that
 * nothing references and no screen shows — and a logo an institution has retired is
 * exactly the thing they expect to be gone when they say "remove it".
 */
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
