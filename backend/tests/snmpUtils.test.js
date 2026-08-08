import { test } from "node:test";
import assert from "node:assert/strict";
import {
  numOrNull,
  inRange,
  UPS_BOUNDS,
  normalizePort,
  isValidIp,
  networkSegment,
  computeUtilizationPct,
  counterDelta,
} from "../services/snmpUtils.js";

// Pure-logic tests for the SNMP router/UPS path. No MySQL, no InfluxDB, no .env —
// snmpUtils.js is import-free on purpose so `npm test` runs anywhere.
// Run: cd backend && npm test

// ─── computeUtilizationPct ────────────────────────────────────────────────────

test("utilization uses the busier direction, not the sum (full-duplex)", () => {
  // 100 Mbit/s link = 12_500_000 bytes/s each way. 60 Mbit/s in AND out at once is
  // 60% each way — well inside capacity. Summing would read 120% (clamped to 100%)
  // and false-fire the `link_util >= 95` critical rule.
  const sixtyMbitInBytes = (60 * 1e6) / 8;
  const pct = computeUtilizationPct({
    dRxBytes: sixtyMbitInBytes,
    dTxBytes: sixtyMbitInBytes,
    dtSec: 1,
    speedMbps: 100,
  });
  assert.equal(Math.round(pct), 60);
});

test("utilization matches the dev-simulator's known rates", () => {
  // dev-snmpsim ether1: rx 1_250_000 B/s, tx 375_000 B/s on a 100 Mbit/s link.
  // max(rx,tx) / 12_500_000 = 10%. (The old sum formula gave 13%.)
  const pct = computeUtilizationPct({ dRxBytes: 1_250_000, dTxBytes: 375_000, dtSec: 1, speedMbps: 100 });
  assert.equal(Number(pct.toFixed(2)), 10);
});

test("utilization is clamped to 100 and never negative", () => {
  const over = computeUtilizationPct({ dRxBytes: 1e9, dTxBytes: 0, dtSec: 1, speedMbps: 100 });
  assert.equal(over, 100);
  const idle = computeUtilizationPct({ dRxBytes: 0, dTxBytes: 0, dtSec: 1, speedMbps: 100 });
  assert.equal(idle, 0);
});

test("utilization is null when it cannot be computed, not 0", () => {
  // A bogus 0% is indistinguishable from a genuinely idle link, so these must be
  // null and the InfluxDB field omitted.
  assert.equal(computeUtilizationPct({ dRxBytes: 10, dTxBytes: 10, dtSec: 0, speedMbps: 100 }), null);
  assert.equal(computeUtilizationPct({ dRxBytes: 10, dTxBytes: 10, dtSec: 1, speedMbps: 0 }), null);
  assert.equal(computeUtilizationPct({ dRxBytes: 10, dTxBytes: 10, dtSec: 1, speedMbps: null }), null);
});

// ─── counterDelta ─────────────────────────────────────────────────────────────

test("counterDelta handles Counter64 BigInts beyond float64 safe range", () => {
  // 2^60-ish: past Number.MAX_SAFE_INTEGER, which is why Counter64 is kept as BigInt.
  const prev = 1152921504606846976n;
  const cur = prev + 5000n;
  assert.equal(counterDelta(cur, prev), 5000);
});

test("counterDelta returns 0 on a counter reset (wrap or reboot), never negative", () => {
  assert.equal(counterDelta(10n, 900n), 0);
  assert.equal(counterDelta(0n, 5_000_000_000n), 0);
});

test("counterDelta accepts plain numbers and missing values", () => {
  assert.equal(counterDelta(500, 100), 400);
  assert.equal(counterDelta(500, null), 500);
  assert.equal(counterDelta(null, null), 0);
});

// ─── inRange / UPS sentinel rejection ─────────────────────────────────────────

test("inRange passes real readings through untouched", () => {
  assert.equal(inRange(42, 0, 100), 42);
  assert.equal(inRange(0, 0, 100), 0); // a genuine 0 is a reading, not a sentinel
  assert.equal(inRange(100, 0, 100), 100); // inclusive at both ends
  assert.equal(inRange("55", 0, 100), 55); // SNMP values may arrive as strings
});

test("inRange rejects out-of-range values and non-numbers", () => {
  assert.equal(inRange(101, 0, 100), null);
  assert.equal(inRange(-1, 0, 100), null);
  assert.equal(inRange(null, 0, 100), null);
  assert.equal(inRange(undefined, 0, 100), null);
  assert.equal(inRange("n/a", 0, 100), null);
  assert.equal(inRange(NaN, 0, 100), null);
  assert.equal(inRange(Infinity, 0, 100), null);
});

test("classic UPS firmware sentinels are rejected by their real bounds", () => {
  // These are the exact values that would otherwise reach deviceAlerts.evalMetric
  // and raise a false CRITICAL against the seeded `<=` rules.
  assert.equal(inRange(255, ...UPS_BOUNDS.batteryChargePct), null); // 0xFF charge
  assert.equal(inRange(-1, ...UPS_BOUNDS.batteryChargePct), null);
  assert.equal(inRange(65535, ...UPS_BOUNDS.runtimeRemainingMin), null); // 0xFFFF runtime
  assert.equal(inRange(-1, ...UPS_BOUNDS.runtimeRemainingMin), null);
  assert.equal(inRange(65535, ...UPS_BOUNDS.loadPct), null);
  assert.equal(inRange(-1, ...UPS_BOUNDS.voltage), null);
  assert.equal(inRange(7, ...UPS_BOUNDS.batteryStatus), null); // outside the RFC enum
  assert.equal(inRange(-999, ...UPS_BOUNDS.temperatureC), null);
});

test("genuinely alarming UPS readings still pass — clamping must not mute alerts", () => {
  // The failure mode to guard against is over-filtering: a real emergency has to
  // survive. 12% charge and 3 minutes runtime are exactly what should page someone.
  assert.equal(inRange(12, ...UPS_BOUNDS.batteryChargePct), 12);
  assert.equal(inRange(3, ...UPS_BOUNDS.runtimeRemainingMin), 3);
  assert.equal(inRange(0, ...UPS_BOUNDS.batteryChargePct), 0); // fully flat, still a reading
  assert.equal(inRange(195, ...UPS_BOUNDS.loadPct), 195); // heavy overload, within RFC 0..200
  assert.equal(inRange(4, ...UPS_BOUNDS.batteryStatus), 4); // "depleted"
});

test("numOrNull keeps 0 and rejects junk", () => {
  assert.equal(numOrNull(0), 0);
  assert.equal(numOrNull("12.5"), 12.5);
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull("abc"), null);
});

// ─── normalizePort ────────────────────────────────────────────────────────────

test("normalizePort defaults only when the value is genuinely absent", () => {
  assert.equal(normalizePort(undefined), 161);
  assert.equal(normalizePort(null), 161);
  assert.equal(normalizePort(""), 161);
  assert.equal(normalizePort(1161), 1161); // the dev simulator's port
  assert.equal(normalizePort("161"), 161);
});

test("normalizePort throws a 400 instead of silently coercing a typo", () => {
  // The old behaviour turned "1611"→161 and 99999→161, registering a device that
  // then sat Offline forever with nothing explaining why.
  for (const bad of [99999, 0, -1, 1.5, "abc", "16 1"]) {
    assert.throws(() => normalizePort(bad), (e) => e.status === 400, `expected ${bad} to be rejected`);
  }
});

// ─── IP helpers ───────────────────────────────────────────────────────────────

test("isValidIp accepts IPv4 and rejects everything else", () => {
  assert.equal(isValidIp("192.168.1.1"), true);
  assert.equal(isValidIp("0.0.0.0"), true);
  assert.equal(isValidIp("255.255.255.255"), true);
  assert.equal(isValidIp("256.1.1.1"), false);
  assert.equal(isValidIp("192.168.1"), false);
  assert.equal(isValidIp("192.168.1.1.1"), false);
  assert.equal(isValidIp("router.cspc.edu.ph"), false); // hostnames unsupported
  assert.equal(isValidIp(""), false);
  assert.equal(isValidIp(null), false);
});

test("networkSegment derives the /24 and degrades to empty string", () => {
  assert.equal(networkSegment("10.0.5.23"), "10.0.5.0/24");
  assert.equal(networkSegment("127.0.0.1"), "127.0.0.0/24");
  assert.equal(networkSegment("not-an-ip"), "");
  assert.equal(networkSegment(null), "");
});
