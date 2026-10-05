import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS,
  osFamily,
  isValidServiceName,
  listActions,
  roleMayRun,
  buildCommand,
  sudoWrap,
  powershell,
  isValidSshHost,
} from "../services/consoleCommands.js";

test("osFamily reads the agent's platform string", () => {
  assert.equal(osFamily("Ubuntu 22.04"), "linux");
  assert.equal(osFamily("linux"), "linux");
  assert.equal(osFamily("Microsoft Windows Server 2019 Standard"), "windows");
  assert.equal(osFamily("windows"), "windows");
  assert.equal(osFamily("unknown"), null);
  assert.equal(osFamily(""), null);
  assert.equal(osFamily(null), null);
});

test("every action has a command for BOTH operating systems", () => {
  for (const [id, a] of Object.entries(ACTIONS)) {
    const arg = a.param ? "nginx" : undefined;
    assert.equal(typeof a.linux(arg), "string", `${id} linux`);
    assert.equal(typeof a.windows(arg), "string", `${id} windows`);
    assert.ok(["info", "control"].includes(a.group), `${id} group`);
    if (a.group === "control") assert.ok(a.confirm, `${id} is a control action and must ask first`);
  }
});

test("service names: strict allow-list, no shell or PowerShell metacharacters", () => {
  for (const ok of ["nginx", "php8.1-fpm", "getty@tty1", "Spooler", "W3SVC", "mysql.service"]) {
    assert.ok(isValidServiceName(ok), ok);
  }
  for (const bad of [
    "", "-h", "--now", "a b", "x;reboot", "x&&y", "$(id)", "`id`", "a'b", 'a"b', "a|b",
    "MSSQL$SQLEXPRESS", "a\nb", "../etc", "x".repeat(129), null, 5,
  ]) {
    assert.ok(!isValidServiceName(bad), JSON.stringify(bad));
  }
});

test("buildCommand refuses a bad service name instead of escaping it", () => {
  const r = buildCommand("restart_service", "linux", { param: "nginx; rm -rf /", username: "admin" });
  assert.ok(r.error);
  assert.equal(r.command, undefined);
});

test("buildCommand: unknown action / unknown OS are errors, not throws", () => {
  assert.ok(buildCommand("format_disk", "linux").error);
  assert.ok(buildCommand("overview", null).error);
  assert.ok(buildCommand("overview", "macos").error);
});

test("Linux control actions go through sudo, except for root", () => {
  const asUser = buildCommand("restart_service", "linux", { param: "nginx", username: "ictu" });
  assert.equal(asUser.sudo, true);
  assert.match(asUser.command, /^sudo -S -p '' sh -c '/);
  assert.match(asUser.command, /systemctl restart nginx/);

  const asRoot = buildCommand("restart_service", "linux", { param: "nginx", username: "root" });
  assert.equal(asRoot.sudo, false);
  assert.doesNotMatch(asRoot.command, /sudo/);

  const info = buildCommand("disk", "linux", { username: "ictu" });
  assert.equal(info.sudo, false, "read-only actions never ask for sudo");
});

test("Windows never uses sudo and is sent as -EncodedCommand", () => {
  const r = buildCommand("restart_service", "windows", { param: "Spooler", username: "Administrator" });
  assert.equal(r.sudo, false);
  assert.match(r.command, /^powershell\.exe .* -EncodedCommand [A-Za-z0-9+/=]+$/);
  const b64 = r.command.split(" ").pop();
  const script = Buffer.from(b64, "base64").toString("utf16le");
  assert.match(script, /Restart-Service -Name 'Spooler'/);
});

test("sudoWrap survives single quotes in the command", () => {
  assert.equal(sudoWrap("echo 'hi'"), "sudo -S -p '' sh -c 'echo '\\''hi'\\'''");
});

test("every Windows command fits cmd.exe's 8191-character command line", () => {
  // OpenSSH on Windows runs exec requests through cmd.exe by default.
  for (const [id, a] of Object.entries(ACTIONS)) {
    const cmd = a.windows(a.param ? "x".repeat(128) : undefined);
    assert.ok(cmd.length < 8000, `${id}: ${cmd.length} chars`);
  }
  assert.ok(powershell("Get-Date").length < 8000);
});

test("roles: it_staff gets read-only actions only, admin gets all", () => {
  for (const [id, a] of Object.entries(ACTIONS)) {
    assert.equal(roleMayRun("admin", id), true, id);
    assert.equal(roleMayRun("it_staff", id), a.group === "info", id);
    assert.equal(roleMayRun("viewer", id), false, id);
  }
  assert.equal(roleMayRun("admin", "nope"), false);
});

test("listActions exposes no command text to the browser", () => {
  for (const a of listActions()) {
    assert.deepEqual(Object.keys(a).sort(), ["confirm", "description", "group", "id", "label", "param"]);
  }
});

test("SSH address override: IPs and hostnames only", () => {
  for (const ok of ["192.168.56.101", "10.0.2.15", "0.0.0.0", "srv-core", "srv-core.cspc.edu.ph", "fe80::1", "::1", " 192.168.1.5 "]) {
    assert.ok(isValidSshHost(ok), ok);
  }
  for (const bad of [
    "", " ", "999.1.1.1", "192.168.1", "1.2.3.4.5", "-host", "host-", "a b", "host;id", "$(id)",
    "user@host", "host:22", "http://host", "a..b", "1::2::3", "x".repeat(254), null, 42,
  ]) {
    assert.ok(!isValidSshHost(bad), JSON.stringify(bad));
  }
});
