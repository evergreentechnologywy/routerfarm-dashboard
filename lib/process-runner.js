/**
 * RouterFarm v2 — Child process spawning utilities.
 */

const { spawn, spawnSync } = require("child_process");
const path = require("path");

function toWinPath(p) {
  if (typeof p !== "string") return p;
  const mntMatch = p.match(/^\/mnt\/([a-zA-Z])\//);
  if (mntMatch) {
    return p.replace(/^\/mnt\/[a-zA-Z]\//, `${mntMatch[1].toUpperCase()}:\\`).replace(/\//g, "\\");
  }
  return p;
}

function runProcess(command, args = [], options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: options.cwd ? toWinPath(options.cwd) : process.cwd(),
      windowsHide: options.windowsHide ?? true,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeoutHandle = null;

    const finalize = payload => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve(payload);
    };

    if (child.stdout) {
      child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    }
    if (child.stderr) {
      child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    }

    if (options.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch (_e) { /* ignore */ }
      }, Math.max(Number(options.timeoutMs) || 0, 1));
    }

    child.on("error", error => {
      finalize({ stdout, stderr, status: null, error });
    });

    child.on("exit", code => {
      finalize({
        stdout,
        stderr,
        status: code,
        error: timedOut ? new Error(`Process timed out after ${options.timeoutMs}ms`) : null
      });
    });
  });
}

function runPowerShellScript(scriptDir, scriptName, scriptArgs = [], options = {}) {
  const scriptPath = path.join(scriptDir, scriptName);
  const psArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", toWinPath(scriptPath), ...scriptArgs];
  const child = spawn("powershell.exe", psArgs, {
    cwd: options.cwd ? toWinPath(options.cwd) : process.cwd(),
    windowsHide: options.windowsHide ?? true,
    detached: Boolean(options.detached),
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (options.detached) {
    child.unref();
  }

  return child;
}

function runPowerShellJson(scriptPath, scriptArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      toWinPath(scriptPath),
      ...scriptArgs
    ], {
      windowsHide: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });

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
          } catch (_e) { /* scan for last JSON line */ }
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

function parseJsonPayload(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch (_e) { /* keep scanning */ }
  }
  return null;
}

module.exports = {
  toWinPath,
  runProcess,
  runPowerShellScript,
  runPowerShellJson,
  parseJsonPayload
};
