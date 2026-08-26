import test from "node:test";
import assert from "node:assert/strict";
import { toCSV } from "../services/reportRenderer.js";

// ─── CSV formula injection (CWE-1236) ─────────────────────────────────────────
//
// RFC 4180 quoting makes a cell PARSE correctly; it says nothing about what a
// spreadsheet DOES with the text. These pin the neutralisation in csvCell.
//
// The reachable inputs are real: a report `title` comes from the request body, and device
// names come from `devices.device_name`, which agentService.register fills from the
// agent-supplied hostname with no character validation.

/** Build the smallest report the renderer accepts, with `cells` as one table row. */
const reportWith = (cells, title = "T") => ({
  title,
  type: "alerts",
  periodStart: new Date("2026-08-01T00:00:00Z"),
  periodEnd: new Date("2026-08-02T00:00:00Z"),
  generatedAt: new Date("2026-08-02T00:00:00Z"),
  summary: [],
  table: { columns: cells.map((_, i) => `c${i}`), rows: [cells] },
});

/** The data row as the renderer emitted it. */
const rowFor = (cells) => {
  const lines = toCSV(reportWith(cells)).split("\r\n");
  return lines[lines.length - 1];
};

test("a formula-leading cell is neutralised with a leading apostrophe", () => {
  for (const payload of [
    "=cmd|'/c calc'!A1",
    "=1+1",
    "+1+1",
    "@SUM(A1)",
    '=HYPERLINK("http://attacker/","x")',
  ]) {
    const row = rowFor([payload]);
    assert.ok(
      row.includes("'" + payload.slice(0, 3)) || row.includes(`"'`),
      `expected ${JSON.stringify(payload)} to be prefixed, got ${row}`,
    );
    assert.ok(!/^=/.test(row), `row must not START with = : ${row}`);
  }
});

test("NEGATIVE NUMBERS ARE NOT TOUCHED — the whole reason for the numeric exemption", () => {
  // -12.5 starts with '-'. Prefixing it would turn every negative measurement into a
  // text cell and silently break every SUM in the sheet.
  assert.equal(rowFor([-12.5]), "-12.5");
  assert.equal(rowFor(["-12.5"]), "-12.5");
  assert.equal(rowFor([-1]), "-1");
  assert.equal(rowFor(["+63917"]), "+63917"); // parses as a number, so it is one
});

test("a lone dash IS neutralised — it is not a number", () => {
  assert.equal(rowFor(["-"]), "'-");
});

test("ordinary text is untouched", () => {
  assert.equal(rowFor(["server-01"]), "server-01");
  assert.equal(rowFor(["CPU usage"]), "CPU usage");
  assert.equal(rowFor([42]), "42");
  assert.equal(rowFor([""]), "");
});

test("RFC 4180 quoting still works, and composes with the guard", () => {
  assert.equal(rowFor(['say "hi"']), '"say ""hi"""');
  assert.equal(rowFor(["a,b"]), '"a,b"');
  // Both needed at once: formula-leading AND contains a comma.
  assert.equal(rowFor(["=a,b"]), `"'=a,b"`);
});

test("the report TITLE is guarded too — it is user-supplied at POST /api/reports", () => {
  const csv = toCSV(reportWith(["x"], "=1+1"));
  const titleLine = csv.split("\r\n")[0];
  assert.ok(titleLine.includes("'=1+1"), `title not guarded: ${titleLine}`);
});
