const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sanitizeSerial,
  sanitizeRouterId,
  sanitizeAction,
  sanitizeUsername,
  isValidPathSegment,
  parsePositiveIntegerOrNull,
  clampInteger,
  sanitizeNickname,
  sanitizeMetadataPatch
} = require("../lib/validation");

test("sanitizeSerial accepts valid serial", () => {
  assert.equal(sanitizeSerial("ABC123"), "ABC123");
  assert.equal(sanitizeSerial("23AAC652"), "23AAC652");
});

test("sanitizeSerial rejects invalid serial", () => {
  assert.throws(() => sanitizeSerial("../etc/passwd"), /Invalid serial/);
  assert.throws(() => sanitizeSerial(""), /Invalid serial/);
  assert.throws(() => sanitizeSerial("a".repeat(200)), /Invalid serial/);
});

test("sanitizeRouterId accepts valid id", () => {
  assert.equal(sanitizeRouterId("opal-09"), "opal-09");
});

test("sanitizeRouterId rejects invalid id", () => {
  assert.throws(() => sanitizeRouterId("../../etc"), /Invalid routerId/);
});

test("sanitizeAction accepts known actions", () => {
  assert.equal(sanitizeAction("start-session"), "start-session");
  assert.equal(sanitizeAction("check-ip"), "check-ip");
});

test("sanitizeAction rejects unknown actions", () => {
  assert.throws(() => sanitizeAction("rm -rf /"), /Unsupported action/);
});

test("sanitizeUsername normalizes and validates", () => {
  assert.equal(sanitizeUsername("Admin"), "admin");
  assert.equal(sanitizeUsername("user_1"), "user_1");
});

test("sanitizeUsername rejects invalid usernames", () => {
  assert.throws(() => sanitizeUsername(""), /Invalid username/);
  assert.throws(() => sanitizeUsername("admin@evil.com"), /Invalid username/);
});

test("isValidPathSegment blocks traversal", () => {
  assert.equal(isValidPathSegment("foo"), true);
  assert.equal(isValidPathSegment("../foo"), false);
  assert.equal(isValidPathSegment("C:\\foo"), false);
  assert.equal(isValidPathSegment("/etc/passwd"), false);
});

test("parsePositiveIntegerOrNull parses valid numbers", () => {
  assert.equal(parsePositiveIntegerOrNull("5"), 5);
  assert.equal(parsePositiveIntegerOrNull(10), 10);
});

test("parsePositiveIntegerOrNull rejects invalid values", () => {
  assert.equal(parsePositiveIntegerOrNull("abc"), null);
  assert.equal(parsePositiveIntegerOrNull("-1"), null);
  assert.equal(parsePositiveIntegerOrNull("0"), null);
  assert.equal(parsePositiveIntegerOrNull(""), null);
});

test("clampInteger clamps values", () => {
  assert.equal(clampInteger(5, 0, 10), 5);
  assert.equal(clampInteger(-5, 0, 10), 0);
  assert.equal(clampInteger(15, 0, 10), 10);
});

test("sanitizeNickname accepts valid names", () => {
  assert.equal(sanitizeNickname("Katy Milano"), "Katy Milano");
});

test("sanitizeNickname rejects invalid names", () => {
  assert.throws(() => sanitizeNickname("a".repeat(100)), /Invalid nickname/);
});

test("sanitizeMetadataPatch sanitizes fields", () => {
  const patch = {
    nickname: "Test Device",
    phoneNumber: "42",
    role: "router-linkpro",
    routerId: "opal-01",
    routerSlot: "2"
  };
  const result = sanitizeMetadataPatch(patch);
  assert.equal(result.nickname, "Test Device");
  assert.equal(result.phoneNumber, 42);
  assert.equal(result.role, "router-linkpro");
  assert.equal(result.routerId, "opal-01");
  assert.equal(result.routerSlot, 2);
});
