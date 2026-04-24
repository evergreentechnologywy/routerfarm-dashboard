/**
 * RouterFarm v2 — Authentication, session management, and security utilities.
 */

const crypto = require("crypto");

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_COOKIE_NAME = "routerfarm_session";
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

const loginAttempts = new Map();

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = parts[3];
  if (!iterations || !salt || !expected) return false;
  const actual = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function hashPassword(password, iterations = 210000) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
  return `pbkdf2$${iterations}$${salt}$${hash}`;
}

function createSessionCookie(token, ttlMs = SESSION_TTL_MS, secure = false) {
  const secureFlag = secure ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict${secureFlag}; Max-Age=${Math.floor(ttlMs / 1000)}`;
}

function expireSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index);
    const value = trimmed.slice(index + 1);
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function sanitizeUser(user) {
  return {
    username: user.username,
    displayName: user.displayName || user.username,
    role: user.role || "operator",
    allowedDevices: user.allowedDevices || []
  };
}

function userCanAccessDevice(user, serial) {
  if (!user) return false;
  const allowed = user.allowedDevices || [];
  return allowed.includes("*") || allowed.includes(serial);
}

function checkRateLimit(key) {
  const now = Date.now();
  const record = loginAttempts.get(key);
  if (!record) {
    loginAttempts.set(key, { count: 1, firstAttempt: now, lockedUntil: 0 });
    return { allowed: true, remaining: MAX_LOGIN_ATTEMPTS - 1 };
  }
  if (record.lockedUntil && now < record.lockedUntil) {
    const waitSeconds = Math.ceil((record.lockedUntil - now) / 1000);
    return { allowed: false, locked: true, waitSeconds };
  }
  if (now - record.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAttempt: now, lockedUntil: 0 });
    return { allowed: true, remaining: MAX_LOGIN_ATTEMPTS - 1 };
  }
  record.count += 1;
  if (record.count >= MAX_LOGIN_ATTEMPTS) {
    record.lockedUntil = now + LOGIN_LOCKOUT_MS;
    return { allowed: false, locked: true, waitSeconds: Math.ceil(LOGIN_LOCKOUT_MS / 1000) };
  }
  return { allowed: true, remaining: MAX_LOGIN_ATTEMPTS - record.count };
}

function cleanupRateLimits() {
  const now = Date.now();
  for (const [key, record] of loginAttempts.entries()) {
    if (record.lockedUntil && now > record.lockedUntil + LOGIN_WINDOW_MS) {
      loginAttempts.delete(key);
    } else if (!record.lockedUntil && now - record.firstAttempt > LOGIN_WINDOW_MS) {
      loginAttempts.delete(key);
    }
  }
}

function isWeakDefaultHash(storedHash) {
  return storedHash === "pbkdf2$210000$d5d2d23da02115eb83c4ee3f060ee253$efcd13bca1e29d682e132ab345da8ecd9f38f6b5a9c211fee4e50a3dfa6609f3";
}

module.exports = {
  SESSION_TTL_MS,
  SESSION_COOKIE_NAME,
  MAX_LOGIN_ATTEMPTS,
  LOGIN_WINDOW_MS,
  LOGIN_LOCKOUT_MS,
  verifyPassword,
  hashPassword,
  createSessionCookie,
  expireSessionCookie,
  parseCookies,
  generateToken,
  sanitizeUser,
  userCanAccessDevice,
  checkRateLimit,
  cleanupRateLimits,
  isWeakDefaultHash
};
