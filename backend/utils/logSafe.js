// ─── Making attacker-controlled text safe to LOG — PURE, import-free ──────────
//
// A log line is a record of what happened. The moment a value the caller chose can
// contain a newline, the attacker chooses what the record SAYS:
//
//     User-Agent: Mozilla/5.0<LF>[AUTH] rejected POST /api/admin — user=1 role=admin
//
//   [AUTH] rejected GET /x — from=1.2.3.4 ua="Mozilla/5.0
//   [AUTH] rejected POST /api/admin — user=1 role=admin"      ← forged, reads as genuine
//
// That is CWE-117. It grants no access — it corrupts the thing you would use to work out
// what happened afterwards, which on a system whose own audit trail is compliance
// evidence (RA 10173) is the wrong thing to leave writable.
//
// Slicing to a length does NOT fix it: the newline is usually in the first few bytes.
//
// Control characters other than CR/LF matter too. A terminal reading these logs
// interprets ANSI escapes, so ESC-[2J clears the screen and ESC-[1A moves the cursor up
// to overwrite the line above — the same forgery with extra steps. Everything in the
// C0 and C1 ranges is therefore escaped, not just the newline.
//
// Escaped rather than stripped, deliberately: seeing `ua="Mozilla\n5.0"` tells you the
// client sent something strange, which is itself worth knowing. Deleting it hides that.
//
// Written as an explicit code-point test rather than a regex character class, because a
// class of control characters has to be spelled with escape sequences that are easy to
// mangle into the literal bytes they denote — which would put invisible control
// characters in this file, in the module whose entire job is removing them.

/** True for C0 (0x00-0x1F), DEL (0x7F) and C1 (0x80-0x9F). */
function isControl(code) {
  return code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

/**
 * Render an untrusted value as a single-line, length-capped fragment that is safe to
 * interpolate into a log message.
 *
 * @param {unknown} value the untrusted value
 * @param {number} [max]  characters to keep before truncating (default 120)
 * @returns {string}
 */
export function logSafe(value, max = 120) {
  const s = value === null || value === undefined ? "" : String(value);

  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (!isControl(code)) {
      out += ch;
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
    }
    // Cap inside the loop so a string of escapes cannot blow past `max` by 4x.
    if (out.length >= max) return `${out.slice(0, max)}…`;
  }
  return out;
}

export default { logSafe };
