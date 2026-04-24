const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildRouterOccupancyLock,
  mergePublicIpLocation,
  isUsablePublicIp
} = require("../lib/routerfarm-routing");

test("buildRouterOccupancyLock blocks when another device is already active on the same router", () => {
  const devices = [
    {
      serial: "A",
      nickname: "Amber Grace",
      routerId: "opal-05",
      sessionState: "running",
      network: { interface: "wlan0" }
    },
    {
      serial: "B",
      nickname: "Nicole Valentina",
      routerId: "opal-05",
      sessionState: "stopped",
      network: { interface: "" }
    }
  ];

  const result = buildRouterOccupancyLock(devices, devices[1]);

  assert.equal(result.allowed, false);
  assert.match(result.reason, /Amber Grace/);
  assert.match(result.reason, /opal-05/i);
});

test("buildRouterOccupancyLock allows the device when no sibling is active on its router", () => {
  const devices = [
    {
      serial: "A",
      nickname: "Amber Grace",
      routerId: "opal-05",
      sessionState: "stopped",
      network: { interface: "" }
    },
    {
      serial: "B",
      nickname: "Nicole Valentina",
      routerId: "opal-05",
      sessionState: "stopped",
      network: { interface: "" }
    }
  ];

  const result = buildRouterOccupancyLock(devices, devices[1]);

  assert.deepEqual(result, { allowed: true, reason: "" });
});

test("mergePublicIpLocation attaches city and timezone metadata without dropping the current IP state", () => {
  const publicIp = {
    currentIp: "172.59.72.86",
    status: "verified",
    source: "routerfarm-ip-helper:ipify-json",
    lastCheckedAt: "2026-04-18T22:00:00.000Z"
  };

  const result = mergePublicIpLocation(publicIp, {
    city: "Chicago",
    region: "Illinois",
    country: "United States",
    timezone: "America/Chicago",
    source: "ipwho.is",
    checkedAt: "2026-04-18T22:00:01.000Z"
  });

  assert.equal(result.currentIp, "172.59.72.86");
  assert.equal(result.status, "verified");
  assert.deepEqual(result.location, {
    city: "Chicago",
    region: "Illinois",
    country: "United States",
    timezone: "America/Chicago",
    source: "ipwho.is",
    checkedAt: "2026-04-18T22:00:01.000Z"
  });
});

test("isUsablePublicIp rejects empty values and obvious transport errors", () => {
  assert.equal(isUsablePublicIp(""), false);
  assert.equal(isUsablePublicIp("curl: (6) Couldn't resolve host 'api.ipify.org'"), false);
  assert.equal(isUsablePublicIp("banner exchange: Connection refused"), false);
  assert.equal(isUsablePublicIp("172.59.72.86"), true);
  assert.equal(isUsablePublicIp("2600:100a:b03e:8003::1"), true);
});
