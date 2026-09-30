import test from "node:test";
import assert from "node:assert/strict";
import { clientIpFrom, createHandshakeLimiter } from "../services/handshakeLimiter.js";

// ─── clientIpFrom ─────────────────────────────────────────────────────────────
// Must match Express's numeric `trust proxy` rules exactly, so the socket limiter
// sees the same address as the HTTP limiters.

test("clientIpFrom: hops=0 trusts nothing but the direct peer", () => {
  const h = { "x-forwarded-for": "1.1.1.1, 2.2.2.2" };
  assert.equal(clientIpFrom(h, "10.0.0.5", 0), "10.0.0.5");
});

test("clientIpFrom: hops=2 takes the 2nd entry of [peer, ...xff reversed]", () => {
  // chain = [R, c, b, a] → index 2 = "b"; matches Express's proxy-addr with trust=2
  const h = { "x-forwarded-for": "a, b, c" };
  assert.equal(clientIpFrom(h, "R", 2), "b");
});

test("clientIpFrom: hops=1 is the last X-Forwarded-For entry (nearest proxy)", () => {
  const h = { "x-forwarded-for": "203.0.113.9, 172.16.0.1" };
  assert.equal(clientIpFrom(h, "127.0.0.1", 1), "172.16.0.1");
});

test("clientIpFrom: clamps to the far end when the chain is shorter than the hop count", () => {
  // A single-proxy request arriving at a trust=2 deployment must not read undefined.
  assert.equal(clientIpFrom({ "x-forwarded-for": "9.9.9.9" }, "127.0.0.1", 2), "9.9.9.9");
});

test("clientIpFrom: no header, missing address", () => {
  assert.equal(clientIpFrom({}, "10.0.0.5", 2), "10.0.0.5");
  assert.equal(clientIpFrom(undefined, undefined, 2), "unknown");
});

test("clientIpFrom: accepts a repeated header delivered as an array", () => {
  assert.equal(clientIpFrom({ "x-forwarded-for": ["a, b", "c"] }, "R", 1), "c");
});

// ─── createHandshakeLimiter ───────────────────────────────────────────────────

function fakeClock(start = 1_000_000) {
  const state = { t: start };
  return { now: () => state.t, advance: (ms) => (state.t += ms), state };
}

test("blocks only after the failure budget is spent", () => {
  const clock = fakeClock();
  const lim = createHandshakeLimiter({ windowMs: 1000, maxFailures: 3, now: clock.now });
  assert.equal(lim.isBlocked("ip"), false);
  lim.recordFailure("ip");
  lim.recordFailure("ip");
  assert.equal(lim.isBlocked("ip"), false, "under budget must stay open");
  lim.recordFailure("ip");
  assert.equal(lim.isBlocked("ip"), true);
});

test("a success clears the key — the whole point, or nginx's loopback locks out everyone", () => {
  const clock = fakeClock();
  const lim = createHandshakeLimiter({ windowMs: 1000, maxFailures: 2, now: clock.now });
  lim.recordFailure("127.0.0.1");
  lim.recordSuccess("127.0.0.1"); // one working dashboard connects
  lim.recordFailure("127.0.0.1");
  assert.equal(lim.isBlocked("127.0.0.1"), false, "counter must have restarted");
});

test("the window rolls over", () => {
  const clock = fakeClock();
  const lim = createHandshakeLimiter({ windowMs: 1000, maxFailures: 1, now: clock.now });
  lim.recordFailure("ip");
  assert.equal(lim.isBlocked("ip"), true);
  clock.advance(1001);
  assert.equal(lim.isBlocked("ip"), false);
  assert.equal(lim.retryAfterSec("ip"), 0);
});

test("keys are independent — one attacker must not block the campus", () => {
  const clock = fakeClock();
  const lim = createHandshakeLimiter({ windowMs: 1000, maxFailures: 1, now: clock.now });
  lim.recordFailure("attacker");
  assert.equal(lim.isBlocked("attacker"), true);
  assert.equal(lim.isBlocked("staff"), false);
});

test("retryAfterSec reports the remaining window", () => {
  const clock = fakeClock();
  const lim = createHandshakeLimiter({ windowMs: 10_000, maxFailures: 1, now: clock.now });
  lim.recordFailure("ip");
  clock.advance(4000);
  assert.equal(lim.retryAfterSec("ip"), 6);
});

test("key tracking is bounded — a spoofed-XFF flood must not become a memory leak", () => {
  const clock = fakeClock();
  const lim = createHandshakeLimiter({ windowMs: 1000, maxFailures: 5, now: clock.now, maxKeys: 10 });
  for (let i = 0; i < 500; i++) lim.recordFailure(`ip-${i}`);
  assert.ok(lim.size() <= 10, `expected <=10 tracked keys, got ${lim.size()}`);
});

test("expired keys are pruned before the cap is enforced", () => {
  const clock = fakeClock();
  const lim = createHandshakeLimiter({ windowMs: 1000, maxFailures: 5, now: clock.now, maxKeys: 4 });
  for (let i = 0; i < 4; i++) lim.recordFailure(`old-${i}`);
  clock.advance(1001); // every bucket above is now stale
  lim.recordFailure("fresh");
  assert.equal(lim.size(), 1, "stale buckets should be dropped, not kept alongside");
  assert.equal(lim.isBlocked("fresh"), false);
});
