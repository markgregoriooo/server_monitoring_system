const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
  LevelFormat, convertInchesToTwip,
} = require("docx");

/* A4, 0.75in margins -> content width */
const PAGE_W = 11906;
const MARGIN = 1080;
const W = PAGE_W - MARGIN * 2; // 9746

const INK = "1A1A1A";
const STEEL = "2B3A55";
const MUTED = "5A6068";
const DANGER = "A81F12";
const HEAD_FILL = "EAECF0";
const NOTE_FILL = "F4F6F9";
const WARN_FILL = "FBEDEA";

const FONT = "Calibri";
const MONO = "Consolas";

/* ---------- helpers ---------- */

const run = (text, opts = {}) => new TextRun({ text, font: opts.mono ? MONO : FONT, ...opts });

const p = (children, opts = {}) =>
  new Paragraph({
    children: Array.isArray(children) ? children : [children],
    spacing: { before: 60, after: 100, line: 264 },
    ...opts,
  });

const h1 = (text) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 240, after: 130 },
    keepNext: true,
    keepLines: true,
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: STEEL, space: 4 } },
    children: [new TextRun({ text, font: FONT, bold: true, size: 26, color: STEEL, allCaps: true })],
  });

const h2 = (text) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 180, after: 80 },
    keepNext: true,
    keepLines: true,
    children: [new TextRun({ text, font: FONT, bold: true, size: 20, color: INK })],
  });

/* a shaded callout paragraph */
const callout = (children, warn = false) =>
  new Paragraph({
    children: Array.isArray(children) ? children : [children],
    spacing: { before: 140, after: 140, line: 264 },
    indent: { left: 180, right: 180 },
    shading: { type: ShadingType.CLEAR, fill: warn ? WARN_FILL : NOTE_FILL, color: "auto" },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color: warn ? DANGER : STEEL, space: 8 } },
  });

/* table: rows = array of arrays; first row is the header */
function table(cols, rows, opts = {}) {
  const widths = cols.map((c) => Math.round(W * c));
  const mkCell = (content, i, header) =>
    new TableCell({
      width: { size: widths[i], type: WidthType.DXA },
      shading: header ? { type: ShadingType.CLEAR, fill: HEAD_FILL, color: "auto" } : undefined,
      margins: { top: 60, bottom: 60, left: 110, right: 110 },
      children: [
        new Paragraph({
          spacing: { before: 0, after: 0, line: 252 },
          children: Array.isArray(content) ? content : [run(String(content), header ? { bold: true, size: 18 } : { size: 19 })],
        }),
      ],
    });

  return new Table({
    columnWidths: widths,
    width: { size: W, type: WidthType.DXA },
    borders: {
      top:    { style: BorderStyle.SINGLE, size: 4, color: "C9CCD1" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "C9CCD1" },
      left:   { style: BorderStyle.SINGLE, size: 4, color: "C9CCD1" },
      right:  { style: BorderStyle.SINGLE, size: 4, color: "C9CCD1" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: "DDDFE3" },
      insideVertical:   { style: BorderStyle.SINGLE, size: 2, color: "DDDFE3" },
    },
    rows: rows.map((cells, r) =>
      new TableRow({
        tableHeader: r === 0,
        children: cells.map((c, i) => mkCell(c, i, r === 0)),
      }),
    ),
    ...opts,
  });
}

const spacer = () => new Paragraph({ spacing: { before: 0, after: 80 }, children: [] });

/* numbered steps — each list gets its own instance so numbering restarts */
let stepInstance = 0;
function steps(items) {
  const instance = stepInstance++;
  return items.map(
    (children) =>
      new Paragraph({
        numbering: { reference: "steps", level: 0, instance },
        spacing: { before: 40, after: 40, line: 264 },
        keepLines: true,
        children: Array.isArray(children) ? children : [run(children, { size: 19 })],
      }),
  );
}

function bullets(items) {
  return items.map(
    (text, i) => {
      const keepTogether = i < items.length - 1;
      return new Paragraph({
        numbering: { reference: "dots", level: 0 },
        spacing: { before: 40, after: 40, line: 264 },
        keepLines: true,
        keepNext: keepTogether,
        children: [run(text, { size: 19 })],
      });
    },
  );
}

const b = (t) => run(t, { bold: true, size: 19 });
const t = (txt) => run(txt, { size: 19 });
const code = (txt) => run(txt, { mono: true, size: 18, color: STEEL });

/* ---------- document ---------- */

const doc = new Document({
  creator: "CSPC-ICTU Server Room Monitoring",
  title: "Sensor Box — Quick Guide",
  description: "Guide card for the ESP32 environment monitoring enclosure.",
  numbering: {
    config: [
      {
        reference: "steps",
        levels: [
          {
            level: 0,
            format: LevelFormat.DECIMAL,
            text: "%1.",
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 400, hanging: 260 } } },
          },
        ],
      },
      {
        reference: "dots",
        levels: [
          {
            level: 0,
            format: LevelFormat.BULLET,
            text: "•",
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 400, hanging: 260 } } },
          },
        ],
      },
    ],
  },
  styles: {
    default: {
      document: { run: { font: FONT, size: 19, color: INK } },
    },
  },
  sections: [
    {
      properties: {
        page: {
          size: { width: PAGE_W, height: 16838 },
          margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
        },
      },
      children: [
        /* ---- masthead ---- */
        new Paragraph({
          spacing: { after: 40 },
          children: [run("CSPC · ICTU  —  SERVER ROOM MONITORING", { size: 16, color: STEEL, bold: true, characterSpacing: 40 })],
        }),
        new Paragraph({
          spacing: { after: 100 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: INK, space: 6 } },
          children: [run("SENSOR BOX — QUICK GUIDE", { bold: true, size: 40 })],
        }),
        p([
          t("Keep this card on the box. Everything here is done from the "),
          b("dashboard"),
          t(" or with a "),
          b("screwdriver"),
          t(". No laptop, no programming. Full setup: "),
          code("SENSOR-SETUP-SHEET.md"),
          t("."),
        ]),

        /* ---- 1 ---- */
        h1("1.  What the light means"),
        h2("Starting up — first 30 seconds"),
        table([0.26, 0.74], [
          ["Light", "Meaning"],
          ["Blue, dim", "Booting. Wait about 20 seconds"],
          [[b("Magenta")], [t("Press "), b("SETUP"), t(" (or BOOT) now if you want to change the WiFi — 4 seconds only")]],
          ["Red", "WiFi failed — wrong password, or network not found"],
          ["Orange", "On WiFi, but the server did not answer — Backend IP is wrong"],
          ["Green", "Connected. Nothing to do"],
        ]),
        spacer(),

        h2("Running"),
        table([0.26, 0.74], [
          ["Light", "Meaning"],
          ["Green", "Normal"],
          [[b("Magenta")], [t("You are holding "), b("SETUP"), t(". Keep holding — at 3 s it blinks green once, then restarts into WiFi setup")]],
          ["Green + blue blink every 5 s", "Readings are not reaching the dashboard. Nothing is lost — they are saved on the memory card"],
          ["Blue, bright", "Room too cold"],
          ["Yellow", "Warning — heat, humidity or gas rising"],
          ["Orange", "Humidity critical"],
          [[b("Red")], [b("Critical — heat or smoke."), t(" Buzzer is on")]],
        ]),
        spacer(),
        p([
          b("Buzzer: "),
          t("one continuous tone = smoke. Fast beeping = heat or humidity critical. Slow beeping = warning. "),
          t("The blue blink never covers an alarm."),
        ]),

        /* ---- 2 ---- */
        h1("2.  Add a smoke sensor (MQ-2)"),
        p([t("4 channels, 2 are fitted. "), b("CH is what the dashboard calls them"), t(" — the GPIO column is only for whoever wires it.")]),
        table([0.14, 0.43, 0.43], [
          ["CH", "Wire AOUT to", "Printed on the board"],
          ["1", [code("GPIO 34")], [code("34"), t("  — fitted")]],
          ["2", [code("GPIO 35")], [code("35"), t("  — fitted")]],
          ["3", [code("GPIO 36")], [code("VP")]],
          ["4", [code("GPIO 39")], [code("VN")]],
        ]),
        spacer(),
        ...steps([
          [b("Unplug the box.")],
          [t("Wire it: "), code("VCC → 5V"), t(", "), code("GND → GND"), t(", "), code("AOUT → that CH’s pin"), t(" "), b("through the 10k / 20k divider"), t(".")],
          [t("Plug in, wait for green.")],
          [t("Dashboard → "), b("Environment → Add smoke sensor"), t(" (admin).")],
          [t("Pick the CH you wired, give it a location name, save.")],
          [t("Press "), b("Recalibrate gas"), t(" — only when the air is clean.")],
        ]),
        callout([
          b("Never wire AOUT straight to the board. "),
          t("The sensor puts out 5 V, the pin takes 3.3 V. The channel stays off until step 5 — an empty pin picks up noise that can read as smoke. To remove a sensor: same screen → "),
          b("Remove sensor"),
          t("."),
        ], true),

        /* ---- 3 ---- */
        h1("3.  Add an IR transmitter (aircon)"),
        p([t("4 channels, 2 are fitted. "), b("CH is what the dashboard calls them.")]),
        table([0.14, 0.53, 0.33], [
          ["CH", "Wire the signal pin to", "Status"],
          ["1", [code("GPIO 25")], "fitted"],
          ["2", [code("GPIO 33")], "fitted"],
          ["3", [code("GPIO 32")], "free"],
          ["4", [code("GPIO 15")], "free"],
        ]),
        spacer(),
        ...steps([
          [b("Unplug the box.")],
          [t("Wire it: "), code("VCC → 5V"), t(", "), code("GND → GND"), t(", "), code("DATA → that CH’s GPIO"), t(".")],
          [t("Aim it at the aircon’s remote sensor — clear line of sight, like pointing a remote.")],
          [t("Plug in, wait for green.")],
          [t("Dashboard → "), b("Air Conditioner → Add Aircon"), t(" (admin).")],
          [t("Pick the CH you wired, name the unit, save.")],
        ]),
        callout([t("The transmitter does nothing until step 6.")]),

        /* ---- 4 ---- */
        h1("4.  Change a setting"),
        table([0.42, 0.58], [
          ["What", "Where"],
          ["WiFi / Backend IP", [t("On the box — hold "), b("SETUP"), t(" 3 s, section 5")]],
          ["Alarm levels (temperature, humidity, gas)", [t("Dashboard → "), b("Alert Rules"), t(" (admin)")]],
          ["When the aircon kicks in", [t("Dashboard → "), b("Air Conditioner → Auto-Cooling Thresholds"), t(" (admin)")]],
          ["Smoke baseline, after moving the box", [t("Dashboard → "), b("Environment → Recalibrate gas")]],
          ["Device secret", "Firmware — call the dev team"],
        ]),
        spacer(),
        p([t("No reflash needed except the last one. Changes reach the box in seconds.")]),

        /* ---- 5 ---- */
        h1("5.  Change the WiFi or server address"),
        p([
          b("Leave the box plugged in. "),
          t("Hold the "), b("SETUP"), t(" button for a full "), b("3 seconds"),
          t(" — the box restarts itself into the setup page. Nothing to unplug, no window to catch."),
        ]),
        ...steps([
          [t("Hold "), b("SETUP"), t(". The light turns "), b("magenta"), t(" while the 3 seconds count.")],
          [t("It blinks "), b("green"), t(" once — the hold registered. Let go; the box restarts on its own.")],
          [t("The setup page comes up by itself. On your phone, join the WiFi "), code("CSPC-ICTU-Sensor-XXXX"), t(" (no password) — if the page does not open, go to "), code("http://192.168.4.1"), t(".")],
          [b("Configure WiFi"), t(" → pick the network ("), b("2.4 GHz only"), t("), type the password, enter the "), b("Backend IP"), t(" and port "), code("3000"), t(".")],
          [b("Save"), t(", and wait for the page to say "), b("Connected"), t(".")],
        ]),
        callout([
          t("The 3 seconds must be unbroken — let go early and the count starts over. "),
          b("During an alarm there is no magenta"),
          t(" (the alarm colour keeps the light), but the hold still counts: watch for the green blink. The setup page waits about "),
          b("3 minutes"),
          t("; if nobody connects, the box goes back to monitoring — hold "),
          b("SETUP"),
          t(" again."),
        ]),

        h2("No SETUP button on the box?"),
        /* keepNext, or the heading and this line sit at the foot of a page with their steps
           overleaf — the one block on the card somebody reads while standing at the rack. */
        p([t("Older boxes have none. This boot-time window also works on a box that has one, and is the only route left if the box stops before it starts running.")], { keepNext: true }),
        ...steps([
          [t("Plug the box in — "), b("do not touch any button yet"), t(".")],
          [t("After about 4 seconds the light turns "), b("magenta"), t(".")],
          [t("While it is magenta, "), b("press BOOT once"), t(" (marked "), code("BOOT"), t(" or "), code("IO0"), t("), then carry on from step 3 above.")],
        ]),
        callout([
          b("Do not hold BOOT while plugging in. "),
          t("That puts the chip in programming mode and it stops running. Unplug and start again."),
        ], true),

        h2("Fitting a SETUP button"),
        p([
          t("Once, with the box "), b("unplugged"), t(". Any momentary push-button: one leg to "),
          code("GPIO 13"), t(", the other to "), code("GND"),
          t(". No resistor, nothing else to add. Label it "), code("SETUP"), t("."),
        ]),
        callout([
          code("GPIO 13"),
          t(" and nothing else. The other pins left free on this board are either strapping pins — a button on one of them stops the box booting — or memory lines."),
        ], true),

        /* ---- 6 ---- */
        h1("6.  Never"),
        ...bullets([
          "Wire anything while the box is plugged in.",
          "Wire an MQ-2 AOUT straight to the board — use the divider.",
          "Hold BOOT while powering on.",
          "Wire the SETUP button to 3.3 V or 5 V — it goes to GND.",
          "Remove the coin cell from the clock module.",
          "Use a 5 GHz WiFi network.",
          "Use any pin not listed on this card.",
        ]),

        /* ---- 7 ---- */
        h1("7.  If something is wrong"),
        table([0.42, 0.58], [
          ["You see", "Do this"],
          ["Orange at startup", "Backend IP wrong → section 5"],
          ["Red at startup", "Wrong password, or a 5 GHz network → section 5"],
          ["Blue blink for a long time", "Server or network is down. Readings are safe on the card"],
          ["New sensor reads nothing", "Not added on the dashboard → section 2, step 4"],
          ["New sensor reads a strange high value", [b("Recalibrate gas"), t(" in clean air")]],
          ["Aircon does not respond", "Check the aim, and that the unit is registered → section 3"],
          ["Nothing happens when I hold SETUP", "Hold a full 3 s without letting go. In an alarm there is no magenta — watch for the green blink"],
          ["Setup page never came back after the restart", [t("It waits 3 minutes, then returns to monitoring. Hold "), b("SETUP"), t(" again → section 5")]],
          ["Box never appears on the dashboard", "Section 5, and check the server is running"],
        ]),
        spacer(),
        p([t("Anything else — contact ICTU or the development team.")]),
      ],
    },
  ],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(process.argv[2], buf);
  console.log("written", process.argv[2], buf.length, "bytes");
});
