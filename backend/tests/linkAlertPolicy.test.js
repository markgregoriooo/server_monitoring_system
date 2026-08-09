import test from "node:test";
import assert from "node:assert/strict";
import { isLinkFault, linkAlertReason, LINK_REASON_TEXT } from "../services/linkAlertPolicy.js";

// A live port that has carried traffic and just went dark — the whole point of the
// feature. Everything else in this file is a case that must NOT reach an inbox.
const LIVE_PORT_DOWN = { adminUp: true, linkUp: false, everUp: true, monitored: true };

test("a port that carried a link and went down is a fault", () => {
  assert.equal(isLinkFault(LIVE_PORT_DOWN), true);
  assert.equal(linkAlertReason(LIVE_PORT_DOWN), "down");
});

test("an empty socket is not a fault, however long it stays down", () => {
  const empty = { ...LIVE_PORT_DOWN, everUp: false };
  assert.equal(isLinkFault(empty), false);
  assert.equal(linkAlertReason(empty), "never-connected");
});

test("a port disabled in RouterOS is not a fault", () => {
  // The regression this exists for: `disabled=yes` used to be folded into linkUp, so
  // switching a port off on purpose produced the loudest alert on the dashboard.
  const disabled = { ...LIVE_PORT_DOWN, adminUp: false };
  assert.equal(isLinkFault(disabled), false);
  assert.equal(linkAlertReason(disabled), "disabled");
});

test("disabled beats every other reason — even a port that used to be live", () => {
  assert.equal(isLinkFault({ adminUp: false, linkUp: false, everUp: true, monitored: true }), false);
});

test("an admin can silence a flapping port explicitly", () => {
  const silenced = { ...LIVE_PORT_DOWN, monitored: false };
  assert.equal(isLinkFault(silenced), false);
  assert.equal(linkAlertReason(silenced), "silenced");
});

test("a port that is up is never a fault", () => {
  assert.equal(isLinkFault({ ...LIVE_PORT_DOWN, linkUp: true }), false);
  assert.equal(linkAlertReason({ ...LIVE_PORT_DOWN, linkUp: true }), "up");
});

test("unknown link state is not escalated into an outage", () => {
  // A RouterOS field that moved or an SNMP row that didn't answer is a MONITORING gap.
  // Reporting it as a link failure would send ICTU to a healthy switch.
  for (const linkUp of [null, undefined, "false", 0]) {
    assert.equal(isLinkFault({ ...LIVE_PORT_DOWN, linkUp }), false, `linkUp=${String(linkUp)}`);
    assert.equal(linkAlertReason({ ...LIVE_PORT_DOWN, linkUp }), "unknown");
  }
});

test("missing gate data defaults to silence, not to a fault", () => {
  // Ports have no network_interfaces row until they first come up, and the DB read is
  // allowed to fail. Both paths land here, and both must stay quiet.
  assert.equal(isLinkFault({}), false);
  assert.equal(isLinkFault(undefined), false);
  assert.equal(isLinkFault({ adminUp: true, linkUp: false }), false);
});

test("the four gates are checked in priority order", () => {
  // Reason ordering is what the port editor shows a user, so the MOST actionable
  // explanation has to win: "you silenced it" outranks "it is disabled" outranks
  // "it never had a cable".
  assert.equal(
    linkAlertReason({ adminUp: false, linkUp: false, everUp: false, monitored: false }),
    "silenced",
  );
  assert.equal(
    linkAlertReason({ adminUp: false, linkUp: false, everUp: false, monitored: true }),
    "disabled",
  );
});

test("every reason has display copy", () => {
  const reasons = new Set();
  for (const monitored of [true, false])
    for (const adminUp of [true, false])
      for (const linkUp of [true, false, null])
        for (const everUp of [true, false])
          reasons.add(linkAlertReason({ monitored, adminUp, linkUp, everUp }));
  for (const r of reasons) {
    assert.ok(LINK_REASON_TEXT[r], `no copy for reason "${r}"`);
  }
  assert.equal(reasons.size, 6, "all six reasons are reachable");
});

test("only 'down' raises — reason and fault never disagree", () => {
  for (const monitored of [true, false])
    for (const adminUp of [true, false])
      for (const linkUp of [true, false, null])
        for (const everUp of [true, false]) {
          const s = { monitored, adminUp, linkUp, everUp };
          assert.equal(
            isLinkFault(s),
            linkAlertReason(s) === "down",
            `disagreement at ${JSON.stringify(s)}`,
          );
        }
});
