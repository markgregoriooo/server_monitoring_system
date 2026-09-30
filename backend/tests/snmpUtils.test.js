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
  UPS_OUTPUT_SOURCE,
  upsOutputState,
  isOnBattery,
  isOnBypass,
  isOutputOff,
  isProtected,
} from "../services/snmpUtils.js";

// Tests for the SNMP helpers. No MySQL, InfluxDB or .env needed.
// Run: cd backend && npm test

// ─── computeUtilizationPct ────────────────────────────────────────────────────

test("utilization uses the busier direction, not the sum (full-duplex)", () => {
  // 100 Mbit/s = 12_500_000 bytes/s each way. 60 Mbit/s in and out is 60% each way;
  // summing would give 120% and trigger the `link_util >= 95` rule.
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

// ─── UPS output source (RFC 1628) ─────────────────────────────────────────────

test("every enum value maps to a state, and only two mean the load is safe", () => {
  const S = UPS_OUTPUT_SOURCE;
  assert.equal(upsOutputState(S.normal), "normal");
  assert.equal(upsOutputState(S.battery), "battery");
  assert.equal(upsOutputState(S.bypass), "bypass");
  assert.equal(upsOutputState(S.none), "off");
  assert.equal(upsOutputState(S.booster), "avr");
  assert.equal(upsOutputState(S.reducer), "avr");
  assert.equal(upsOutputState(S.other), "unknown");

  // Protected = mains through the inverter, or mains being boosted/trimmed by AVR.
  assert.equal(isProtected(S.normal), true);
  assert.equal(isProtected(S.booster), true);
  assert.equal(isProtected(S.battery), false);
  assert.equal(isProtected(S.bypass), false);
  assert.equal(isProtected(S.none), false);
});

test("BYPASS is detected — the state that used to read as a healthy UPS", () => {
  // isOnBattery only checks battery(5), so bypass(4) used to look like a normal UPS.
  const bypass = UPS_OUTPUT_SOURCE.bypass;
  assert.equal(isOnBattery(bypass), false); // still false — that part was never wrong
  assert.equal(isOnBypass(bypass), true); // …but now something catches it
  assert.equal(isProtected(bypass), false); // and it counts as unprotected
});

test("the three abnormal states are mutually exclusive", () => {
  // A UPS is on battery, on bypass, or off — never two at once. Overlapping
  // predicates would raise two critical alerts for one condition.
  for (const v of Object.values(UPS_OUTPUT_SOURCE)) {
    const flags = [isOnBattery(v), isOnBypass(v), isOutputOff(v)].filter(Boolean);
    assert.ok(flags.length <= 1, `value ${v} matched ${flags.length} states`);
  }
});

test("an unreported or unrecognised source never invents an outage", () => {
  // A UPS that answers other(1), or a value outside the enum, has told us nothing.
  // Reading that as "unprotected" would page someone over a firmware quirk.
  for (const v of [null, undefined, "", 0, 99, "banana", NaN]) {
    assert.equal(upsOutputState(v), "unknown", `value=${String(v)}`);
    assert.equal(isOnBattery(v), false);
    assert.equal(isOnBypass(v), false);
    assert.equal(isOutputOff(v), false);
    assert.equal(isProtected(v), true); // benefit of the doubt, deliberately
  }
});

test("a numeric string from SNMP reads the same as a number", () => {
  // net-snmp normalizes Integer varbinds to numbers, but a value that has been
  // through JSON (the backup replay path) can arrive as a string.
  assert.equal(upsOutputState("4"), "bypass");
  assert.equal(isOnBypass("4"), true);
  assert.equal(isOnBattery("5"), true);
});

// ─── Fast UPS power watch ──────────────────────────────────────────────────────
import { upsPowerKey } from "../services/snmpUtils.js";

test("upsPowerKey changes when mains fails or the battery degrades", () => {
  const normal = upsPowerKey("normal", 2);
  assert.notEqual(upsPowerKey("battery", 2), normal); // mains lost
  assert.notEqual(upsPowerKey("bypass", 2), normal); // load on raw mains
  assert.notEqual(upsPowerKey("off", 2), normal); // output off
  assert.notEqual(upsPowerKey("normal", 3), normal); // battery low
});

test("upsPowerKey ignores AVR flicker, which raises no alert", () => {
  assert.equal(upsPowerKey("avr", 2), upsPowerKey("normal", 2));
});

test("upsPowerKey is stable for missing values", () => {
  assert.equal(upsPowerKey(null, null), "unknown|?");
  assert.equal(upsPowerKey(undefined, undefined), upsPowerKey(null, null));
});
