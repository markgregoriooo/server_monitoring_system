import test from "node:test";
import assert from "node:assert/strict";
import {
  PAPER_SIZES,
  PAPER_SIZE_KEYS,
  DEFAULT_PAPER_SIZE,
  normalizePaperSize,
  paperDimensions,
  formatPH,
  philippineYear,
  referenceNo,
  sniffImageType,
  logoFileName,
  TYPE_CODE,
  MAX_SIGNATORIES,
  MAX_SIGNATORY_TEXT,
  DEFAULT_SIGNATORIES,
  normalizeSignatories,
  resolveSignatories,
  signatoriesPerRow,
  sanitizeFileName,
  MAX_ORIGINAL_NAME,
} from "../services/reportTemplate.js";
import { REPORT_TYPES } from "../services/reportTypes.js";

// ─── Paper size ───────────────────────────────────────────────────────────────

test("the default is Folio — ICTU prints on long bond, not A4", () => {
  assert.equal(DEFAULT_PAPER_SIZE, "folio");
  assert.deepEqual(paperDimensions(undefined), PAPER_SIZES.folio.size);
});

test("folio is 8.5 x 13 inches, not US Legal", () => {
  // 14in would leave an inch of dead space and misplace the signature block.
  const [w, h] = PAPER_SIZES.folio.size;
  assert.equal(w, 8.5 * 72);
  assert.equal(h, 13 * 72);
});

test("letter and A4 keep their standard dimensions", () => {
  assert.deepEqual(PAPER_SIZES.letter.size, [612, 792]);
  const [w, h] = PAPER_SIZES.a4.size;
  assert.ok(Math.abs(w - 595.28) < 0.01 && Math.abs(h - 841.89) < 0.01);
});

test("a paper size is accepted in any casing or with stray whitespace", () => {
  assert.equal(normalizePaperSize("A4"), "a4");
  assert.equal(normalizePaperSize("  Letter "), "letter");
  assert.equal(normalizePaperSize("FOLIO"), "folio");
});

test("an unusable stored default degrades to folio instead of failing the build", () => {
  for (const junk of [null, undefined, "", "legal", "A3", 42, {}]) {
    assert.equal(normalizePaperSize(junk), "folio");
  }
});

test("normalizePaperSize cannot be tricked into reaching Object.prototype", () => {
  // A plain `key in PAPER_SIZES` would answer true for these and hand pdfkit a function.
  assert.equal(normalizePaperSize("constructor"), "folio");
  assert.equal(normalizePaperSize("toString"), "folio");
  assert.equal(normalizePaperSize("__proto__"), "folio");
});

test("every advertised key resolves to real dimensions", () => {
  for (const key of PAPER_SIZE_KEYS) {
    const [w, h] = paperDimensions(key);
    assert.ok(w > 0 && h > 0, `${key} has usable dimensions`);
    assert.ok(h > w, `${key} is portrait`);
  }
});

// ─── Philippine time ──────────────────────────────────────────────────────────

test("an instant is printed as Philippine wall-clock time, tagged PHT", () => {
  assert.equal(formatPH(new Date("2026-08-28T06:35:02Z")), "2026-08-28 14:35:02 PHT");
});

test("the 8-hour shift rolls the date over, not just the clock", () => {
  // 20:00 UTC is already tomorrow morning in Manila. A report generated in the
  // evening must not be filed under the previous day.
  assert.equal(formatPH(new Date("2026-08-28T20:00:00Z")), "2026-08-29 04:00:00 PHT");
});

test("midnight UTC reads as 8 AM the same day", () => {
  assert.equal(formatPH(new Date("2026-01-01T00:00:00Z")), "2026-01-01 08:00:00 PHT");
});

test("seconds can be dropped for a date-only context", () => {
  assert.equal(formatPH(new Date("2026-08-28T06:35:02Z"), { seconds: false }), "2026-08-28 14:35 PHT");
});

test("an unusable timestamp renders blank, never 'Invalid Date' in a filed document", () => {
  for (const bad of [null, undefined, "", "not a date", NaN]) {
    assert.equal(formatPH(bad), "");
  }
});

test("ISO strings and epoch millis format identically to a Date", () => {
  const d = new Date("2026-08-28T06:35:02Z");
  assert.equal(formatPH(d.toISOString()), formatPH(d));
  assert.equal(formatPH(d.getTime()), formatPH(d));
});

test("the reference year follows the Philippine calendar, not UTC", () => {
  // 2025-12-31 16:00 UTC is already 2026-01-01 in Manila — the first report of the
  // new year must not be numbered under the old one.
  assert.equal(philippineYear(new Date("2025-12-31T16:00:00Z")), 2026);
  assert.equal(philippineYear(new Date("2025-12-31T15:59:00Z")), 2025);
});

// ─── Reference number ─────────────────────────────────────────────────────────

test("the reference number matches ICTU's own sample shape", () => {
  assert.equal(referenceNo("environment", 2026, 1), "ICTU-ENV-2026-001");
});

test("each report type has its own three-letter code", () => {
  assert.equal(referenceNo("server", 2026, 42), "ICTU-SRV-2026-042");
  assert.equal(referenceNo("network", 2026, 7), "ICTU-NET-2026-007");
  assert.equal(referenceNo("ups", 2026, 7), "ICTU-UPS-2026-007");
});

test("every registered report type has a code — a new type cannot file as GEN unnoticed", () => {
  for (const type of REPORT_TYPES) {
    assert.ok(TYPE_CODE[type], `report type "${type}" needs a TYPE_CODE entry`);
  }
});

test("an unknown type files under a neutral code rather than 'undefined'", () => {
  assert.equal(referenceNo("something-new", 2026, 3), "ICTU-GEN-2026-003");
});

test("a sequence past 999 grows rather than wrapping back to 001", () => {
  // Restarting the count silently would put two documents on the same number.
  assert.equal(referenceNo("alerts", 2026, 1000), "ICTU-ALR-2026-1000");
});

test("a missing or nonsense sequence still yields a well-formed number", () => {
  assert.equal(referenceNo("aircon", 2026, 0), "ICTU-AIR-2026-001");
  assert.equal(referenceNo("aircon", 2026, NaN), "ICTU-AIR-2026-001");
  assert.equal(referenceNo("aircon", 2026, undefined), "ICTU-AIR-2026-001");
});

// ─── Logo upload validation ───────────────────────────────────────────────────

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);

test("a real PNG and a real JPEG are recognised by their leading bytes", () => {
  assert.equal(sniffImageType(PNG), "png");
  assert.equal(sniffImageType(JPEG), "jpeg");
});

test("SVG is refused — it is XML with script in it, not a raster image", () => {
  assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), null);
});

test("a file that merely claims to be an image is refused", () => {
  // The failure this prevents: a mislabelled upload is stored, then throws inside
  // build() days later, silently failing every report from then on.
  assert.equal(sniffImageType(Buffer.from("GIF89a and then some padding")), null);
  assert.equal(sniffImageType(Buffer.from("%PDF-1.7 not a logo at all")), null);
  assert.equal(sniffImageType(Buffer.from("MZ\x90\x00 an executable......")), null);
});

test("a truncated or empty upload is refused rather than half-read", () => {
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
  assert.equal(sniffImageType(PNG.subarray(0, 4)), null);
  assert.equal(sniffImageType(null), null);
  assert.equal(sniffImageType(undefined), null);
});

test("a PNG signature with one byte wrong is not a PNG", () => {
  const corrupt = Buffer.from(PNG);
  corrupt[3] = 0x00;
  assert.equal(sniffImageType(corrupt), null);
});

test("the stored filename is fixed per slot, so an upload replaces rather than accumulates", () => {
  assert.equal(logoFileName("ictu", "png"), "ictu-logo.png");
  assert.equal(logoFileName("ictu", "jpeg"), "ictu-logo.jpg");
  assert.equal(logoFileName("cspc", "png"), "cspc-logo.png");
});

test("no user-supplied text can reach the logo path", () => {
  // Slot and extension are both closed sets, so traversal is not expressible.
  assert.equal(logoFileName("../../.env", "png"), null);
  assert.equal(logoFileName("ictu", "svg"), null);
  assert.equal(logoFileName("", "png"), null);
});

// ─── Signature block ──────────────────────────────────────────────────────────

test("the shipped default is Prepared by + Approved by", () => {
  // ⚠️ ICTU's written answer was all three (Prepared / Noted / Approved). Narrowed to
  // two on 2026-08-28 at the project team's instruction — "Noted by:" is one press of
  // Add line away. Pinned here so the divergence from the client's answer cannot drift
  // further without someone deciding to.
  assert.deepEqual(
    DEFAULT_SIGNATORIES.map((s) => s.role),
    ["Prepared by:", "Approved by:"],
  );
  // Only the first is auto-filled: nobody has approved anything at the moment a PDF is
  // written, so printing a name there would assert an approval that has not happened on
  // a document filed for accreditation.
  assert.deepEqual(DEFAULT_SIGNATORIES.map((s) => s.auto), [true, false]);
});

test("a configured block is kept as given", () => {
  const list = [{ role: "Submitted by:", name: "Juan Dela Cruz", auto: false }];
  assert.deepEqual(normalizeSignatories(list), [
    { role: "Submitted by:", name: "Juan Dela Cruz", auto: false },
  ]);
});

test("config stored as JSON text is parsed", () => {
  const json = JSON.stringify([{ role: "Checked by:", name: "A", auto: false }]);
  assert.equal(normalizeSignatories(json)[0].role, "Checked by:");
});

test("unusable config falls back to the default rather than failing a build", () => {
  // A settings row someone hand-edited must not be able to stop reports generating.
  for (const junk of [null, undefined, "", "not json", "{}", 42, [], [null, 7, "x"]]) {
    assert.deepEqual(normalizeSignatories(junk), DEFAULT_SIGNATORIES);
  }
});

test("a line with no role is dropped — it is an empty column, not a signature", () => {
  const list = [{ role: "Prepared by:" }, { role: "   " }, { role: "", name: "Ghost" }];
  const out = normalizeSignatories(list);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "Prepared by:");
});

test("the block is capped, so it can never be narrower than a signature", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ role: `Role ${i}:` }));
  assert.equal(normalizeSignatories(many).length, MAX_SIGNATORIES);
});

test("role and name are trimmed, collapsed and length-capped", () => {
  const [s] = normalizeSignatories([{ role: "  Noted   by:  ", name: " Juan   Dela  Cruz " }]);
  assert.equal(s.role, "Noted by:");
  assert.equal(s.name, "Juan Dela Cruz");
  const [long] = normalizeSignatories([{ role: "x".repeat(200), name: "y".repeat(200) }]);
  assert.equal(long.role.length, MAX_SIGNATORY_TEXT);
  assert.equal(long.name.length, MAX_SIGNATORY_TEXT);
});

test("auto is strictly boolean true — a truthy string does not enable it", () => {
  assert.equal(normalizeSignatories([{ role: "R", auto: "yes" }])[0].auto, false);
  assert.equal(normalizeSignatories([{ role: "R", auto: 1 }])[0].auto, false);
  assert.equal(normalizeSignatories([{ role: "R", auto: true }])[0].auto, true);
});

test("resolve fills an auto line with whoever generated the report", () => {
  const out = resolveSignatories(DEFAULT_SIGNATORIES, "Mark Angelo Gregorio");
  assert.equal(out[0].name, "Mark Angelo Gregorio");
  // Every non-auto line stays blank for a manual signature, whatever the block holds.
  for (const s of out.slice(1)) {
    assert.equal(s.name, "", `${s.role} stays blank for a manual signature`);
  }
});

test("an explicit name always beats auto", () => {
  // If an admin typed someone in, they meant that person — silently overwriting them
  // with the generator would be the more surprising rule.
  const out = resolveSignatories([{ role: "Prepared by:", name: "Dr. Reyes", auto: true }], "Someone Else");
  assert.equal(out[0].name, "Dr. Reyes");
});

test("resolve tolerates a missing generator name", () => {
  const out = resolveSignatories(DEFAULT_SIGNATORIES, undefined);
  assert.equal(out[0].name, "");
});

test("columns per row keep a signature signable, and never strand one alone", () => {
  assert.equal(signatoriesPerRow(1), 1);
  assert.equal(signatoriesPerRow(2), 2);
  assert.equal(signatoriesPerRow(3), 3);
  // 3+1 would leave a lone trailing column that reads as a mistake.
  assert.equal(signatoriesPerRow(4), 2);
  assert.equal(signatoriesPerRow(5), 3);
  assert.equal(signatoriesPerRow(6), 3);
});

test("columns per row survives nonsense input", () => {
  for (const bad of [0, -3, NaN, undefined, 99]) {
    const n = signatoriesPerRow(bad);
    assert.ok(n >= 1 && n <= 3, `${bad} -> ${n}`);
  }
});

// ─── Original filename (display only) ─────────────────────────────────────────

test("an ordinary filename is kept as the admin recognises it", () => {
  assert.equal(sanitizeFileName("CSPC Seal 2026.png"), "CSPC Seal 2026.png");
  assert.equal(sanitizeFileName("ictu-logo-final-v3.JPG"), "ictu-logo-final-v3.JPG");
});

test("any directory part is dropped, both separators", () => {
  // Display-only today, but a value that is only CURRENTLY display-only is one
  // refactor away from being joined to a directory.
  // String.raw so the backslashes are literal — written with normal escapes this reads
  // as "....env", which has no separator in it and would pass while testing nothing.
  assert.equal(sanitizeFileName(String.raw`..\..\.env`), ".env");
  assert.equal(sanitizeFileName(String.raw`C:\Users\me\Desktop\seal.png`), "seal.png");
  assert.equal(sanitizeFileName("C:/Windows/System32/evil.png"), "evil.png");
  assert.equal(sanitizeFileName("/etc/passwd"), "passwd");
});

test("bidi overrides are stripped — they make exe.gnp render as png.exe", () => {
  assert.equal(sanitizeFileName("\u202Egnp.exe"), "gnp.exe");
  assert.equal(sanitizeFileName("logo\u2066\u2069.png"), "logo.png");
});

test("control characters cannot reach the panel", () => {
  assert.equal(sanitizeFileName("logo\u0000\u001b[31m.png"), "logo[31m.png");
});

test("whitespace is collapsed and trimmed", () => {
  assert.equal(sanitizeFileName("  spaced   name.jpg  "), "spaced name.jpg");
});

test("a name that is only dots, or empty, yields nothing", () => {
  for (const junk of ["", "   ", ".", "..", "...", null, undefined]) {
    assert.equal(sanitizeFileName(junk), "");
  }
});

test("the name is length-capped", () => {
  assert.equal(sanitizeFileName(`${"a".repeat(400)}.png`).length, MAX_ORIGINAL_NAME);
});
