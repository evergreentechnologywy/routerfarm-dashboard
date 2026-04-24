const test = require("node:test");
const assert = require("node:assert/strict");

const {
  verifyPassword,
  hashPassword,
  createSessionCookie,
  expireSessionCookie,
  parseCookies,
  generateToken,
  sanitizeUser,
  userCanAccessDevice,
  checkRateLimit,
  isWeakDefaultHash
} = require("../lib/security");

test("hashPassword generates valid PBKDF2 hash", () => {
  const password = "testpassword123";
  const hash = hashPassword(password);
  assert.match(hash, /^pbkdf2\$210000\$/);
});

test("verifyPassword accepts correct password", () => {
  const password = "testpassword123";
  const hash = hashPassword(password);
  assert.equal(verifyPassword(password, hash), true);
});

test("verifyPassword rejects incorrect password", () => {
  const password = "testpassword123";
  const hash = hashPassword(password);
  assert.equal(verifyPassword("wrongpassword", hash), false);
});

test("verifyPassword returns false for malformed hash", () => {
  assert.equal(verifyPassword("password", "notahash"), false);
  assert.equal(verifyPassword("password", ""), false);
});

test("createSessionCookie contains expected attributes", () => {
  const cookie = createSessionCookie("abc123");
  assert.match(cookie, /routerfarm_session=abc123/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Max-Age=43200/);
});

test("createSessionCookie adds Secure flag when requested", () => {
  const cookie = createSessionCookie("abc123", 43200000, true);
  assert.match(cookie, /Secure/);
});

test("expireSessionCookie zeroes Max-Age", () => {
  const cookie = expireSessionCookie();
  assert.match(cookie, /Max-Age=0/);
});

test("parseCookies handles multiple cookies", () => {
  const cookies = parseCookies("a=1; b=2; c=hello%20world");
  assert.equal(cookies.a, "1");
  assert.equal(cookies.b, "2");
  assert.equal(cookies.c, "hello world");
});

test("parseCookies handles empty input", () => {
  assert.deepEqual(parseCookies(""), {});
  assert.deepEqual(parseCookies(undefined), {});
});

test("generateToken returns 64-char hex string", () => {
  const token = generateToken();
  assert.equal(token.length, 64);
  assert.match(token, /^[a-f0-9]+$/);
});

test("sanitizeUser strips passwordHash", () => {
  const user = {
    username: "admin",
    displayName: "Admin",
    role: "admin",
    allowedDevices: ["*"],
    passwordHash: "secret"
  };
  const sanitized = sanitizeUser(user);
  assert.equal(sanitized.username, "admin");
  assert.equal(sanitized.role, "admin");
  assert.equal(sanitized.passwordHash, undefined);
});

test("userCanAccessDevice allows wildcard", () => {
  const user = { allowedDevices: ["*"] };
  assert.equal(userCanAccessDevice(user, "ABC123"), true);
});

test("userCanAccessDevice denies unknown serial", () => {
  const user = { allowedDevices: ["ABC123"] };
  assert.equal(userCanAccessDevice(user, "XYZ789"), false);
});

test("userCanAccessDevice rejects null user", () => {
  assert.equal(userCanAccessDevice(null, "ABC123"), false);
});

test("checkRateLimit allows first attempts", () => {
  const result = checkRateLimit("test-ip");
  assert.equal(result.allowed, true);
  assert.equal(result.remaining >= 0, true);
});

test("checkRateLimit locks after max attempts", () => {
  const key = "lock-test";
  for (let i = 0; i < 10; i++) {
    checkRateLimit(key);
  }
  const result = checkRateLimit(key);
  assert.equal(result.allowed, false);
  assert.equal(result.locked, true);
  assert.ok(result.waitSeconds > 0);
});

test("isWeakDefaultHash detects known weak hash", () => {
  assert.equal(
    isWeakDefaultHash("pbkdf2$210000$d5d2d23da02115eb83c4ee3f060ee253$efcd13bca1e29d682e132ab345da8ecd9f38f6b5a9c211fee4e50a3dfa6609f3"),
    true
  );
  assert.equal(isWeakDefaultHash(hashPassword("something")), false);
});
