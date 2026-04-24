/**
 * RouterFarm v2 — Input validation and sanitization utilities.
 */

const VALID_SERIAL_PATTERN = /^[A-Za-z0-9._-]+$/;
const VALID_ROUTER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const VALID_USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;

function isValidSerial(serial) {
  return typeof serial === "string" && VALID_SERIAL_PATTERN.test(serial) && serial.length <= 128;
}

function sanitizeSerial(serial) {
  const normalized = String(serial || "").trim();
  if (!isValidSerial(normalized)) {
    throw new Error(`Invalid serial: ${normalized.slice(0, 32)}`);
  }
  return normalized;
}

function isValidRouterId(routerId) {
  return typeof routerId === "string" && VALID_ROUTER_ID_PATTERN.test(routerId) && routerId.length <= 128;
}

function sanitizeRouterId(routerId) {
  const normalized = String(routerId || "").trim();
  if (!isValidRouterId(normalized)) {
    throw new Error(`Invalid routerId: ${normalized.slice(0, 32)}`);
  }
  return normalized;
}

function isValidAction(action) {
  const allowed = new Set([
    "metadata",
    "viewer-state",
    "open-control",
    "check-ip",
    "recover-radios",
    "engage-airplane",
    "start-session",
    "stop-session",
    "connect-router",
    "reset-uplink-ip",
    "prep",
    "router-health",
    "wan-reconnect",
    "restart-wifi",
    "cycle-uplink",
    "reboot-router"
  ]);
  return typeof action === "string" && allowed.has(action);
}

function sanitizeAction(action) {
  const normalized = String(action || "").trim();
  if (!isValidAction(normalized)) {
    throw new Error(`Unsupported action: ${normalized.slice(0, 32)}`);
  }
  return normalized;
}

function isValidUsername(username) {
  return typeof username === "string" && VALID_USERNAME_PATTERN.test(username) && username.length >= 1 && username.length <= 64;
}

function sanitizeUsername(username) {
  const normalized = String(username || "").trim().toLowerCase();
  if (!isValidUsername(normalized)) {
    throw new Error("Invalid username");
  }
  return normalized;
}

function isValidPathSegment(segment) {
  return typeof segment === "string" && !segment.includes("..") && !segment.includes(":") && !segment.startsWith("/") && !segment.startsWith("\\");
}

function sanitizePathSegment(segment) {
  const normalized = String(segment || "").trim();
  if (!isValidPathSegment(normalized)) {
    throw new Error(`Invalid path segment: ${normalized.slice(0, 32)}`);
  }
  return normalized;
}

function parsePositiveIntegerOrNull(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function clampInteger(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

module.exports = {
  isValidSerial,
  sanitizeSerial,
  isValidRouterId,
  sanitizeRouterId,
  isValidAction,
  sanitizeAction,
  isValidUsername,
  sanitizeUsername,
  isValidPathSegment,
  sanitizePathSegment,
  parsePositiveIntegerOrNull,
  clampInteger
};
