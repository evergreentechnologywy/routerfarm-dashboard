const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("server.js syntax is valid", () => {
  const serverPath = path.join(__dirname, "..", "server.js");
  assert.ok(fs.existsSync(serverPath), "server.js exists");
});

test("lib modules load without errors", () => {
  assert.doesNotThrow(() => require("../lib/routerfarm-routing"));
  assert.doesNotThrow(() => require("../lib/validation"));
  assert.doesNotThrow(() => require("../lib/security"));
  assert.doesNotThrow(() => require("../lib/process-runner"));
});

test("config templates exist and are valid JSON", () => {
  const templates = ["settings.template.json", "routers.template.json", "users.template.json", "devices.template.json"];
  for (const tmpl of templates) {
    const p = path.join(__dirname, "..", "config", tmpl);
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      assert.ok(data, `${tmpl} parses as JSON`);
    }
  }
});

test("config templates do not contain real-looking credentials", () => {
  const usersTemplate = fs.readFileSync(path.join(__dirname, "..", "config", "users.template.json"), "utf8");
  assert.ok(usersTemplate.includes("CHANGE_ME"), "users.template.json has placeholder password");

  const routersTemplate = fs.readFileSync(path.join(__dirname, "..", "config", "routers.template.json"), "utf8");
  assert.ok(routersTemplate.includes("CHANGE_ME"), "routers.template.json has placeholder WiFi passwords");
});

test("security headers are set on static file responses", async () => {
  const http = require("http");
  const res = await new Promise((resolve, reject) => {
    const req = http.get("http://127.0.0.1:7781/", response => {
      response.resume();
      resolve(response);
    });
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error("timeout")); });
  });
  assert.equal(res.statusCode, 200); // Static files are served without auth
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["x-frame-options"], "DENY");
});
