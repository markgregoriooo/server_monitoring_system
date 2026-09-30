// ─── Alert-rule validation ─────────────────────────────────────────────────────
// Moved out of alertRulesService.clean(), where the same present/validate/default
// steps were written out once per field. Now it is a table of fields. No imports,
// so backend/tests can run it without MySQL. It is the only validation of alert
// thresholds, so it is tested closely.
// See audits/code-complexity-report-2026-08-25.md (C-01).

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
 * One row per field: the client key, the column, how to parse it, and what to do
 * when it is missing on create. `required: true` means missing is an error;
 * otherwise `dflt` is used.
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
 * A port-scoped rule needs the device that owns the port. Checked on the merged
 * row so a PATCH that sets only one of the two still validates.
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
 * Validate and normalise an incoming rule into its column shape.
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

// ─── Severity order within one scope ───────────────────────────────────────
// Rules in one scope must be ordered info < warning < critical with different
// thresholds. At equal thresholds the milder rule can never fire (the worst band
// wins), and inverted thresholds would also make the ESP32's LED disagree with the
// dashboard. The direction comes from `comparison`: for ups_runtime/ups_charge
// (`<=`) a lower number is worse, so warning 20 / critical 10 is correct.

/** Comparisons where a bigger reading is worse. The rest are lower-is-worse. */
export const HIGHER_IS_WORSE = new Set([">", ">="]);

/** info < warning < critical. Shared with the ordering check below. */
export const SEVERITY_RANK = { info: 1, warning: 2, critical: 3 };

const dirOf = (comparison) => (HIGHER_IS_WORSE.has(comparison) ? "up" : "down");

/**
 * Check one rule against the other rules in its scope.
 *
 * Scope = the exact (device_id, interface_name, metric_name), as in
 * getEffectiveRules. A device's rules replace the global ones, so the two are not
 * compared with each other.
 *
 * @param candidate {{severity, threshold_value, comparison}} the rule as it will be stored
 * @param siblings  other rules in the same scope, SELF EXCLUDED by the caller
 * @returns {string|null} null when the order is fine, otherwise the reason
 */
export function severityOrderError(candidate, siblings = []) {
  const rank = SEVERITY_RANK[candidate.severity];
  if (!rank) return null; // severity already rejected by the field parser
  const value = Number(candidate.threshold_value);
  if (!Number.isFinite(value)) return null; // ditto for the threshold
  const dir = dirOf(candidate.comparison);

  for (const other of siblings) {
    const otherRank = SEVERITY_RANK[other.severity];
    if (!otherRank) continue;
    const otherValue = Number(other.threshold_value);
    if (!Number.isFinite(otherValue)) continue;

    // Rules in one scope that disagree on the direction cannot be ordered.
    if (dirOf(other.comparison) !== dir) {
      return (
        `The ${other.severity} rule for this metric uses "${other.comparison}" while this one uses ` +
        `"${candidate.comparison}". Rules for the same metric must agree on whether a higher or a ` +
        `lower reading is worse.`
      );
    }

    if (otherRank === rank) continue; // same severity — a duplicate, not an ordering fault

    if (otherValue === value) {
      return (
        `${candidate.severity} and ${other.severity} would both be ${value} for this metric. ` +
        `Give them different values — at the same number the ${
          rank > otherRank ? other.severity : candidate.severity
        } rule can never fire, because a reading that crosses one crosses both and the more ` +
        `severe one always wins.`
      );
    }

    // The more severe rule must sit further along the worsening direction.
    const severeIsCandidate = rank > otherRank;
    const severeValue = severeIsCandidate ? value : otherValue;
    const milderValue = severeIsCandidate ? otherValue : value;
    const ordered = dir === "up" ? severeValue > milderValue : severeValue < milderValue;
    if (!ordered) {
      const severeName = severeIsCandidate ? candidate.severity : other.severity;
      const milderName = severeIsCandidate ? other.severity : candidate.severity;
      return dir === "up"
        ? `${severeName} (${severeValue}) must be HIGHER than ${milderName} (${milderValue}) for this ` +
          `metric — with "${candidate.comparison}", a bigger reading is worse.`
        : `${severeName} (${severeValue}) must be LOWER than ${milderName} (${milderValue}) for this ` +
          `metric — with "${candidate.comparison}", a smaller reading is worse.`;
    }
  }
  return null;
}

/**
 * Reject a second rule with the same severity in the same scope.
 *
 * Two `temperature warning` rules are not combined: getRoomThresholds takes the
 * first one it finds, so which value reaches the ESP32 would depend on row order.
 *
 * @param candidate {{severity}} the rule as it will be stored
 * @param siblings  other rules in the same scope, SELF EXCLUDED by the caller
 * @returns {string|null}
 */
export function duplicateSeverityError(candidate, siblings = []) {
  if (!SEVERITY_RANK[candidate.severity]) return null; // already rejected by the field parser
  const clash = siblings.find((o) => o.severity === candidate.severity);
  if (!clash) return null;
  return (
    `A ${candidate.severity} rule already exists for this metric at this scope ` +
    `(threshold ${clash.threshold_value}). Edit that rule instead of adding a second one — ` +
    `two rules at the same severity do not both apply, one of them is simply ignored.`
  );
}

/** Both scope-level checks, in the order an admin can act on them. */
export function scopeConflictError(candidate, siblings = []) {
  return duplicateSeverityError(candidate, siblings) ?? severityOrderError(candidate, siblings);
}

export default { cleanRule, checkCrossField, RULE_FIELDS, COMPARISONS, SEVERITIES, ruleError, INVALID, severityOrderError, duplicateSeverityError, scopeConflictError, SEVERITY_RANK, HIGHER_IS_WORSE };
