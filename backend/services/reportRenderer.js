import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

// Letterhead marks live beside the code, not in BACKUP_DIR/REPORTS_DIR — they are
// source material, not generated output, so a fresh clone must carry them.
// Resolved from this module rather than process.cwd(): the backend is normally
// started from backend/, but a report must not depend on that.
const BRANDING = path.join(path.dirname(fileURLToPath(import.meta.url)), "../assets/branding");

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

function fmtTs(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

// ─── CSV ──────────────────────────────────────────────────────────────────────
function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvRow(arr) {
  return arr.map(csvCell).join(",");
}

export function toCSV(report) {
  const lines = [];
  lines.push(csvRow(["Title", report.title]));
  lines.push(csvRow(["Type", report.type]));
  lines.push(csvRow(["Period", `${fmtTs(report.periodStart)} to ${fmtTs(report.periodEnd)}`]));
  lines.push(csvRow(["Generated", fmtTs(report.generatedAt)]));
  lines.push("");

  if (report.summary?.length) {
    lines.push("Summary");
    for (const s of report.summary) lines.push(csvRow([s.label, s.value]));
    lines.push("");
  }

  const secs = sections(report).filter((s) => s.columns.length);
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
const ACCENT = "#2563eb";
const ROW_ALT = "#f3f4f6";
const BORDER = "#d1d5db";

// pdfkit's built-in fonts (Helvetica/Times/Courier) are WinAnsi — a SINGLE-BYTE
// encoding. Hand it a codepoint outside that set and it does not throw: it writes the
// codepoint's bytes raw, so "→" left the Period line reading "!’" in every report
// ever generated. Report titles and device names are user-typed and reach this file
// verbatim, so one pasted character can do the same again at any time.
//
// Latin-1 passes through, plus the typographic block CP1252 keeps at 0x80-0x9F.
// Anything else is transliterated where there is an honest equivalent, else "?" —
// a visible gap beats a glyph that silently reads as different text.
const CP1252_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
const TRANSLIT = {
  "→": "->", "←": "<-", "↔": "<->", "≤": "<=", "≥": ">=",
  "≠": "!=", "≈": "~", "✓": "Y", "✗": "N", "′": "'", "″": '"',
};

function winAnsi(v) {
  const str = v === null || v === undefined ? "" : String(v);
  let out = "";
  for (const ch of str) {
    out += ch.codePointAt(0) <= 0xff || CP1252_EXTRA.includes(ch) ? ch : (TRANSLIT[ch] ?? "?");
  }
  return out;
}

function truncate(doc, text, width) {
  let s = winAnsi(text);
  if (doc.widthOfString(s) <= width) return s;
  while (s.length > 1 && doc.widthOfString(s + "…") > width) s = s.slice(0, -1);
  return s + "…";
}

function drawTable(doc, columns, rows) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const totalW = right - left;
  const colW = totalW / columns.length;
  const padX = 4;
  const rowH = 18;

  const header = (y) => {
    doc.rect(left, y, totalW, rowH).fill(ACCENT);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8);
    columns.forEach((c, i) => {
      doc.text(truncate(doc, c, colW - padX * 2), left + i * colW + padX, y + 5, {
        width: colW - padX * 2,
        lineBreak: false,
      });
    });
    return y + rowH;
  };

  let y = header(doc.y);
  doc.font("Helvetica").fontSize(8);

  rows.forEach((row, ri) => {
    if (y + rowH > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = header(doc.page.margins.top);
      doc.font("Helvetica").fontSize(8);
    }
    if (ri % 2 === 1) doc.rect(left, y, totalW, rowH).fill(ROW_ALT);
    doc.fillColor(INK);
    columns.forEach((_, ci) => {
      doc.text(truncate(doc, row[ci], colW - padX * 2), left + ci * colW + padX, y + 5, {
        width: colW - padX * 2,
        lineBreak: false,
      });
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
function drawLogo(doc, file, x, y, size) {
  try {
    const abs = path.join(BRANDING, file);
    if (!fs.existsSync(abs)) return false;
    // `fit` scales inside a square box and preserves aspect ratio — the two marks
    // are not identically proportioned and must not be stretched to match.
    doc.image(abs, x, y, { fit: [size, size], align: "center", valign: "center" });
    return true;
  } catch {
    return false;
  }
}

// ─── Signatories ──────────────────────────────────────────────────────────────
// Blank rules, deliberately — never a stored signature image. Embedding a scanned
// signature would mean anyone able to click "Generate" could produce a document
// already bearing someone's name, without that person ever seeing it. A blank rule
// is what makes a signature evidence that a specific human approved a specific
// printed copy, which is the only reason the block is here at all.
//
// No names either: staff change, and a hardcoded one outlives the person. When
// ICTU's template names the roles, this array is the single place to edit — the
// layout divides the width by however many entries it holds.
const SIGNATORIES = [{ role: "Prepared by:" }, { role: "Noted by:" }];

function drawSignatories(doc) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const BLOCK_H = 120;

  // Keep the block whole. "Prepared by:" stranded at the foot of a page with its
  // rule overleaf is worse than ending the tables early and leaving white space.
  if (doc.y + BLOCK_H > doc.page.height - doc.page.margins.bottom) doc.addPage();

  const y0 = doc.y + 24;
  const colW = (right - left) / SIGNATORIES.length;
  const ruleW = Math.min(230, colW - 24);

  SIGNATORIES.forEach((s, i) => {
    const x = left + i * colW;

    doc.fillColor(MUTED).font("Helvetica").fontSize(9)
      .text(s.role, x, y0, { width: colW, lineBreak: false });

    // ~40pt of clear air above the rule — a hand needs room to sign, and a block
    // tight enough to look neat on screen is the one people sign across.
    const ruleY = y0 + 50;
    doc.moveTo(x, ruleY).lineTo(x + ruleW, ruleY).lineWidth(0.75).strokeColor(INK).stroke();

    doc.fillColor(MUTED).fontSize(7.5)
      .text("Signature over printed name", x, ruleY + 5, {
        width: ruleW, align: "center", lineBreak: false,
      });

    doc.fillColor(MUTED).fontSize(8.5).text("Date:", x, ruleY + 26, { lineBreak: false });
    const dateX = x + doc.widthOfString("Date:  ");
    doc.moveTo(dateX, ruleY + 34).lineTo(x + ruleW, ruleY + 34).lineWidth(0.75)
      .strokeColor(INK).stroke();
  });

  doc.x = left;
  doc.y = y0 + 100;
}

export function toPDFBuffer(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ── Letterhead ──
    // ⚠️ PLACEHOLDER ARRANGEMENT. ICTU had not supplied their official report
    // template when this was written — the marks and the wording are real, the
    // layout is ours. Expect to replace this whole block, not tweak it.
    // See assets/branding/README.md.
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const LOGO = 46;
    const top = 34;

    const hasCspc = drawLogo(doc, "cspc-logo.png", left, top, LOGO);
    const hasIctu = drawLogo(doc, "ictu-logo.jpg", right - LOGO, top, LOGO);

    // Reclaim a missing logo's gutter so the wordmark stays centred on the page
    // rather than drifting toward whichever mark failed to load.
    const tx = left + (hasCspc ? LOGO + 10 : 0);
    const tw = right - (hasIctu ? LOGO + 10 : 0) - tx;

    doc.fillColor(MUTED).font("Helvetica").fontSize(8.5)
      .text("CAMARINES SUR POLYTECHNIC COLLEGES", tx, top + 3, {
        width: tw, align: "center", characterSpacing: 1.1,
      });
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11.5)
      .text("Information and Communications Technology Unit", tx, doc.y + 1, {
        width: tw, align: "center",
      });
    doc.fillColor(ACCENT).font("Helvetica").fontSize(8.5)
      .text("Server Infrastructure Monitoring System", tx, doc.y + 2, {
        width: tw, align: "center", characterSpacing: 0.6,
      });

    // Sit the rule below whichever ran taller — the logos or the wordmark.
    const ruleY = Math.max(top + LOGO, doc.y) + 9;
    doc.moveTo(left, ruleY).lineTo(right, ruleY).lineWidth(1).strokeColor(ACCENT).stroke();

    // ── Report identity ──
    // Absolute positioning above left pdfkit's cursor wherever the last string
    // ended, so both axes are reset before the flowing content resumes.
    doc.x = left;
    doc.y = ruleY + 13;
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(13)
      .text(winAnsi(report.title), { width: right - left });
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9).fillColor(MUTED);
    doc.text(winAnsi(`Type: ${report.type}`));
    doc.text(`Period: ${fmtTs(report.periodStart)}  to  ${fmtTs(report.periodEnd)}`);
    doc.text(`Generated: ${fmtTs(report.generatedAt)}`);
    doc.moveDown(0.8);

    // ── Summary ──
    if (report.summary?.length) {
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text("Summary");
      doc.moveDown(0.3);
      doc.font("Helvetica").fontSize(9);
      report.summary.forEach((s) => {
        doc.fillColor(MUTED).text(winAnsi(`${s.label}: `), { continued: true });
        doc.fillColor(INK).text(winAnsi(s.value));
      });
      doc.moveDown(0.8);
    }

    // ── Tables ──
    sections(report).forEach((s, i) => {
      if (i > 0) doc.moveDown(1);
      // A heading stranded at the foot of a page is worse than an early break.
      if (doc.y > doc.page.height - doc.page.margins.bottom - 60) doc.addPage();
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(winAnsi(s.title));
      doc.moveDown(0.3);
      if (s.columns.length && s.rows.length) {
        drawTable(doc, s.columns, s.rows);
      } else {
        doc.font("Helvetica").fontSize(9).fillColor(MUTED)
          .text("No data for the selected period.");
      }
    });

    drawSignatories(doc);

    doc.end();
  });
}
