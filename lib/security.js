/**
 * RouterFarm v2 — Authentication, session management, and security utilities.
 */

const crypto = require("crypto");

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_COOKIE_NAME = "routerfarm_session";

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

function createSessionCookie(token, ttlMs = SESSION_TTL_MS) {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(ttlMs / 1000)}`;
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

module.exports = {
  SESSION_TTL_MS,
  SESSION_COOKIE_NAME,
  verifyPassword,
  hashPassword,
  createSessionCookie,
  expireSessionCookie,
  parseCookies,
  generateToken,
  sanitizeUser,
  userCanAccessDevice
};
