/**
 * RouterFarm v2 — Input validation and sanitization utilities.
 */

const VALID_SERIAL_PATTERN = /^[A-Za-z0-9._-]+$/;
const VALID_ROUTER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const VALID_USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const VALID_NICKNAME_PATTERN = /^[\p{L}\p{N}\s._-]{1,64}$/u;

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

function isValidNickname(nickname) {
  return typeof nickname === "string" && nickname.length <= 64 && VALID_NICKNAME_PATTERN.test(nickname);
}

function sanitizeNickname(nickname) {
  const normalized = String(nickname || "").trim();
  if (normalized && !isValidNickname(normalized)) {
    throw new Error("Invalid nickname");
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

function isValidEmailLocalPart(local) {
  return typeof local === "string" && local.length <= 64 && /^[a-zA-Z0-9._-]+$/.test(local);
}

function sanitizeMetadataPatch(patch = {}) {
  const result = {};
  if (Object.prototype.hasOwnProperty.call(patch, "nickname")) {
    result.nickname = sanitizeNickname(patch.nickname);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "phoneNumber")) {
    result.phoneNumber = parsePositiveIntegerOrNull(patch.phoneNumber);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "role")) {
    const role = String(patch.role || "").trim().toLowerCase();
    result.role = role || "sim-direct";
  }
  if (Object.prototype.hasOwnProperty.call(patch, "parentHotspotSerial")) {
    const serial = String(patch.parentHotspotSerial || "").trim();
    result.parentHotspotSerial = serial.length <= 128 && VALID_SERIAL_PATTERN.test(serial) ? serial : "";
  }
  if (Object.prototype.hasOwnProperty.call(patch, "routerId")) {
    const rid = String(patch.routerId || "").trim();
    result.routerId = rid.length <= 128 && VALID_ROUTER_ID_PATTERN.test(rid) ? rid : "";
  }
  if (Object.prototype.hasOwnProperty.call(patch, "routerSlot")) {
    result.routerSlot = parsePositiveIntegerOrNull(patch.routerSlot);
  }
  return result;
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
  isValidNickname,
  sanitizeNickname,
  isValidPathSegment,
  sanitizePathSegment,
  parsePositiveIntegerOrNull,
  clampInteger,
  isValidEmailLocalPart,
  sanitizeMetadataPatch
};
