import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import * as fontkit from "fontkit";
import { paperDimensions, formatPH, signatoriesPerRow } from "./reportTemplate.js";
import { drawChart, chartHeight } from "./reportChart.js";

// ─── Body font ───────────────────────────────────────────────────────────────
// ICTU asked for Arial 11/12. Arimo has the same metrics as Arial and is
// OFL-licensed, so it can be shipped in the repo. See assets/fonts/README.md.
const FONTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "../assets/fonts");
const FONT_FILES = {
  regular: path.join(FONTS, "Arimo-Regular.ttf"),
  bold: path.join(FONTS, "Arimo-Bold.ttf"),
};

// Font names used throughout. They map to Arimo when the files exist and to
// pdfkit's built-in Helvetica otherwise, so a report is still produced.
const BODY = "Body";
const BODY_BOLD = "Body-Bold";
const haveBodyFont = fs.existsSync(FONT_FILES.regular) && fs.existsSync(FONT_FILES.bold);
const F = haveBodyFont
  ? { reg: BODY, bold: BODY_BOLD }
  : { reg: "Helvetica", bold: "Helvetica-Bold" };

// Open the embedded font once so renderable() can check which characters it has.
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

// Logos come in as absolute paths on `report.branding`; reportBrandingService picks
// the file (an admin upload, else the bundled default). This module only draws.

// Turns a report object into the two download formats (CSV + PDF). reportService
// builds the object from InfluxDB/MySQL; this module only lays it out. Shape:
//   { title, type, periodStart, periodEnd, generatedAt,
//     summary: [{ label, value }], table: { columns: [...], rows: [[...]] } }
//
// A report may use `tables: [{ title, columns, rows }]` instead when it needs more
// than one table (e.g. network: per device and per interface). `table` still works
// and renders as one "Details" section.

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

// All timestamps in a report are Philippine time (ICTU asked for local time). Data is
// stored in UTC and converted here. The " PHT" suffix makes the timezone explicit.
const fmtTs = formatPH;

// The identity block (labelled lines under the title). Built by reportService and
// drawn as given, so adding a field does not touch the layout.
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
// A cell starting with one of these is run as a formula by Excel, LibreOffice and
// Google Sheets.
const FORMULA_START = /^[=+\-@\t\r]/;

// ─── CSV formula injection (CWE-1236) ─────────────────────────────────────────
// Quoting only makes a cell parse; a cell like `=HYPERLINK(...)` still runs as a
// formula when opened. Report titles come from the request and device names from
// the agent's hostname (not validated), so such text can reach a CSV. A leading
// apostrophe makes the spreadsheet treat it as text.
//
// Numbers are left alone: prefixing `-12.5` would turn it into text and break sums.
// Number.isFinite still catches a lone `-` or `=1+1`, which are NaN.
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
  // The CSV has the same identity block as the PDF, in the same order, so either
  // copy can be traced.
  if (report.referenceNo) lines.push(csvRow(["Reference No.", report.referenceNo]));
  lines.push(csvRow(["Title", report.title]));
  for (const m of metaRows(report)) lines.push(csvRow([m.label, m.value]));
  // A spreadsheet has no signature block, so names printed on the PDF's signature
  // lines are added as fields. Lines without a name are skipped.
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

// CSPC blue ("Madison"), the one blue in a report: the letterhead rule and every
// table header use it.
const CSPC_BLUE = "#0F2E66";

// ─── Type sizes ──────────────────────────────────────────────────────────────
// Arial 11/12 (reports-client-questionnaire.md) applies to body text: identity
// block, summary, signature block. Wide tables do not fit at 11pt on a portrait
// page, so drawTable sizes each table on its own, starting at 11.
const BODY_PT = 11;
// Letterhead unit line: always one line, shrinking within these bounds to fit
// beside the logos.
const UNIT_MAX_PT = 15;
const UNIT_MIN_PT = 9;
const HEADING_PT = 12.5;
const CSPC_BLACK = "#000000";

// Only draw characters the font actually has. pdfkit writes unknown characters as
// raw bytes (e.g. "→" came out as "!’"), and titles and device names are typed by
// users. The bundled Arimo is a Latin subset without arrows or maths symbols (see
// assets/fonts/README.md), so the check uses the font's own glyph table; a fuller
// font would allow more characters with no code change.
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


// Width sampling is capped at 200 rows; more rows do not change the column widths.
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

// Table sizing. Tables start at 11pt and only go smaller if their own content needs
// it, so small tables keep the full size.
//
// Headers are never cut off. Each column's minimum width is its widest single word
// (header or value), so text only wraps to more lines, never gets truncated. With
// this, every current table fits at 11pt on a 532pt-wide folio page:
//
//   table                  full headers   token floor
//   resource util (9)          601pt         299pt
//   ups gauges (9)             661pt         395pt
//   ups voltages (9)           577pt         368pt
//   network devices (12)       619pt         399pt
//   aircon (6)                 220pt         220pt   (all single words — no squeeze)
const TABLE_MAX_PT = 11;
const TABLE_MIN_PT = 7.5;


/**
 * The narrowest a column may be: its widest single word, in the header or any
 * value. At that width every word fits whole; long text just takes more lines.
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
  // The largest size at which every column still fits its widest word.
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
  // Natural width = the full header or the widest cell. Space is shared in proportion,
  // not equally, so a long name gets more room than a one-digit number.
  const natural = measureColumns(doc, columns, rows, size, padX);
  const need = natural.reduce((a, b) => a + b, 0);
  let widths;

  if (need <= totalW) {
    // Spare width goes to the columns that can use it, in proportion to what they
    // already occupy — so a long device name gets the slack, not a number column.
    const slack = totalW - need;
    widths = natural.map((w) => w + (slack * w) / need);
  } else {
    // Too wide: every column keeps its floor and gives up the same fraction of the
    // extra width it wanted. Solved directly, so no column goes under its floor.
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
  // Wrapped, never truncated.
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
    // Cells wrap rather than truncate; a row is as tall as its tallest cell.
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

  // Move the cursor below the last row. Cells are placed absolutely, so doc.y is out
  // of date and the next table would be drawn on top of this one.
  doc.x = left;
  doc.y = y;
  doc.lineWidth(0.5).strokeColor(BORDER);
}

// doc.image() throws on a missing or unreadable file, which would fail the whole
// report. A logo that will not load only loses the logo.
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
// Prepared by / Noted by / Approved by, as confirmed by ICTU. Only "Prepared by" is
// filled in automatically (the person who generated the report); the others stay
// blank, since nobody has noted or approved the report when it is created. Never a
// signature image: a printed name under a line, signed by hand.
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

    // ── Printed name above the line ──
    // ICTU's format: the name is printed and signed across. Upper-case, as is usual in
    // a Philippine signature block. Shrinks to fit instead of wrapping.
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
 * The "System Generated Report" footer on every page (ICTU's wording), with the
 * control number, so every sheet of a filed report identifies itself.
 *
 * Drawn after all content (bufferPages), since "Page 1 of 3" needs the total. The
 * bottom margin is set to zero while drawing, or pdfkit would start a new page.
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
    // Page size is chosen per report (default Folio / long bond) and saved on the
    // report, so re-downloading gives the same size. Given in points because pdfkit has
    // no name for Folio. bufferPages so the footer can write "Page 1 of 3".
    const doc = new PDFDocument({ size: paperDimensions(report.paperSize), margin: 40, bufferPages: true });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Must happen before anything is drawn — F.reg/F.bold name these.
    registerBodyFont(doc);

    // ── Letterhead ──
    // Copies CSPC's official letterhead from ICTU's sample
    // (reports_template/sample_reports_header.png):
    //   · both logos on the left, side by side
    //   · a left-aligned serif text block beside them: four small lines, then one large
    //   · a rule beneath: CSPC blue for the first 70.5% of the width, then black
    // Set in Times (a pdfkit built-in) like the sample, independent of the body font.
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;
    const top = 30;

    // Sized from the sample, where the logos are about four-fifths of the letterhead height.
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
    // Configurable (`report.unit_name`). Sized before drawing because its height sets
    // the layout. Always one line; the font shrinks to fit (ICTU's long name lands at
    // 12pt, still above the 11pt college line).
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
    // Blue to 70.5% of the width, then black, as measured on the sample.
    const ruleY = Math.max(top + LOGO, doc.y) + 8;
    const split = left + width * 0.705;
    // 3pt: at 2pt the dark navy looks greyer than the table headers.
    doc.moveTo(left, ruleY).lineTo(split, ruleY).lineWidth(3).strokeColor(CSPC_BLUE).stroke();
    doc.moveTo(split, ruleY).lineTo(right, ruleY).lineWidth(3).strokeColor(CSPC_BLACK).stroke();

    // ── Report identity ──
    // The absolute positioning above leaves pdfkit's cursor somewhere else, so reset both axes.
    doc.x = left;
    doc.y = ruleY + 13;

    // Control number above the title, on the right, where it is easy to find in a folder.
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
    // Label/value pairs for the fields ICTU asked for: server, IP, OS, monitoring
    // period, date created, responsible.
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
    // Between the summary and the tables, so the reader sees the trend before the numbers.
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
