const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

test("devices table/card toggle synchronizes tab state before rendering", () => {
  const appJs = read("web/app.js");
  assert.match(
    appJs,
    /function setViewMode\(mode\)[\s\S]*appShell\.classList\.toggle\("table-mode", mode === "table"\);\s*syncTabState\(\);\s*renderDeviceViews\(\);/
  );
});

test("dashboard layout no longer nests a secondary main landmark", () => {
  const indexHtml = read("web/index.html");
  assert.doesNotMatch(indexHtml, /<main class="dashboard-layout">/);
  assert.match(indexHtml, /<section class="dashboard-layout">/);
});

test("router mode script exits non-zero when requested mode is not applied", () => {
  const script = read("scripts/set-routerfarm-router-mode.ps1");
  assert.match(script, /\$modeApplied = \(\$reportedMode -eq \$Mode\)/);
  assert.match(script, /exit \$\(if \(\$modeApplied\) \{ 0 \} else \{ 1 \}\)/);
});

test("radio recovery waits for exact adb device state", () => {
  const script = read("scripts/recover-device-radios.ps1");
  assert.match(script, /\(\$result\.Output \| Out-String\)\.Trim\(\) -eq "device"/);
});

test("PowerShell JSON writers use UTF-8 without BOM", () => {
  const files = [
    ["scripts/manage-routerfarm-user.ps1", /\$usersPath -Encoding utf8NoBOM/],
    ["scripts/audit-routerfarm-routing.ps1", /\$outputPath -Encoding utf8NoBOM/],
    ["scripts/enable-tailscale-access.ps1", /\$settingsPath -Encoding utf8NoBOM/],
    ["scripts/disable-tailscale-access.ps1", /\$settingsPath -Encoding utf8NoBOM/]
  ];

  for (const [relPath, pattern] of files) {
    assert.match(read(relPath), pattern, `${relPath} should write UTF-8 without BOM`);
  }
});
