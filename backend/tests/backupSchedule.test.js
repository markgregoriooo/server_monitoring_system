import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lastSlotAtOrBefore,
  nextSlotAfter,
  isoWeekLabel,
  coverageFor,
  filesInCoverage,
  selectExpired,
  validateSchedule,
  normalizeSchedule,
  archiveName,
  ARCHIVE_NAME_RE,
  phDate,
} from "../services/backupSchedule.js";

const SUN_2AM = { day: 0, time: "02:00", keepWeeks: 12 };
// Manila wall-clock time → instant (UTC+8).
const ph = (iso) => new Date(`${iso}+08:00`);

test("the slot is Sunday 02:00 in MANILA, whatever the server's zone", () => {
  // Sunday 2026-10-11 02:00 Manila = Saturday 2026-10-10 18:00 UTC.
  const slot = lastSlotAtOrBefore(ph("2026-10-11T09:00:00"), SUN_2AM);
  assert.equal(slot.toISOString(), "2026-10-10T18:00:00.000Z");
});

test("exactly at the slot counts as due; a minute before is last week's", () => {
  assert.equal(
    lastSlotAtOrBefore(ph("2026-10-11T02:00:00"), SUN_2AM).getTime(),
    ph("2026-10-11T02:00:00").getTime(),
  );
  assert.equal(
    lastSlotAtOrBefore(ph("2026-10-11T01:59:00"), SUN_2AM).getTime(),
    ph("2026-10-04T02:00:00").getTime(),
  );
});

test("mid-week, the last slot is the previous Sunday and the next is the coming one", () => {
  const now = ph("2026-10-07T15:30:00"); // Wednesday
  assert.equal(lastSlotAtOrBefore(now, SUN_2AM).getTime(), ph("2026-10-04T02:00:00").getTime());
  assert.equal(nextSlotAfter(now, SUN_2AM).getTime(), ph("2026-10-11T02:00:00").getTime());
});

test("another day and time is honoured (Wednesday 23:30)", () => {
  const s = { day: 3, time: "23:30", keepWeeks: 4 };
  assert.equal(nextSlotAfter(ph("2026-10-07T23:29:00"), s).getTime(), ph("2026-10-07T23:30:00").getTime());
  assert.equal(nextSlotAfter(ph("2026-10-07T23:30:00"), s).getTime(), ph("2026-10-14T23:30:00").getTime());
});

test("a slot that falls back across a month boundary", () => {
  // Thursday 2026-10-01 → previous Sunday is 2026-09-27.
  assert.equal(
    lastSlotAtOrBefore(ph("2026-10-01T08:00:00"), SUN_2AM).getTime(),
    ph("2026-09-27T02:00:00").getTime(),
  );
});

test("ISO week labels, including the New Year edge", () => {
  assert.equal(isoWeekLabel(ph("2026-10-11T02:00:00")), "2026-W41"); // Sunday ends W41
  assert.equal(isoWeekLabel(ph("2026-10-12T02:00:00")), "2026-W42"); // Monday starts W42
  assert.equal(isoWeekLabel(ph("2027-01-01T02:00:00")), "2026-W53"); // still 2026's last week
  assert.equal(isoWeekLabel(ph("2026-01-01T02:00:00")), "2026-W01");
});

test("the week label is read in Manila, not UTC", () => {
  // Monday 2026-10-12 01:00 Manila is still Sunday in UTC.
  assert.equal(isoWeekLabel(ph("2026-10-12T01:00:00")), "2026-W42");
});

test("coverage is the seven whole days BEFORE the run day", () => {
  assert.deepEqual(coverageFor(ph("2026-10-11T02:00:00")), { from: "2026-10-04", to: "2026-10-10" });
});

test("only data files inside the coverage window are packed", () => {
  const names = [
    "env-2026-10-03.ndjson",
    "env-2026-10-04.ndjson",
    "server-2026-10-10.ndjson",
    "network-2026-10-11.ndjson", // the run day itself: next week's
    "mysql-2026-10-05.sql.gz", // the host's dump is not a data stream
    "checksums.sha256",
  ];
  assert.deepEqual(filesInCoverage(names, { from: "2026-10-04", to: "2026-10-10" }), [
    "env-2026-10-04.ndjson",
    "server-2026-10-10.ndjson",
  ]);
});

test("retention removes old archives but never the newest good one", () => {
  const now = ph("2026-12-31T12:00:00");
  const rows = [
    { id: 1, status: "ok", finishedAt: ph("2026-06-07T02:10:00") },
    { id: 2, status: "ok", finishedAt: ph("2026-06-14T02:10:00") },
    { id: 3, status: "failed", finishedAt: ph("2026-06-21T02:10:00") },
    { id: 4, status: "ok", finishedAt: ph("2026-12-27T02:10:00") },
  ];
  assert.deepEqual(selectExpired(rows, now, 12).sort(), [1, 2]);
});

test("after a long outage the only (old) good backup is kept", () => {
  const now = ph("2027-06-01T12:00:00");
  const rows = [{ id: 7, status: "ok", finishedAt: ph("2026-01-04T02:10:00") }];
  assert.deepEqual(selectExpired(rows, now, 12), []);
});

test("schedule validation rejects junk; normalization falls back field by field", () => {
  assert.ok(validateSchedule({ day: 7, time: "02:00", keepWeeks: 12 }).error);
  assert.ok(validateSchedule({ day: 0, time: "25:00", keepWeeks: 12 }).error);
  assert.ok(validateSchedule({ day: 0, time: "02:00", keepWeeks: 0 }).error);
  assert.deepEqual(validateSchedule({ day: "1", time: "3:05", keepWeeks: "8" }).value, {
    day: 1,
    time: "03:05",
    keepWeeks: 8,
  });
  assert.deepEqual(normalizeSchedule({ day: "x", time: "02:00", keepWeeks: 999 }), {
    day: 0,
    time: "02:00",
    keepWeeks: 12,
  });
});

test("archive names match the download allow-list, and nothing else does", () => {
  const w = archiveName("weekly", ph("2026-10-11T02:00:00"));
  const m = archiveName("manual", ph("2026-10-06T14:32:05"));
  assert.equal(w, "weekly-2026-W41.tar.gz.enc");
  assert.equal(m, "manual-2026-10-06-143205.tar.gz.enc");
  assert.match(w, ARCHIVE_NAME_RE);
  assert.match(m, ARCHIVE_NAME_RE);
  for (const bad of ["../../.env", "weekly-2026-W41.tar.gz", "mysql-2026-10-05.sql.gz", "weekly-2026-W41.tar.gz.enc/.."]) {
    assert.doesNotMatch(bad, ARCHIVE_NAME_RE);
  }
});

test("phDate reads the Manila date", () => {
  assert.equal(phDate(new Date("2026-10-10T18:30:00Z")), "2026-10-11");
});
