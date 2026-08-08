import PDFDocument from "pdfkit";

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

function truncate(doc, text, width) {
  let s = String(text ?? "");
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

export function toPDFBuffer(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ── Header ──
    doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(16)
      .text("CSPC-ICTU Monitoring", { continued: false });
    doc.fillColor(INK).fontSize(13).text(report.title);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(9).fillColor(MUTED);
    doc.text(`Type: ${report.type}`);
    doc.text(`Period: ${fmtTs(report.periodStart)}  →  ${fmtTs(report.periodEnd)}`);
    doc.text(`Generated: ${fmtTs(report.generatedAt)}`);
    doc.moveDown(0.8);

    // ── Summary ──
    if (report.summary?.length) {
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text("Summary");
      doc.moveDown(0.3);
      doc.font("Helvetica").fontSize(9);
      report.summary.forEach((s) => {
        doc.fillColor(MUTED).text(`${s.label}: `, { continued: true });
        doc.fillColor(INK).text(String(s.value));
      });
      doc.moveDown(0.8);
    }

    // ── Tables ──
    sections(report).forEach((s, i) => {
      if (i > 0) doc.moveDown(1);
      // A heading stranded at the foot of a page is worse than an early break.
      if (doc.y > doc.page.height - doc.page.margins.bottom - 60) doc.addPage();
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(s.title);
      doc.moveDown(0.3);
      if (s.columns.length && s.rows.length) {
        drawTable(doc, s.columns, s.rows);
      } else {
        doc.font("Helvetica").fontSize(9).fillColor(MUTED)
          .text("No data for the selected period.");
      }
    });

    doc.end();
  });
}
