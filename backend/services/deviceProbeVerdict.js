// What a probe's measurements mean and what to do next. No imports, so the verdict
// shown on the Add form is unit-tested. Worded as an instruction ("register with a
// blank community") rather than a reading, since the readings are already shown.

/** Probe outcomes, most capable first. `code` is stable — the UI keys copy off it. */
export const PROBE_CODE = {
  UPS: "ups", // UPS-MIB (RFC 1628) answered — a monitorable UPS
  SNMP_ROUTER: "snmp_router", // SNMP + IF-MIB interfaces — a monitorable router
  SNMP_BARE: "snmp_bare", // SNMP answers but exposes neither ports nor a battery
  PING_ONLY: "ping_only", // alive, but silent on SNMP with this community
  UNREACHABLE: "unreachable", // nothing answered at all
};

/**
 * Combine the four measurements into one outcome. Each MIB is checked separately
 * because a device may implement any subset.
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

// A UPS has no ping-only mode (a ping only proves the management card has power),
// so every non-UPS outcome is a failure here, and each says what to check.
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

// A router can be monitored by ping alone (for ISP-owned equipment), so `ping_only`
// passes when the community was left blank and fails when SNMP was asked for.
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
 * `ok` depends on what is being registered, so `expect` is required: a bare ping
 * reply passes for a router with no community and fails on the UPS form.
 */
export function verdictFor(m = {}, { expect = "router", communityGiven = false } = {}) {
  const code = classify(m);
  const v =
    expect === "ups" ? upsVerdict(code, { communityGiven }) : routerVerdict(code, { communityGiven });
  return { code, ...v };
}

export default { PROBE_CODE, classify, verdictFor };
