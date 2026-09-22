const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
  LevelFormat,
} = require("docx");

/* A5 sticker: 148 x 210 mm — one page, read at arm's length */
const PAGE_W = 8391;
const PAGE_H = 11906;
const MARGIN = 340;
const W = PAGE_W - MARGIN * 2;

const FONT = "Calibri";
const INK = "111111";
const STEEL = "22304A";
const MUTED = "555B63";
const HAIR = "BFC3C9";

/* LED swatches — the firmware's own colours, lifted for print legibility */
const C_BLUE_DIM = "1B3A8C";
const C_PURPLE = "8E2A8E";
const C_RED = "D81B0B";
const C_ORANGE = "F25C00";
const C_YELLOW = "E8A400";
const C_GREEN = "12A312";
const C_BLUE = "1338E8";

const t = (s, o = {}) => new TextRun({ text: s, font: FONT, size: 17, ...o });
const b = (s, o = {}) => t(s, { bold: true, ...o });

const p = (children, o = {}) =>
  new Paragraph({
    children: Array.isArray(children) ? children : [children],
    spacing: { before: 30, after: 60, line: 230 },
    ...o,
  });

const head = (s) =>
  new Paragraph({
    spacing: { before: 90, after: 44 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: STEEL, space: 2 } },
    children: [new TextRun({ text: s, font: FONT, bold: true, size: 22, color: STEEL, allCaps: true })],
  });

/* colour swatch + meaning */
function ledTable(rows) {
  const wSwatch = 340;
  const wText = W - wSwatch;
  return new Table({
    columnWidths: [wSwatch, wText],
    width: { size: W, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
      left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: HAIR },
      insideVertical: { style: BorderStyle.NONE },
    },
    rows: rows.map(([colour, name, meaning]) =>
      new TableRow({
        children: [
          new TableCell({
            width: { size: wSwatch, type: WidthType.DXA },
            shading: { type: ShadingType.CLEAR, fill: colour, color: "auto" },
            margins: { top: 40, bottom: 40, left: 40, right: 40 },
            children: [new Paragraph({ spacing: { before: 0, after: 0 }, children: [t(" ")] })],
          }),
          new TableCell({
            width: { size: wText, type: WidthType.DXA },
            margins: { top: 26, bottom: 26, left: 110, right: 40 },
            children: [
              new Paragraph({
                spacing: { before: 0, after: 0, line: 220 },
                children: [b(name + " — "), t(meaning)],
              }),
            ],
          }),
        ],
      }),
    ),
  });
}

/* plain grid — CH numbers are what the dashboard shows, so they are what the
   sticker shows. GPIO numbers live on the CARD, for whoever holds the iron. */
function grid(cols, rows) {
  const widths = cols.map((c) => Math.round(W * c));
  return new Table({
    columnWidths: widths,
    width: { size: W, type: WidthType.DXA },
    borders: {
      top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
      left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: HAIR },
      insideVertical: { style: BorderStyle.NONE },
    },
    rows: rows.map((cells, r) =>
      new TableRow({
        children: cells.map((c, i) =>
          new TableCell({
            width: { size: widths[i], type: WidthType.DXA },
            margins: { top: 26, bottom: 26, left: 60, right: 40 },
            children: [
              new Paragraph({
                spacing: { before: 0, after: 0, line: 220 },
                children: [r === 0 ? b(String(c), { color: MUTED }) : t(String(c))],
              }),
            ],
          }),
        ),
      }),
    ),
  });
}

let inst = 0;
const steps = (items) => {
  const instance = inst++;
  return items.map((s) =>
    new Paragraph({
      numbering: { reference: "n", level: 0, instance },
      spacing: { before: 14, after: 14, line: 215 },
      keepLines: true,
      children: Array.isArray(s) ? s : [t(s)],
    }),
  );
};

const bullets = (items) =>
  items.map((s) =>
    new Paragraph({
      numbering: { reference: "d", level: 0 },
      spacing: { before: 14, after: 14, line: 215 },
      keepLines: true,
      children: [t(s)],
    }),
  );

const warn = (children) =>
  new Paragraph({
    children: Array.isArray(children) ? children : [children],
    spacing: { before: 60, after: 60, line: 220 },
    indent: { left: 120, right: 120 },
    shading: { type: ShadingType.CLEAR, fill: "FBEDEA", color: "auto" },
    border: { left: { style: BorderStyle.SINGLE, size: 14, color: C_RED, space: 6 } },
  });

const doc = new Document({
  creator: "CSPC-ICTU Server Room Monitoring",
  title: "Server Room Sensor — sticker",
  numbering: {
    config: [
      { reference: "n", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 300, hanging: 200 } } } }] },
      { reference: "d", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.START, style: { paragraph: { indent: { left: 300, hanging: 200 } } } }] },
    ],
  },
  styles: { default: { document: { run: { font: FONT, size: 17, color: INK } } } },
  sections: [
    {
      properties: {
        page: {
          size: { width: PAGE_W, height: PAGE_H },
          margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
        },
      },
      children: [
        new Paragraph({
          spacing: { after: 20 },
          children: [new TextRun({ text: "CSPC · ICTU", font: FONT, bold: true, size: 15, color: STEEL, characterSpacing: 40 })],
        }),
        new Paragraph({
          spacing: { after: 70 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 14, color: INK, space: 3 } },
          children: [new TextRun({ text: "SERVER ROOM SENSOR", font: FONT, bold: true, size: 34 })],
        }),

        head("What the light means"),
        p([b("When you switch it on")], { spacing: { before: 20, after: 40 } }),
        ledTable([
          [C_BLUE_DIM, "Blue", "Starting up. Wait about 20 seconds."],
          [C_PURPLE, "Purple", "Press SETUP or BOOT now to change the WiFi. 4 seconds only."],
          [C_RED, "Red", "Wrong WiFi password, or no network found."],
          [C_ORANGE, "Orange", "On WiFi, but it cannot reach the server."],
          [C_GREEN, "Green", "Ready. Nothing to do."],
        ]),

        p([b("While it is working")], { spacing: { before: 90, after: 40 } }),
        ledTable([
          [C_GREEN, "Green", "Everything is normal."],
          [C_GREEN, "Green with a blue blink", "Not reaching the dashboard. Nothing is lost."],
          [C_BLUE, "Bright blue", "The room is too cold."],
          [C_YELLOW, "Yellow", "Getting hot, humid or smoky."],
          [C_ORANGE, "Orange", "Humidity is too high."],
          [C_RED, "Red", "DANGER — heat or smoke. Check the room."],
        ]),

        head("What the sound means"),
        ...bullets([
          "One long continuous tone — SMOKE. Act now.",
          "Fast beeping — too hot, or too humid.",
          "Slow beeping — warning.",
        ]),

        head("What is plugged in"),
        grid([0.16, 0.42, 0.42], [
          ["CH", "Smoke sensor", "Aircon remote"],
          ["1", "Fitted", "Fitted"],
          ["2", "Fitted", "Fitted"],
          ["3", "Empty", "Empty"],
          ["4", "Empty", "Empty"],
        ]),
        p([t("CH3 and CH4 are spare. A technician can fit them — ask ICTU. "),
           t("The dashboard uses these same CH numbers.", { color: MUTED })],
          { spacing: { before: 70, after: 40 } }),

        head("To change the WiFi"),
        ...steps([
          [b("Hold the small SETUP button for 3 seconds."), t(" Leave the box plugged in.")],
          "The light turns purple, then blinks green once — let go. The box restarts by itself.",
          [t("On your phone, join the WiFi "), b("CSPC-ICTU-Sensor"), t(" (no password). A setup page opens by itself — pick a 2.4 GHz network.")],
        ]),
        p([t("No SETUP button? Plug it in, wait for purple, then press BOOT once.", { color: MUTED })],
          { spacing: { before: 30, after: 30 } }),
        warn([b("Never hold the BOOT button while plugging it in."), t(" It will stop working. Unplug and start again.")]),

        head("Never"),
        ...bullets([
          "Open it or touch the wiring while it is plugged in.",
          "Take out the small round battery inside.",
          "Connect it to a 5 GHz WiFi network.",
        ]),

        p([b("Do not open the box."), t(" Anything not on this sticker — contact ICTU or the development team.")],
          { spacing: { before: 130, after: 0 } }),
      ],
    },
  ],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(process.argv[2], buf);
  console.log("written", process.argv[2], buf.length, "bytes");
});
