import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DURATION_MINUTES,
  NOTE_MAX,
  parseStartRequest,
  isOpenAt,
  isOverdue,
  windowsInPeriod,
} from "../services/envMaintenanceRules.js";

const T = (s) => new Date(`2026-10-13T${s}:00Z`);

test("only the fixed durations are accepted — no open-ended window", () => {
  for (const m of DURATION_MINUTES) assert.equal(parseStartRequest({ minutes: m }).ok, true);
  for (const bad of [0, 15, 45, 300, 1440, -30, "abc", null, undefined]) {
    assert.equal(parseStartRequest({ minutes: bad }).ok, false, `minutes=${bad}`);
  }
  // A numeric string from a form is fine.
  assert.equal(parseStartRequest({ minutes: "60" }).minutes, 60);
});

test("the note is optional, trimmed, whitespace-collapsed and length-capped", () => {
  assert.equal(parseStartRequest({ minutes: 30 }).note, null);
  assert.equal(parseStartRequest({ minutes: 30, note: "   " }).note, null);
  assert.equal(parseStartRequest({ minutes: 30, note: "  replace   MQ-2 #2 " }).note, "replace MQ-2 #2");
  assert.equal(parseStartRequest({ minutes: 30, note: "x".repeat(NOTE_MAX) }).ok, true);
  assert.equal(parseStartRequest({ minutes: 30, note: "x".repeat(NOTE_MAX + 1) }).ok, false);
  assert.equal(parseStartRequest({ minutes: 30, note: 42 }).ok, false);
});

test("a window is open until its scheduled end, and never after it", () => {
  const w = { started_at: T("10:00"), ends_at: T("11:00"), ended_at: null };
  assert.equal(isOpenAt(w, T("10:30").getTime()), true);
  assert.equal(isOpenAt(w, T("11:00").getTime()), false); // end is exclusive
  assert.equal(isOverdue(w, T("10:30").getTime()), false);
  assert.equal(isOverdue(w, T("11:00").getTime()), true); // expired while nobody closed it
});

test("a window resumed early is closed even before its scheduled end", () => {
  const w = { started_at: T("10:00"), ends_at: T("11:00"), ended_at: T("10:20") };
  assert.equal(isOpenAt(w, T("10:30").getTime()), false);
  assert.equal(isOverdue(w, T("12:00").getTime()), false);
  assert.equal(isOpenAt(null), false);
});

test("report windows are clipped to the period and sorted", () => {
  const rows = [
    { id: 2, started_at: T("13:00"), ends_at: T("14:00"), ended_at: T("13:30") },
    // started before the period, ended inside it
    { id: 1, started_at: T("07:00"), ends_at: T("09:00"), ended_at: T("09:00") },
    // entirely outside
    { id: 3, started_at: T("20:00"), ends_at: T("21:00"), ended_at: T("21:00") },
  ];
  const out = windowsInPeriod(rows, T("08:00"), T("18:00"), T("23:00").getTime());
  assert.deepEqual(out.map((w) => w.id), [1, 2]);
  assert.equal(out[0].clippedFrom.getTime(), T("08:00").getTime());
  assert.equal(out[0].minutes, 60);
  assert.equal(out[1].minutes, 30);
});

test("an open window counts up to now, not to its planned end", () => {
  const rows = [{ id: 1, started_at: T("10:00"), ends_at: T("14:00"), ended_at: null }];
  const out = windowsInPeriod(rows, T("00:00"), T("23:59"), T("11:00").getTime());
  assert.equal(out.length, 1);
  assert.equal(out[0].minutes, 60);
});
