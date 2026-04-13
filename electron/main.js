const { app, BrowserWindow, dialog, shell, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");

const START_TIMEOUT_MS = 25000;
const DEFAULT_WORKSPACE_ROOT = "C:\\RouterFarm";

app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");

let mainWindow = null;
let serverProcess = null;
let serverOwnedByDesktop = false;

function getCliArg(name) {
  const prefix = `${name}=`;
  const match = process.argv.find(arg => String(arg).startsWith(prefix));
  return match ? String(match).slice(prefix.length) : "";
}

function getDesktopTestSpec() {
  const openControlSerial = getCliArg("--phonefarm-test-open-control");
  const startSessionSerial = getCliArg("--phonefarm-test-start-session");
  const action = openControlSerial ? "open-control" : (startSessionSerial ? "start-session" : "");
  const serial = openControlSerial || startSessionSerial;
  if (!action || !serial) {
    return null;
  }

  return {
    action,
    serial,
    outputPath: getCliArg("--phonefarm-test-output"),
    exitWhenDone: process.argv.includes("--phonefarm-test-exit")
  };
}

function writeDesktopLog(root, message) {
  try {
    const logDir = path.join(root, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(path.join(logDir, "desktop-shell.log"), line);
  } catch (error) {
    // Ignore logging failures.
  }
}

function pathExists(targetPath) {
  try {
    return fs.existsSync(targetPath);
  } catch (error) {
    return false;
  }
}

function resolveWorkspaceRoot() {
  const candidates = [
    process.env.PHONEFARM_ROOT,
    DEFAULT_WORKSPACE_ROOT,
    path.join(__dirname, "..")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (pathExists(path.join(candidate, "server.js")) && pathExists(path.join(candidate, "config", "settings.json"))) {
      return candidate;
    }
  }

  throw new Error("RouterFarm workspace was not found. Expected C:\\RouterFarm or PHONEFARM_ROOT.");
}

function getWorkspaceContext() {
  const root = resolveWorkspaceRoot();
  const settingsPath = path.join(root, "config", "settings.json");
  let settings = { host: "127.0.0.1", port: 7780, nodePath: "" };

  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath, "utf8")) };
  } catch (error) {
    // Keep defaults when settings are not readable.
  }

  return {
    root,
    settingsPath,
    settings,
    baseUrl: `http://${settings.host || "127.0.0.1"}:${Number(settings.port) || 7780}`,
    serverScript: path.join(root, "server.js")
  };
}

function checkServer(url) {
  return new Promise(resolve => {
    const req = http.get(`${url}/api/status`, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (await checkServer(url)) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`RouterFarm server did not become ready at ${url} within ${timeoutMs}ms`));
        return;
      }
      setTimeout(poll, 500);
    };
    poll();
  });
}

function resolveNodeCommand(settings) {
  const candidates = [
    process.env.PHONEFARM_NODE_PATH,
    settings.nodePath,
    "C:\\Program Files\\nodejs\\node.exe",
    "node"
  ].filter(Boolean);

  return candidates[0];
}

function runPowerShellJson(scriptPath, scriptArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...scriptArgs], {
      windowsHide: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("exit", code => {
      const trimmed = String(stdout || "").trim();
      let payload = null;
      if (trimmed) {
        const lines = trimmed.split(/\r?\n/).filter(Boolean);
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          try {
            payload = JSON.parse(lines[index]);
            break;
          } catch (error) {
            // Scan for the last JSON object line.
          }
        }
      }

      if (code === 0) {
        resolve(payload || {});
        return;
      }

      const message = payload?.error || stderr.trim() || `PowerShell script exited with code ${code}`;
      reject(new Error(message));
    });
  });
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

async function requestJson(context, request) {
  const method = String(request?.method || "GET").toUpperCase();
  const pathname = String(request?.path || "");
  if (!pathname.startsWith("/")) {
    throw new Error("Desktop API requests must use an absolute /api path");
  }

  const options = {
    method,
    headers: { "Content-Type": "application/json" }
  };

  if (method !== "GET" && request?.body !== undefined) {
    options.body = JSON.stringify(request.body);
  }

  const response = await fetch(`${context.baseUrl}${pathname}`, options);
  const payload = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    payload
  };
}

async function ensureServer(context) {
  if (await checkServer(context.baseUrl)) {
    writeDesktopLog(context.root, `Reused running server at ${context.baseUrl}`);
    return context.baseUrl;
  }

  const nodeCommand = resolveNodeCommand(context.settings);
  serverProcess = spawn(nodeCommand, [context.serverScript], {
    cwd: context.root,
    windowsHide: false,
    stdio: "ignore"
  });
  serverOwnedByDesktop = true;

  serverProcess.on("exit", () => {
    serverProcess = null;
  });

  serverProcess.on("error", error => {
    writeDesktopLog(context.root, `Server start failed: ${error.message}`);
    dialog.showErrorBox("RouterFarm Server Start Failed", error.message);
  });

  await waitForServer(context.baseUrl, START_TIMEOUT_MS);
  writeDesktopLog(context.root, `Started desktop-owned server at ${context.baseUrl}`);
  return context.baseUrl;
}

function createWindow(context) {
  const iconPath = path.join(context.root, "assets", "routerfarm.ico");
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1280,
    minHeight: 820,
    title: "RouterFarm",
    icon: pathExists(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: "#f5f7fb",
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.js")
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("did-finish-load", async () => {
    try {
      const bridgeReady = await mainWindow.webContents.executeJavaScript("Boolean(window.phoneFarmDesktop && window.phoneFarmDesktop.isDesktopApp)", true);
      writeDesktopLog(context.root, `Renderer loaded from local files; API bridge ready=${bridgeReady}; backend=${context.baseUrl}`);
    } catch (error) {
      writeDesktopLog(context.root, `Renderer bridge check failed: ${error.message}`);
    }
  });

  mainWindow.loadFile(path.join(context.root, "web", "index.html"));
}

async function callRendererBridge(methodName, arg) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error("Desktop window is not available");
  }

  const serializedArg = JSON.stringify(arg);
  const script = `(async () => {
    if (!window.phoneFarmDesktop || typeof window.phoneFarmDesktop.${methodName} !== "function") {
      throw new Error("Desktop bridge method ${methodName} is not available");
    }
    return await window.phoneFarmDesktop.${methodName}(${serializedArg});
  })()`;

  return mainWindow.webContents.executeJavaScript(script, true);
}

async function runDesktopViewerAction(testSpec, context) {
  const requestedAt = new Date().toISOString();
  const result = {
    ok: false,
    action: testSpec.action,
    serial: testSpec.serial,
    requestedAt,
    baseUrl: context.baseUrl,
    bridgeReady: false
  };

  try {
    result.bridgeReady = await mainWindow.webContents.executeJavaScript("Boolean(window.phoneFarmDesktop && window.phoneFarmDesktop.isDesktopApp)", true);
    if (!result.bridgeReady) {
      throw new Error("Desktop bridge is not available in the renderer");
    }

    if (testSpec.action === "start-session") {
      result.startSession = await postJson(`${context.baseUrl}/api/devices/${encodeURIComponent(testSpec.serial)}/start-session`, {
        skipViewerLaunch: true
      });
    }

    result.nativeLaunch = await callRendererBridge("launchViewer", testSpec.serial);
    const syncPayload = {
      serial: testSpec.serial,
      sourceAction: testSpec.action,
      status: result.nativeLaunch?.fallbackViewer ? "fallback" : (result.nativeLaunch?.windowReady ? "confirmed" : "unverified"),
      requestedAt,
      confirmedAt: result.nativeLaunch?.startedAt || new Date().toISOString(),
      pid: result.nativeLaunch?.pid || null,
      processName: result.nativeLaunch?.processName || "",
      filePath: result.nativeLaunch?.filePath || "",
      aliveAfterLaunch: Boolean(result.nativeLaunch?.aliveAfterLaunch),
      windowReady: Boolean(result.nativeLaunch?.windowReady),
      fallbackViewer: result.nativeLaunch?.fallbackViewer || "",
      manualSelectionRequired: Boolean(result.nativeLaunch?.manualSelectionRequired),
      lastError: result.nativeLaunch?.fallbackViewer ? (result.nativeLaunch?.scrcpyError || "") : ""
    };
    result.syncResult = await callRendererBridge("syncViewerState", syncPayload);
    result.ok = true;
    writeDesktopLog(context.root, `Desktop viewer action ${testSpec.action} completed for ${testSpec.serial}: ${syncPayload.status}`);
  } catch (error) {
    result.error = error.message;
    writeDesktopLog(context.root, `Desktop viewer action ${testSpec.action} failed for ${testSpec.serial}: ${error.message}`);
    if (testSpec.action === "start-session") {
      try {
        result.rollback = await postJson(`${context.baseUrl}/api/devices/${encodeURIComponent(testSpec.serial)}/stop-session`, {});
      } catch (rollbackError) {
        result.rollbackError = rollbackError.message;
      }
    }
  }

  if (testSpec.outputPath) {
    fs.writeFileSync(testSpec.outputPath, `${JSON.stringify(result, null, 2)}\n`);
  }

  return result;
}

async function maybeRunDesktopTest(context) {
  const testSpec = getDesktopTestSpec();
  if (!testSpec) {
    return;
  }

  const run = async () => {
    await new Promise(resolve => setTimeout(resolve, 800));
    await runDesktopViewerAction(testSpec, context);
    if (testSpec.exitWhenDone) {
      setTimeout(() => app.quit(), 600);
    }
  };

  mainWindow.webContents.once("did-finish-load", () => {
    run().catch(error => {
      writeDesktopLog(context.root, `Desktop test runner failed: ${error.message}`);
      if (testSpec.outputPath) {
        fs.writeFileSync(testSpec.outputPath, `${JSON.stringify({ ok: false, action: testSpec.action, serial: testSpec.serial, error: error.message }, null, 2)}\n`);
      }
      if (testSpec.exitWhenDone) {
        setTimeout(() => app.quit(), 600);
      }
    });
  });
}

ipcMain.handle("phonefarm:launch-viewer", async (_event, { serial }) => {
  const context = getWorkspaceContext();
  const scriptPath = path.join(context.root, "scripts", "open-scrcpy-for-device.ps1");
  return runPowerShellJson(scriptPath, ["-Serial", String(serial)]);
});

ipcMain.handle("phonefarm:sync-viewer-state", async (_event, payload) => {
  const context = getWorkspaceContext();
  const serial = String(payload?.serial || "");
  if (!serial) {
    throw new Error("serial is required");
  }
  return postJson(`${context.baseUrl}/api/devices/${encodeURIComponent(serial)}/viewer-state`, payload);
});

ipcMain.handle("phonefarm:request-json", async (_event, request) => {
  const context = getWorkspaceContext();
  return requestJson(context, request);
});

async function bootstrap() {
  try {
    const context = getWorkspaceContext();
    await ensureServer(context);
    createWindow(context);
    maybeRunDesktopTest(context);
  } catch (error) {
    dialog.showErrorBox("RouterFarm Startup Failed", error.message);
    app.quit();
  }
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(bootstrap);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    try {
      const context = getWorkspaceContext();
      await ensureServer(context);
      createWindow(context);
    } catch (error) {
      dialog.showErrorBox("RouterFarm Activate Failed", error.message);
    }
  }
});

app.on("before-quit", () => {
  if (serverOwnedByDesktop && serverProcess) {
    try {
      serverProcess.kill();
    } catch (error) {
      // Ignore shutdown cleanup failures.
    }
  }
});
