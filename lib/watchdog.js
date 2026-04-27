/**
 * RouterFarm v2 — Kimi Autonomous Watchdog
 * Monitors fleet health, diagnoses issues via Kimi API, and executes repairs.
 */

const fs = require("fs");
const path = require("path");

const WATCHDOG_LOG_PATH = path.join(process.cwd(), "logs", "watchdog.json");
const WATCHDOG_STATE_PATH = path.join(process.cwd(), "config", "watchdog-state.json");
const KIMI_API_URLS = [
  "https://api.moonshot.cn/v1/chat/completions",
  "https://api.kimi.com/coding/v1/chat/completions"
];

const REPAIR_ACTIONS = {
  reassign_device: {
    description: "Move a device from a dead/offline router to an available router",
    safe: true,
    params: ["serial", "fromRouterId", "toRouterId", "toSlot"]
  },
  remove_router: {
    description: "Mark a router as missing/offline in config",
    safe: true,
    params: ["routerId", "reason"]
  },
  clear_prep_queue: {
    description: "Clear the prep queue if stalled",
    safe: true,
    params: ["reason"]
  },
  update_router_status: {
    description: "Update router status field in config",
    safe: true,
    params: ["routerId", "status", "note"]
  },
  run_device_action: {
    description: "Run a device action (prep, recover-radios, etc.)",
    safe: false,
    params: ["serial", "action"]
  },
  update_setting: {
    description: "Update a settings.json value",
    safe: false,
    params: ["path", "value"]
  },
  log_only: {
    description: "Log the issue without taking action",
    safe: true,
    params: ["message"]
  }
};

class Watchdog {
  constructor(options = {}) {
    this.enabled = false;
    this.mode = "suggest"; // off | suggest | auto_safe | auto_all
    this.intervalMs = options.intervalMs || 60000;
    this.kimiApiKey = options.kimiApiKey || process.env.KIMI_API_KEY || "";
    this.kimiModel = options.kimiModel || "kimi-latest";
    this.timer = null;
    this.inFlight = false;
    this.log = this.loadLog();
    this.lastRun = null;
    this.suggestions = [];
    this.recentActions = [];
    this.kimiLoginInFlight = false;
    this.kimiLoginUrl = null;
    this.kimiLoginUserCode = null;
    this.kimiLoginLastAttempt = null;
  }

  loadLog() {
    try {
      if (fs.existsSync(WATCHDOG_LOG_PATH)) {
        return JSON.parse(fs.readFileSync(WATCHDOG_LOG_PATH, "utf8"));
      }
    } catch (_e) { /* ignore */ }
    return { entries: [] };
  }

  saveLog() {
    try {
      const dir = path.dirname(WATCHDOG_LOG_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(WATCHDOG_LOG_PATH, JSON.stringify(this.log, null, 2));
    } catch (_e) { /* ignore */ }
  }

  appendLog(entry) {
    if (!this.log.entries) this.log.entries = [];
    this.log.entries.unshift({
      timestamp: new Date().toISOString(),
      ...entry
    });
    if (this.log.entries.length > 500) {
      this.log.entries = this.log.entries.slice(0, 500);
    }
    this.saveLog();
  }

  start() {
    if (this.timer) return;
    this.enabled = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.enabled = false;
  }

  setMode(mode) {
    this.mode = mode;
    if (mode !== "off" && !this.timer) {
      this.start();
    } else if (mode === "off") {
      this.stop();
    }
  }

  async tick() {
    if (this.inFlight || this.mode === "off") return;
    this.inFlight = true;
    try {
      await this.runCycle();
    } catch (error) {
      this.appendLog({ level: "error", message: `Watchdog cycle failed: ${error.message}` });
    } finally {
      this.inFlight = false;
      this.lastRun = new Date().toISOString();
    }
  }

  buildSituationReport(context) {
    const { routers, devices, settings, state, queue, prepTelemetry } = context;

    const routerSummary = (routers || []).map(r => ({
      id: r.id,
      ip: r.ip,
      status: r.status,
      modem: r.modem || "unknown",
      note: r.note || ""
    }));

    const deviceSummary = (devices || []).map(d => ({
      serial: d.serial,
      nickname: d.nickname,
      online: d.online,
      role: d.role,
      routerId: d.routerId,
      routerSlot: d.routerSlot,
      prepState: d.prepState,
      sessionState: d.sessionState,
      publicIpStatus: d.publicIp?.status || "unknown"
    }));

    const deadRouters = routerSummary.filter(r => r.modem === "dead" || r.status === "missing" || r.status === "offline");
    const orphanedDevices = deviceSummary.filter(d => deadRouters.some(r => r.id === d.routerId));
    const stalledPrep = prepTelemetry?.active && prepTelemetry.active.elapsedMs > 300000;

    return {
      timestamp: new Date().toISOString(),
      fleet: {
        routerCount: routerSummary.length,
        deviceCount: deviceSummary.length,
        queueLength: (queue || []).length,
        prepActive: prepTelemetry?.active
          ? {
              serial: prepTelemetry.active.serial,
              elapsedMs: prepTelemetry.active.elapsedMs,
              startedAt: prepTelemetry.active.startedAt
            }
          : null
      },
      issues: {
        deadRouters,
        orphanedDevices,
        stalledPrep,
        offlineRouters: routerSummary.filter(r => r.status === "offline" || r.status === "missing")
      },
      routers: routerSummary,
      devices: deviceSummary,
      settings_snapshot: {
        prepMinWait: settings?.prep?.minWaitSeconds,
        prepMaxWait: settings?.prep?.maxWaitSeconds,
        restartRouterBeforeSession: settings?.sessionPolicy?.restartRouterBeforeSession,
        routerRestartSettleMs: settings?.sessionPolicy?.routerRestartSettleMs
      }
    };
  }

  async callKimi(report) {
    if (!this.kimiApiKey) {
      throw new Error("Kimi API key not configured");
    }

    const prompt = `You are the RouterFarm Autonomous Watchdog. Analyze the following fleet situation report and return a JSON repair plan.

Available repair actions:
${Object.entries(REPAIR_ACTIONS).map(([k, v]) => `- ${k}: ${v.description} (safe=${v.safe}, params=${v.params.join(", ")})`).join("\n")}

Mode rules:
- If action is "safe" and mode is auto_safe or auto_all, it can be executed automatically.
- If action is NOT safe, it requires human approval unless mode is auto_all.
- Always prefer "log_only" if the situation is unclear.

Current fleet report:
${JSON.stringify(report, null, 2)}

Respond ONLY with a JSON object in this exact format (no markdown, no explanation):
{
  "analysis": "Brief description of what you found",
  "confidence": 0.0-1.0,
  "repairs": [
    {
      "action": "action_name",
      "params": { ... },
      "reason": "Why this repair is needed",
      "safe": true/false
    }
  ]
}`;

    let lastError = null;
    for (const apiUrl of KIMI_API_URLS) {
      try {
        const response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.kimiApiKey}`
          },
          body: JSON.stringify({
            model: this.kimiModel,
            messages: [
              { role: "system", content: "You are a strict JSON-only output assistant. Never wrap output in markdown code blocks." },
              { role: "user", content: prompt }
            ],
            temperature: 0.2,
            max_tokens: 2000
          })
        });

        if (!response.ok) {
          const text = await response.text();
          const isAuthError = response.status === 401 || response.status === 403;
          if (isAuthError) {
            this.appendLog({ level: "warning", message: `Kimi API auth error ${response.status}. Triggering login flow.` });
            this.triggerKimiLogin();
          }
          lastError = new Error(`Kimi API error ${response.status}: ${text}`);
          continue;
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content || "";

        const cleaned = content.replace(/^```json\s*/, "").replace(/\s*```$/, "").trim();
        return JSON.parse(cleaned);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("All Kimi API endpoints failed");
  }

  localDiagnosis(report) {
    const repairs = [];
    const { issues } = report;

    if (issues.orphanedDevices && issues.orphanedDevices.length > 0) {
      const availableRouters = report.routers.filter(r =>
        r.status === "online" && r.modem !== "dead"
      );
      issues.orphanedDevices.forEach(device => {
        const target = availableRouters.find(r => r.id !== device.routerId);
        if (target) {
          repairs.push({
            action: "reassign_device",
            params: {
              serial: device.serial,
              fromRouterId: device.routerId,
              toRouterId: target.id,
              toSlot: 1
            },
            reason: `Device ${device.serial} is assigned to dead router ${device.routerId}. Reassign to ${target.id}.`,
            safe: true
          });
        }
      });
    }

    if (issues.deadRouters && issues.deadRouters.length > 0) {
      issues.deadRouters.forEach(router => {
        if (router.status === "missing") return;
        repairs.push({
          action: "update_router_status",
          params: {
            routerId: router.id,
            status: "missing",
            note: router.note || "Marked missing by local watchdog diagnosis"
          },
          reason: `Router ${router.id} has dead modem or is unreachable.`,
          safe: true
        });
      });
    }

    if (issues.stalledPrep) {
      repairs.push({
        action: "clear_prep_queue",
        params: { reason: "Prep has been running for over 5 minutes — likely stalled." },
        reason: "Prep queue appears stalled.",
        safe: true
      });
    }

    const unmarkedOffline = (issues.offlineRouters || []).filter(r => r.status !== "missing");
    if (unmarkedOffline.length > 0) {
      unmarkedOffline.forEach(router => {
        repairs.push({
          action: "update_router_status",
          params: {
            routerId: router.id,
            status: "offline",
            note: "Router unreachable"
          },
          reason: `Router ${router.id} is offline.`,
          safe: true
        });
      });
    }

    if (repairs.length === 0) {
      repairs.push({
        action: "log_only",
        params: { message: "Fleet looks healthy. No issues detected." },
        reason: "No actionable issues found in local diagnosis.",
        safe: true
      });
    }

    return {
      analysis: `Local diagnosis found ${issues.deadRouters?.length || 0} dead routers, ${issues.orphanedDevices?.length || 0} orphaned devices, ${issues.stalledPrep ? 1 : 0} stalled prep.`,
      confidence: 0.85,
      repairs
    };
  }

  async runCycle() {
    // This method is called by the server with context
    // The actual context injection happens in server.js
  }

  async executeRepair(repair, context) {
    const { action, params, reason } = repair;
    const result = { success: false, message: "" };

    try {
      switch (action) {
        case "reassign_device": {
          const { serial, toRouterId, toSlot } = params;
          result.success = context.reassignDevice(serial, toRouterId, toSlot);
          result.message = result.success
            ? `Reassigned ${serial} to ${toRouterId} slot ${toSlot}`
            : `Failed to reassign ${serial}`;
          break;
        }
        case "remove_router": {
          const { routerId, reason: note } = params;
          result.success = context.removeRouter(routerId, note);
          result.message = result.success
            ? `Removed router ${routerId}: ${note}`
            : `Failed to remove router ${routerId}`;
          break;
        }
        case "clear_prep_queue": {
          result.success = context.clearPrepQueue();
          result.message = result.success ? "Prep queue cleared" : "Failed to clear prep queue";
          break;
        }
        case "update_router_status": {
          const { routerId, status, note } = params;
          result.success = context.updateRouterStatus(routerId, status, note);
          result.message = result.success
            ? `Updated ${routerId} status to ${status}`
            : `Failed to update ${routerId}`;
          break;
        }
        case "run_device_action": {
          const { serial, action: deviceAction } = params;
          result.success = context.runDeviceAction(serial, deviceAction);
          result.message = `Triggered ${deviceAction} on ${serial}`;
          break;
        }
        case "update_setting": {
          const { path: settingPath, value } = params;
          result.success = context.updateSetting(settingPath, value);
          result.message = result.success
            ? `Updated setting ${settingPath}`
            : `Failed to update setting ${settingPath}`;
          break;
        }
        case "log_only": {
          result.success = true;
          result.message = params.message || reason || "No action taken";
          break;
        }
        default:
          result.message = `Unknown action: ${action}`;
      }
    } catch (error) {
      result.message = `Execution error: ${error.message}`;
    }

    return result;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      mode: this.mode,
      lastRun: this.lastRun,
      inFlight: this.inFlight,
      intervalMs: this.intervalMs,
      recentActions: this.recentActions.slice(0, 20),
      suggestions: this.suggestions.slice(0, 20),
      logSize: (this.log.entries || []).length,
      kimiLoginInFlight: this.kimiLoginInFlight,
      kimiLoginUrl: this.kimiLoginUrl,
      kimiLoginUserCode: this.kimiLoginUserCode,
      kimiLoginLastAttempt: this.kimiLoginLastAttempt
    };
  }

  async reloadKimiApiKey() {
    try {
      const homeDir = process.env.HOME || process.env.USERPROFILE || "/tmp";
      const configPath = path.join(homeDir, ".kimi", "config.toml");
      if (!fs.existsSync(configPath)) return false;
      const raw = fs.readFileSync(configPath, "utf8");
      const match = raw.match(/api_key\s*=\s*"([^"]+)"/);
      if (match && match[1]) {
        this.kimiApiKey = match[1];
        return true;
      }
    } catch (_e) { /* ignore */ }
    return false;
  }

  async triggerKimiLogin() {
    if (this.kimiLoginInFlight) {
      this.appendLog({ level: "info", message: "Kimi login already in progress" });
      return { success: false, url: this.kimiLoginUrl, userCode: this.kimiLoginUserCode, message: "Login already in progress" };
    }

    const now = Date.now();
    if (this.kimiLoginLastAttempt && now - new Date(this.kimiLoginLastAttempt).getTime() < 120000) {
      this.appendLog({ level: "info", message: "Kimi login rate limited (2 min cooldown)" });
      return { success: false, url: this.kimiLoginUrl, userCode: this.kimiLoginUserCode, message: "Login rate limited. Try again in 2 minutes." };
    }

    this.kimiLoginInFlight = true;
    this.kimiLoginUrl = null;
    this.kimiLoginUserCode = null;
    this.kimiLoginLastAttempt = new Date().toISOString();

    return new Promise((resolve) => {
      const child = require("child_process").spawn("kimi", ["login", "--json"], {
        detached: false,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let resolved = false;

      const finalize = (result) => {
        if (resolved) return;
        resolved = true;
        this.kimiLoginInFlight = false;
        if (result.success) {
          this.reloadKimiApiKey();
        }
        resolve(result);
      };

      if (child.stdout) {
        child.stdout.on("data", chunk => {
          stdout += chunk.toString();
          const lines = stdout.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const event = JSON.parse(trimmed);
              if (event.type === "verification_url" && event.data) {
                this.kimiLoginUrl = event.data.verification_url || "";
                this.kimiLoginUserCode = event.data.user_code || "";
                this.appendLog({ level: "info", message: `Kimi login URL: ${this.kimiLoginUrl}`, url: this.kimiLoginUrl, userCode: this.kimiLoginUserCode });
              }
              if (event.type === "success") {
                this.appendLog({ level: "info", message: "Kimi login succeeded" });
                finalize({ success: true, url: this.kimiLoginUrl, userCode: this.kimiLoginUserCode, message: "Login succeeded" });
              }
              if (event.type === "error") {
                this.appendLog({ level: "error", message: `Kimi login failed: ${event.message}` });
                finalize({ success: false, url: this.kimiLoginUrl, userCode: this.kimiLoginUserCode, message: event.message || "Login failed" });
              }
            } catch (_e) { /* ignore non-JSON lines */ }
          }
        });
      }

      if (child.stderr) {
        child.stderr.on("data", chunk => { stderr += chunk.toString(); });
      }

      child.on("error", error => {
        this.appendLog({ level: "error", message: `Kimi login process error: ${error.message}` });
        finalize({ success: false, url: null, userCode: null, message: error.message });
      });

      child.on("exit", code => {
        if (!resolved) {
          if (code === 0) {
            this.appendLog({ level: "info", message: "Kimi login process exited successfully" });
            finalize({ success: true, url: this.kimiLoginUrl, userCode: this.kimiLoginUserCode, message: "Login completed" });
          } else {
            this.appendLog({ level: "warning", message: `Kimi login process exited with code ${code}` });
            finalize({ success: false, url: this.kimiLoginUrl, userCode: this.kimiLoginUserCode, message: `Login process exited with code ${code}` });
          }
        }
      });

      setTimeout(() => {
        if (!resolved) {
          try { child.kill(); } catch (_e) { /* ignore */ }
          this.appendLog({ level: "warning", message: "Kimi login timed out after 5 minutes" });
          finalize({ success: false, url: this.kimiLoginUrl, userCode: this.kimiLoginUserCode, message: "Login timed out. Visit the URL and approve, then the next cycle will retry." });
        }
      }, 300000);
    });
  }
}

module.exports = { Watchdog, REPAIR_ACTIONS };
