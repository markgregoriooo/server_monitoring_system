// Tests for the server-metric helpers. Run: npm test (node --test)
// serverMetricUtils.js has no imports, so no MySQL, InfluxDB or .env is needed.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_INTERVAL_SEC,
  MAX_VOLUMES,
  OFFLINE_CEILING_SEC,
  OFFLINE_FLOOR_SEC,
  backfillTimestamp,
  formatUptime,
  offlineWindowSec,
  sanitizeInterval,
  sanitizeVolumes,
  validateSample,
} from "../services/serverMetricUtils.js";

// ─── offlineWindowSec ─────────────────────────────────────────────────────────

test("offlineWindowSec: floors fast agents so they don't get a hair trigger", () => {
  assert.equal(offlineWindowSec(1), OFFLINE_FLOOR_SEC);
  assert.equal(offlineWindowSec(5), OFFLINE_FLOOR_SEC);
  // 10s agent × 3 = 30s, which is exactly the historical flat value.
  assert.equal(offlineWindowSec(10), OFFLINE_FLOOR_SEC);
});

test("offlineWindowSec: scales with a slow agent — the flapping bug", () => {
  // The regression this exists for: a `-interval 60` agent used to be judged
  // against a flat 30s window, so it flapped Offline/Online forever.
  assert.equal(offlineWindowSec(60), 180);
  assert.ok(offlineWindowSec(60) > 60, "window must exceed the posting interval");
  assert.equal(offlineWindowSec(120), 360);
});

test("offlineWindowSec: unknown/garbage interval falls back to the default", () => {
  const fallback = offlineWindowSec(DEFAULT_INTERVAL_SEC);
  for (const bad of [null, undefined, 0, -5, NaN, "abc", {}]) {
    assert.equal(offlineWindowSec(bad), fallback, `for ${JSON.stringify(bad)}`);
  }
});

test("offlineWindowSec: capped so a nonsense interval can't disable detection", () => {
  assert.equal(offlineWindowSec(99999), OFFLINE_CEILING_SEC);
});

// ─── sanitizeInterval ─────────────────────────────────────────────────────────

test("sanitizeInterval: accepts sane cadences, rejects the rest", () => {
  assert.equal(sanitizeInterval(10), 10);
  assert.equal(sanitizeInterval("30"), 30);
  assert.equal(sanitizeInterval(10.4), 10);
  assert.equal(sanitizeInterval(0), null);
  assert.equal(sanitizeInterval(-1), null);
  assert.equal(sanitizeInterval(3601), null);
  assert.equal(sanitizeInterval("soon"), null);
  assert.equal(sanitizeInterval(undefined), null);
});

// ─── sanitizeVolumes ──────────────────────────────────────────────────────────

const vol = (over = {}) => ({
  mount: "/", fstype: "ext4", total_gb: 100, used_gb: 40, percent: 40, ...over,
});

test("sanitizeVolumes: non-arrays yield an empty list, never a throw", () => {
  for (const bad of [undefined, null, "nope", 42, {}]) {
    assert.deepEqual(sanitizeVolumes(bad), []);
  }
});

test("sanitizeVolumes: keeps well-formed volumes intact", () => {
  const out = sanitizeVolumes([
    vol({ mount: "C:", fstype: "NTFS", total_gb: 455.6, used_gb: 226.4, percent: 49.7 }),
    vol({ mount: "D:", fstype: "NTFS", total_gb: 1863, used_gb: 1789, percent: 96 }),
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    mount: "C:", fstype: "NTFS", total_gb: 455.6, used_gb: 226.4, percent: 49.7,
  });
});

test("sanitizeVolumes: drops duplicates by mount", () => {
  assert.equal(sanitizeVolumes([vol(), vol()]).length, 1);
});

test("sanitizeVolumes: drops malformed entries but keeps the good ones", () => {
  const out = sanitizeVolumes([
    vol({ mount: "" }),                   // no mount
    vol({ mount: "   " }),                // whitespace-only mount
    vol({ mount: "/a", total_gb: "big" }), // non-numeric
    vol({ mount: "/b", percent: 101 }),   // out of range
    vol({ mount: "/c", percent: -1 }),    // negative
    vol({ mount: "/d", used_gb: Infinity }),
    vol({ mount: "/keep" }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].mount, "/keep");
});

test("sanitizeVolumes: caps count and mount length (Influx tag cardinality)", () => {
  const many = Array.from({ length: MAX_VOLUMES + 40 }, (_, i) => vol({ mount: `/m${i}` }));
  assert.equal(sanitizeVolumes(many).length, MAX_VOLUMES);
  assert.equal(sanitizeVolumes([vol({ mount: "/" + "x".repeat(500) })]).length, 0);
});

test("sanitizeVolumes: trims the mount and defaults a missing fstype", () => {
  const out = sanitizeVolumes([vol({ mount: "  /data  ", fstype: undefined })]);
  assert.equal(out[0].mount, "/data");
  assert.equal(out[0].fstype, "");
});

// ─── formatUptime ─────────────────────────────────────────────────────────────

test("formatUptime: picks the coarsest useful unit", () => {
  assert.equal(formatUptime(0), "0m");
  assert.equal(formatUptime(59), "0m");
  assert.equal(formatUptime(60), "1m");
  assert.equal(formatUptime(3600), "1h 0m");
  assert.equal(formatUptime(3661), "1h 1m");
  assert.equal(formatUptime(86400), "1d 0h");
  assert.equal(formatUptime(90061), "1d 1h");
});

test("formatUptime: clamps negatives instead of rendering nonsense", () => {
  assert.equal(formatUptime(-5), "0m");
});

// ─── validateSample ───────────────────────────────────────────────────────────

const sample = (over = {}) => ({
  cpu_percent: 12.5, mem_used_mb: 8000, mem_total_mb: 16000, mem_percent: 50,
  disk_used_gb: 226, disk_total_gb: 455, disk_percent: 49.7,
  net_bytes_sent: 1000, net_bytes_recv: 2000, uptime_seconds: 3600,
  process_count: 312, ...over,
});

test("validateSample: accepts a complete sample", () => {
  assert.equal(validateSample(sample()), null);
});

test("validateSample: names the first missing/invalid numeric field", () => {
  assert.match(validateSample(sample({ cpu_percent: undefined })), /cpu_percent/);
  assert.match(validateSample(sample({ mem_percent: "50" })), /mem_percent/);
  assert.match(validateSample(sample({ disk_percent: NaN })), /disk_percent/);
  assert.match(validateSample(sample({ uptime_seconds: Infinity })), /uptime_seconds/);
});

test("validateSample: process_count must be an integer", () => {
  assert.match(validateSample(sample({ process_count: 3.5 })), /process_count/);
  assert.match(validateSample(sample({ process_count: "312" })), /process_count/);
});

test("validateSample: rejects junk bodies without throwing", () => {
  for (const bad of [undefined, null, {}, "nope"]) {
    assert.ok(validateSample(bad), `expected an error for ${JSON.stringify(bad)}`);
  }
});

// ─── backfillTimestamp ────────────────────────────────────────────────────────

test("backfillTimestamp: accepts a recent RFC3339 stamp", () => {
  const now = Date.now();
  const iso = new Date(now - 5 * 60_000).toISOString();
  assert.equal(backfillTimestamp(iso, now)?.toISOString(), iso);
});

test("backfillTimestamp: rejects a clock running ahead of the server", () => {
  const now = Date.now();
  assert.equal(backfillTimestamp(new Date(now + 10 * 60_000).toISOString(), now), null);
  // A little skew is tolerated rather than discarding otherwise-good data.
  assert.notEqual(backfillTimestamp(new Date(now + 5_000).toISOString(), now), null);
});

test("backfillTimestamp: rejects samples older than the retention window", () => {
  const now = Date.now();
  const ancient = new Date(now - 30 * 24 * 60 * 60_000).toISOString();
  assert.equal(backfillTimestamp(ancient, now), null);
});

test("backfillTimestamp: rejects missing/garbage values", () => {
  const now = Date.now();
  for (const bad of [undefined, null, "", "not-a-date", 12345, {}]) {
    assert.equal(backfillTimestamp(bad, now), null, `for ${JSON.stringify(bad)}`);
  }
});

// ─── Heartbeat + shutdown notice ──────────────────────────────────────────────
import {
  staleBeats,
  inShutdownHold,
  shutdownReason,
} from "../services/serverMetricUtils.js";

test("staleBeats flags only servers silent past the timeout", () => {
  const now = 100_000;
  const beats = new Map([
    [1, now - 1_000], // fresh
    [2, now - 6_000], // exactly at the timeout — not yet
    [3, now - 6_001], // past it
  ]);
  assert.deepEqual(staleBeats(beats, now, 6_000), [3]);
});

test("staleBeats ignores servers that never heartbeated (older agents)", () => {
  assert.deepEqual(staleBeats(new Map(), 100_000, 6_000), []);
});

test("inShutdownHold covers the window after a notice and nothing else", () => {
  assert.equal(inShutdownHold(1_000, 1_000, 30_000), true);
  assert.equal(inShutdownHold(1_000, 30_999, 30_000), true);
  assert.equal(inShutdownHold(1_000, 31_000, 30_000), false);
  assert.equal(inShutdownHold(undefined, 5_000, 30_000), false);
  assert.equal(inShutdownHold(10_000, 5_000, 30_000), false); // clock went backwards
});

test("shutdownReason folds unknown values to 'stopped'", () => {
  assert.equal(shutdownReason("shutdown"), "shutdown");
  assert.equal(shutdownReason("stopped"), "stopped");
  assert.equal(shutdownReason("reboot-now"), "stopped");
  assert.equal(shutdownReason(undefined), "stopped");
});
