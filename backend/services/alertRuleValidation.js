// ─── Alert-rule validation — PURE, import-free ────────────────────────────────
//
// Split out of alertRulesService.clean(), which scored the worst complexity density in
// the backend: cyclomatic 34 and cognitive 62 in 55 lines, from 18 `if` statements. None
// of it was twisty logic — it was ONE shape written out seven times, once per field:
//
//     present?  -> validate -> assign
//     absent and not a PATCH?  -> default, or throw
//
// The differences between the seven copies were only ever four values, so they are a
// table now and the shape is written once. Adding a field is a row, not a branch.
//
// Import-free on purpose, like snmpUtils / installKeyUtils / historyRange / analyticsMath:
// `backend/tests/` can then exercise it with no MySQL, no InfluxDB and no .env. That
// matters here more than most places — this is the ONLY validation gate on alert
// thresholds, and alerting is rules-only, so a rule that slips through wrong is either a
// silent alarm or a false one.
//
// See audits/code-complexity-report-2026-08-25.md — C-01.

export const COMPARISONS = [">", "<", ">=", "<="]; // '=' intentionally unsupported (no useful hysteresis)
export const SEVERITIES = ["info", "warning", "critical"];

/** Returned by a field parser that rejected its input. A sentinel rather than a thrown
 *  error so the table stays declarative and the throwing happens in one place. */
export const INVALID = Symbol("invalid");

export function ruleError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ── field parsers ────────────────────────────────────────────────────────────
const nullableInt = (v) => {
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : INVALID;
};

const nullableStr = (max) => (v) => {
  if (v === null || v === "") return null;
  const s = String(v).trim();
  if (s.length > max) return INVALID;
  return s || null;
};

const requiredSlug = (max) => (v) => {
  const s = String(v ?? "").trim().toLowerCase();
  return !s || s.length > max ? INVALID : s;
};

const finiteNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : INVALID;
};

const oneOf = (allowed) => (v) => (allowed.includes(v) ? v : INVALID);

const boolInt = (v) => (v ? 1 : 0);

/**
 * One row per field: the client key, the column, how to parse it, and what happens when
 * it is absent on a CREATE. `required: true` means "absent on create is an error";
 * otherwise `dflt` is written.
 */
export const RULE_FIELDS = [
  {
    in: "deviceId", out: "device_id", parse: nullableInt, dflt: null,
    msg: "deviceId must be an integer or null (null = global default).",
  },
  {
    // Only meaningful alongside a device — a global rule cannot name a port, because
    // ports exist only in the context of one router. Enforced in checkCrossField below.
    in: "interfaceName", out: "interface_name", parse: nullableStr(50), dflt: null,
    msg: "interfaceName must be 50 characters or fewer.",
  },
  {
    in: "metricName", out: "metric_name", parse: requiredSlug(50), required: true,
    msg: "metricName is required (max 50 chars).",
    missingMsg: "metricName is required.",
  },
  {
    in: "thresholdValue", out: "threshold_value", parse: finiteNum, required: true,
    msg: "thresholdValue must be a number.",
    missingMsg: "thresholdValue is required.",
  },
  {
    in: "comparison", out: "comparison", parse: oneOf(COMPARISONS), required: true,
    msg: `comparison must be one of: ${COMPARISONS.join(" ")}`,
    missingMsg: "comparison is required.",
  },
  {
    in: "severity", out: "severity", parse: oneOf(SEVERITIES), required: true,
    msg: `severity must be one of: ${SEVERITIES.join(", ")}`,
    missingMsg: "severity is required.",
  },
  { in: "isActive", out: "is_active", parse: boolInt, dflt: 1 },
];

/**
 * A port-scoped rule needs the device that owns the port.
 *
 * Checked against the MERGED view — what the row will look like after the patch — so a
 * PATCH that sets only one of the two still validates. This is the one genuinely
 * conditional piece and is deliberately kept out of the table.
 */
export function checkCrossField(out, existing = null) {
  const finalDevice = out.device_id !== undefined ? out.device_id : existing?.device_id ?? null;
  const finalIface = out.interface_name !== undefined ? out.interface_name : existing?.interface_name ?? null;
  if (finalIface && finalDevice == null) {
    throw ruleError(400, "A port-scoped rule needs a device — pick the router the port belongs to.");
  }
  return out;
}

/**
 * Validate + normalize an incoming rule into its column shape.
 *
 * @param data      the client payload (camelCase)
 * @param partial   true for a PUT/PATCH — missing fields are left alone rather than defaulted
 * @param existing  the current row on a PATCH, so cross-field rules see the merged result
 */
export function cleanRule(data, { partial = false, existing = null } = {}) {
  const out = {};
  for (const f of RULE_FIELDS) {
    if (data[f.in] !== undefined) {
      const parsed = f.parse(data[f.in]);
      if (parsed === INVALID) throw ruleError(400, f.msg);
      out[f.out] = parsed;
    } else if (!partial) {
      if (f.required) throw ruleError(400, f.missingMsg ?? f.msg);
      out[f.out] = f.dflt;
    }
  }
  return checkCrossField(out, existing);
}

export default { cleanRule, checkCrossField, RULE_FIELDS, COMPARISONS, SEVERITIES, ruleError, INVALID };
