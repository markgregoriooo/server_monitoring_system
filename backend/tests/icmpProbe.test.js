import test from "node:test";
import assert from "node:assert/strict";
import { ping } from "../services/icmpPing.js";

// ─── "The probe is broken" must never look like "the network is down" ─────────
//
// Both used to return packetLossPct: 100. That is the most misleading answer this
// module can give — every router reads as a total outage, alerts fire on all of them at
// once, and the fault is investigated on a network that is fine. The cause is mundane
// (no `ping` binary, or systemd's NoNewPrivileges blocking the setuid/cap_net_raw that
// ping needs) and the symptom points nowhere near it.
//
// These use small counts and short timeouts so the suite stays fast.

test("a broken probe reports probeError and NO loss measurement", async () => {
  const realPath = process.env.PATH;
  process.env.PATH = "/__no_such_directory__"; // spawn('ping') -> ENOENT on any platform
  try {
    const r = await ping("127.0.0.1", { count: 1, timeoutMs: 300 });
    assert.ok(r.probeError, "probeError must be set when ping cannot run");
    assert.match(r.probeError, /could not be started/);
    assert.equal(
      r.packetLossPct,
      null,
      "loss must be NULL, not 100 — nothing was measured, so there is no measurement",
    );
    assert.equal(r.reachable, false);
  } finally {
    process.env.PATH = realPath;
  }
});

test("a genuinely unreachable host DOES report 100% loss — that is a real result", async () => {
  // 192.0.2.0/24 is TEST-NET-1 (RFC 5737): reserved, guaranteed not routed.
  const r = await ping("192.0.2.1", { count: 1, timeoutMs: 600 });
  assert.equal(r.probeError, null, "a silent host is a measurement, not a probe failure");
  assert.equal(r.reachable, false);
  assert.equal(r.packetLossPct, 100, "loss really is 100% — this must still be recorded");
});

test("an invalid IP is refused as a probe error, not reported as an outage", async () => {
  const r = await ping("not-an-ip");
  assert.ok(r.probeError, "a value that never reached the network is not a measurement");
  assert.equal(r.reachable, false);
});

test("every return path has the same shape", async () => {
  const realPath = process.env.PATH;
  process.env.PATH = "/__no_such_directory__";
  const broken = await ping("127.0.0.1", { count: 1, timeoutMs: 300 });
  process.env.PATH = realPath;
  const invalid = await ping("nope");
  const unreachable = await ping("192.0.2.1", { count: 1, timeoutMs: 600 });

  // A caller destructuring one result must be able to destructure them all.
  for (const [name, r] of [["broken", broken], ["invalid", invalid], ["unreachable", unreachable]]) {
    for (const k of ["probeError", "reachable", "latencyMs", "packetLossPct", "sent", "received"]) {
      assert.ok(k in r, `${name} result is missing "${k}"`);
    }
  }
});
