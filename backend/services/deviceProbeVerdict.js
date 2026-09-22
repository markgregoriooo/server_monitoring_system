// PURE, import-free: what a probe's MEASUREMENTS mean, and what to do about them.
//
// Split from deviceProbe.js (the I/O half) the same way pingOutput is split from
// icmpPing and snmpUtils from snmpClient — so the decision an admin sees in the Add
// form can be tested without a network, a device or a .env.
//
// The problem this exists for: registering a router or a UPS with a wrong IP, a wrong
// community or a blocked UDP 161 used to be SILENT. The device was created, the first
// poll failed into the server console, and the row went Offline — which is also what a
// perfectly healthy device that simply has not been polled yet looks like. So an admin
// sat waiting for a card to fill that never would.
//
// The verdict is deliberately phrased as an INSTRUCTION ("register with a blank
// community"), not as a reading ("snmpAnswered: false"). The reading is already on
// screen; what the operator cannot derive from it is which of four things to go change.

/** Probe outcomes, most capable first. `code` is stable — the UI keys copy off it. */
export const PROBE_CODE = {
  UPS: "ups", // UPS-MIB (RFC 1628) answered — a monitorable UPS
  SNMP_ROUTER: "snmp_router", // SNMP + IF-MIB interfaces — a monitorable router
  SNMP_BARE: "snmp_bare", // SNMP answers but exposes neither ports nor a battery
  PING_ONLY: "ping_only", // alive, but silent on SNMP with this community
  UNREACHABLE: "unreachable", // nothing answered at all
};

/**
 * Fold the four independent measurements into one outcome.
 *
 * Each MIB is asked independently on purpose — a device may implement any subset, and
 * conflating "SNMP answered" with "the system group had contents" is what once made the
 * dev UPS (UPS-MIB only, empty MIB-II) look unmonitorable. See deviceProbe.js.
 */
export function classify({ icmpReachable, snmpAnswered, ifCount = 0, isUps = false } = {}) {
  if (isUps) return PROBE_CODE.UPS;
  if (snmpAnswered && ifCount > 0) return PROBE_CODE.SNMP_ROUTER;
  if (snmpAnswered) return PROBE_CODE.SNMP_BARE;
  if (icmpReachable) return PROBE_CODE.PING_ONLY;
  return PROBE_CODE.UNREACHABLE;
}

const NOTHING_ANSWERED = {
  ok: false,
  registerAs: null,
  title: "Nothing answered at this address.",
  detail:
    "No ICMP reply and no SNMP response. Check the IP is right and the device is " +
    "powered. Registered now, it would sit Offline forever with nothing on screen " +
    "explaining why.",
};

// A UPS has no ping fallback and never will: pinging a battery tells you its management
// card has power, which is the one fact about a UPS that is never in doubt once you can
// reach it at all. So every non-UPS outcome is a refusal here, and each names the thing
// to go and check rather than restating the measurement.
function upsVerdict(code, { communityGiven }) {
  switch (code) {
    case PROBE_CODE.UPS:
      return {
        ok: true,
        registerAs: "ups",
        title: "This is a monitorable UPS.",
        detail: "UPS-MIB answered — battery, runtime, load and output source will all be read.",
      };
    case PROBE_CODE.SNMP_ROUTER:
    case PROBE_CODE.SNMP_BARE:
      return {
        ok: false,
        registerAs: null,
        title: "SNMP works, but this device is not a UPS.",
        detail:
          "It answered SNMP and did not implement UPS-MIB (RFC 1628). Either this is the " +
          "wrong address, or the unit's network card only speaks its vendor's own app." +
          (code === PROBE_CODE.SNMP_ROUTER ? " It looks like a router — add it under Network." : ""),
      };
    case PROBE_CODE.PING_ONLY:
      return {
        ok: false,
        registerAs: null,
        title: communityGiven
          ? "The host is alive, but that community did not work."
          : "The host is alive, but no community was given.",
        detail: communityGiven
          ? "Something answers at this address and ignored SNMP with this community string. " +
            "Check the community, check UDP 161 is open to the backend host, and confirm the " +
            "UPS network card has SNMP v2c enabled."
          : "A UPS is read over SNMP and has no ping-only mode — a reply to ping only proves " +
            "its management card has power. Enter the read community.",
      };
    default:
      return NOTHING_ANSWERED;
  }
}

// A router, unlike a UPS, has a legitimate second mode: no community at all, monitored
// by ICMP. That is the only way to watch ISP-owned CPE, so `ping_only` is a SUCCESS here
// when the admin left the community blank — and a failure when they did not, because
// then they asked for SNMP and did not get it.
function routerVerdict(code, { communityGiven }) {
  switch (code) {
    case PROBE_CODE.SNMP_ROUTER:
      return {
        ok: true,
        registerAs: "router",
        title: "Monitorable over SNMP.",
        detail: "Per-port traffic, link up/down and uptime will all be read.",
      };
    case PROBE_CODE.UPS:
      return {
        ok: true,
        registerAs: "ups",
        title: "This answers as a UPS, not a router.",
        detail:
          "UPS-MIB (RFC 1628) answered. Add it under UPS instead — registered here it would " +
          "be polled for interfaces it does not have.",
      };
    case PROBE_CODE.SNMP_BARE:
      return {
        ok: false,
        registerAs: "router-ping",
        title: "SNMP works, but this device exposes nothing we monitor.",
        detail:
          "No IF-MIB interfaces and no UPS-MIB battery. Register it with a BLANK community to " +
          "track reachability, or try the community that exposes more.",
      };
    case PROBE_CODE.PING_ONLY:
      return communityGiven
        ? {
            ok: false,
            registerAs: "router-ping",
            title: "The host is alive, but that community did not work.",
            detail:
              "It replies to ping and ignored SNMP with this community. Check the community " +
              "string and that UDP 161 is open to the backend host — or clear the community and " +
              "register it for ping-only monitoring, which is normal for ISP-owned gear.",
          }
        : {
            ok: true,
            registerAs: "router-ping",
            title: "Monitorable by ping.",
            detail:
              "Up/down, latency and packet loss — no per-port traffic or link status, because no " +
              "SNMP community was given. This is the right mode for ISP-owned CPE.",
          };
    default:
      return NOTHING_ANSWERED;
  }
}

/**
 * The verdict for one probe.
 *
 * @param {object} m   measurements — { icmpReachable, snmpAnswered, ifCount, isUps }
 * @param {object} ctx { expect: 'router'|'ups', communityGiven: boolean }
 * @returns {{ code: string, ok: boolean, registerAs: string|null, title: string, detail: string }}
 *
 * `ok` is answered RELATIVE TO WHAT WAS ASKED FOR, which is why `expect` is required: a
 * bare ICMP reply is a pass for a router registered with no community and a failure for
 * the same address typed into the UPS form.
 */
export function verdictFor(m = {}, { expect = "router", communityGiven = false } = {}) {
  const code = classify(m);
  const v =
    expect === "ups" ? upsVerdict(code, { communityGiven }) : routerVerdict(code, { communityGiven });
  return { code, ...v };
}

export default { PROBE_CODE, classify, verdictFor };
