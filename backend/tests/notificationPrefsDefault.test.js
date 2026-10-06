import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─── Alert email is opt-in ───────────────────────
// It used to default to on (`COALESCE(p.email_enabled, 1)`), so a newly approved
// account got critical alert email before its owner had signed in or seen the
// Privacy Notice. Tested because the failure is silent. Reads the source as text,
// since notificationService needs MySQL and .env (like agentTokenHash.test.js and
// contract.test.js).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

/** Drop `--` comment lines so the schema's own prose cannot satisfy a check. */
const sqlCode = (s) =>
  s.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");

/** Drop `//` comment lines, for the same reason. */
const jsCode = (s) =>
  s.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

const schema = sqlCode(read("..", "v13_cspc-ictu-monitoring-system.sql"));
const notificationService = jsCode(read("services", "notificationService.js"));
const userService = jsCode(read("services", "userService.js"));
const prefsComponent = jsCode(
  read("..", "frontend", "src", "components", "notifications", "NotificationPreferences.tsx"),
);

test("PREF_DEFAULTS makes alert email opt-in", () => {
  const m = notificationService.match(/PREF_DEFAULTS\s*=\s*\{([^}]*)\}/);
  assert.ok(m, "PREF_DEFAULTS is gone — every default below has lost its single source");
  assert.match(
    m[1],
    /emailEnabled:\s*false/,
    "emailEnabled must default to false: email is the only channel that reaches somebody " +
      "who has never signed in, so it is the only one that needs consent first",
  );
});

test("the recipient query binds that default instead of hard-coding one", () => {
  assert.match(
    notificationService,
    /COALESCE\(p\.email_enabled,\s*\?\)/,
    "the email fallback must be a bound parameter, not a literal — a literal is a second " +
      "definition of the default, hidden in a query string where PREF_DEFAULTS cannot reach it",
  );
  assert.doesNotMatch(
    notificationService,
    /COALESCE\(p\.email_enabled,\s*1\)/,
    "this is the original bug verbatim: a missing prefs row means email ON, and every " +
      "newly approved account has a missing prefs row",
  );
});

test("getPrefs reads its fallbacks from PREF_DEFAULTS", () => {
  assert.match(
    notificationService,
    /emailEnabled:\s*row\s*\?\s*Boolean\(row\.email_enabled\)\s*:\s*PREF_DEFAULTS\.emailEnabled/,
    "getPrefs must fall back to PREF_DEFAULTS — it is what the Settings page renders, so a " +
      "literal here shows a toggle that disagrees with what the fan-out will actually do",
  );
});

test("registration seeds the row, so the fallback is never what decides", () => {
  assert.match(
    userService,
    /INSERT INTO notification_prefs[\s\S]{0,400}PREF_DEFAULTS\.emailEnabled/,
    "registerGoogleUser must seed notification_prefs from PREF_DEFAULTS: an explicit row " +
      "records the decision, so a later change to the fallback cannot re-subscribe people",
  );
});

test("the schema's column default is 0", () => {
  const table = schema.match(/CREATE TABLE `notification_prefs` \(([\s\S]*?)\) ENGINE=/)?.[1];
  assert.ok(table, "CREATE TABLE `notification_prefs` not found in v13");
  assert.match(
    table,
    /`email_enabled`\s+tinyint\(4\)\s+NOT NULL\s+DEFAULT\s+0/i,
    "the column default must be 0, so a row inserted by hand is silent too",
  );
});

test("the Settings toggle does not render 'on' before it knows", () => {
  assert.doesNotMatch(
    prefsComponent,
    /emailEnabled:\s*prefs\s*\?\s*Boolean\(prefs\.emailEnabled\)\s*:\s*true/,
    "a failed fetch must not show the toggle on: the user would read it as subscribed, " +
      "and switching it 'off' saves the value it already had",
  );
  assert.doesNotMatch(
    prefsComponent,
    /useState\(true\);\s*\/\/?.*emailEnabled|\[emailEnabled,\s*setEmailEnabled\]\s*=\s*useState\(true\)/,
    "the pre-fetch default must be false, to match PREF_DEFAULTS",
  );
});
