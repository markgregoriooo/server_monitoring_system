// ─── Making untrusted text safe to log ────────────────────────────────────────
// A newline in a value like the User-Agent lets the sender forge extra log lines
// (CWE-117), and ANSI escapes can rewrite what a terminal shows. All C0/C1 control
// characters are escaped (not stripped, so odd input is still visible). Cutting the
// length alone does not help. Uses a code-point test instead of a regex so no raw
// control characters end up in this file.

/** True for C0 (0x00-0x1F), DEL (0x7F) and C1 (0x80-0x9F). */
function isControl(code) {
  return code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

/**
 * Render an untrusted value as a single-line, length-capped string for a log message.
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
