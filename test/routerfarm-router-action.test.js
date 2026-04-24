const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const actionScriptPath = path.join(__dirname, "..", "scripts", "invoke-routerfarm-router-action.ps1");
const actionScript = fs.readFileSync(actionScriptPath, "utf8");

test("usb-tether-reset uses a soft reconnect path on SFT1200 instead of driver unbind", () => {
  assert.match(actionScript, /"usb-tether-reset"\s*=\s*@'/);
  assert.match(actionScript, /cat \/proc\/gl-hw-info\/model/);
  const sft1200BlockMatch = actionScript.match(/if \[ "\$model" = "sft1200" \]; then([\s\S]*?)elif \[ -n "\$iface" \]/);
  assert.ok(sft1200BlockMatch, "expected an explicit SFT1200 branch before the driver unbind path");
  const sft1200Block = sft1200BlockMatch[1];
  assert.doesNotMatch(sft1200Block, /unbind|bind/);
  assert.match(sft1200Block, /ifdown tethering/);
  assert.match(sft1200Block, /ifup tethering/);
});
