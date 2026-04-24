"use strict";

function formatDeviceLabel(device) {
  if (!device) {
    return "";
  }
  if (device.nickname) {
    return String(device.nickname);
  }
  if (device.phoneNumber) {
    return `Phone ${String(device.phoneNumber).padStart(2, "0")}`;
  }
  return String(device.serial || "");
}

function deviceLooksOnRouterWifi(device) {
  const interfaceName = String(device?.network?.interface || "").toLowerCase();
  return interfaceName.startsWith("wlan") || interfaceName.includes("wifi");
}

function buildRouterOccupancyLock(devices, currentDevice) {
  if (!currentDevice?.routerId) {
    return { allowed: true, reason: "" };
  }

  const sibling = (devices || []).find(device => {
    if (!device || device.serial === currentDevice.serial) {
      return false;
    }
    if (String(device.routerId || "") !== String(currentDevice.routerId || "")) {
      return false;
    }
    return device.sessionState === "running" || deviceLooksOnRouterWifi(device);
  });

  if (!sibling) {
    return { allowed: true, reason: "" };
  }

  return {
    allowed: false,
    reason: `${formatDeviceLabel(sibling)} is already active on ${currentDevice.routerId}. Disconnect it before moving another phone onto that router.`
  };
}

function normalizeLocation(location) {
  if (!location) {
    return null;
  }

  const city = String(location.city || "").trim();
  const region = String(location.region || "").trim();
  const country = String(location.country || "").trim();
  const timezone = String(location.timezone || "").trim();
  const source = String(location.source || "").trim();
  const checkedAt = String(location.checkedAt || "").trim();

  if (!city && !region && !country && !timezone && !source && !checkedAt) {
    return null;
  }

  return {
    city,
    region,
    country,
    timezone,
    source,
    checkedAt
  };
}

function mergePublicIpLocation(publicIp, location) {
  return {
    ...(publicIp || {}),
    location: normalizeLocation(location)
  };
}

function isUsablePublicIp(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return false;
  }
  if (/curl:|couldn't resolve host|connection refused|banner exchange|no-http-client|timed out|failed/i.test(normalized)) {
    return false;
  }
  if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(normalized)) {
    return true;
  }
  if (/\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9]{1,4}\b/i.test(normalized)) {
    return true;
  }
  return false;
}

module.exports = {
  buildRouterOccupancyLock,
  deviceLooksOnRouterWifi,
  formatDeviceLabel,
  isUsablePublicIp,
  mergePublicIpLocation
};
