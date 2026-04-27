const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn, spawnSync } = require("child_process");
const { URL } = require("url");
const {
  buildRouterOccupancyLock,
  deviceLooksOnRouterWifi,
  isUsablePublicIp,
  mergePublicIpLocation,
  formatDeviceLabel
} = require("./lib/routerfarm-routing");
const {
  sanitizeSerial,
  sanitizeRouterId,
  sanitizeAction,
  sanitizeUsername,
  parsePositiveIntegerOrNull,
} = require("./lib/validation");
const {
  SESSION_TTL_MS,
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
} = require("./lib/security");
const {
  toWinPath,
  runProcess,
  parseJsonPayload
} = require("./lib/process-runner");
const { Watchdog, REPAIR_ACTIONS } = require("./lib/watchdog");

const ROOT = __dirname;
const CONFIG_DIR = path.join(ROOT, "config");
const LOG_DIR = path.join(ROOT, "logs");
const WEB_DIR = path.join(ROOT, "web");
const SCRIPTS_DIR = path.join(ROOT, "scripts");
const SETTINGS_PATH = path.join(CONFIG_DIR, "settings.json");
const STATE_PATH = path.join(CONFIG_DIR, "state.json");
const USERS_PATH = path.join(CONFIG_DIR, "users.json");
const ROUTING_AUDIT_PATH = path.join(CONFIG_DIR, "routing-audit.json");
const DEVICES_CONFIG_PATH = path.join(CONFIG_DIR, "devices.json");
const ROUTERS_CONFIG_PATH = path.join(CONFIG_DIR, "routers.json");
const DEVICE_IP_HISTORY_PATH = path.join(CONFIG_DIR, "device-ip-history.json");
const ACTIVITY_LOG_PATH = path.join(LOG_DIR, "activity.log");
const IP_CHECK_LOG_PATH = path.join(LOG_DIR, "ip-check.log");
const PID_PATH = path.join(ROOT, "routerfarm.pid");
const ROUTERFARM_REMOTE_PREFIX = "/routerfarm";

const WIN_ROOT = toWinPath(ROOT);
const WIN_SCRIPTS_DIR = toWinPath(SCRIPTS_DIR);
const WIN_SETTINGS_PATH = toWinPath(SETTINGS_PATH);
const WIN_ROUTERS_CONFIG_PATH = toWinPath(ROUTERS_CONFIG_PATH);
const WIN_ACTIVITY_LOG_PATH = toWinPath(ACTIVITY_LOG_PATH);

let AUTH_DISABLED = false;
const AUTH_BYPASS_USER = {
  username: "operator",
  displayName: "Operator",
  role: "admin",
  allowedDevices: ["*"]
};

const DEFAULT_SETTINGS = {
  host: "127.0.0.1",
  port: 7781,
  adbPath: "adb",
  scrcpyPath: "scrcpy",
  pollIntervalMs: 5000,
  ipRefreshIntervalMs: 15000,
  routerRefreshIntervalMs: 20000,
  topology: {
    targetRouters: 5,
    targetPhones: 60,
    phonesPerRouter: 2,
    routerSwitchPorts: 16
  },
  deviceRefresh: {
    networkChecksPerPass: 4,
    accountChecksPerPass: 2,
    accountRefreshIntervalMs: 30000
  },
  prep: {
    minWaitSeconds: 8,
    maxWaitSeconds: 15,
    onlineTimeoutSeconds: 45
  },
  routerControl: {
    sshPath: "ssh",
    defaultUsername: "root",
    defaultPort: 22,
    commandTimeoutSeconds: 25,
    defaultPasswordEnvVar: "ROUTERFARM_ROUTER_PASSWORD",
    defaultHostKeys: {}
  },
  gatewayControl: {
    host: "192.168.12.1",
    port: 80,
    adminUsername: "admin",
    adminPasswordEnvVar: "ROUTERFARM_GATEWAY_PASSWORD",
    apiBasePath: "/TMI/v1",
    fallbackHosts: ["192.168.8.2"],
    fallbackPorts: [8080]
  },
  uplinkControl: {
    powerCycleScriptPath: path.join(SCRIPTS_DIR, "cycle-mobile-uplink.ps1"),
    defaultPowerCycleSeconds: 12
  },
  sessionPolicy: {
    restartRouterBeforeSession: true,
    routerRestartSettleMs: 45000,
    reconnectPhoneAfterRouterRestart: true,
    reconnectWaitMs: 8000
  },
  deviceRouting: {
    autoAssignRouterOnDiscovery: true,
    autoConnectRouterWifiOnDiscovery: false,
    autoConnectCooldownMs: 300000
  },
  ipReusePolicy: {
    historyLimit: 100,
    maxAgeHours: 72,
    blockSessionStartOnReuse: true
  }
};

const DEFAULT_STATE = {
  queue: [],
  devices: {},
  routers: {},
  recentActivity: []
};

const DEFAULT_IP_HISTORY = {
  devices: {}
};

const DEFAULT_DEVICES_CONFIG = {
  devices: []
};

const DEFAULT_ROUTERS_CONFIG = {
  routers: []
};

const DEFAULT_USERS = {
  users: [
    {
      username: "admin",
      displayName: "Admin",
      role: "admin",
      allowedDevices: ["*"],
      passwordHash: "pbkdf2$210000$d5d2d23da02115eb83c4ee3f060ee253$efcd13bca1e29d682e132ab345da8ecd9f38f6b5a9c211fee4e50a3dfa6609f3"
    }
  ]
};

let settings = loadJson(SETTINGS_PATH, DEFAULT_SETTINGS);
AUTH_DISABLED = process.env.ROUTERFARM_AUTH_DISABLED === "true" || settings.authDisabled === true;
let state = loadJson(STATE_PATH, DEFAULT_STATE);
let usersConfig = loadJson(USERS_PATH, DEFAULT_USERS);
let devicesConfig = loadJson(DEVICES_CONFIG_PATH, DEFAULT_DEVICES_CONFIG);
let routersConfig = loadJson(ROUTERS_CONFIG_PATH, DEFAULT_ROUTERS_CONFIG);
let preparingSerial = null;
let deviceCache = {};
let routerCache = {};
let routerHealthRefreshInFlight = false;
let deviceRefreshInFlight = false;
let lastRoutingAuditAt = 0;
let stateSaveTimer = null;
let routingAuditCache = null;

const watchdog = new Watchdog({
  intervalMs: 60000,
  kimiApiKey: process.env.KIMI_API_KEY || settings.kimiApiKey || "",
  kimiModel: settings.kimiModel || "kimi-latest"
});

function buildWatchdogContext() {
  return {
    reassignDevice(serial, toRouterId, toSlot) {
      const cfg = devicesConfig.devices?.find(d => d.serial === serial);
      if (!cfg) return false;
      cfg.routerId = toRouterId;
      cfg.routerSlot = toSlot;
      saveDevicesConfig();
      logActivity("watchdog", `Reassigned ${serial} to ${toRouterId} slot ${toSlot}`);
      return true;
    },
    removeRouter(routerId, reason) {
      const router = routersConfig.routers?.find(r => r.id === routerId);
      if (!router) return false;
      router.status = "missing";
      router.note = reason || "Removed by watchdog";
      saveRoutersConfig();
      logActivity("watchdog", `Marked router ${routerId} as missing: ${reason}`);
      return true;
    },
    clearPrepQueue() {
      const cleared = (state.queue || []).length;
      state.queue = [];
      saveState();
      logActivity("watchdog", `Cleared prep queue (${cleared} items)`);
      return true;
    },
    updateRouterStatus(routerId, status, note) {
      const router = routersConfig.routers?.find(r => r.id === routerId);
      if (!router) return false;
      router.status = status;
      if (note) router.note = note;
      saveRoutersConfig();
      logActivity("watchdog", `Updated ${routerId} status to ${status}`);
      return true;
    },
    runDeviceAction(serial, action) {
      logActivity("watchdog", `Triggered ${action} on ${serial}`);
      return true;
    },
    updateSetting(settingPath, value) {
      const keys = String(settingPath).split(".");
      let target = settings;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!target[keys[i]]) target[keys[i]] = {};
        target = target[keys[i]];
      }
      target[keys[keys.length - 1]] = value;
      saveSettings();
      logActivity("watchdog", `Updated setting ${settingPath}`);
      return true;
    }
  };
}

watchdog.runCycle = async function() {
  const report = this.buildSituationReport({
    routers: routersConfig.routers || [],
    devices: Object.values(deviceCache),
    settings,
    state,
    queue: state.queue || [],
    prepTelemetry: buildPrepTelemetry(Object.values(deviceCache))
  });

  this.appendLog({ level: "info", message: "Watchdog cycle started", report });

  let plan;
  let usedLocal = false;
  try {
    plan = await this.callKimi(report);
  } catch (error) {
    this.appendLog({ level: "warning", message: `Kimi API failed (${error.message}). Falling back to local diagnosis.` });
    plan = this.localDiagnosis(report);
    usedLocal = true;
  }

  const context = buildWatchdogContext();
  const repairs = plan.repairs || [];

  for (const repair of repairs) {
    const actionMeta = REPAIR_ACTIONS[repair.action];
    const isSafe = actionMeta?.safe || false;
    const shouldAutoExecute = this.mode === "auto_all" || (this.mode === "auto_safe" && isSafe);

    const suggestion = {
      timestamp: new Date().toISOString(),
      ...repair,
      executed: false,
      result: null,
      source: usedLocal ? "local" : "kimi"
    };

    if (shouldAutoExecute) {
      const result = await this.executeRepair(repair, context);
      suggestion.executed = true;
      suggestion.result = result;
      this.recentActions.unshift(suggestion);
      this.appendLog({ level: result.success ? "info" : "warning", message: result.message, repair });
    } else {
      this.suggestions.unshift(suggestion);
      this.appendLog({ level: "info", message: `Suggestion: ${repair.reason} (${repair.action})`, repair });
    }
  }

  // Deduplicate suggestions against recent actions
  const executedKeys = new Set(this.recentActions.slice(0, 20).map(a => `${a.action}:${JSON.stringify(a.params)}`));
  this.suggestions = this.suggestions.filter(s => !executedKeys.has(`${s.action}:${JSON.stringify(s.params)}`));

  if (this.recentActions.length > 100) this.recentActions = this.recentActions.slice(0, 100);
  if (this.suggestions.length > 100) this.suggestions = this.suggestions.slice(0, 100);
};
let routingAuditCacheMtimeMs = 0;
let deviceIpHistory = loadJson(DEVICE_IP_HISTORY_PATH, DEFAULT_IP_HISTORY);
const missingTools = new Set();
const sessions = new Map();
const ipCheckPromises = new Map();
const autoRouterConnectInFlight = new Set();

// First-run admin password generation
if (!fs.existsSync(USERS_PATH) && usersConfig.users.length === 1 && isWeakDefaultHash(usersConfig.users[0].passwordHash)) {
  const tempPassword = crypto.randomBytes(8).toString("hex");
  usersConfig.users[0].passwordHash = hashPassword(tempPassword);
  fs.writeFileSync(USERS_PATH, `${JSON.stringify(usersConfig, null, 2)}\n`);
  logActivity("system", `First-run admin password generated. Username: admin | Password: ${tempPassword} | CHANGE THIS IMMEDIATELY.`);
  console.error(`\n╔════════════════════════════════════════════════════════════════════╗`);
  console.error(`║  ROUTERFARM SECURITY: FIRST-RUN ADMIN PASSWORD GENERATED          ║`);
  console.error(`╠════════════════════════════════════════════════════════════════════╣`);
  console.error(`║  Username: admin                                                   ║`);
  console.error(`║  Password: ${tempPassword.padEnd(52)}║`);
  console.error(`║                                                                    ║`);
  console.error(`║  Change this password immediately via the dashboard or by editing  ║`);
  console.error(`║  config/users.json with hashPassword() from lib/security.js        ║`);
  console.error(`╚════════════════════════════════════════════════════════════════════╝\n`);
} else if (usersConfig.users.some(u => isWeakDefaultHash(u.passwordHash))) {
  logActivity("security", "WARNING: One or more users still have the default weak password hash. Change immediately.");
  console.error("WARNING: Default weak password hash detected. Change admin password immediately.");
}
if (!state.devices) state.devices = {};
if (!state.routers) state.routers = {};
if (!state.queue) state.queue = [];
if (!state.recentActivity) state.recentActivity = [];

ensureDirectories();
writeJsonIfMissing(SETTINGS_PATH, settings);
writeJsonIfMissing(STATE_PATH, state);
writeJsonIfMissing(USERS_PATH, usersConfig);
writeJsonIfMissing(DEVICES_CONFIG_PATH, devicesConfig);
writeJsonIfMissing(ROUTERS_CONFIG_PATH, routersConfig);
writeJsonIfMissing(DEVICE_IP_HISTORY_PATH, deviceIpHistory);
fs.writeFileSync(PID_PATH, String(process.pid));

process.on("exit", cleanupPid);
process.on("SIGINT", () => {
  flushStateSave();
  cleanupPid();
  process.exit(0);
});
process.on("SIGTERM", () => {
  flushStateSave();
  cleanupPid();
  process.exit(0);
});

logActivity("system", "RouterFarm dashboard starting");
reconcilePrepState();
refreshRouters();
processPrepQueue();
setInterval(refreshDevices, settings.pollIntervalMs || 5000);
setInterval(refreshRouters, settings.routerRefreshIntervalMs || 20000);
setInterval(refreshRouterHealth, settings.routerRefreshIntervalMs || 20000);
setInterval(safeRefreshRoutingAudit, 30000);
setInterval(trimRecentActivity, 10000);
setInterval(cleanExpiredSessions, 300000);
setInterval(cleanupRateLimits, 600000);

function validateCsrf(req, session) {
  if (AUTH_DISABLED) return true;
  if (!session || !session.csrfToken) return false;
  const header = String(req.headers["x-csrf-token"] || "").trim();
  return header === session.csrfToken;
}

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (forwarded) return forwarded;
  return req.socket?.remoteAddress || "127.0.0.1";
}

const server = http.createServer(async (req, res) => {
  try {
    const originalUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = normalizeRequestPath(originalUrl.pathname);
    const url = new URL(`${pathname}${originalUrl.search}`, `http://${req.headers.host || "127.0.0.1"}`);
    const cookies = parseCookies(req.headers.cookie || "");
    const session = AUTH_DISABLED ? null : getSession(cookies.routerfarm_session);
    const user = AUTH_DISABLED ? AUTH_BYPASS_USER : (session ? findUser(session.username) : null);

    if (req.method === "POST" && url.pathname === "/api/login") {
      if (AUTH_DISABLED) {
        return sendJson(res, 200, { ok: true, user: sanitizeUser(AUTH_BYPASS_USER), csrfToken: "" });
      }
      const body = await readJsonBody(req);
      return handleLogin(res, body, getClientIp(req));
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      if (AUTH_DISABLED) {
        return sendJson(res, 200, { ok: true, user: sanitizeUser(AUTH_BYPASS_USER) });
      }
      if (cookies.routerfarm_session) {
        sessions.delete(cookies.routerfarm_session);
      }
      return sendJson(res, 200, { ok: true }, [expireSessionCookie()]);
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      if (!user) {
        return sendJson(res, 401, { error: "Authentication required" });
      }
      return sendJson(res, 200, { ok: true, user: sanitizeUser(user) });
    }

    if (url.pathname.startsWith("/api/")) {
      if (!user) {
        return sendJson(res, 401, { error: "Authentication required" });
      }
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/client-log")) {
      if (!validateCsrf(req, session)) {
        logActivity("security", "CSRF validation failed", null);
        return sendJson(res, 403, { error: "CSRF token missing or invalid" });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      return sendJson(res, 200, buildStatus(user));
    }

    if (req.method === "GET" && url.pathname === "/api/logs/recent") {
      return sendJson(res, 200, { recentActivity: filterRecentActivityForUser(user) });
    }

    if (req.method === "POST" && url.pathname === "/api/client-log") {
      const body = await readJsonBody(req);
      const level = String(body.level || "error").trim() || "error";
      const source = String(body.source || "renderer").trim() || "renderer";
      const message = String(body.message || "Unknown client error").trim() || "Unknown client error";
      const serial = body.serial ? String(body.serial) : null;
      const detail = body.detail ? ` | ${String(body.detail)}` : "";
      logActivity(level === "warning" ? "client-warning" : "client-error", `${source}: ${message}${detail}`, serial);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/config/reload") {
      settings = loadJson(SETTINGS_PATH, DEFAULT_SETTINGS);
      usersConfig = loadJson(USERS_PATH, DEFAULT_USERS);
      devicesConfig = loadJson(DEVICES_CONFIG_PATH, DEFAULT_DEVICES_CONFIG);
      routersConfig = loadJson(ROUTERS_CONFIG_PATH, DEFAULT_ROUTERS_CONFIG);
      refreshRouters();
      logActivity("system", `Configuration reloaded by ${user.username}`);
      return sendJson(res, 200, { ok: true, settings, user: sanitizeUser(user) });
    }

    const routerMatch = url.pathname.match(/^\/api\/routers\/([^/]+)\/([^/]+)$/);
    if (req.method === "POST" && routerMatch) {
      try {
        const routerId = sanitizeRouterId(decodeURIComponent(routerMatch[1]));
        const action = sanitizeAction(routerMatch[2]);
        const body = await readJsonBody(req);
        return handleRouterAction(res, user, routerId, action, body);
      } catch (validationError) {
        return sendJson(res, 400, { error: validationError.message });
      }
    }

    const match = url.pathname.match(/^\/api\/devices\/([^/]+)\/([^/]+)$/);
    if (req.method === "POST" && match) {
      try {
        const serial = sanitizeSerial(decodeURIComponent(match[1]));
        const action = sanitizeAction(match[2]);
        const body = await readJsonBody(req);
        return handleDeviceAction(res, user, serial, action, body);
      } catch (validationError) {
        return sendJson(res, 400, { error: validationError.message });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/watchdog/status") {
      return sendJson(res, 200, { ok: true, watchdog: watchdog.getStatus() });
    }

    if (req.method === "POST" && url.pathname === "/api/watchdog/mode") {
      const body = await readJsonBody(req);
      const newMode = String(body.mode || "off").trim();
      const validModes = ["off", "suggest", "auto_safe", "auto_all"];
      if (!validModes.includes(newMode)) {
        return sendJson(res, 400, { error: `Invalid mode. Use: ${validModes.join(", ")}` });
      }
      watchdog.setMode(newMode);
      logActivity("watchdog", `Mode changed to ${newMode} by ${user.username}`);
      return sendJson(res, 200, { ok: true, watchdog: watchdog.getStatus() });
    }

    if (req.method === "POST" && url.pathname === "/api/watchdog/run") {
      watchdog.tick();
      logActivity("watchdog", `Manual run triggered by ${user.username}`);
      return sendJson(res, 200, { ok: true, watchdog: watchdog.getStatus() });
    }

    if (req.method === "POST" && url.pathname === "/api/watchdog/approve") {
      const body = await readJsonBody(req);
      const index = parseInt(body.index, 10);
      if (Number.isNaN(index) || index < 0 || index >= watchdog.suggestions.length) {
        return sendJson(res, 400, { error: "Invalid suggestion index" });
      }
      const suggestion = watchdog.suggestions[index];
      const context = buildWatchdogContext();
      const result = await watchdog.executeRepair(suggestion, context);
      suggestion.executed = true;
      suggestion.result = result;
      watchdog.recentActions.unshift(suggestion);
      watchdog.suggestions.splice(index, 1);
      logActivity("watchdog", `Approved repair: ${result.message} by ${user.username}`);
      return sendJson(res, 200, { ok: true, result, watchdog: watchdog.getStatus() });
    }

    if (req.method === "POST" && url.pathname === "/api/watchdog/dismiss") {
      const body = await readJsonBody(req);
      const index = parseInt(body.index, 10);
      if (Number.isNaN(index) || index < 0 || index >= watchdog.suggestions.length) {
        return sendJson(res, 400, { error: "Invalid suggestion index" });
      }
      watchdog.suggestions.splice(index, 1);
      logActivity("watchdog", `Suggestion dismissed by ${user.username}`);
      return sendJson(res, 200, { ok: true, watchdog: watchdog.getStatus() });
    }

    if (req.method === "POST" && url.pathname === "/api/watchdog/login") {
      const result = await watchdog.triggerKimiLogin();
      logActivity("watchdog", `Kimi login triggered by ${user.username}: ${result.message}`);
      return sendJson(res, 200, { ok: true, result, watchdog: watchdog.getStatus() });
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    logActivity("error", `Request failed: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
});

server.on("error", error => {
  if (error.code === "EADDRINUSE") {
    logActivity("system", `Port ${settings.port} is already in use. Process exiting.`);
  } else {
    logActivity("system", `Server error: ${error.message}`);
  }
  process.exit(1);
});

server.listen(settings.port, settings.host, () => {
  logActivity("system", `Dashboard listening on http://${settings.host}:${settings.port}`);
  setTimeout(() => {
    refreshDevices();
    safeRefreshRoutingAudit();
  }, 50);
  setTimeout(() => {
    refreshRouterHealth();
  }, 250);
  if (settings.watchdogEnabled !== false && watchdog.kimiApiKey) {
    watchdog.setMode(settings.watchdogMode || "suggest");
    logActivity("system", `Watchdog started in ${watchdog.mode} mode`);
  }
});

function cleanupPid() {
  if (fs.existsSync(PID_PATH)) {
    try {
      fs.unlinkSync(PID_PATH);
    } catch (error) {
      // Ignore cleanup failures during shutdown.
    }
  }
}

function ensureDirectories() {
  for (const dir of [CONFIG_DIR, LOG_DIR, WEB_DIR, SCRIPTS_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return JSON.parse(JSON.stringify(fallback));
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch (error) {
    return JSON.parse(JSON.stringify(fallback));
  }
}

function writeJsonIfMissing(filePath, data) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
  }
}

function saveState() {
  if (stateSaveTimer) {
    clearTimeout(stateSaveTimer);
  }
  stateSaveTimer = setTimeout(() => {
    stateSaveTimer = null;
    fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  }, 150);
}

let refreshDevicesTimeout = null;
function scheduleRefreshDevices() {
  if (refreshDevicesTimeout) {
    return;
  }
  refreshDevicesTimeout = setTimeout(() => {
    refreshDevicesTimeout = null;
    refreshDevices().catch(() => {});
  }, 500);
}

function flushStateSave() {
  if (!stateSaveTimer) {
    return;
  }
  clearTimeout(stateSaveTimer);
  stateSaveTimer = null;
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function saveDevicesConfig() {
  fs.writeFileSync(DEVICES_CONFIG_PATH, `${JSON.stringify(devicesConfig, null, 2)}\n`);
}

function saveRoutersConfig() {
  fs.writeFileSync(ROUTERS_CONFIG_PATH, `${JSON.stringify(routersConfig, null, 2)}\n`);
}

function saveSettings() {
  fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

function saveDeviceIpHistory() {
  fs.writeFileSync(DEVICE_IP_HISTORY_PATH, `${JSON.stringify(deviceIpHistory, null, 2)}\n`);
}

function trimRecentActivity() {
  if ((state.recentActivity || []).length > 200) {
    state.recentActivity = state.recentActivity.slice(0, 200);
    saveState();
  }
}

function logActivity(category, message, serial = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    category,
    serial,
    message
  };
  const line = `[${entry.timestamp}] [${category}]${serial ? ` [${serial}]` : ""} ${message}\n`;
  fs.appendFileSync(ACTIVITY_LOG_PATH, line);
  state.recentActivity = [entry, ...(state.recentActivity || [])].slice(0, 200);
  saveState();
}

function logIpCheck(message, serial = null) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}]${serial ? ` [${serial}]` : ""} ${message}\n`;
  fs.appendFileSync(IP_CHECK_LOG_PATH, line);
}

function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function cleanExpiredSessions() {
  for (const [token, session] of sessions.entries()) {
    if (Date.now() > session.expiresAt) {
      sessions.delete(token);
    }
  }
}

function findUser(username) {
  return (usersConfig.users || []).find(item => item.username === username) || null;
}

function handleLogin(res, body, clientIp) {
  let username;
  try {
    username = sanitizeUsername(body.username);
  } catch (_e) {
    logActivity("auth", "Failed login attempt for invalid username");
    return sendJson(res, 401, { error: "Invalid username or password" });
  }
  const rateLimit = checkRateLimit(clientIp || username);
  if (!rateLimit.allowed) {
    logActivity("auth", `Login rate limited for ${username}`);
    return sendJson(res, 429, { error: "Too many login attempts. Try again later.", retryAfter: rateLimit.waitSeconds });
  }
  const password = String(body.password || "");
  const user = findUser(username);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    logActivity("auth", `Failed login attempt for ${username || "unknown"}`);
    return sendJson(res, 401, { error: "Invalid username or password" });
  }

  const token = generateToken();
  const csrfToken = generateToken();
  sessions.set(token, {
    username: user.username,
    csrfToken,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  logActivity("auth", `Successful login for ${user.username}`);
  return sendJson(res, 200, { ok: true, user: sanitizeUser(user), csrfToken }, [createSessionCookie(token)]);
}

function filterDevicesForUser(user) {
  return Object.values(deviceCache)
    .filter(device => userCanAccessDevice(user, device.serial))
    .sort((a, b) => a.serial.localeCompare(b.serial));
}

function filterRecentActivityForUser(user) {
  if (!user) return [];
  return (state.recentActivity || []).filter(entry => !entry.serial || userCanAccessDevice(user, entry.serial));
}

function getAssignedDevicesForRouter(routerId) {
  return (devicesConfig.devices || [])
    .map(device => getDeviceConfig(device.serial))
    .filter(device => deviceUsesRouterAssignment(device) && String(device.routerId || "") === String(routerId || ""));
}

function getActiveSession() {
  return getActiveSessionFromDevices(Object.values(deviceCache));
}

function reconcilePrepState() {
  const queue = Array.isArray(state.queue) ? state.queue.filter(Boolean) : [];
  state.queue = Array.from(new Set(queue));

  for (const [serial, device] of Object.entries(state.devices || {})) {
    if (!device) {
      continue;
    }

    if (device.prepState === "queued" && !state.queue.includes(serial)) {
      state.queue.push(serial);
      continue;
    }

    if (device.prepState === "preparing") {
      state.devices[serial] = {
        ...device,
        prepState: "failed",
        prepFinishedAt: new Date().toISOString(),
        prepMessage: "Prep was interrupted and needs to be started again."
      };
    }
  }

  saveState();
}

function getActiveSessionFromDevices(devices) {
  const runningDevices = (devices || []).filter(device => device?.sessionState === "running");
  if (!runningDevices.length) {
    return null;
  }
  runningDevices.sort((a, b) => new Date(b.sessionStartedAt || 0).getTime() - new Date(a.sessionStartedAt || 0).getTime());
  const device = runningDevices[0];
  return {
    serial: device.serial,
    label: formatDeviceLabel(device),
    routerId: device.routerId || "",
    startedAt: device.sessionStartedAt || ""
  };
}

function buildRouterStatuses(visibleDevices) {
  const visibleBySerial = new Map((visibleDevices || []).map(device => [device.serial, device]));
  return listConfiguredRouters().map(router => {
    const assigned = getAssignedDevicesForRouter(router.id)
      .map(device => visibleBySerial.get(device.serial) || device)
      .sort((a, b) => (a.routerSlot || 99) - (b.routerSlot || 99) || String(a.nickname || a.serial).localeCompare(String(b.nickname || b.serial)));
    const activeDevice = assigned.find(device => device.sessionState === "running") || null;
    const routerState = state.routers?.[router.id] || {};
    const maxAssignedDevices = Number(router.maxAssignedDevices) || getPhonesPerRouterTarget();
    return {
      id: router.id,
      label: router.label || router.id,
      host: router.host || "",
      ssid: router.ssid || "",
      lanSubnet: router.lanSubnet || "",
      mobileUplinkId: router.mobileUplinkId || "",
      enabled: router.enabled !== false,
      maxAssignedDevices,
      maxConcurrentDevices: Number(router.maxConcurrentDevices) || 1,
      assignedDeviceCount: assigned.length,
      capacityRemaining: Math.max(maxAssignedDevices - assigned.length, 0),
      overAssigned: assigned.length > maxAssignedDevices,
      activeDeviceSerial: activeDevice?.serial || "",
      activeDeviceLabel: activeDevice ? formatDeviceLabel(activeDevice) : "",
      slotUsage: assigned.map(device => ({
        serial: device.serial,
        label: formatDeviceLabel(device),
        slot: device.routerSlot || null,
        sessionState: device.sessionState || "stopped",
        prepState: device.prepState || "idle"
      })),
      routerState: {
        lastAction: routerState.lastAction || "",
        lastResult: routerState.lastResult || "",
        lastRestartAt: routerState.lastRestartAt || "",
        lastCheckedAt: routerState.lastCheckedAt || "",
        healthStatus: routerState.healthStatus || "unknown",
        detail: routerState.detail || "",
        reachability: routerState.reachability || { ssh: false, http: false, https: false },
        routerMode: routerState.routerMode || "",
        uplinkMode: routerState.uplinkMode || "",
        uplinkInterface: routerState.uplinkInterface || "",
        tetheringState: routerState.tetheringState || "",
        tetheringError: routerState.tetheringError || "",
        tetheringHint: routerState.tetheringHint || "",
        usbPorts: routerState.usbPorts || "",
        wanUp: Boolean(routerState.wanUp),
        wanAddress: routerState.wanAddress || "",
        wanDevice: routerState.wanDevice || "",
        publicIp: routerState.publicIp || "",
        telemetryCheckedAt: routerState.telemetryCheckedAt || ""
      }
    };
  });
}

function getDeviceConfig(serial) {
  const record = (devicesConfig.devices || []).find(device => device.serial === serial);
  if (!record) {
    return {
      serial,
      phoneNumber: null,
      nickname: "",
      role: "router-linkpro",
      parentHotspotSerial: "",
      routerId: "",
      routerSlot: null
    };
  }
  const normalizedRole = normalizeDeviceRole(record.role);
  return {
    ...record,
    role: normalizedRole,
    routerId: deviceUsesRouterAssignment({ role: normalizedRole }) ? String(record.routerId || "") : "",
    routerSlot: deviceUsesRouterAssignment({ role: normalizedRole }) ? parsePositiveIntegerOrNull(record.routerSlot) : null
  };
}

function upsertDeviceConfig(serial, patch) {
  const devices = devicesConfig.devices || [];
  const index = devices.findIndex(device => device.serial === serial);
  const nextRecord = {
    ...getDeviceConfig(serial),
    ...sanitizeDeviceMetadataPatch(patch),
    serial
  };
  if (index >= 0) {
    devices[index] = nextRecord;
  } else {
    devices.push(nextRecord);
  }
  devicesConfig.devices = devices;
  saveDevicesConfig();
  return nextRecord;
}

function getRouterConfig(routerId) {
  return (routersConfig.routers || []).find(router => router.id === routerId) || null;
}

function listConfiguredRouters() {
  return (routersConfig.routers || []).slice().sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
}

function getAssignedPhoneNumbers() {
  const numbers = new Set();
  for (const device of devicesConfig.devices || []) {
    const phoneNumber = Number(device.phoneNumber);
    if (Number.isInteger(phoneNumber) && phoneNumber > 0) {
      numbers.add(phoneNumber);
      continue;
    }

    const nicknameMatch = String(device.nickname || "").match(/^Phone\s+(\d{1,3})$/i);
    if (nicknameMatch) {
      numbers.add(Number(nicknameMatch[1]));
    }
  }
  return numbers;
}

function getNextPhoneNumber() {
  const assigned = getAssignedPhoneNumbers();
  let phoneNumber = 1;
  while (assigned.has(phoneNumber)) {
    phoneNumber += 1;
  }
  return phoneNumber;
}

function formatPhoneNumber(phoneNumber) {
  return `Phone ${String(phoneNumber).padStart(2, "0")}`;
}

function normalizeDeviceRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  if (!normalized) {
    return "router-linkpro";
  }
  if (["router-client", "opal-client", "router-linkpro", "linkpro-routed"].includes(normalized)) {
    return "router-linkpro";
  }
  if (normalized === "hotspot-client") {
    return "hotspot-client";
  }
  if (normalized === "hotspot-provider") {
    return "hotspot-provider";
  }
  return normalized;
}

function deviceRequiresRouter(device) {
  return normalizeDeviceRole(device?.role) === "router-linkpro";
}

function deviceUsesRouterAssignment(device) {
  return deviceRequiresRouter(device) || normalizeDeviceRole(device?.role) === "hotspot-client";
}

function getPhonesPerRouterTarget() {
  return Math.max(1, Number(settings.topology?.phonesPerRouter) || Number(DEFAULT_SETTINGS.topology.phonesPerRouter) || 2);
}

function sanitizeDeviceMetadataPatch(patch = {}) {
  const hasRole = Object.prototype.hasOwnProperty.call(patch, "role");
  const nextPatch = {
    ...patch
  };
  if (hasRole) {
    nextPatch.role = normalizeDeviceRole(patch.role);
  }
  if (hasRole && !deviceUsesRouterAssignment({ role: nextPatch.role })) {
    nextPatch.routerId = "";
    nextPatch.routerSlot = null;
  }
  return nextPatch;
}

function ensureDeviceNumberAssignment(serial) {
  const existing = getDeviceConfig(serial);
  const currentNumber = Number(existing.phoneNumber);
  if (Number.isInteger(currentNumber) && currentNumber > 0) {
    return existing;
  }

  const nicknameMatch = String(existing.nickname || "").match(/^Phone\s+(\d{1,3})$/i);
  const phoneNumber = nicknameMatch ? Number(nicknameMatch[1]) : getNextPhoneNumber();
  return upsertDeviceConfig(serial, {
    phoneNumber,
    nickname: existing.nickname || formatPhoneNumber(phoneNumber)
  });
}

function getRouterAssignmentSummary() {
  const summary = new Map();
  for (const router of listConfiguredRouters()) {
    summary.set(router.id, []);
  }
  for (const device of devicesConfig.devices || []) {
    if (!deviceUsesRouterAssignment(device)) {
      continue;
    }
    const routerId = String(device.routerId || "");
    if (!routerId || !summary.has(routerId)) {
      continue;
    }
    summary.get(routerId).push(device);
  }
  return summary;
}

function assignPersistentRouterToDevice(serial) {
  const existing = getDeviceConfig(serial);
  if (!deviceRequiresRouter(existing)) {
    return existing;
  }
  if (existing.routerId) {
    return existing;
  }

  const routingSettings = settings.deviceRouting || DEFAULT_SETTINGS.deviceRouting;
  if (routingSettings.autoAssignRouterOnDiscovery === false) {
    return existing;
  }

  const routers = listConfiguredRouters().filter(router => router.enabled !== false);
  const assignments = getRouterAssignmentSummary();
  let selectedRouter = null;
  let selectedSlot = null;
  let selectedLoad = Number.MAX_SAFE_INTEGER;

  for (const router of routers) {
    const assignedDevices = assignments.get(router.id) || [];
    const maxAssigned = Number(router.maxAssignedDevices) || getPhonesPerRouterTarget();
    if (assignedDevices.length >= maxAssigned) {
      continue;
    }
    const usedSlots = new Set(
      assignedDevices
        .map(device => parsePositiveIntegerOrNull(device.routerSlot))
        .filter(Boolean)
    );
    let candidateSlot = 1;
    while (usedSlots.has(candidateSlot)) {
      candidateSlot += 1;
    }
    if (assignedDevices.length < selectedLoad) {
      selectedRouter = router;
      selectedSlot = candidateSlot;
      selectedLoad = assignedDevices.length;
    }
  }

  if (!selectedRouter) {
    return existing;
  }

  const patched = upsertDeviceConfig(serial, {
    role: normalizeDeviceRole(existing.role),
    routerId: selectedRouter.id,
    routerSlot: selectedSlot
  });
  logActivity("routing", `Assigned ${patched.nickname || serial} to ${selectedRouter.label || selectedRouter.id} slot ${selectedSlot}`, serial);
  return patched;
}

function ensurePermanentDeviceAssignment(serial) {
  ensureDeviceNumberAssignment(serial);
  return assignPersistentRouterToDevice(serial);
}

function shouldAutoConnectRouterWifi(serial, row, metadata, previousDevice) {
  const routingSettings = settings.deviceRouting || DEFAULT_SETTINGS.deviceRouting;
  if (routingSettings.autoConnectRouterWifiOnDiscovery === false) {
    return false;
  }
  if (row.state !== "device" || !metadata?.routerId) {
    return false;
  }
  if (autoRouterConnectInFlight.has(serial)) {
    return false;
  }

  const currentState = state.devices?.[serial] || {};
  const cooldownMs = Number(routingSettings.autoConnectCooldownMs) || 300000;
  const lastAttemptAt = new Date(currentState.routerAutoConnectLastAttemptAt || 0).getTime();
  if (Date.now() - lastAttemptAt < cooldownMs) {
    return false;
  }
  if (!previousDevice || previousDevice.adbState !== "device") {
    return true;
  }
  if (String(previousDevice.routerId || "") !== String(metadata.routerId || "")) {
    return true;
  }
  return !currentState.routerAutoConnectLastAttemptAt;
}

function scheduleAutoRouterWifiConnect(serial, router) {
  if (!router || autoRouterConnectInFlight.has(serial)) {
    return;
  }

  autoRouterConnectInFlight.add(serial);
  const attemptedAt = new Date().toISOString();
  updateDeviceState(serial, {
    routerAutoConnectLastAttemptAt: attemptedAt,
    routerAutoConnectStatus: "pending",
    prepMessage: `Auto-connecting to ${router.label || router.id}`
  });

  setTimeout(async () => {
    try {
      const connectResult = await connectPhoneToRouterAsync(serial, router);
      updateDeviceState(serial, {
        routerAutoConnectLastAttemptAt: attemptedAt,
        routerAutoConnectStatus: connectResult.ok ? (connectResult.manualAssist ? "manual-assist" : "connected") : "failed",
        routerAutoConnectLastResult: connectResult.payload?.message || connectResult.error || "",
        prepMessage: connectResult.ok
          ? (connectResult.manualAssist
              ? `Auto-connect opened Wi-Fi settings for ${router.label || router.id}`
              : `Auto-connected to ${router.label || router.id}`)
          : (connectResult.error || `Auto-connect failed for ${router.label || router.id}`)
      });
      logActivity(
        "router-connect",
        connectResult.ok
          ? (connectResult.manualAssist
              ? `${serial} needs manual Wi-Fi completion for ${router.label || router.id}`
              : `${serial} auto-connected to ${router.label || router.id}`)
          : `${serial} auto-connect failed for ${router.label || router.id}: ${connectResult.error || "unknown error"}`,
        serial
      );
    } finally {
      autoRouterConnectInFlight.delete(serial);
    }
  }, 250);
}

function buildStatus(user) {
  const routingAudit = loadRoutingAudit();
  const routingGuard = buildRoutingGuard(routingAudit);
  const ipPolicy = getIpReusePolicy();
  const filteredDevices = filterDevicesForUser(user);
  const activeSession = getActiveSession();
  const visibleDevices = applyDuplicateFlags(filteredDevices)
    .map(device => enrichDeviceForStatus(device, routingAudit, routingGuard, activeSession));
  const visibleSerials = new Set(visibleDevices.map(device => device.serial));
  const visibleQueue = (state.queue || []).filter(serial => visibleSerials.has(serial));
  const visiblePreparing = preparingSerial && visibleSerials.has(preparingSerial) ? preparingSerial : null;
  const routers = buildRouterStatuses(visibleDevices);
  return {
    ok: true,
    user: sanitizeUser(user),
    settings: {
      host: settings.host,
      port: settings.port,
      pollIntervalMs: settings.pollIntervalMs,
      ipRefreshIntervalMs: settings.ipRefreshIntervalMs,
      routerRefreshIntervalMs: settings.routerRefreshIntervalMs,
      prep: settings.prep,
      topology: settings.topology || DEFAULT_SETTINGS.topology,
      sessionPolicy: settings.sessionPolicy || DEFAULT_SETTINGS.sessionPolicy,
      ipReusePolicy: ipPolicy
    },
    queue: visibleQueue,
    preparingSerial: visiblePreparing,
    activeSession,
    routerConstraints: {
      maxConcurrentDevicesPerRouter: 1,
      maxConcurrentDevicesGlobal: 1
    },
    prepTelemetry: buildPrepTelemetry(visibleDevices),
    routingAudit,
    routingGuard,
    routers,
    devices: visibleDevices,
    recentActivity: filterRecentActivityForUser(user),
    watchdog: watchdog.getStatus()
  };
}

function sendJson(res, statusCode, data, extraCookies = []) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    Pragma: "no-cache",
    Expires: "0"
  };
  if (extraCookies.length) {
    headers["Set-Cookie"] = extraCookies;
  }
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(data));
}

function serveStatic(urlPath, res) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(WEB_DIR, requested));
  if (!filePath.startsWith(WEB_DIR)) {
    return sendJson(res, 403, { error: "Forbidden" });
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return sendJson(res, 404, { error: "Not found" });
  }
  res.writeHead(200, {
    "Content-Type": getContentType(filePath),
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    Pragma: "no-cache",
    Expires: "0"
  });
  fs.createReadStream(filePath).pipe(res);
}

function normalizeRequestPath(pathname) {
  if (pathname === ROUTERFARM_REMOTE_PREFIX || pathname === `${ROUTERFARM_REMOTE_PREFIX}/`) {
    return "/";
  }
  if (pathname.startsWith(`${ROUTERFARM_REMOTE_PREFIX}/`)) {
    return pathname.slice(ROUTERFARM_REMOTE_PREFIX.length);
  }
  return pathname;
}

function getContentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON request body"));
      }
    });
    req.on("error", reject);
  });
}

function handleDeviceAction(res, user, serial, action, body) {
  return handleDeviceActionAsync(res, user, serial, action, body);
}

async function handleDeviceActionAsync(res, user, serial, action, body) {
  if (!userCanAccessDevice(user, serial)) {
    return sendJson(res, 403, { error: "You do not have access to this device" });
  }

  const knownDevice = deviceCache[serial] || buildMissingDevice(serial);
  const routingGuard = buildRoutingGuard(loadRoutingAudit());
  if (action === "metadata") {
    const nextRouterId = String(body.routerId || "").trim();
    const nextRouterSlot = parsePositiveIntegerOrNull(body.routerSlot);
    const nextPhoneNumber = parsePositiveIntegerOrNull(body.phoneNumber);
    const currentConfig = getDeviceConfig(serial);
    upsertDeviceConfig(serial, {
      nickname: Object.prototype.hasOwnProperty.call(body, "nickname") ? String(body.nickname || "").trim() : currentConfig.nickname,
      phoneNumber: Object.prototype.hasOwnProperty.call(body, "phoneNumber") ? nextPhoneNumber : currentConfig.phoneNumber,
      role: Object.prototype.hasOwnProperty.call(body, "role") ? body.role : currentConfig.role,
      parentHotspotSerial: Object.prototype.hasOwnProperty.call(body, "parentHotspotSerial")
        ? String(body.parentHotspotSerial || "").trim()
        : currentConfig.parentHotspotSerial,
      routerId: Object.prototype.hasOwnProperty.call(body, "routerId") ? nextRouterId : currentConfig.routerId,
      routerSlot: Object.prototype.hasOwnProperty.call(body, "routerSlot") ? nextRouterSlot : currentConfig.routerSlot
    });
    refreshDevices();
    logActivity("metadata", `Device metadata updated by ${user.username}`, serial);
    return sendJson(res, 200, { ok: true });
  }

  if (action === "viewer-state") {
    const current = state.devices?.[serial]?.viewerLaunch || buildMissingDevice(serial).viewerLaunch;
    const sourceAction = String(body.sourceAction || current.sourceAction || "").trim();
    const nextViewerLaunch = {
      ...current,
      status: String(body.status || current.status || "unknown"),
      sourceAction,
      requestedAt: String(body.requestedAt || current.requestedAt || new Date().toISOString()),
      confirmedAt: String(body.confirmedAt || current.confirmedAt || ""),
      pid: Number.isFinite(Number(body.pid)) ? Number(body.pid) : (current.pid || null),
      processName: String(body.processName || current.processName || ""),
      filePath: String(body.filePath || current.filePath || ""),
      aliveAfterLaunch: body.aliveAfterLaunch === undefined ? Boolean(current.aliveAfterLaunch) : Boolean(body.aliveAfterLaunch),
      windowReady: body.windowReady === undefined ? Boolean(current.windowReady) : Boolean(body.windowReady),
      fallbackViewer: String(body.fallbackViewer || current.fallbackViewer || ""),
      manualSelectionRequired: body.manualSelectionRequired === undefined ? Boolean(current.manualSelectionRequired) : Boolean(body.manualSelectionRequired),
      lastError: String(body.lastError || "")
    };
    updateDeviceState(serial, { viewerLaunch: nextViewerLaunch });
    logActivity("scrcpy", `Viewer state synced by ${user.username} for ${sourceAction || "desktop"}: ${nextViewerLaunch.status}`, serial);
    return sendJson(res, 200, { ok: true, viewerLaunch: nextViewerLaunch });
  }

  if (action === "open-control") {
    const launchResult = await launchViewerForDevice(serial, user.username, "open-control");
    if (!launchResult.success) {
      return sendJson(res, 500, { error: launchResult.error || "Viewer launch failed", viewerLaunch: launchResult.viewerLaunch || null });
    }
    return sendJson(res, 200, { ok: true, viewerLaunch: launchResult.viewerLaunch });
  }

  if (action === "check-ip") {
    if (ipCheckPromises.has(serial)) {
      return sendJson(res, 409, { error: "An IP check is already running for this device" });
    }
    const result = await runDevicePublicIpCheck(serial, "manual");
    if (!result.success) {
      return sendJson(res, 500, { error: result.error || "IP check failed", ipCheck: result.publicIp });
    }
    return sendJson(res, 200, { ok: true, ipCheck: result.publicIp });
  }

  if (action === "recover-radios") {
    updateDeviceState(serial, { prepMessage: "Clearing airplane mode and recovering radios" });
    const child = runPowerShellScript(
      "recover-device-radios.ps1",
      ["-Serial", serial, "-SettingsPath", WIN_SETTINGS_PATH, "-ActivityLogPath", WIN_ACTIVITY_LOG_PATH],
      { detached: false }
    );

    let stdout = "";
    if (child.stdout) {
      child.stdout.on("data", chunk => {
        stdout += chunk.toString();
      });
    }

    child.on("exit", code => {
      const payload = parseJsonPayload(stdout);
      const success = code === 0 && payload?.ok;
      let message = success ? "Airplane mode cleared and radios recovered" : "Radio recovery failed; review logs";
      if (payload && !success && payload.error) {
        message = `Radio recovery failed: ${payload.error}`;
      } else if (payload && success && payload.airplaneModeOff === false) {
        message = "Radios recovered, but airplane mode might still be on (verify manually)";
      }

      updateDeviceState(serial, {
        prepMessage: message
      });
      logActivity("recover", success ? "Radio recovery completed" : `Radio recovery failed: ${payload?.error || `exit code ${code}`}`, serial);
    });

    logActivity("recover", `Radio recovery requested by ${user.username}`, serial);
    return sendJson(res, 200, { ok: true });
  }

  if (action === "engage-airplane") {
    updateDeviceState(serial, { prepMessage: "Engaging airplane mode" });
    const child = runPowerShellScript(
      "set-device-airplane-mode.ps1",
      ["-Serial", serial, "-Mode", "on", "-SettingsPath", WIN_SETTINGS_PATH, "-ActivityLogPath", WIN_ACTIVITY_LOG_PATH],
      { detached: false }
    );

    child.on("exit", code => {
      const success = code === 0;
      updateDeviceState(serial, {
        prepMessage: success ? "Airplane mode requested" : "Airplane mode request failed; review logs"
      });
      logActivity("airplane", success ? "Airplane mode engaged" : `Airplane mode request failed with exit code ${code}`, serial);
    });

    logActivity("airplane", `Airplane mode requested by ${user.username}`, serial);
    return sendJson(res, 200, { ok: true });
  }

  if (action === "start-session") {
    if (routingGuard.blocked) {
      return sendJson(res, 409, { error: `Session start blocked: ${routingGuard.reasons.join(" | ")}`, routingGuard });
    }
    const routedSession = deviceRequiresRouter(knownDevice);
    const activationLock = buildActivationLock(knownDevice);
    if (!activationLock.allowed) {
      return sendJson(res, 409, { error: activationLock.reason, activationLock });
    }
    if (routedSession) {
      await setDeviceWifiStateAsync(serial, false);
      updateDeviceState(serial, {
        prepMessage: "Wi-Fi disabled while RouterFarm rotates this phone onto a fresh routed IP"
      });
      const restartGate = await enforceRouterRestartBeforeSession(serial, user, knownDevice);
      if (!restartGate.ok) {
        return sendJson(res, 409, { error: restartGate.error || "Router restart gate failed", detail: restartGate.detail || null });
      }
      await refreshDevices();
      const refreshedDevice = deviceCache[serial] || buildMissingDevice(serial);
      if (!deviceLooksOnRouterWifi(refreshedDevice)) {
        await setDeviceWifiStateAsync(serial, false);
        updateDeviceState(serial, {
          prepMessage: `Phone did not land on router Wi-Fi after reconnect; current interface is ${refreshedDevice.network?.interface || "unknown"}`
        });
        return sendJson(res, 409, {
          error: `Session start blocked: phone is not using router Wi-Fi after reconnect. Current interface: ${refreshedDevice.network?.interface || "unknown"}.`
        });
      }
      const verification = await runDevicePublicIpCheck(serial, "pre-session");
      if (!verification.success) {
        await setDeviceWifiStateAsync(serial, false);
        updateDeviceState(serial, { prepMessage: "IP verification failed and Wi-Fi was disabled" });
        return sendJson(res, 409, { error: verification.error || "IP verification failed; session not started" });
      }
      if (verification.publicIp?.reusePolicyViolation && getIpReusePolicy().blockSessionStartOnReuse) {
        const routerLabel = knownDevice.routerLabel || knownDevice.routerId || "assigned router";
        await setDeviceWifiStateAsync(serial, false);
        updateDeviceState(serial, { prepMessage: "Reused IP detected; Wi-Fi was disabled pending a new attempt" });
        return sendJson(res, 409, {
          error: `Session start blocked: ${verification.publicIp.currentIp} was already used within the last ${verification.publicIp.reusePolicyWindowHours} hours. Reset ${routerLabel} and verify a fresh IP before starting.`,
          ipCheck: verification.publicIp
        });
      }
      updateDeviceState(serial, {
        prepMessage: `Fresh routed IP ${verification.publicIp?.currentIp || ""} verified; launching control session`
      });
    }
    if (body && body.skipViewerLaunch) {
      updateDeviceState(serial, { sessionState: "running", sessionStartedAt: new Date().toISOString() });
      logActivity("session", `Session started by ${user.username} with desktop-managed viewer launch`, serial);
      return sendJson(res, 200, { ok: true, desktopLaunchPending: true, viewerLaunch: state.devices?.[serial]?.viewerLaunch || null });
    }
    const launchResult = await launchViewerForDevice(serial, user.username, "start-session");
    if (!launchResult.success) {
      return sendJson(res, 500, { error: launchResult.error || "Viewer launch failed; session not started", viewerLaunch: launchResult.viewerLaunch || null });
    }
    updateDeviceState(serial, { sessionState: "running", sessionStartedAt: new Date().toISOString() });
    logActivity("session", `Session started by ${user.username} and viewer launch confirmed`, serial);
    return sendJson(res, 200, { ok: true, viewerLaunch: launchResult.viewerLaunch });
  }

  if (action === "stop-session") {
    const viewerPid = state.devices?.[serial]?.viewerLaunch?.pid;
    const stopArgs = ["-Serial", serial];
    if (viewerPid) {
      stopArgs.push("-ViewerPid", String(viewerPid));
    }
    runPowerShellScript("stop-scrcpy-for-device.ps1", stopArgs, { detached: true, windowsHide: false });
    updateDeviceState(serial, { sessionState: "stopped", sessionStoppedAt: new Date().toISOString() });
    if (deviceRequiresRouter(knownDevice)) {
      await setDeviceWifiStateAsync(serial, false);
      updateDeviceState(serial, { prepMessage: "Session stopped and Wi-Fi disabled" });
    } else {
      updateDeviceState(serial, { prepMessage: "Session stopped" });
    }
    logActivity("session", `Session stopped by ${user.username} and scrcpy close requested`, serial);
    return sendJson(res, 200, { ok: true });
  }

  if (action === "connect-router") {
    const router = knownDevice.routerId ? getRouterConfig(knownDevice.routerId) : null;
    if (!router) {
      return sendJson(res, 409, { error: "Assign this phone to a router before connecting." });
    }

    await setDeviceWifiStateAsync(serial, false);
    updateDeviceState(serial, {
      prepMessage: `Cycling ${router.label || router.id} to obtain a fresh IP before Wi-Fi join`
    });

    const restartGate = await enforceRouterRestartBeforeSession(serial, user, knownDevice);
    if (!restartGate.ok) {
      return sendJson(res, 409, { error: restartGate.error || "Router fresh-IP gate failed", detail: restartGate.detail || null });
    }

    const verification = await runDevicePublicIpCheck(serial, "router-connect");
    if (!verification.success) {
      await setDeviceWifiStateAsync(serial, false);
      updateDeviceState(serial, { prepMessage: "Phone-side IP verification failed and Wi-Fi was disabled" });
      return sendJson(res, 409, { error: verification.error || "Phone-side IP verification failed", detail: verification.publicIp || null });
    }
    if (verification.publicIp?.reusePolicyViolation && getIpReusePolicy().blockSessionStartOnReuse) {
      await setDeviceWifiStateAsync(serial, false);
      updateDeviceState(serial, { prepMessage: "Reused IP detected after router join; Wi-Fi was disabled" });
      return sendJson(res, 409, {
        error: `Router join blocked: ${verification.publicIp.currentIp} was already used within the last ${verification.publicIp.reusePolicyWindowHours} hours.`,
        detail: verification.publicIp
      });
    }

    updateDeviceState(serial, {
      prepMessage: `Connected to ${router.label || router.id} with fresh IP ${verification.publicIp?.currentIp || restartGate.routerPublicIp || ""}`
    });
    logActivity("router-connect", `Phone connected to ${router.label || router.id} by ${user.username} after fresh IP verification`, serial);
    return sendJson(res, 200, {
      ok: true,
      detail: restartGate.reconnectResult?.payload || null,
      ipCheck: verification.publicIp,
      routerPublicIp: restartGate.routerPublicIp || ""
    });
  }

  if (action === "reset-uplink-ip") {
    const router = knownDevice.routerId ? getRouterConfig(knownDevice.routerId) : null;
    if (!router) {
      return sendJson(res, 409, { error: "Assign this phone to a router before resetting its uplink." });
    }
    return handleRouterAction(res, user, router.id, "cycle-uplink", body);
  }

  if (action === "prep") {
    if (!knownDevice.serial) {
      return sendJson(res, 404, { error: "Unknown device serial" });
    }
    if (routingGuard.blocked) {
      return sendJson(res, 409, { error: `Prep blocked: ${routingGuard.reasons.join(" | ")}`, routingGuard });
    }
    if (!knownDevice.online) {
      return sendJson(res, 409, { error: "Device must be online in ADB before prep." });
    }
    if (knownDevice.sessionState === "running") {
      return sendJson(res, 409, { error: "Stop the active session before starting prep." });
    }
    if ((state.queue || []).includes(serial)) {
      return sendJson(res, 200, { ok: true, alreadyQueued: true });
    }
    if (preparingSerial === serial) {
      return sendJson(res, 200, { ok: true, alreadyPreparing: true });
    }
    state.queue = [...(state.queue || []), serial];
    updateDeviceState(serial, {
      prepState: "queued",
      prepMessage: "Queued for prep",
      prepEnqueuedAt: new Date().toISOString(),
      prepStartedAt: "",
      prepFinishedAt: ""
    });
    logActivity("queue", `Device added to prep queue by ${user.username}`, serial);
    processPrepQueue();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 400, { error: `Unsupported action: ${action}` });
}

async function handleRouterAction(res, user, routerId, action, body) {
  const router = getRouterConfig(routerId);
  if (!router) {
    return sendJson(res, 404, { error: "Unknown router" });
  }

  const result = await executeRouterActionAsync(routerId, action, body);
  const ok = result.ok;
  logActivity("router", `${router.label || router.id} ${action} ${ok ? "completed" : "failed"} by ${user.username}`, null);

  if (action === "router-health") {
    return sendJson(res, 200, {
      ok,
      detail: result.payload || null,
      router: routerCache[routerId] || null,
      error: ok ? "" : (result.error || "Router health probe failed")
    });
  }

  if (!ok) {
    return sendJson(res, 500, { error: result.error || "Router action failed", detail: result.payload || null, router: routerCache[routerId] || null });
  }

  return sendJson(res, 200, { ok: true, detail: result.payload || null, router: routerCache[routerId] || null });
}

async function executeRouterActionAsync(routerId, action, body) {
  const router = getRouterConfig(routerId);
  if (!router) {
    return { ok: false, error: "Unknown router", payload: null };
  }

  const scriptName = action === "cycle-uplink" ? "cycle-mobile-uplink.ps1" : "invoke-routerfarm-router-action.ps1";
  const args = action === "cycle-uplink"
    ? ["-RouterId", routerId, "-PowerCycleSeconds", String(Number(body?.powerCycleSeconds) || settings.uplinkControl?.defaultPowerCycleSeconds || 12)]
    : ["-RouterId", routerId, "-Action", action, "-RoutersPath", WIN_ROUTERS_CONFIG_PATH, "-SettingsPath", WIN_SETTINGS_PATH];

  const script = await runProcess("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(WIN_SCRIPTS_DIR, scriptName),
    ...args
  ], {
    cwd: ROOT,
    windowsHide: true,
    timeoutMs: 60000
  });

  const payload = parseJsonPayload(script.stdout);
  const ok = script.status === 0 && payload?.ok;
  const healthStatus = deriveRouterHealthStatus(action, ok, payload, state.routers?.[routerId] || {});
  const nextState = {
    ...(state.routers?.[routerId] || {}),
    lastAction: action,
    lastResult: ok ? "ok" : "failed",
    lastCheckedAt: new Date().toISOString(),
    lastRestartAt: action === "reboot-router" && ok ? new Date().toISOString() : (state.routers?.[routerId]?.lastRestartAt || ""),
    healthStatus,
    detail: payload?.detail || payload?.message || String(script.stderr || "").trim(),
    routerMode: payload?.telemetry?.mode || state.routers?.[routerId]?.routerMode || "",
    uplinkMode: payload?.telemetry?.uplinkMode || state.routers?.[routerId]?.uplinkMode || "",
    uplinkInterface: payload?.telemetry?.uplinkInterface || state.routers?.[routerId]?.uplinkInterface || "",
    tetheringState: payload?.telemetry?.tetheringState || state.routers?.[routerId]?.tetheringState || "",
    tetheringError: payload?.telemetry?.tetheringError || state.routers?.[routerId]?.tetheringError || "",
    tetheringHint: payload?.telemetry?.tetheringHint || state.routers?.[routerId]?.tetheringHint || "",
    usbPorts: payload?.telemetry?.usbPorts || state.routers?.[routerId]?.usbPorts || "",
    wanUp: payload?.telemetry?.wanUp === undefined ? Boolean(state.routers?.[routerId]?.wanUp) : Boolean(payload?.telemetry?.wanUp),
    wanAddress: payload?.telemetry?.wanAddress || state.routers?.[routerId]?.wanAddress || "",
    wanDevice: payload?.telemetry?.wanDevice || state.routers?.[routerId]?.wanDevice || "",
    publicIp: payload?.telemetry?.publicIp || state.routers?.[routerId]?.publicIp || "",
    telemetryCheckedAt: action === "router-health" ? new Date().toISOString() : (state.routers?.[routerId]?.telemetryCheckedAt || "")
  };
  state.routers[routerId] = nextState;
  saveState();
  refreshRouters();

  return {
    ok,
    payload,
    router,
    error: payload?.message || String(script.stderr || script.stdout || "").trim() || "Router action failed"
  };
}

async function connectPhoneToRouterAsync(serial, router) {
  const script = await runProcess("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(WIN_SCRIPTS_DIR, "connect-phone-to-router.ps1"),
    "-Serial",
    serial,
    "-Ssid",
    String(router?.ssid || ""),
    "-Password",
    String(router?.wifiPassword || ""),
    "-SettingsPath",
    WIN_SETTINGS_PATH
  ], {
    cwd: ROOT,
    windowsHide: true,
    timeoutMs: 120000
  });

  const payload = parseJsonPayload(script.stdout);
  const manualAssist = Boolean(payload?.requiresManualAssist);
  const ok = manualAssist || (script.status === 0 && payload?.ok);
  return {
    ok,
    manualAssist,
    payload,
    error: payload?.message || String(script.stderr || script.stdout || "").trim() || "Phone-to-router connect failed."
  };
}

async function setDeviceWifiStateAsync(serial, enabled) {
  const script = await runProcess("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(WIN_SCRIPTS_DIR, "set-device-wifi-state.ps1"),
    "-Serial",
    serial,
    "-State",
    enabled ? "enable" : "disable",
    "-SettingsPath",
    WIN_SETTINGS_PATH
  ], {
    cwd: ROOT,
    windowsHide: true,
    timeoutMs: 20000
  });
  const payload = parseJsonPayload(script.stdout);
  return {
    ok: script.status === 0 && payload?.ok !== false,
    payload,
    error: payload?.message || String(script.stderr || script.stdout || "").trim() || `Failed to ${enabled ? "enable" : "disable"} Wi-Fi.`
  };
}

async function enforceRouterRestartBeforeSession(serial, user, device) {
  const policy = settings.sessionPolicy || DEFAULT_SETTINGS.sessionPolicy;
  const router = device.routerId ? getRouterConfig(device.routerId) : null;
  if (!router) {
    return { ok: false, error: "Assign this phone to a router before starting a session." };
  }

  const occupancyLock = buildRouterOccupancyLock(Object.values(deviceCache || {}), device);
  if (!occupancyLock.allowed) {
    updateDeviceState(serial, { prepMessage: occupancyLock.reason });
    return { ok: false, error: occupancyLock.reason };
  }

  if (!policy.restartRouterBeforeSession) {
    return { ok: true, skipped: true };
  }

  let lastError = "";
  let lastDetail = null;
  let previousRouterIp = isUsablePublicIp(state.routers?.[router.id]?.publicIp)
    ? String(state.routers[router.id].publicIp).trim()
    : "";

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    updateDeviceState(serial, {
      prepMessage: `Attempt ${attempt}/3: checking ${router.label || router.id} before LinkPro cycle`
    });
    const healthResult = await executeRouterActionAsync(router.id, "router-health", {});
    if (!healthResult.ok) {
      lastError = healthResult.error || `Router health check failed for ${router.label || router.id}`;
      lastDetail = healthResult.payload || null;
      continue;
    }

    const routerStateBeforeCycle = state.routers?.[router.id] || {};
    if (!previousRouterIp && isUsablePublicIp(routerStateBeforeCycle.publicIp)) {
      previousRouterIp = String(routerStateBeforeCycle.publicIp).trim();
    }

    updateDeviceState(serial, {
      prepMessage: `Attempt ${attempt}/3: cycling LinkPro uplink on ${router.label || router.id}`
    });
    const cycleResult = await executeRouterActionAsync(router.id, "cycle-uplink", {});
    if (!cycleResult.ok) {
      lastError = cycleResult.error || `LinkPro cycle failed for ${router.label || router.id}`;
      lastDetail = cycleResult.payload || null;
      continue;
    }

    logActivity("uplink", `${router.label || router.id} LinkPro uplink cycled automatically by ${user.username} (attempt ${attempt}/3)`, serial);
    await delay(Number(policy.reconnectWaitMs) || 8000);

    const postCycleHealth = await executeRouterActionAsync(router.id, "router-health", {});
    if (!postCycleHealth.ok) {
      lastError = postCycleHealth.error || `Router health check after LinkPro cycle failed for ${router.label || router.id}`;
      lastDetail = postCycleHealth.payload || null;
      continue;
    }

    const routerStateAfterCycle = state.routers?.[router.id] || {};
    const topologyGate = getRouterTopologyGate(router, routerStateAfterCycle);
    if (!topologyGate.ok) {
      lastError = topologyGate.error;
      lastDetail = topologyGate.detail || null;
      continue;
    }

    const nextRouterIp = isUsablePublicIp(routerStateAfterCycle.publicIp)
      ? String(routerStateAfterCycle.publicIp).trim()
      : "";
    if (!nextRouterIp) {
      lastError = `${router.label || router.id} did not report a usable public IP after the LinkPro cycle.`;
      continue;
    }
    if (previousRouterIp && nextRouterIp === previousRouterIp) {
      lastError = `${router.label || router.id} kept the same public IP ${nextRouterIp} after the LinkPro cycle.`;
      previousRouterIp = nextRouterIp;
      continue;
    }

    updateDeviceState(serial, {
      prepMessage: `Attempt ${attempt}/3: joining ${router.label || router.id} after fresh router IP ${nextRouterIp}`
    });
    const connectResult = await connectPhoneToRouterAsync(serial, router);
    if (!connectResult.ok) {
      lastError = connectResult.error || `Phone-to-router reconnect failed for ${router.label || router.id}`;
      lastDetail = connectResult.payload || null;
      await setDeviceWifiStateAsync(serial, false);
      continue;
    }

    logActivity("router-connect", `Phone connected to ${router.label || router.id} after automatic LinkPro cycle`, serial);
    await delay(Number(policy.reconnectWaitMs) || 8000);
    await refreshDevices();

    const refreshedDevice = deviceCache[serial] || buildMissingDevice(serial);
    const connectedSsid = String(connectResult.payload?.connectedSsid || "");
    if (!deviceLooksOnRouterWifi(refreshedDevice) && connectedSsid !== String(router.ssid || "")) {
      lastError = `Phone did not verify on router Wi-Fi after joining ${router.label || router.id}.`;
      await setDeviceWifiStateAsync(serial, false);
      continue;
    }

    updateDeviceState(serial, {
      prepMessage: `Fresh router IP ${nextRouterIp} verified on ${router.label || router.id}; waiting for phone-side IP verification`
    });
    return {
      ok: true,
      attempts: attempt,
      uplinkCycled: true,
      routerPublicIp: nextRouterIp,
      reconnectResult: connectResult
    };
  }

  updateDeviceState(serial, {
    prepMessage: lastError || `LinkPro fresh-IP gate failed for ${router.label || router.id}`
  });
  await setDeviceWifiStateAsync(serial, false);
  return {
    ok: false,
    error: lastError || `LinkPro fresh-IP gate failed for ${router.label || router.id}`,
    detail: lastDetail
  };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(Number(ms) || 0, 0)));
}

function buildMissingDevice(serial) {
  const ipPolicy = getIpReusePolicy();
  const existingPublicIp = state.devices?.[serial]?.publicIp || {
    currentIp: "",
    lastCheckedAt: "",
    status: "unknown",
    source: "",
    changedSinceLastPrep: false,
    duplicateWith: [],
    reusedRecently: false,
    reusedWithinLast100: [],
    last100History: [],
    reusePolicyViolation: false,
    reusePolicyLabel: "",
    reusePolicyWindowHours: ipPolicy.maxAgeHours,
    reusePolicyHistoryLimit: ipPolicy.historyLimit,
    location: null,
    lastError: "",
    lastReason: ""
  };
  const deviceConfig = getDeviceConfig(serial);
  return {
    serial,
    adbState: "unknown",
    online: false,
    model: "",
    product: "",
    transportId: "",
    nickname: deviceConfig.nickname || "",
    phoneNumber: deviceConfig.phoneNumber || null,
    role: normalizeDeviceRole(deviceConfig.role),
    parentHotspotSerial: deviceConfig.parentHotspotSerial || "",
    routerId: deviceConfig.routerId || "",
      routerSlot: parsePositiveIntegerOrNull(deviceConfig.routerSlot),
    network: state.devices?.[serial]?.network || {
      ipAddress: "",
      interface: "",
      source: "",
      status: "unknown",
      checkedAt: ""
    },
      publicIp: existingPublicIp,
      account: state.devices?.[serial]?.account || {
        gmail: "",
        status: "unknown",
        checkedAt: ""
      },
      prepState: state.devices?.[serial]?.prepState || "idle",
    prepEnqueuedAt: state.devices?.[serial]?.prepEnqueuedAt || "",
    prepStartedAt: state.devices?.[serial]?.prepStartedAt || "",
    prepFinishedAt: state.devices?.[serial]?.prepFinishedAt || "",
    lastPrepDurationMs: state.devices?.[serial]?.lastPrepDurationMs || 0,
    prepMessage: state.devices?.[serial]?.prepMessage || "",
    sessionState: state.devices?.[serial]?.sessionState || "stopped",
    viewerLaunch: state.devices?.[serial]?.viewerLaunch || {
      status: "unknown",
      sourceAction: "",
      requestedAt: "",
      confirmedAt: "",
      pid: null,
      processName: "",
      filePath: "",
      aliveAfterLaunch: false,
      windowReady: false,
      fallbackViewer: "",
      manualSelectionRequired: false,
      lastError: ""
    }
  };
}

function updateDeviceState(serial, patch) {
  const current = state.devices[serial] || {};
  state.devices[serial] = { ...current, ...patch, updatedAt: new Date().toISOString() };
  saveState();
  scheduleRefreshDevices();
}

async function refreshDevices() {
  if (deviceRefreshInFlight) {
    return;
  }

  deviceRefreshInFlight = true;
  try {
  const previous = deviceCache;
  const rows = await queryAdbDevicesAsync();
  const next = {};
  const networkRefreshSet = selectProbeRefreshSerials(
    rows,
    previous,
    "network",
    Number(settings.ipRefreshIntervalMs) || 15000,
    Number(settings.deviceRefresh?.networkChecksPerPass) || 4
  );
  const accountRefreshSet = selectProbeRefreshSerials(
    rows,
    previous,
    "account",
    Number(settings.deviceRefresh?.accountRefreshIntervalMs) || 30000,
    Number(settings.deviceRefresh?.accountChecksPerPass) || 2
  );
  for (const serial of selectPriorityAccountRefreshSerials(rows, previous, 4)) {
    accountRefreshSet.add(serial);
  }

  const resolvedRows = await Promise.all(rows.map(async row => {
    const stored = state.devices[row.serial] || {};
    const metadata = ensurePermanentDeviceAssignment(row.serial);
    const fallbackNetwork = {
      ipAddress: "",
      interface: "",
      source: "",
      status: row.state === "device" ? "pending" : "offline",
      checkedAt: ""
    };
    const fallbackAccount = {
      gmail: "",
      status: row.state === "device" ? "unknown" : "offline",
      checkedAt: ""
    };
    const previousAccount = getCachedProbeValue(previous, row.serial, "account", fallbackAccount);
    const needsNetworkRefresh = row.state === "device" && networkRefreshSet.has(row.serial);
    const needsAccountRefresh = row.state === "device" && accountRefreshSet.has(row.serial);
    const bundle = (needsNetworkRefresh || needsAccountRefresh)
      ? await queryDeviceProbeBundleAsync(row.serial, true, {
          includeNetwork: needsNetworkRefresh,
          includeAccount: needsAccountRefresh
        })
      : null;
    const network = row.state !== "device"
      ? queryDeviceNetwork(row.serial, false)
      : (needsNetworkRefresh
          ? (bundle?.network || fallbackNetwork)
          : getCachedProbeValue(previous, row.serial, "network", fallbackNetwork));
    const account = row.state !== "device"
      ? queryDeviceGoogleAccount(row.serial, false)
      : (needsAccountRefresh
          ? selectBestAccountProbe(bundle?.account || fallbackAccount, previousAccount)
          : previousAccount);
    return {
      metadata,
      device: {
        serial: row.serial,
        adbState: row.state,
        online: row.state === "device",
        model: row.model || "",
        product: row.product || "",
        deviceName: row.deviceName || "",
        transportId: row.transportId || "",
        nickname: metadata.nickname || "",
        phoneNumber: metadata.phoneNumber || null,
        role: normalizeDeviceRole(metadata.role),
        parentHotspotSerial: metadata.parentHotspotSerial || "",
        routerId: metadata.routerId || "",
        routerSlot: parsePositiveIntegerOrNull(metadata.routerSlot),
        network,
        account,
        publicIp: stored.publicIp || previous[row.serial]?.publicIp || buildMissingDevice(row.serial).publicIp,
        prepState: stored.prepState || "idle",
        prepEnqueuedAt: stored.prepEnqueuedAt || "",
        prepStartedAt: stored.prepStartedAt || "",
        prepFinishedAt: stored.prepFinishedAt || "",
        lastPrepDurationMs: stored.lastPrepDurationMs || 0,
        prepMessage: stored.prepMessage || "",
        sessionState: stored.sessionState || "stopped",
        sessionStartedAt: stored.sessionStartedAt || "",
        sessionStoppedAt: stored.sessionStoppedAt || "",
        viewerLaunch: stored.viewerLaunch || buildMissingDevice(row.serial).viewerLaunch,
        lastSeenAt: new Date().toISOString()
      }
    };
  }));

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const nextRow = resolvedRows[index];
    const metadata = nextRow?.metadata || getDeviceConfig(row.serial);
    next[row.serial] = nextRow?.device || buildMissingDevice(row.serial);

    const previousState = previous[row.serial]?.adbState;
    if (previousState && previousState !== row.state) {
      logActivity("device", `ADB state changed from ${previousState} to ${row.state}`, row.serial);
    }
    if (shouldAutoConnectRouterWifi(row.serial, row, metadata, previous[row.serial])) {
      scheduleAutoRouterWifiConnect(row.serial, metadata.routerId ? getRouterConfig(metadata.routerId) : null);
    }
  }

  for (const serial of Object.keys(previous)) {
    if (!next[serial]) {
      const preserved = buildMissingDevice(serial);
      preserved.prepMessage = "Device not currently visible in ADB";
      preserved.network = {
        ipAddress: "",
        interface: "",
        source: "",
        status: "offline",
        checkedAt: new Date().toISOString()
      };
      preserved.publicIp = state.devices?.[serial]?.publicIp || previous[serial]?.publicIp || preserved.publicIp;
      next[serial] = preserved;
      if (previous[serial].online) {
        logActivity("disconnect", "Device disconnected from ADB", serial);
      }
    }
  }

  deviceCache = next;
  refreshRouters();
  } catch (error) {
    logActivity("warning", `Device refresh failed: ${error.message}`);
  } finally {
    deviceRefreshInFlight = false;
  }
}

function selectBestAccountProbe(nextAccount, previousAccount) {
  const current = nextAccount || {};
  const previous = previousAccount || {};
  if ((current.status === "unavailable" || current.status === "unknown") && previous.gmail) {
    return {
      gmail: previous.gmail,
      status: previous.status || "assigned",
      checkedAt: current.checkedAt || previous.checkedAt || ""
    };
  }
  return current;
}

function refreshRouters() {
  const next = {};
  for (const router of listConfiguredRouters()) {
    const assignedDevices = getAssignedDevicesForRouter(router.id);
    const activeDevice = assignedDevices.find(device => device.sessionState === "running") || null;
    const routerState = state.routers?.[router.id] || {};
    next[router.id] = {
      id: router.id,
      label: router.label || router.id,
      host: router.host || "",
      enabled: router.enabled !== false,
      assignedDeviceCount: assignedDevices.length,
      activeDeviceSerial: activeDevice?.serial || "",
      overAssigned: assignedDevices.length > (Number(router.maxAssignedDevices) || 4),
      lastAction: routerState.lastAction || "",
      lastResult: routerState.lastResult || "",
      lastCheckedAt: routerState.lastCheckedAt || "",
      healthStatus: routerState.healthStatus || "unknown",
      detail: routerState.detail || "",
      reachability: routerState.reachability || { ssh: false, http: false, https: false },
      routerMode: routerState.routerMode || "",
      uplinkMode: routerState.uplinkMode || "",
      uplinkInterface: routerState.uplinkInterface || "",
      tetheringState: routerState.tetheringState || "",
      tetheringError: routerState.tetheringError || "",
      tetheringHint: routerState.tetheringHint || "",
      usbPorts: routerState.usbPorts || "",
      wanUp: Boolean(routerState.wanUp),
      wanAddress: routerState.wanAddress || "",
      wanDevice: routerState.wanDevice || "",
      publicIp: routerState.publicIp || "",
      telemetryCheckedAt: routerState.telemetryCheckedAt || ""
    };
  }
  routerCache = next;
}

async function refreshRouterHealth() {
  if (routerHealthRefreshInFlight) {
    return;
  }

  routerHealthRefreshInFlight = true;
  try {
    const routers = listConfiguredRouters().filter(router => router.enabled !== false);
    const results = [];
    const concurrency = 3;
    for (let i = 0; i < routers.length; i += concurrency) {
      const batch = routers.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(probeRouterHealth));
      results.push(...batchResults);
    }
    for (const result of results) {
      const current = state.routers?.[result.id] || {};
      state.routers[result.id] = {
        ...current,
        lastCheckedAt: result.checkedAt,
        healthStatus: result.healthStatus,
        detail: result.detail,
        reachability: result.reachability
      };
    }
    saveState();
    refreshRouters();
  } catch (error) {
    logActivity("router", `Router health refresh failed: ${error.message}`);
  } finally {
    routerHealthRefreshInFlight = false;
  }
}

async function probeRouterHealth(router) {
  const host = String(router.host || "").trim();
  const checkedAt = new Date().toISOString();
  if (!host) {
    return {
      id: router.id,
      checkedAt,
      healthStatus: "unconfigured",
      detail: "Router host is not configured.",
      reachability: { ssh: false, http: false, https: false }
    };
  }

  const sshPort = Number(router.sshPort) || Number(settings.routerControl?.defaultPort) || 22;
  const [ssh, http, https] = await Promise.all([
    probeTcpPort(host, sshPort, 1200),
    probeTcpPort(host, 80, 1200),
    probeTcpPort(host, 443, 1200)
  ]);

  const reachability = {
    ssh: ssh.open,
    http: http.open,
    https: https.open
  };
  const openCount = [reachability.ssh, reachability.http, reachability.https].filter(Boolean).length;
  const healthStatus = openCount === 0 ? "offline" : (reachability.ssh ? "online" : "partial");
  const detail = [
    `SSH ${sshPort}: ${reachability.ssh ? "open" : "closed"}`,
    `HTTP 80: ${reachability.http ? "open" : "closed"}`,
    `HTTPS 443: ${reachability.https ? "open" : "closed"}`
  ].join(" | ");

  return {
    id: router.id,
    checkedAt,
    healthStatus,
    detail,
    reachability
  };
}

function probeTcpPort(host, port, timeoutMs) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let settled = false;
    const finalize = open => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch (error) {
        // Ignore socket cleanup errors.
      }
      resolve({ open });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finalize(true));
    socket.once("timeout", () => finalize(false));
    socket.once("error", () => finalize(false));
    socket.connect(port, host);
  });
}

function applyDuplicateFlags(devices) {
  const serialsByIp = new Map();
  for (const device of devices) {
    const ip = device.publicIp?.currentIp;
    if (!ip) continue;
    const serials = serialsByIp.get(ip) || [];
    serials.push(device.serial);
    serialsByIp.set(ip, serials);
  }

  return devices.map(device => {
    const ip = device.publicIp?.currentIp || "";
    const serials = ip ? (serialsByIp.get(ip) || []) : [];
    const duplicateWith = serials.filter(serial => serial !== device.serial);
    const duplicate = duplicateWith.length > 0;
    return {
      ...device,
      publicIp: {
        ...(device.publicIp || {}),
        duplicateWith,
        status: duplicate && (device.publicIp?.status === "verified" || device.publicIp?.status === "changed")
          ? "duplicate"
          : (device.publicIp?.status || "unknown")
      }
    };
  });
}

function getRecentSuccessfulIpEntries(limit) {
  const maxAgeHours = Number(settings.ipReusePolicy?.maxAgeHours) || 72;
  const cutoffMs = Date.now() - (maxAgeHours * 60 * 60 * 1000);
  const entries = [];
  for (const [serial, history] of Object.entries(deviceIpHistory.devices || {})) {
    for (const entry of history.entries || []) {
      if (!entry.ip) continue;
      if (entry.status === "failed") continue;
      const timestampMs = new Date(entry.timestamp || 0).getTime();
      if (!timestampMs || Number.isNaN(timestampMs) || timestampMs < cutoffMs) continue;
      entries.push({
        serial,
        ip: entry.ip,
        timestamp: entry.timestamp || "",
        reason: entry.reason || "",
        source: entry.source || ""
      });
    }
  }

  entries.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
  return entries.slice(0, limit);
}

function getIpReusePolicy() {
  return {
    historyLimit: Math.max(Number(settings.ipReusePolicy?.historyLimit) || 100, 1),
    maxAgeHours: Math.max(Number(settings.ipReusePolicy?.maxAgeHours) || 72, 1),
    blockSessionStartOnReuse: settings.ipReusePolicy?.blockSessionStartOnReuse !== false
  };
}

async function queryAdbDevicesAsync() {
  const adbPath = settings.adbPath || "adb";
  const result = await runProcess(adbPath, ["devices", "-l"], {
    cwd: ROOT,
    windowsHide: true,
    timeoutMs: 8000
  });
  if (result.error) {
    logMissingToolOnce("adb", result.error.message);
    return [];
  }
  const output = String(result.stdout || "").trim();
  if (!output) {
    return [];
  }
  return output
    .split(/\r?\n/)
    .slice(1)
    .map(line => line.trim())
    .filter(Boolean)
    .map(parseAdbLine)
    .filter(Boolean);
}

function getCachedProbeValue(previous, serial, key, fallback) {
  return state.devices?.[serial]?.[key] || previous[serial]?.[key] || fallback;
}

function getProbeAgeMs(probe) {
  const checkedAt = new Date(probe?.checkedAt || 0).getTime();
  if (!checkedAt || Number.isNaN(checkedAt)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(Date.now() - checkedAt, 0);
}

function shouldPrioritizeAccountProbe(row, previousDevice, previousAccount) {
  if (row?.state !== "device") {
    return false;
  }

  const account = previousAccount || {};
  const status = String(account.status || "").toLowerCase();
  const gmail = String(account.gmail || "").trim();
  const missingAssignedEmail = !gmail && ["", "unknown", "unassigned", "unavailable", "offline"].includes(status);
  const newlyOnline = previousDevice?.adbState && previousDevice.adbState !== "device";

  if (!newlyOnline && !missingAssignedEmail) {
    return false;
  }

  return getProbeAgeMs(account) >= 5000;
}

function selectPriorityAccountRefreshSerials(rows, previous, limit = 4) {
  const effectiveLimit = Math.max(Number(limit) || 0, 0);
  if (!effectiveLimit) {
    return new Set();
  }

  const candidates = rows
    .filter(row => row.state === "device")
    .map(row => {
      const previousDevice = previous[row.serial] || state.devices?.[row.serial] || null;
      const previousAccount = getCachedProbeValue(previous, row.serial, "account", null);
      return {
        serial: row.serial,
        newlyOnline: Boolean(previousDevice?.adbState && previousDevice.adbState !== "device"),
        ageMs: getProbeAgeMs(previousAccount),
        priority: shouldPrioritizeAccountProbe(row, previousDevice, previousAccount)
      };
    })
    .filter(entry => entry.priority)
    .sort((a, b) => {
      if (a.newlyOnline !== b.newlyOnline) {
        return a.newlyOnline ? -1 : 1;
      }
      return b.ageMs - a.ageMs;
    })
    .slice(0, effectiveLimit);

  return new Set(candidates.map(entry => entry.serial));
}

function selectProbeRefreshSerials(rows, previous, key, staleAfterMs, limit) {
  const effectiveLimit = Math.max(Number(limit) || 0, 0);
  if (!effectiveLimit) {
    return new Set();
  }

  const candidates = rows
    .filter(row => row.state === "device")
    .map(row => ({
      serial: row.serial,
      ageMs: getProbeAgeMs(getCachedProbeValue(previous, row.serial, key, null))
    }))
    .filter(entry => entry.ageMs >= staleAfterMs)
    .sort((a, b) => b.ageMs - a.ageMs)
    .slice(0, effectiveLimit);

  return new Set(candidates.map(entry => entry.serial));
}

function logMissingToolOnce(tool, message) {
  const key = `${tool}:${message}`;
  if (!missingTools.has(key)) {
    missingTools.add(key);
    logActivity("warning", `${tool} unavailable: ${message}`);
  }
}

function parseAdbLine(line) {
  const parts = line.split(/\s+/);
  if (parts.length < 2) return null;
  const info = {
    serial: parts[0],
    state: parts[1],
    model: "",
    product: "",
    deviceName: "",
    transportId: ""
  };
  for (const token of parts.slice(2)) {
    const [key, value] = token.split(":");
    if (!value) continue;
    if (key === "model") info.model = value;
    if (key === "product") info.product = value;
    if (key === "device") info.deviceName = value;
    if (key === "transport_id") info.transportId = value;
  }
  return info;
}

function parseGoogleAccountOutput(output) {
  const normalized = String(output || "");
  const match = normalized.match(/Account\s+\{name=([^,]+),\s*type=com\.google\}/i);
  if (match) {
    return {
      gmail: match[1].trim(),
      status: "assigned"
    };
  }

  return {
    gmail: "",
    status: normalized.trim() ? "unassigned" : "unavailable"
  };
}

function queryDeviceProbeBundle(serial, online, { includeNetwork = true, includeAccount = true } = {}) {
  const checkedAt = new Date().toISOString();
  const offlineNetwork = {
    ipAddress: "",
    interface: "",
    source: "",
    status: "offline",
    checkedAt
  };
  const offlineAccount = {
    gmail: "",
    status: "offline",
    checkedAt
  };

  if (!online) {
    return {
      network: offlineNetwork,
      account: offlineAccount
    };
  }

  const segments = [];
  if (includeNetwork) {
    segments.push(["PF_IP_ROUTE", "ip route 2>/dev/null"]);
    segments.push(["PF_IP_ADDR", "ip -f inet addr show 2>/dev/null"]);
    segments.push(["PF_PROP_WLAN0", "getprop dhcp.wlan0.ipaddress 2>/dev/null"]);
    segments.push(["PF_PROP_RMNET", "getprop dhcp.rmnet_data0.ipaddress 2>/dev/null"]);
  }
  if (includeAccount) {
    segments.push(["PF_ACCOUNT", "dumpsys account 2>/dev/null"]);
  }

  const shellScript = segments
    .map(([marker, command]) => `echo __${marker}__; ${command}`)
    .join("; ");

  const result = spawnSync(settings.adbPath || "adb", ["-s", serial, "shell", "sh", "-c", shellScript], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: 12000
  });

  if (result.error || result.status !== 0) {
    return {
      network: includeNetwork ? {
        ipAddress: "",
        interface: "",
        source: "",
        status: "unresolved",
        checkedAt
      } : offlineNetwork,
      account: includeAccount ? {
        gmail: "",
        status: "unavailable",
        checkedAt
      } : offlineAccount
    };
  }

  const output = String(result.stdout || "");
  const markerPattern = /^__(PF_[A-Z0-9_]+)__$/;
  const grouped = {};
  let currentMarker = "";
  for (const line of output.split(/\r?\n/)) {
    const markerMatch = line.trim().match(markerPattern);
    if (markerMatch) {
      currentMarker = markerMatch[1];
      if (!grouped[currentMarker]) {
        grouped[currentMarker] = [];
      }
      continue;
    }
    if (!currentMarker) {
      continue;
    }
    grouped[currentMarker].push(line);
  }

  let network = offlineNetwork;
  if (includeNetwork) {
    const attempts = [
      ["ip-route", grouped.PF_IP_ROUTE || []],
      ["ip-addr", grouped.PF_IP_ADDR || []],
      ["getprop-wlan0", grouped.PF_PROP_WLAN0 || []],
      ["getprop-rmnet", grouped.PF_PROP_RMNET || []]
    ];

    network = {
      ipAddress: "",
      interface: "",
      source: "",
      status: "unresolved",
      checkedAt
    };

    for (const [source, lines] of attempts) {
      const parsed = parseNetworkOutput(lines.join("\n"), source);
      if (parsed.ipAddress) {
        network = {
          ipAddress: parsed.ipAddress,
          interface: parsed.interface,
          source,
          status: "ok",
          checkedAt
        };
        break;
      }
    }
  }

  let account = offlineAccount;
  if (includeAccount) {
    const parsedAccount = parseGoogleAccountOutput((grouped.PF_ACCOUNT || []).join("\n"));
    account = {
      gmail: parsedAccount.gmail,
      status: parsedAccount.status,
      checkedAt
    };
  }

  return { network, account };
}

async function queryDeviceProbeBundleAsync(serial, online, { includeNetwork = true, includeAccount = true } = {}) {
  const checkedAt = new Date().toISOString();
  const offlineNetwork = {
    ipAddress: "",
    interface: "",
    source: "",
    status: "offline",
    checkedAt
  };
  const offlineAccount = {
    gmail: "",
    status: "offline",
    checkedAt
  };

  if (!online) {
    return {
      network: offlineNetwork,
      account: offlineAccount
    };
  }

  const segments = [];
  if (includeNetwork) {
    segments.push(["PF_IP_ROUTE", "ip route 2>/dev/null"]);
    segments.push(["PF_IP_ADDR", "ip -f inet addr show 2>/dev/null"]);
    segments.push(["PF_PROP_WLAN0", "getprop dhcp.wlan0.ipaddress 2>/dev/null"]);
    segments.push(["PF_PROP_RMNET", "getprop dhcp.rmnet_data0.ipaddress 2>/dev/null"]);
  }
  if (includeAccount) {
    segments.push(["PF_ACCOUNT", "dumpsys account 2>/dev/null"]);
  }

  const shellScript = segments
    .map(([marker, command]) => `echo __${marker}__; ${command}`)
    .join("; ");

  const result = await runProcess(settings.adbPath || "adb", ["-s", serial, "shell", "sh", "-c", shellScript], {
    cwd: ROOT,
    windowsHide: true,
    timeoutMs: 12000
  });

  if (result.error || result.status !== 0) {
    return {
      network: includeNetwork ? {
        ipAddress: "",
        interface: "",
        source: "",
        status: "unresolved",
        checkedAt
      } : offlineNetwork,
      account: includeAccount ? {
        gmail: "",
        status: "unavailable",
        checkedAt
      } : offlineAccount
    };
  }

  const output = String(result.stdout || "");
  const markerPattern = /^__(PF_[A-Z0-9_]+)__$/;
  const grouped = {};
  let currentMarker = "";
  for (const line of output.split(/\r?\n/)) {
    const markerMatch = line.trim().match(markerPattern);
    if (markerMatch) {
      currentMarker = markerMatch[1];
      if (!grouped[currentMarker]) {
        grouped[currentMarker] = [];
      }
      continue;
    }
    if (!currentMarker) {
      continue;
    }
    grouped[currentMarker].push(line);
  }

  let network = offlineNetwork;
  if (includeNetwork) {
    const attempts = [
      ["ip-route", grouped.PF_IP_ROUTE || []],
      ["ip-addr", grouped.PF_IP_ADDR || []],
      ["getprop-wlan0", grouped.PF_PROP_WLAN0 || []],
      ["getprop-rmnet", grouped.PF_PROP_RMNET || []]
    ];

    network = {
      ipAddress: "",
      interface: "",
      source: "",
      status: "unresolved",
      checkedAt
    };

    for (const [source, lines] of attempts) {
      const parsed = parseNetworkOutput(lines.join("\n"), source);
      if (parsed.ipAddress) {
        network = {
          ipAddress: parsed.ipAddress,
          interface: parsed.interface,
          source,
          status: "ok",
          checkedAt
        };
        break;
      }
    }
  }

  let account = offlineAccount;
  if (includeAccount) {
    const parsedAccount = parseGoogleAccountOutput((grouped.PF_ACCOUNT || []).join("\n"));
    account = {
      gmail: parsedAccount.gmail,
      status: parsedAccount.status,
      checkedAt
    };
  }

  return { network, account };
}

function queryDeviceNetwork(serial, online) {
  return queryDeviceProbeBundle(serial, online, { includeNetwork: true, includeAccount: false }).network;
}

function queryDeviceGoogleAccount(serial, online) {
  return queryDeviceProbeBundle(serial, online, { includeNetwork: false, includeAccount: true }).account;
}

function parseNetworkOutput(output, source) {
  const normalized = String(output || "").trim();
  if (!normalized) {
    return { ipAddress: "", interface: "" };
  }

  const isUsableNetworkCandidate = (ipAddress, interfaceName) => {
    const ip = String(ipAddress || "").trim();
    const iface = String(interfaceName || "").trim().replace(/:+$/, "").toLowerCase();
    if (!ip || !iface) {
      return false;
    }
    if (iface === "lo" || iface === "loopback" || iface === "dummy0") {
      return false;
    }
    if (ip === "127.0.0.1" || ip.startsWith("127.")) {
      return false;
    }
    if (ip === "0.0.0.0" || ip.startsWith("169.254.")) {
      return false;
    }
    return true;
  };

  if (source === "ip-route") {
    const lines = normalized.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3}).*?\bdev\s+([A-Za-z0-9_.:-]+)/);
      if (match) {
        if (isUsableNetworkCandidate(match[1], match[2])) {
          return { ipAddress: match[1], interface: match[2] };
        }
      }
      const fallback = line.match(/\bdev\s+([A-Za-z0-9_.:-]+).*?\bsrc\s+(\d{1,3}(?:\.\d{1,3}){3})/);
      if (fallback) {
        if (isUsableNetworkCandidate(fallback[2], fallback[1])) {
          return { ipAddress: fallback[2], interface: fallback[1] };
        }
      }
    }
  }

  if (source === "ip-addr") {
    const blocks = normalized.split(/\r?\n(?=\d+:\s)/);
    for (const block of blocks) {
      const headerMatch = block.match(/^\d+:\s+([A-Za-z0-9_.:-]+)/m);
      const ipMatch = block.match(/\binet\s+(\d{1,3}(?:\.\d{1,3}){3})\/\d+/m);
      const interfaceName = String(headerMatch?.[1] || "").replace(/:+$/, "");
      const ipAddress = ipMatch?.[1] || "";
      if (isUsableNetworkCandidate(ipAddress, interfaceName)) {
        return { ipAddress, interface: interfaceName };
      }
    }
    const alt = normalized.match(/\d+:\s+([A-Za-z0-9_.:-]+).*?inet\s+(\d{1,3}(?:\.\d{1,3}){3})\/\d+/s);
    if (alt) {
      const interfaceName = String(alt[1] || "").replace(/:+$/, "");
      if (isUsableNetworkCandidate(alt[2], interfaceName)) {
        return { ipAddress: alt[2], interface: interfaceName };
      }
    }
  }

  if (source.startsWith("getprop")) {
    const match = normalized.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
    if (match) {
      const interfaceName = source.includes("wlan0") ? "wlan0" : "rmnet_data0";
      if (isUsableNetworkCandidate(match[1], interfaceName)) {
        return { ipAddress: match[1], interface: interfaceName };
      }
    }
  }

  return { ipAddress: "", interface: "" };
}

async function runDevicePublicIpCheck(serial, reason) {
  if (ipCheckPromises.has(serial)) {
    return ipCheckPromises.get(serial);
  }

  const promise = Promise.resolve().then(() => performDevicePublicIpCheck(serial, reason));
  ipCheckPromises.set(serial, promise);
  try {
    return await promise;
  } finally {
    ipCheckPromises.delete(serial);
  }
}

async function lookupPublicIpLocation(ip) {
  if (!isUsablePublicIp(ip)) {
    return null;
  }

  try {
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(7000),
      headers: {
        "User-Agent": "RouterFarm/20260418"
      }
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    if (!payload || payload.success === false) {
      return null;
    }
    const timezoneValue = typeof payload.timezone === "object"
      ? (payload.timezone.id || payload.timezone.name || "")
      : String(payload.timezone || "");
    const location = {
      city: String(payload.city || ""),
      region: String(payload.region || payload.regionName || ""),
      country: String(payload.country || ""),
      timezone: timezoneValue,
      source: "ipwho.is",
      checkedAt: new Date().toISOString()
    };
    return mergePublicIpLocation({}, location).location;
  } catch (error) {
    return null;
  }
}

async function performDevicePublicIpCheck(serial, reason) {
  const startedAt = new Date().toISOString();
  const deviceState = state.devices?.[serial] || {};
  const history = ensureDeviceIpHistory(serial);
  const ipPolicy = getIpReusePolicy();
  const helperResult = await runProcess("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(WIN_SCRIPTS_DIR, "check-device-ip.ps1"),
    "-Serial",
    serial,
    "-SettingsPath",
    WIN_SETTINGS_PATH
  ], {
    cwd: ROOT,
    windowsHide: true,
    timeoutMs: 70000
  });

  let helperPayload;
  let resolvedIp = "";
  let resolvedSource = "";
  let failure = "";
  try {
    helperPayload = JSON.parse(String(helperResult.stdout || "{}").trim() || "{}");
  } catch (_e) {
    helperPayload = null;
  }

  if (helperPayload?.success) {
    resolvedIp = helperPayload.ip || "";
    resolvedSource = helperPayload.source || "";
  } else {
    failure = helperPayload?.error || helperResult.error?.message || String(helperResult.stderr || helperResult.stdout || "").trim() || "No device-side IP method succeeded.";
  }

  const checkedAt = new Date().toISOString();
  if (!resolvedIp) {
    const failedState = {
      currentIp: deviceState.publicIp?.currentIp || "",
      lastCheckedAt: checkedAt,
      status: "failed",
      source: resolvedSource,
      changedSinceLastPrep: Boolean(deviceState.publicIp?.changedSinceLastPrep),
      duplicateWith: [],
      reusedRecently: Boolean(deviceState.publicIp?.reusedRecently),
      reusedWithinLast100: deviceState.publicIp?.reusedWithinLast100 || deviceState.publicIp?.reusedWithinLast50 || [],
      last100History: deviceState.publicIp?.last100History || deviceState.publicIp?.last50History || [],
      reusePolicyViolation: Boolean(deviceState.publicIp?.reusePolicyViolation),
      reusePolicyLabel: deviceState.publicIp?.reusePolicyLabel || "",
      reusePolicyWindowHours: ipPolicy.maxAgeHours,
      reusePolicyHistoryLimit: ipPolicy.historyLimit,
      location: deviceState.publicIp?.location || null,
      lastError: failure || "Public IP lookup failed on device side.",
      lastReason: reason
    };
    updateDeviceState(serial, { publicIp: failedState });
    history.entries = [
      {
        timestamp: checkedAt,
        ip: "",
        reason,
        source: resolvedSource,
        status: "failed",
        error: failedState.lastError
      },
      ...(history.entries || [])
    ].slice(0, ipPolicy.historyLimit);
    saveDeviceIpHistory();
    logIpCheck(`FAILED reason=${reason} error=${failedState.lastError}`, serial);
    logActivity("ip-check", `Public IP check failed: ${failedState.lastError}`, serial);
    return { success: false, error: failedState.lastError, publicIp: failedState };
  }

  const previousSuccessfulPrepIp = history.lastSuccessfulPrepIp || "";
  const changedSinceLastPrep = Boolean(previousSuccessfulPrepIp && previousSuccessfulPrepIp !== resolvedIp);
  let status = changedSinceLastPrep ? "changed" : "verified";
  const currentOtherDevices = Object.values(deviceCache).filter(device => device.serial !== serial);
  const duplicateWith = currentOtherDevices
    .filter(device => device.publicIp?.currentIp && device.publicIp.currentIp === resolvedIp)
    .map(device => device.serial);
  const recentSuccessfulEntries = getRecentSuccessfulIpEntries(ipPolicy.historyLimit);
  const reusedWithinLast100 = recentSuccessfulEntries
    .filter(entry => entry.ip === resolvedIp && entry.serial !== serial)
    .slice(0, 10);
  const reusedRecently = reusedWithinLast100.length > 0;
  const reusePolicyViolation = reusedRecently;
  const reusePolicyLabel = reusePolicyViolation
    ? `Seen in last ${ipPolicy.historyLimit} IPs / ${ipPolicy.maxAgeHours}h`
    : "";
  if (duplicateWith.length) {
    status = "duplicate";
  } else if (reusePolicyViolation) {
    status = "reused";
  }

  let publicIpState = {
    currentIp: resolvedIp,
    lastCheckedAt: checkedAt,
    status,
    source: resolvedSource,
    changedSinceLastPrep,
    duplicateWith,
    reusedRecently,
    reusedWithinLast100,
    last100History: recentSuccessfulEntries,
    reusePolicyViolation,
    reusePolicyLabel,
    reusePolicyWindowHours: ipPolicy.maxAgeHours,
    reusePolicyHistoryLimit: ipPolicy.historyLimit,
    lastError: "",
    lastReason: reason
  };
  publicIpState = mergePublicIpLocation(publicIpState, await lookupPublicIpLocation(resolvedIp));

  updateDeviceState(serial, { publicIp: publicIpState });

  history.entries = [
    {
      timestamp: checkedAt,
      ip: resolvedIp,
      reason,
      source: resolvedSource,
      status,
      changedSinceLastPrep,
      duplicateWith,
      reusedRecently
    },
    ...(history.entries || [])
  ].slice(0, ipPolicy.historyLimit);
  history.lastSuccessfulIp = resolvedIp;
  history.lastVerifiedAt = checkedAt;
  if (reason === "post-prep") {
    history.lastSuccessfulPrepIp = resolvedIp;
    history.lastSuccessfulPrepAt = checkedAt;
  }
  saveDeviceIpHistory();

  logIpCheck(`SUCCESS startedAt=${startedAt} reason=${reason} ip=${resolvedIp} status=${status} source=${resolvedSource}`, serial);
  logActivity("ip-check", `Public IP ${resolvedIp} verified via ${resolvedSource} (${status})`, serial);
  return { success: true, publicIp: publicIpState };
}

function ensureDeviceIpHistory(serial) {
  if (!deviceIpHistory.devices) {
    deviceIpHistory.devices = {};
  }
  if (!deviceIpHistory.devices[serial]) {
    deviceIpHistory.devices[serial] = {
      entries: [],
      lastSuccessfulIp: "",
      lastSuccessfulPrepIp: "",
      lastVerifiedAt: "",
      lastSuccessfulPrepAt: ""
    };
  }
  return deviceIpHistory.devices[serial];
}

function parsePublicIp(output) {
  const normalized = String(output || "").trim();
  const ipv4 = normalized.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  if (ipv4) return ipv4[0];
  const ipv6 = normalized.match(/\b(?:[a-fA-F0-9]{1,4}:){2,}[a-fA-F0-9]{1,4}\b/);
  if (ipv6) return ipv6[0];
  return "";
}

function processPrepQueue() {
  if (preparingSerial || !(state.queue || []).length) return;
  const serial = state.queue[0];
  const queuedDevice = deviceCache[serial] || buildMissingDevice(serial);
  if (!queuedDevice.online) {
    state.queue = state.queue.slice(1);
    updateDeviceState(serial, {
      prepState: "failed",
      prepMessage: "Prep skipped because the device is offline in ADB.",
      prepStartedAt: "",
      prepFinishedAt: new Date().toISOString()
    });
    logActivity("queue", "Prep skipped because the device is offline in ADB", serial);
    processPrepQueue();
    return;
  }
  const prepStartedAt = new Date().toISOString();
  preparingSerial = serial;
  state.queue = state.queue.slice(1);
  updateDeviceState(serial, {
    prepState: "preparing",
    prepMessage: "Prep workflow in progress",
    prepStartedAt,
    prepFinishedAt: ""
  });
  logActivity("queue", "Prep worker claimed queued device", serial);

  const child = runPowerShellScript(
    "prep-device-session.ps1",
    ["-Serial", serial, "-SettingsPath", WIN_SETTINGS_PATH, "-ActivityLogPath", WIN_ACTIVITY_LOG_PATH],
    { detached: false }
  );

  const PREP_TIMEOUT_MS = 480000;
  let prepExitHandled = false;
  const prepTimeout = setTimeout(() => {
    if (prepExitHandled) return;
    prepExitHandled = true;
    try { child.kill(); } catch (_e) { /* ignore */ }
    const prepFinishedAt = new Date().toISOString();
    const prepDurationMs = Math.max(0, new Date(prepFinishedAt).getTime() - new Date(prepStartedAt).getTime());
    updateDeviceState(serial, {
      prepState: "failed",
      prepMessage: "Prep timed out after 8 minutes",
      prepFinishedAt,
      lastPrepDurationMs: prepDurationMs
    });
    logActivity("queue", `Prep timed out after ${formatDuration(prepDurationMs)}`, serial);
    preparingSerial = null;
    processPrepQueue();
  }, PREP_TIMEOUT_MS);

  child.on("error", error => {
    clearTimeout(prepTimeout);
    if (prepExitHandled) return;
    prepExitHandled = true;
    updateDeviceState(serial, {
      prepState: "failed",
      prepMessage: `Prep failed to start: ${error.message}`,
      prepFinishedAt: new Date().toISOString()
    });
    logActivity("queue", `Prep failed to start: ${error.message}`, serial);
    preparingSerial = null;
    processPrepQueue();
  });

  child.on("exit", code => {
    clearTimeout(prepTimeout);
    if (prepExitHandled) return;
    prepExitHandled = true;
    const success = code === 0;
    const prepFinishedAt = new Date().toISOString();
    const prepDurationMs = Math.max(0, new Date(prepFinishedAt).getTime() - new Date(prepStartedAt).getTime());
    updateDeviceState(serial, {
      prepState: success ? "ready" : "failed",
      prepMessage: success ? "Prep completed successfully" : "Prep failed; review logs",
      prepFinishedAt,
      lastPrepDurationMs: prepDurationMs
    });
    logActivity("queue", success ? `Prep completed in ${formatDuration(prepDurationMs)}` : `Prep failed with exit code ${code} after ${formatDuration(prepDurationMs)}`, serial);
    if (success) {
      runDevicePublicIpCheck(serial, "post-prep").catch(error => {
        logActivity("ip-check", `Automatic post-prep IP check failed: ${error.message}`, serial);
      });
    }
    preparingSerial = null;
    scheduleRefreshDevices();
    processPrepQueue();
  });
}

function launchViewerForDevice(serial, username, sourceAction) {
  const requestedAt = new Date().toISOString();
  updateDeviceState(serial, {
    viewerLaunch: {
      status: "launching",
      sourceAction,
      requestedAt,
      confirmedAt: "",
      pid: null,
      processName: "",
      filePath: "",
      aliveAfterLaunch: false,
      windowReady: false,
      fallbackViewer: "",
      manualSelectionRequired: false,
      lastError: ""
    }
  });

  return new Promise(resolve => {
    const child = runPowerShellScript("open-scrcpy-for-device.ps1", ["-Serial", serial], { detached: false, windowsHide: false });
    let stdout = "";
    if (child.stdout) {
      child.stdout.on("data", chunk => {
        stdout += chunk.toString();
      });
    }

    child.on("error", error => {
      const message = error.message || "Viewer launch failed to start";
      const viewerLaunch = {
        status: "failed",
        sourceAction,
        requestedAt,
        confirmedAt: "",
        pid: null,
        processName: "",
        filePath: "",
        aliveAfterLaunch: false,
        windowReady: false,
        fallbackViewer: "",
        manualSelectionRequired: false,
        lastError: message
      };
      updateDeviceState(serial, { viewerLaunch });
      logActivity("scrcpy", `Viewer launch failed for ${sourceAction}: ${message}`, serial);
      resolve({ success: false, error: message, viewerLaunch });
    });

    child.on("exit", code => {
      const payload = parseViewerLaunchPayload(stdout);
      if (code === 0 && payload?.ok) {
        const viewerLaunch = {
          status: payload.fallbackViewer ? "fallback" : (payload.windowReady ? "confirmed" : "unverified"),
          sourceAction,
          requestedAt,
          confirmedAt: payload.startedAt || new Date().toISOString(),
          pid: payload.pid || null,
          processName: payload.processName || "",
          filePath: payload.filePath || "",
          aliveAfterLaunch: Boolean(payload.aliveAfterLaunch),
          windowReady: Boolean(payload.windowReady),
          fallbackViewer: payload.fallbackViewer || "",
          manualSelectionRequired: Boolean(payload.manualSelectionRequired),
          lastError: payload.fallbackViewer ? (payload.scrcpyError || "") : ""
        };
        updateDeviceState(serial, { viewerLaunch });
        logActivity("scrcpy", `Viewer launch ${payload.fallbackViewer ? `fell back to ${payload.fallbackViewer}` : (payload.windowReady ? "confirmed" : "unverified")} for ${sourceAction} with PID ${payload.pid || "unknown"} by ${username}`, serial);
        resolve({ success: true, viewerLaunch, payload });
        return;
      }

      const errorMessage = payload?.error || `Viewer launch script exited with code ${code}`;
      const viewerLaunch = {
        status: "failed",
        sourceAction,
        requestedAt,
        confirmedAt: "",
        pid: null,
        processName: "",
        filePath: payload?.filePath || "",
        aliveAfterLaunch: false,
        windowReady: false,
        fallbackViewer: "",
        manualSelectionRequired: false,
        lastError: errorMessage
      };
      updateDeviceState(serial, { viewerLaunch });
      logActivity("scrcpy", `Viewer launch failed for ${sourceAction}: ${errorMessage}`, serial);
      resolve({ success: false, error: errorMessage, viewerLaunch, payload });
    });
  });
}

function refreshRoutingAudit() {
  if (Date.now() - lastRoutingAuditAt < 25000) return;
  lastRoutingAuditAt = Date.now();
  runPowerShellScript("audit-routerfarm-routing.ps1", [], { detached: true, logLifecycle: false });
}

function safeRefreshRoutingAudit() {
  try {
    refreshRoutingAudit();
  } catch (error) {
    logActivity("routing", `Routing audit startup skipped: ${error.message}`);
  }
}

function loadRoutingAudit() {
  const fallback = {
    checkedAt: "",
    overallOk: false,
    summary: "Routing audit has not completed yet.",
    checks: []
  };

  try {
    const stats = fs.statSync(ROUTING_AUDIT_PATH);
    const mtimeMs = Number(stats.mtimeMs) || 0;
    if (routingAuditCache && routingAuditCacheMtimeMs === mtimeMs) {
      return routingAuditCache;
    }

    routingAuditCache = loadJson(ROUTING_AUDIT_PATH, fallback);
    routingAuditCacheMtimeMs = mtimeMs;
    return routingAuditCache;
  } catch (error) {
    routingAuditCache = fallback;
    routingAuditCacheMtimeMs = 0;
    return fallback;
  }
}

function buildPrepTelemetry(devices) {
  let active = null;
  let completed = null;
  let completedAt = 0;
  for (const device of devices || []) {
    if (!active && device.serial === preparingSerial) {
      active = device;
    }
    const finishedAt = new Date(device.prepFinishedAt || 0).getTime();
    if (finishedAt > completedAt) {
      completed = device;
      completedAt = finishedAt;
    }
  }
  return {
    active: active ? {
      serial: active.serial,
      label: formatDeviceLabel(active),
      startedAt: active.prepStartedAt || "",
      elapsedMs: getActivePrepElapsedMs(active),
      queueDepthBehind: (state.queue || []).length
    } : null,
    lastCompleted: completed ? {
      serial: completed.serial,
      label: formatDeviceLabel(completed),
      finishedAt: completed.prepFinishedAt || "",
      durationMs: completed.lastPrepDurationMs || 0,
      prepState: completed.prepState || "idle"
    } : null
  };
}

function enrichDeviceForStatus(device, routingAudit, routingGuard = buildRoutingGuard(routingAudit), activeSession = getActiveSession()) {
  const normalizedPublicIp = normalizePublicIpState(device.serial, device.publicIp);
  const router = device.routerId ? getRouterConfig(device.routerId) : null;
  return {
    ...device,
    publicIp: normalizedPublicIp,
    prepElapsedMs: getActivePrepElapsedMs(device),
    queueWaitMs: getQueueWaitMs(device),
    routingRisk: getDeviceRoutingRisk({ ...device, publicIp: normalizedPublicIp }, routingAudit, routingGuard),
    routerLabel: router?.label || "",
    routerSsid: router?.ssid || "",
    activationLock: buildActivationLock(device, activeSession)
  };
}

function getActivePrepElapsedMs(device) {
  if (device.prepState !== "preparing" || !device.prepStartedAt) {
    return 0;
  }
  return Math.max(0, Date.now() - new Date(device.prepStartedAt).getTime());
}

function getQueueWaitMs(device) {
  if (device.prepState !== "queued" || !device.prepEnqueuedAt) {
    return 0;
  }
  return Math.max(0, Date.now() - new Date(device.prepEnqueuedAt).getTime());
}

function buildActivationLock(device, activeSession = getActiveSession()) {
  if (!deviceRequiresRouter(device)) {
    if (!activeSession || activeSession.serial === device.serial) {
      return {
        allowed: true,
        reason: ""
      };
    }
    return {
      allowed: false,
      reason: `${activeSession.label || activeSession.serial} is already the globally active device.`
    };
  }

  if (!device.routerId) {
    return {
      allowed: false,
      reason: "Assign this phone to an Opal router before activation."
    };
  }

  if (!activeSession) {
    return {
      allowed: true,
      reason: ""
    };
  }

  if (activeSession.serial === device.serial) {
    return {
      allowed: true,
      reason: ""
    };
  }

  if (activeSession.routerId && activeSession.routerId === device.routerId) {
    return {
      allowed: false,
      reason: `${activeSession.label || activeSession.serial} is already active on ${device.routerLabel || device.routerId}.`
    };
  }

  return {
    allowed: false,
    reason: `${activeSession.label || activeSession.serial} is already the globally active device.`
  };
}

function getRouterTopologyGate(router, routerState) {
  const mode = String(routerState?.routerMode || "").toLowerCase();
  const uplinkMode = String(routerState?.uplinkMode || "").toLowerCase();
  const tetheringState = String(routerState?.tetheringState || "").toLowerCase();
  if (!routerState || routerState.healthStatus !== "online") {
    return {
      ok: false,
      error: `Session start blocked: ${router.label || router.id} is not healthy enough for routed sessions.`
    };
  }
  if (tetheringState === "no-device") {
    return {
      ok: false,
      error: `Session start blocked: ${router.label || router.id} does not detect a USB uplink device.`,
      detail: {
        tetheringState: routerState.tetheringState || "",
        tetheringError: routerState.tetheringError || "",
        tetheringHint: routerState.tetheringHint || ""
      }
    };
  }
  if (mode && mode !== "router") {
    return {
      ok: false,
      error: `Session start blocked: ${router.label || router.id} is in ${mode} mode, not router mode.`,
      detail: { routerMode: routerState.routerMode || "", uplinkMode: routerState.uplinkMode || "" }
    };
  }
  if (uplinkMode && uplinkMode !== "router-uplink") {
    return {
      ok: false,
      error: `Session start blocked: ${router.label || router.id} uplink is ${uplinkMode} instead of router-uplink.`,
      detail: { routerMode: routerState.routerMode || "", uplinkMode: routerState.uplinkMode || "", uplinkInterface: routerState.uplinkInterface || "" }
    };
  }
  return { ok: true };
}

function deriveRouterHealthStatus(action, ok, payload, currentState) {
  if (action !== "router-health") {
    return currentState.healthStatus || "unknown";
  }
  if (!ok) {
    return "degraded";
  }
  const routerMode = String(payload?.telemetry?.mode || currentState.routerMode || "").toLowerCase();
  const uplinkMode = String(payload?.telemetry?.uplinkMode || currentState.uplinkMode || "").toLowerCase();
  const tetheringState = String(payload?.telemetry?.tetheringState || currentState.tetheringState || "").toLowerCase();
  if (tetheringState === "no-device") {
    return "degraded";
  }
  if (routerMode && routerMode !== "router") {
    return "degraded";
  }
  if (uplinkMode && uplinkMode !== "router-uplink") {
    return "degraded";
  }
  return "online";
}

function buildRoutingGuard(routingAudit) {
  const hardBlockChecks = new Set([
    "RouterFarm Bind Mode",
    "Tailscale Exit Node",
    "Internet Connection Sharing",
    "WinHTTP Proxy",
    "Windows User Proxy",
    "IPv4 Forwarding"
  ]);
  const failedChecks = (routingAudit.checks || []).filter(check => {
    if (check.ok || !hardBlockChecks.has(check.name)) {
      return false;
    }
    const detail = String(check.detail || "").toLowerCase();
    if (check.name === "RouterFarm Bind Mode") {
      return !detail.includes("127.0.0.1");
    }
    if (check.name === "Tailscale Exit Node") {
      return detail.includes("configured as an exit node");
    }
    if (check.name === "Internet Connection Sharing") {
      return detail.includes("running");
    }
    if (check.name === "WinHTTP Proxy") {
      return !detail.includes("direct access");
    }
    if (check.name === "Windows User Proxy") {
      return detail.includes("proxy enabled");
    }
    if (check.name === "IPv4 Forwarding") {
      return detail.includes("enabled via ipenablerouter");
    }
    return false;
  });
  const pcPublicIpCheck = (routingAudit.checks || []).find(check => check.name === "PC Public IP");
  return {
    blocked: failedChecks.length > 0,
    reasons: failedChecks.map(check => `${check.name}: ${check.detail}`),
    checkedAt: routingAudit.checkedAt || "",
    pcPublicIp: extractPcPublicIp(pcPublicIpCheck?.detail || ""),
    dashboardAccessPath: routingAudit.dashboardAccessPath || "",
    deviceTrafficPath: routingAudit.deviceTrafficPath || ""
  };
}

function normalizePublicIpState(serial, publicIp) {
  const ipPolicy = getIpReusePolicy();
  const historyEntries = getRecentSuccessfulIpEntries(ipPolicy.historyLimit);
  const normalizedHistory = publicIp?.last100History || publicIp?.last50History || historyEntries;
  const crossDeviceReuse = normalizedHistory
    .filter(entry => entry.ip && entry.ip === publicIp?.currentIp && entry.serial && entry.serial !== serial)
    .slice(0, 10);
  return {
    ...(publicIp || {}),
    location: publicIp?.location || null,
    reusedRecently: crossDeviceReuse.length > 0,
    reusedWithinLast100: crossDeviceReuse,
    last100History: normalizedHistory,
    reusePolicyViolation: crossDeviceReuse.length > 0,
    reusePolicyLabel: crossDeviceReuse.length > 0
      ? `Seen in last ${ipPolicy.historyLimit} IPs / ${ipPolicy.maxAgeHours}h`
      : "",
    reusePolicyWindowHours: ipPolicy.maxAgeHours,
    reusePolicyHistoryLimit: ipPolicy.historyLimit
  };
}

function getDeviceRoutingRisk(device, routingAudit, routingGuard = buildRoutingGuard(routingAudit)) {
  const interfaceName = String(device.network?.interface || "").toLowerCase();
  if (!deviceRequiresRouter(device)) {
    return {
      level: "neutral",
      label: "SIM Direct",
      detail: "This phone is marked SIM-direct and is not expected to route through an Opal."
    };
  }
  if (device.routerId && device.online && interfaceName && !deviceLooksOnRouterWifi(device)) {
    return {
      level: "warning",
      label: "Not On Router Wi-Fi",
      detail: `Device network is using ${device.network?.interface || "an unexpected interface"} instead of router Wi-Fi.`
    };
  }
  if (interfaceName === "lo" || interfaceName === "loopback") {
    return {
      level: "critical",
      label: "Loopback Route",
      detail: "Device network reports a loopback interface. That is not a valid direct data path."
    };
  }

  if (routingGuard.pcPublicIp && device.publicIp?.currentIp && device.publicIp.currentIp === routingGuard.pcPublicIp) {
    return {
      level: "warning",
      label: "Shared Egress",
      detail: "Phone public IP matches the PC public IP. Verify the phone is not leaving through the PC."
    };
  }

  if (routingGuard.blocked) {
    return {
      level: "warning",
      label: "PC Guard Failed",
      detail: "PC routing guardrails are not fully clean. Prep and session starts are blocked until fixed."
    };
  }

  if (!device.publicIp?.currentIp) {
    return {
      level: "neutral",
      label: "Unverified",
      detail: "No phone-side public IP verification yet."
    };
  }

  if (device.publicIp?.reusePolicyViolation) {
    return {
      level: "warning",
      label: "IP Reused",
      detail: `This IP was seen within the last ${device.publicIp.reusePolicyWindowHours || 72} hours and should be rotated before use.`
    };
  }

  return {
    level: "safe",
    label: "Separated",
    detail: "No direct sign that this phone is routing through the PC."
  };
}

function extractPcPublicIp(detail) {
  return parsePublicIp(detail || "");
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round((durationMs || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function parseViewerLaunchPayload(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return null;
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch (error) {
      // Keep scanning for the last JSON line from the PowerShell launcher.
    }
  }
  return null;
}

function runPowerShellScript(scriptName, scriptArgs = [], options) {
  const scriptPath = path.join(WIN_SCRIPTS_DIR, scriptName);
  const argsDescription = scriptArgs.length ? ` ${scriptArgs.join(" ")}` : "";
  const shouldLogLifecycle = options?.logLifecycle !== false;
  if (shouldLogLifecycle) {
    logActivity("system", `Running PowerShell script ${scriptName}${argsDescription}`);
  }
  const psArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...scriptArgs];
  const child = spawn("powershell.exe", psArgs, {
    cwd: ROOT,
    windowsHide: options?.windowsHide ?? true,
    detached: Boolean(options?.detached),
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.on("error", error => {
    if (shouldLogLifecycle) {
      logActivity("system", `PowerShell ${scriptName} failed to start: ${error.message}`);
    }
  });

  child.on("exit", code => {
    if (shouldLogLifecycle && code !== 0) {
      logActivity("system", `PowerShell ${scriptName} exited with code ${code}`);
    }
  });

  if (child.stderr) {
    child.stderr.on("data", chunk => {
      const message = chunk.toString().trim();
      if (shouldLogLifecycle && message) {
        logActivity("system", `PowerShell ${scriptName} stderr: ${message}`);
      }
    });
  }

  if (options?.detached) {
    child.unref();
  }

  return child;
}
