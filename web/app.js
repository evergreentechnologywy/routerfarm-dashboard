const state = {
  data: null,
  user: {
    username: "operator",
    displayName: "Operator",
    role: "admin",
    allowedDevices: ["*"]
  },
  viewMode: "cards",
  pendingActions: {},
  filters: {
    search: "",
    status: "all",
    role: "all",
    warningsOnly: false,
    readyOnly: false
  },
  editor: {
    serial: null,
    saving: false
  },
  renderCache: {
    heroGuard: "",
    heroInsights: "",
    summaryStats: "",
    rackOverview: "",
    contextBar: "",
    routers: "",
    queue: "",
    activity: "",
    routingAudit: "",
    deviceCount: "",
    deviceViews: ""
  },
  userLoaded: false,
  refreshInFlight: false
};

const desktopBridge = window.routerFarmDesktop || window.phoneFarmDesktop || null;

const BASE_PATH = window.location.pathname.startsWith("/routerfarm") ? "/routerfarm" : "";

const appShell = document.getElementById("appShell");
const currentUser = document.getElementById("currentUser");
const logoutButton = document.getElementById("logoutButton");
const refreshButton = document.getElementById("refreshButton");
const routeGuardBadge = document.getElementById("routeGuardBadge");
const liveClock = document.getElementById("liveClock");
const heroNarrative = document.getElementById("heroNarrative");
const heroPrimaryValue = document.getElementById("heroPrimaryValue");
const heroPrimaryNote = document.getElementById("heroPrimaryNote");
const heroSecondaryValue = document.getElementById("heroSecondaryValue");
const heroSecondaryNote = document.getElementById("heroSecondaryNote");
const heroTertiaryValue = document.getElementById("heroTertiaryValue");
const heroTertiaryNote = document.getElementById("heroTertiaryNote");
const statsGrid = document.getElementById("statsGrid");
const rackOverviewBadge = document.getElementById("rackOverviewBadge");
const rackOverviewGrid = document.getElementById("rackOverviewGrid");
const deviceCount = document.getElementById("deviceCount");
const cardView = document.getElementById("cardView");
const tableView = document.getElementById("tableView");
const deviceTableBody = document.getElementById("deviceTableBody");
const queueLengthBadge = document.getElementById("queueLengthBadge");
const activePrepDevice = document.getElementById("activePrepDevice");
const activePrepCountdown = document.getElementById("activePrepCountdown");
const activePrepProgressBar = document.getElementById("activePrepProgressBar");
const lastCompletedPrep = document.getElementById("lastCompletedPrep");
const lastCompletedPrepMeta = document.getElementById("lastCompletedPrepMeta");
const queueList = document.getElementById("queueList");
const activityList = document.getElementById("activityList");
const routingStatusBadge = document.getElementById("routingStatusBadge");
const routingSummary = document.getElementById("routingSummary");
const routingPaths = document.getElementById("routingPaths");
const routingChecks = document.getElementById("routingChecks");
const searchInput = document.getElementById("searchInput");
const statusFilter = document.getElementById("statusFilter");
const roleFilter = document.getElementById("roleFilter");
const warningsOnlyToggle = document.getElementById("warningsOnlyToggle");
const readyOnlyToggle = document.getElementById("readyOnlyToggle");
const cardViewButton = document.getElementById("cardViewButton");
const tableViewButton = document.getElementById("tableViewButton");
const contextSummary = document.getElementById("contextSummary");
const contextChips = document.getElementById("contextChips");
const showAllButton = document.getElementById("showAllButton");
const showReadyButton = document.getElementById("showReadyButton");
const showWarningsButton = document.getElementById("showWarningsButton");
const toggleViewButton = document.getElementById("toggleViewButton");
const focusSearchButton = document.getElementById("focusSearchButton");
const routerCount = document.getElementById("routerCount");
const routerGrid = document.getElementById("routerGrid");
const template = document.getElementById("deviceCardTemplate");
const deviceEditorModal = document.getElementById("deviceEditorModal");
const deviceEditorTitle = document.getElementById("deviceEditorTitle");
const deviceEditorSubtitle = document.getElementById("deviceEditorSubtitle");
const deviceEditorForm = document.getElementById("deviceEditorForm");
const deviceEditorCloseButton = document.getElementById("deviceEditorCloseButton");
const deviceEditorCancelButton = document.getElementById("deviceEditorCancelButton");
const deviceEditorSaveButton = document.getElementById("deviceEditorSaveButton");
const editorNickname = document.getElementById("editorNickname");
const editorPhoneNumber = document.getElementById("editorPhoneNumber");
const editorRole = document.getElementById("editorRole");
const editorRouterId = document.getElementById("editorRouterId");
const editorRouterSlot = document.getElementById("editorRouterSlot");
const editorParentHotspotSerial = document.getElementById("editorParentHotspotSerial");

let searchDebounce = 0;

window.addEventListener("error", event => {
  reportClientError({
    source: "window.error",
    message: event.message || "Unhandled window error",
    detail: event.error?.stack || `${event.filename || ""}:${event.lineno || 0}:${event.colno || 0}`
  });
});

window.addEventListener("unhandledrejection", event => {
  const reason = event.reason;
  reportClientError({
    source: "window.unhandledrejection",
    message: reason?.message || String(reason || "Unhandled promise rejection"),
    detail: reason?.stack || ""
  });
});

logoutButton.addEventListener("click", handleLogout);
refreshButton.addEventListener("click", () => refresh(true));
searchInput.addEventListener("input", event => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    state.filters.search = event.target.value.trim().toLowerCase();
    render();
  }, 120);
});
statusFilter.addEventListener("change", event => {
  state.filters.status = event.target.value;
  render();
});
roleFilter.addEventListener("change", event => {
  state.filters.role = event.target.value;
  render();
});
warningsOnlyToggle.addEventListener("change", event => {
  state.filters.warningsOnly = event.target.checked;
  render();
});
readyOnlyToggle.addEventListener("change", event => {
  state.filters.readyOnly = event.target.checked;
  render();
});
cardViewButton.addEventListener("click", () => setViewMode("cards"));
tableViewButton.addEventListener("click", () => setViewMode("table"));
showAllButton.addEventListener("click", () => clearQuickFilters());
showReadyButton.addEventListener("click", () => applyQuickFilter({ status: "ready", readyOnly: true, warningsOnly: false }));
showWarningsButton.addEventListener("click", () => applyQuickFilter({ warningsOnly: true, readyOnly: false }));
toggleViewButton.addEventListener("click", () => setViewMode(state.viewMode === "cards" ? "table" : "cards"));
focusSearchButton.addEventListener("click", () => focusSearch());
document.addEventListener("keydown", handleGlobalShortcut);
deviceEditorCloseButton?.addEventListener("click", closeDeviceEditor);
deviceEditorCancelButton?.addEventListener("click", closeDeviceEditor);
deviceEditorModal?.addEventListener("click", event => {
  if (event.target?.dataset?.closeModal === "device-editor") {
    closeDeviceEditor();
  }
});
deviceEditorForm?.addEventListener("submit", async event => {
  event.preventDefault();
  await saveDeviceMetadata();
});

render();
refresh();

setInterval(() => {
  if (state.user && !document.hidden) {
    refresh(false);
  }
}, 4000);

setInterval(() => {
  liveClock.textContent = formatNow();
}, 1000);

async function refresh(showToast = false) {
  if (state.refreshInFlight) {
    return;
  }

  state.refreshInFlight = true;
  try {
    await ensureUserLoaded();

    const response = await apiRequest("/api/status");
    if (!response.ok) {
      throw new Error(`Dashboard refresh failed (${response.status})`);
    }

    state.data = response.payload;
    render();

    if (showToast) {
      refreshButton.textContent = "Refreshed";
      setTimeout(() => {
        refreshButton.textContent = "Refresh";
      }, 800);
    }
  } catch (error) {
    if (showToast || !state.data) {
      window.alert(error.message || "Dashboard refresh failed.");
    } else {
      console.warn(error.message || "Dashboard refresh failed.");
    }
  } finally {
    state.refreshInFlight = false;
  }
}

async function ensureUserLoaded(force = false) {
  if (state.userLoaded && !force) {
    return state.user;
  }

  const meResponse = await apiRequest("/api/me");
  if (meResponse.status === 401) {
    state.user = null;
    state.userLoaded = false;
    state.data = null;
    render();
    throw new Error("Authentication required");
  }
  if (!meResponse.ok) {
    throw new Error(`Login session check failed (${meResponse.status})`);
  }

  const mePayload = meResponse.payload;
  state.user = mePayload.user;
  state.userLoaded = true;
  return state.user;
}

function setViewMode(mode) {
  state.viewMode = mode;
  cardViewButton.classList.toggle("is-active", mode === "cards");
  tableViewButton.classList.toggle("is-active", mode === "table");
  appShell.classList.toggle("table-mode", mode === "table");
  renderDeviceViews();
}

async function handleLogout() {
  await apiRequest("/api/logout", { method: "POST" });
  state.userLoaded = false;
  await refresh();
}

function apiPath(pathname) {
  return `${BASE_PATH}${pathname}`;
}

async function apiRequest(pathname, options = {}) {
  const path = apiPath(pathname);
  if (desktopBridge?.isDesktopApp && typeof desktopBridge.requestJson === "function") {
    return desktopBridge.requestJson({
      path,
      method: options.method || "GET",
      body: options.body
    });
  }

  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    credentials: "same-origin",
    cache: "no-store",
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });

  return {
    ok: response.ok,
    status: response.status,
    payload: await response.json().catch(() => ({}))
  };
}

function reportClientError({ source, message, detail = "", serial = null, level = "error" }) {
  const payload = {
    source: source || "renderer",
    message: message || "Unknown client error",
    detail: detail || "",
    serial,
    level
  };

  if (desktopBridge?.isDesktopApp && typeof desktopBridge.requestJson === "function") {
    desktopBridge.requestJson({
      path: apiPath("/api/client-log"),
      method: "POST",
      body: payload
    }).catch(() => undefined);
    return;
  }

  fetch(apiPath("/api/client-log"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    body: JSON.stringify(payload)
  }).catch(() => undefined);
}

function setTextIfChanged(element, nextText) {
  if (element.textContent !== nextText) {
    element.textContent = nextText;
  }
}

function setClassIfChanged(element, nextClassName) {
  if (element.className !== nextClassName) {
    element.className = nextClassName;
  }
}

function buildSummaryStatsSignature(stats) {
  return stats.map(stat => `${stat.label}:${stat.value}:${stat.tone}`).join("|");
}

function buildHeroInsightsSignature(data, visibleDevices) {
  const routers = data?.routers || [];
  const prepActive = data?.prepTelemetry?.active || null;
  const readyRouters = routers.filter(router => {
    const routerState = router.routerState || {};
    return routerState.healthStatus === "online"
      && String(routerState.routerMode || "").toLowerCase() === "router"
      && String(routerState.uplinkMode || "").toLowerCase() === "router-uplink";
  }).length;
  const blockedDevices = (visibleDevices || []).filter(device => shouldDisableAction(device, "start-session")).length;
  return [
    data?.routingGuard?.blocked ? "1" : "0",
    readyRouters,
    blockedDevices,
    prepActive?.serial || "",
    prepActive?.elapsedMs || 0
  ].join("|");
}

function buildContextSignature(allDevices, visibleDevices, activeSession) {
  return [
    state.viewMode,
    state.filters.search,
    state.filters.status,
    state.filters.role,
    state.filters.warningsOnly ? "1" : "0",
    state.filters.readyOnly ? "1" : "0",
    allDevices.length,
    visibleDevices.length,
    visibleDevices.filter(hasWarning).length,
    activeSession?.serial || ""
  ].join("|");
}

function buildRackOverviewSignature(routers) {
  return (routers || []).map(router => [
    router.id,
    router.routerState?.healthStatus || "",
    router.routerState?.routerMode || "",
    router.routerState?.uplinkMode || "",
    router.routerState?.tetheringState || "",
    router.activeDeviceSerial || ""
  ].join("~")).join("|");
}

function buildRoutersSignature(routers) {
  return routers.map(router => [
    router.id,
    router.assignedDeviceCount,
    router.activeDeviceSerial || "",
    router.routerState?.healthStatus || "",
    router.routerState?.lastCheckedAt || "",
    router.routerState?.lastRestartAt || "",
    router.routerState?.wanAddress || "",
    router.routerState?.publicIp || "",
    router.routerState?.tetheringState || "",
    router.routerState?.tetheringError || "",
    router.routerState?.tetheringHint || "",
    router.routerState?.usbPorts || "",
    router.routerState?.detail || "",
    router.ssid || "",
    router.mobileUplinkId || ""
  ].join("~")).join("|");
}

function buildQueueSignature(data) {
  const active = data.prepTelemetry?.active;
  const completed = data.prepTelemetry?.lastCompleted;
  return [
    ...(data.queue || []),
    active?.serial || "",
    active?.startedAt || "",
    active?.elapsedMs || 0,
    completed?.serial || "",
    completed?.finishedAt || "",
    completed?.durationMs || 0,
    completed?.prepState || ""
  ].join("|");
}

function buildActivitySignature(events) {
  return events
    .filter(isOperatorEvent)
    .slice(0, 20)
    .map(event => `${event.timestamp}|${event.category}|${event.serial || ""}|${event.message}`)
    .join("|");
}

function buildRoutingAuditSignature(audit, routingGuard) {
  return [
    audit.summary || "",
    audit.overallOk ? "1" : "0",
    routingGuard.blocked ? "1" : "0",
    routingGuard.checkedAt || "",
    routingGuard.pcPublicIp || "",
    routingGuard.dashboardAccessPath || "",
    routingGuard.deviceTrafficPath || "",
    ...(routingGuard.reasons || []),
    ...(audit.checks || []).map(check => `${check.name}|${check.ok ? "1" : "0"}|${check.detail || ""}`)
  ].join("|");
}

function buildDeviceSignature(device) {
  if (!device) {
    return "missing-device";
  }
  const pendingByDevice = Object.keys(state.pendingActions)
    .filter(key => key.startsWith(`${device.serial}:`))
    .sort()
    .join(",");
  return [
    device.serial,
    pendingByDevice,
    device.online ? "1" : "0",
    device.model || "",
    device.transportId || "",
    device.nickname || "",
    device.phoneNumber || "",
    device.role || "",
    device.routerId || "",
    device.routerSlot || "",
    device.routerLabel || "",
    device.routerSsid || "",
    device.sessionState || "",
    device.prepState || "",
    device.prepElapsedMs || 0,
    device.queueWaitMs || 0,
    device.lastPrepDurationMs || 0,
    device.prepMessage || "",
    device.publicIp?.currentIp || "",
    device.publicIp?.status || "",
    device.publicIp?.lastCheckedAt || "",
    device.publicIp?.changedSinceLastPrep ? "1" : "0",
    device.publicIp?.reusedRecently ? "1" : "0",
    (device.publicIp?.duplicateWith || []).join(","),
    device.routingRisk?.level || "",
    device.routingRisk?.label || "",
    device.routingRisk?.detail || "",
    device.activationLock?.allowed ? "1" : "0",
    device.activationLock?.reason || "",
    device.viewerLaunch?.status || "",
    device.viewerLaunch?.pid || "",
    device.viewerLaunch?.requestedAt || "",
    device.viewerLaunch?.confirmedAt || "",
    device.viewerLaunch?.lastError || ""
  ].join("~");
}

function buildDeviceViewsSignature(devices) {
  const safeDevices = (devices || []).filter(Boolean);
  const pendingKeys = Object.keys(state.pendingActions).sort().join(",");
  return [
    state.viewMode,
    state.data?.routingGuard?.blocked ? "1" : "0",
    pendingKeys,
    ...safeDevices.map(buildDeviceSignature)
  ].join("|");
}

function mapChildrenBySerial(container, selector) {
  const mapped = new Map();
  container.querySelectorAll(selector).forEach(node => {
    if (node.dataset.serial) {
      mapped.set(node.dataset.serial, node);
    }
  });
  return mapped;
}

function createEmptyStateElement(tagName, className, text, colSpan = 0) {
  const element = document.createElement(tagName);
  if (className) {
    element.className = className;
  }
  if (tagName.toLowerCase() === "tr" && colSpan > 0) {
    const cell = document.createElement("td");
    cell.colSpan = colSpan;
    cell.className = className;
    cell.textContent = text;
    element.appendChild(cell);
    return element;
  }
  element.textContent = text;
  return element;
}

function render() {
  appShell.hidden = false;
  appShell.classList.toggle("table-mode", state.viewMode === "table");
  setTextIfChanged(currentUser, `${state.user?.displayName || "Operator"} (${state.user?.role || "admin"})`);
  setTextIfChanged(liveClock, formatNow());

  const data = state.data || buildEmptyData();
  const visibleDevices = filterDevices(data.devices || []);
  const summaryStats = buildSummaryStats(data.devices || []);
  const heroGuardSignature = `${data.routingGuard?.blocked ? "1" : "0"}|${(data.routingGuard?.reasons || []).join("|")}`;
  const heroInsightsSignature = buildHeroInsightsSignature(data, visibleDevices);
  const summaryStatsSignature = buildSummaryStatsSignature(summaryStats);
  const rackOverviewSignature = buildRackOverviewSignature(data.routers || []);
  const contextSignature = buildContextSignature(data.devices || [], visibleDevices, data.activeSession);
  const routersSignature = buildRoutersSignature(data.routers || []);
  const queueSignature = buildQueueSignature(data);
  const activitySignature = buildActivitySignature(data.recentActivity || []);
  const routingAuditSignature = buildRoutingAuditSignature(
    data.routingAudit || { overallOk: false, summary: "Routing audit has not completed yet.", checks: [] },
    data.routingGuard || {}
  );
  const deviceCountSignature = `${visibleDevices.length}`;
  const deviceViewsSignature = buildDeviceViewsSignature(visibleDevices);

  syncControls();
  if (state.renderCache.heroGuard !== heroGuardSignature) {
    renderHeroGuard(data.routingGuard || {});
    state.renderCache.heroGuard = heroGuardSignature;
  }
  if (state.renderCache.heroInsights !== heroInsightsSignature) {
    renderHeroInsights(data, visibleDevices);
    state.renderCache.heroInsights = heroInsightsSignature;
  }
  if (state.renderCache.summaryStats !== summaryStatsSignature) {
    renderSummaryStats(summaryStats);
    state.renderCache.summaryStats = summaryStatsSignature;
  }
  if (state.renderCache.rackOverview !== rackOverviewSignature) {
    renderRackOverview(data.routers || []);
    state.renderCache.rackOverview = rackOverviewSignature;
  }
  if (state.renderCache.contextBar !== contextSignature) {
    renderContextBar(data.devices || [], visibleDevices);
    state.renderCache.contextBar = contextSignature;
  }
  if (state.renderCache.routers !== routersSignature) {
    renderRouters(data.routers || []);
    state.renderCache.routers = routersSignature;
  }
  if (state.renderCache.queue !== queueSignature) {
    renderQueuePanel(data);
    state.renderCache.queue = queueSignature;
  }
  if (state.renderCache.activity !== activitySignature) {
    renderActivityFeed(data.recentActivity || []);
    state.renderCache.activity = activitySignature;
  }
  if (state.renderCache.routingAudit !== routingAuditSignature) {
    renderRoutingAudit(data.routingAudit || { overallOk: false, summary: "Routing audit has not completed yet.", checks: [] }, data.routingGuard || {});
    state.renderCache.routingAudit = routingAuditSignature;
  }
  if (state.renderCache.deviceCount !== deviceCountSignature) {
    setTextIfChanged(deviceCount, `${visibleDevices.length} visible device${visibleDevices.length === 1 ? "" : "s"}`);
    state.renderCache.deviceCount = deviceCountSignature;
  }
  if (state.renderCache.deviceViews !== deviceViewsSignature) {
    renderDeviceViews(visibleDevices);
    state.renderCache.deviceViews = deviceViewsSignature;
  }
}

function buildEmptyData() {
  return {
    devices: [],
    routers: [],
    queue: [],
    recentActivity: [],
    routingAudit: { overallOk: false, summary: "Routing audit has not completed yet.", checks: [] },
    routingGuard: { blocked: false, reasons: [] },
    prepTelemetry: { active: null, lastCompleted: null },
    activeSession: null
  };
}

function syncControls() {
  searchInput.value = state.filters.search || "";
  statusFilter.value = state.filters.status;
  roleFilter.value = state.filters.role;
  warningsOnlyToggle.checked = state.filters.warningsOnly;
  readyOnlyToggle.checked = state.filters.readyOnly;
}

function renderHeroGuard(routingGuard) {
  const blocked = Boolean(routingGuard?.blocked);
  setTextIfChanged(routeGuardBadge, blocked ? "Prep Guard Blocked" : "Prep Guard Clear");
  setClassIfChanged(routeGuardBadge, `badge ${blocked ? "badge-failed" : "badge-ready"}`);
}

function renderHeroInsights(data, visibleDevices) {
  const routers = data?.routers || [];
  const readyRouters = routers.filter(router => {
    const routerState = router.routerState || {};
    return routerState.healthStatus === "online"
      && String(routerState.routerMode || "").toLowerCase() === "router"
      && String(routerState.uplinkMode || "").toLowerCase() === "router-uplink";
  });
  const blockedDevices = (visibleDevices || []).filter(device => shouldDisableAction(device, "start-session"));
  const prepActive = data?.prepTelemetry?.active || null;
  const noUplinkRouters = routers.filter(router => String(router.routerState?.tetheringState || "").toLowerCase() === "no-device").length;
  const apRouters = routers.filter(router => String(router.routerState?.routerMode || "").toLowerCase() === "ap").length;

  setTextIfChanged(heroPrimaryValue, `${readyRouters.length}/${routers.length || 0}`);
  setTextIfChanged(
    heroPrimaryNote,
    readyRouters.length
      ? "Routed Opals with a healthy uplink and a session-safe path."
      : "No Opals are fully session-ready yet. Promote one working router template first."
  );

  setTextIfChanged(heroSecondaryValue, String(blockedDevices.length));
  setTextIfChanged(
    heroSecondaryNote,
    blockedDevices.length
      ? "Visible phones blocked by routing, IP, or activation policy."
      : "Visible phones are currently clear of session policy blockers."
  );

  setTextIfChanged(heroTertiaryValue, prepActive ? formatDeviceName(getDeviceBySerial(prepActive.serial) || prepActive) : "Idle");
  setTextIfChanged(
    heroTertiaryNote,
    prepActive
      ? `Prep active for ${formatDuration(prepActive.elapsedMs || 0)} on ${prepActive.serial}.`
      : "No active prep worker is running."
  );

  const narrative = data?.routingGuard?.blocked
    ? "Desktop routing safety is blocking prep. Resolve the host path before launching phones."
    : readyRouters.length === 0
      ? `Rack is reachable but not session-ready. ${apRouters} router(s) remain in AP mode and ${noUplinkRouters} report no USB uplink device.`
      : blockedDevices.length > 0
        ? `${blockedDevices.length} phone(s) still need clearance before launch. Prioritize duplicate IP and activation lock issues.`
        : "Rack is in a clean operator state. Filter by ready devices and launch controlled sessions.";
  setTextIfChanged(heroNarrative, narrative);
}

function buildSummaryStats(devices) {
  const routers = state.data?.routers || [];
  return [
    { label: "Fleet", value: devices.length, tone: "neutral", onClick: () => clearQuickFilters() },
    { label: "Router Pool", value: routers.length, tone: "neutral", onClick: () => focusSearch() },
    { label: "Online", value: devices.filter(device => device.online).length, tone: "success", onClick: () => applyQuickFilter({ status: "online" }) },
    { label: "Queued", value: devices.filter(device => device.prepState === "queued").length, tone: "warning", onClick: () => applyQuickFilter({ status: "queued" }) },
    { label: "Preparing", value: devices.filter(device => device.prepState === "preparing").length, tone: "info", onClick: () => applyQuickFilter({ status: "preparing" }) },
    { label: "Ready", value: devices.filter(device => device.prepState === "ready").length, tone: "success", onClick: () => applyQuickFilter({ status: "ready", readyOnly: true }) },
    { label: "Failed", value: devices.filter(device => device.prepState === "failed").length, tone: "danger", onClick: () => applyQuickFilter({ status: "failed" }) },
    { label: "Locked", value: devices.filter(device => device.activationLock?.allowed === false).length, tone: devices.some(device => device.activationLock?.allowed === false) ? "warning" : "neutral", onClick: () => applyQuickFilter({ warningsOnly: true }) },
    {
      label: "Duplicate IP",
      value: devices.filter(device => isDuplicate(device)).length,
      tone: devices.some(device => isDuplicate(device)) ? "danger" : "neutral",
      onClick: () => applyQuickFilter({ warningsOnly: true })
    }
  ];
}

function renderSummaryStats(stats) {
  statsGrid.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const stat of stats) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `stat-card tone-${stat.tone}`;
    button.innerHTML = `<span>${escapeHtml(stat.label)}</span><strong>${escapeHtml(String(stat.value))}</strong>`;
    button.addEventListener("click", stat.onClick);
    fragment.appendChild(button);
  }
  statsGrid.appendChild(fragment);
}

function renderRackOverview(routers) {
  const safeRouters = (routers || []).filter(Boolean);
  const readyRouters = safeRouters.filter(router => {
    const state = router.routerState || {};
    return state.healthStatus === "online" && String(state.routerMode || "").toLowerCase() === "router" && String(state.uplinkMode || "").toLowerCase() === "router-uplink";
  }).length;
  const apRouters = safeRouters.filter(router => String(router.routerState?.routerMode || "").toLowerCase() === "ap").length;
  const missingUplinkRouters = safeRouters.filter(router => String(router.routerState?.tetheringState || "").toLowerCase() === "no-device").length;
  const unreachableRouters = safeRouters.filter(router => (router.routerState?.healthStatus || "") === "offline" || router.routerState?.lastError).length;
  const activeRouters = safeRouters.filter(router => router.activeDeviceSerial).length;

  const statusLabel = readyRouters > 0 ? `${readyRouters} routed ready` : "No routed routers";
  rackOverviewBadge.textContent = statusLabel;
  rackOverviewBadge.className = `count-pill ${readyRouters > 0 ? "count-pill-success" : "count-pill-warning"}`;

  const items = [
    { label: "Routed Ready", value: readyRouters, tone: "success", note: "Routers in router mode with a usable uplink path." },
    { label: "AP Only", value: apRouters, tone: apRouters ? "warning" : "neutral", note: "Reachable Opals still bridged or in access-point mode." },
    { label: "No USB Uplink", value: missingUplinkRouters, tone: missingUplinkRouters ? "danger" : "neutral", note: "Routers that do not currently detect a LinkPro USB data device." },
    { label: "Unreachable", value: unreachableRouters, tone: unreachableRouters ? "danger" : "neutral", note: "Routers that failed management checks and need recovery." },
    { label: "Active Routers", value: activeRouters, tone: activeRouters ? "info" : "neutral", note: "Routers currently tied to an active device session." }
  ];

  rackOverviewGrid.innerHTML = "";
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const article = document.createElement("article");
    article.className = `rack-overview-card tone-${item.tone}`;
    article.innerHTML = `
      <span class="rack-overview-label">${escapeHtml(item.label)}</span>
      <strong class="rack-overview-value">${escapeHtml(String(item.value))}</strong>
      <p class="rack-overview-note">${escapeHtml(item.note)}</p>
    `;
    fragment.appendChild(article);
  }
  rackOverviewGrid.appendChild(fragment);
}

function renderContextBar(allDevices, visibleDevices) {
  const hiddenCount = Math.max((allDevices || []).length - (visibleDevices || []).length, 0);
  const modeLabel = state.viewMode === "table" ? "Table view" : "Card view";
  const warningCount = (visibleDevices || []).filter(hasWarning).length;
  const activeSession = state.data?.activeSession;
  const activeSummary = activeSession ? `Active device: ${activeSession.label || activeSession.serial}.` : "No active device.";
  contextSummary.textContent = `${visibleDevices.length} visible, ${hiddenCount} filtered out, ${warningCount} with warnings, ${modeLabel.toLowerCase()}. ${activeSummary}`;

  contextChips.innerHTML = "";
  const chips = [];
  if (state.filters.search) chips.push(`Search: ${state.filters.search}`);
  if (state.filters.status !== "all") chips.push(`Status: ${state.filters.status}`);
  if (state.filters.role !== "all") chips.push(`Role: ${state.filters.role}`);
  if (state.filters.warningsOnly) chips.push("Warnings only");
  if (state.filters.readyOnly) chips.push("Ready only");
  if (!chips.length) chips.push("All devices");
  chips.push(modeLabel);

  const fragment = document.createDocumentFragment();
  for (const chipLabel of chips) {
    const chip = document.createElement("div");
    chip.className = "context-chip";
    chip.textContent = chipLabel;
    fragment.appendChild(chip);
  }
  contextChips.appendChild(fragment);
}

function applyQuickFilter(patch) {
  state.filters = {
    ...state.filters,
    ...patch
  };
  render();
}

function clearQuickFilters() {
  state.filters = {
    search: "",
    status: "all",
    role: "all",
    warningsOnly: false,
    readyOnly: false
  };
  render();
}

function focusSearch() {
  searchInput.focus();
  searchInput.select();
}

function handleGlobalShortcut(event) {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }

  const target = event.target;
  const editing = target && (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );

  if (event.key === "/" && !editing) {
    event.preventDefault();
    focusSearch();
    return;
  }

  if (editing) {
    return;
  }

  if (event.key === "v" || event.key === "V") {
    event.preventDefault();
    setViewMode(state.viewMode === "cards" ? "table" : "cards");
    return;
  }

  if (event.key === "r" || event.key === "R") {
    event.preventDefault();
    refresh(true);
    return;
  }

  if (event.key === "w" || event.key === "W") {
    event.preventDefault();
    applyQuickFilter({ warningsOnly: !state.filters.warningsOnly, readyOnly: false });
    return;
  }

  if (event.key === "a" || event.key === "A") {
    event.preventDefault();
    clearQuickFilters();
  }
}

function renderQueuePanel(data) {
  const queue = data.queue || [];
  const prepTelemetry = data.prepTelemetry || {};
  queueLengthBadge.textContent = `${queue.length} queued`;

  if (prepTelemetry.active) {
    activePrepDevice.textContent = prepTelemetry.active.label || prepTelemetry.active.serial;
    activePrepCountdown.textContent = `Elapsed ${formatDuration(prepTelemetry.active.elapsedMs)} | Started ${formatShortTime(prepTelemetry.active.startedAt)}`;
    syncProgressBar(activePrepProgressBar, computePrepProgress(prepTelemetry.active.elapsedMs, "preparing"));
  } else {
    activePrepDevice.textContent = "Idle";
    activePrepCountdown.textContent = "No active prep worker";
    syncProgressBar(activePrepProgressBar, 0);
  }

  if (prepTelemetry.lastCompleted) {
    lastCompletedPrep.textContent = prepTelemetry.lastCompleted.label || prepTelemetry.lastCompleted.serial;
    lastCompletedPrepMeta.textContent = `${prepTelemetry.lastCompleted.prepState.toUpperCase()} in ${formatDuration(prepTelemetry.lastCompleted.durationMs)} | ${formatDateTime(prepTelemetry.lastCompleted.finishedAt)}`;
  } else {
    lastCompletedPrep.textContent = "No completed prep yet";
    lastCompletedPrepMeta.textContent = "Waiting for first completion";
  }

  queueList.innerHTML = "";
  if (!queue.length) {
    queueList.innerHTML = `<div class="queue-item">Queue is empty.</div>`;
    return;
  }

  const devicesBySerial = new Map((data.devices || []).map(device => [device.serial, device]));
  const fragment = document.createDocumentFragment();
  queue.forEach((serial, index) => {
    const device = devicesBySerial.get(serial);
    const item = document.createElement("div");
    item.className = "queue-item";
    const label = device ? formatDeviceName(device) : serial;
    const waitMs = device?.queueWaitMs || 0;
    item.innerHTML = `<strong>${index + 1}. ${escapeHtml(label)}</strong><small>${escapeHtml(serial)} | Waiting ${escapeHtml(formatDuration(waitMs))}</small>`;
    fragment.appendChild(item);
  });
  queueList.appendChild(fragment);
}

function renderRouters(routers) {
  routerCount.textContent = `${routers.length} routers`;
  routerGrid.innerHTML = "";
  if (!routers.length) {
    routerGrid.innerHTML = `<div class="empty-state">No routers are configured yet.</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const router of routers) {
    const card = document.createElement("article");
    card.className = "router-card";
    const healthStatus = router.routerState?.healthStatus || "unknown";
    const healthClass = healthStatus === "online"
      ? "badge-ready"
      : ((healthStatus === "partial" || healthStatus === "degraded") ? "badge-queued" : (healthStatus === "offline" ? "badge-failed" : "badge-neutral"));
    const tetheringState = String(router.routerState?.tetheringState || "");
    const tetheringTone = tetheringState === "detected" ? "badge-ready" : (tetheringState === "no-device" ? "badge-failed" : "badge-neutral");
    const tetheringLabel = tetheringState ? tetheringState.replace(/-/g, " ") : "Unknown";
    const tetheringHint = router.routerState?.tetheringHint || router.routerState?.tetheringError || "";
    card.innerHTML = `
      <header>
        <div>
          <p class="device-kicker">Router</p>
          <h3>${escapeHtml(router.label || router.id)}</h3>
          <p class="device-serial">${escapeHtml(router.host || "Host not set")}</p>
        </div>
        <div class="card-badges">
          ${renderBadgeMarkup(router.activeDeviceSerial ? "Active" : "Idle", router.activeDeviceSerial ? "badge-online" : "badge-idle")}
          ${renderBadgeMarkup(healthStatus.toUpperCase(), healthClass)}
        </div>
      </header>
      <div class="router-meta">
        <div><span>Assigned</span><strong>${escapeHtml(String(router.assignedDeviceCount))}/${escapeHtml(String(router.maxAssignedDevices || 4))}</strong></div>
        <div><span>Active Device</span><strong>${escapeHtml(router.activeDeviceLabel || "None")}</strong></div>
        <div><span>SSID</span><strong>${escapeHtml(router.ssid || "Not set")}</strong></div>
        <div><span>Uplink</span><strong>${escapeHtml(router.mobileUplinkId || "Not set")}</strong></div>
        <div><span>Reachability</span><strong>${escapeHtml(buildRouterReachability(router))}</strong></div>
        <div><span>Last Check</span><strong>${escapeHtml(router.routerState?.lastCheckedAt ? formatShortTime(router.routerState.lastCheckedAt) : "Not checked")}</strong></div>
        <div><span>WAN</span><strong>${escapeHtml(router.routerState?.wanUp ? "Up" : "Unknown")}${router.routerState?.wanDevice ? ` via ${escapeHtml(router.routerState.wanDevice)}` : ""}</strong></div>
        <div><span>Router Mode</span><strong>${escapeHtml(router.routerState?.routerMode || "Unknown")}</strong></div>
        <div><span>Uplink Mode</span><strong>${escapeHtml(router.routerState?.uplinkMode || "Unknown")}${router.routerState?.uplinkInterface ? ` via ${escapeHtml(router.routerState.uplinkInterface)}` : ""}</strong></div>
        <div><span>USB Uplink</span><strong class="${escapeHtml(tetheringTone)}">${escapeHtml(tetheringLabel)}</strong></div>
        <div><span>USB Ports</span><strong>${escapeHtml(router.routerState?.usbPorts || "Unknown")}</strong></div>
        <div><span>WAN Address</span><strong class="table-code">${escapeHtml(router.routerState?.wanAddress || "Unknown")}</strong></div>
        <div><span>Router Public IP</span><strong class="table-code">${escapeHtml(router.routerState?.publicIp || "Unknown")}</strong></div>
        <div><span>Last Restart</span><strong>${escapeHtml(router.routerState?.lastRestartAt ? formatShortTime(router.routerState.lastRestartAt) : "Never")}</strong></div>
      </div>
      ${tetheringHint ? `<div class="router-alert">${escapeHtml(tetheringHint)}</div>` : ""}
      <div class="table-subline">${escapeHtml(router.routerState?.detail || "No router health detail yet.")}</div>
      <div class="router-actions">
        <button class="button button-secondary" type="button" data-router-action="router-health">Health</button>
        <button class="button button-secondary" type="button" data-router-action="reboot-router">Reboot</button>
        <button class="button button-secondary" type="button" data-router-action="wan-reconnect">Reconnect WAN</button>
        <button class="button button-secondary" type="button" data-router-action="restart-wifi">Restart Wi-Fi</button>
        <button class="button button-secondary" type="button" data-router-action="cycle-uplink">Cycle Uplink</button>
      </div>
    `;
    card.querySelectorAll("[data-router-action]").forEach(button => {
      button.addEventListener("click", () => invokeRouterAction(router.id, button.dataset.routerAction));
    });
    fragment.appendChild(card);
  }

  routerGrid.appendChild(fragment);
}

function renderActivityFeed(events) {
  activityList.innerHTML = "";
  const visibleEvents = events.filter(isOperatorEvent).slice(0, 20);

  if (!visibleEvents.length) {
    activityList.innerHTML = `<div class="activity-item">No recent operator-visible events.</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const event of visibleEvents) {
    const item = document.createElement("article");
    item.className = "activity-item";
    const serialLabel = event.serial ? ` | ${escapeHtml(event.serial)}` : "";
    item.innerHTML = `<strong>${escapeHtml(event.category.toUpperCase())}${serialLabel}</strong><div>${escapeHtml(event.message)}</div><small>${escapeHtml(formatDateTime(event.timestamp))}</small>`;
    fragment.appendChild(item);
  }
  activityList.appendChild(fragment);
}

function renderRoutingAudit(audit, routingGuard) {
  routingSummary.textContent = audit.summary || "Routing audit has not completed yet.";
  routingStatusBadge.textContent = routingGuard.blocked ? "Blocked" : (audit.overallOk ? "Separated" : "Review Needed");
  routingStatusBadge.className = `badge ${routingGuard.blocked ? "badge-failed" : (audit.overallOk ? "badge-ready" : "badge-queued")}`;

  routingPaths.innerHTML = "";
  const pathFragment = document.createDocumentFragment();
  for (const line of [
    routingGuard.dashboardAccessPath ? `Dashboard path: ${routingGuard.dashboardAccessPath}` : "",
    routingGuard.deviceTrafficPath ? `Device path: ${routingGuard.deviceTrafficPath}` : "",
    routingGuard.pcPublicIp ? `PC public IP: ${routingGuard.pcPublicIp}` : ""
  ].filter(Boolean)) {
    const chip = document.createElement("div");
    chip.className = "route-chip";
    chip.textContent = line;
    pathFragment.appendChild(chip);
  }
  if (routingGuard.blocked && routingGuard.reasons?.length) {
    for (const reason of routingGuard.reasons) {
      const chip = document.createElement("div");
      chip.className = "route-chip route-chip-danger";
      chip.textContent = reason;
      pathFragment.appendChild(chip);
    }
  }
  routingPaths.appendChild(pathFragment);

  routingChecks.innerHTML = "";
  const checks = audit.checks || [];
  if (!checks.length) {
    routingChecks.innerHTML = `<div class="activity-item">No routing audit results yet.</div>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const check of checks) {
    const item = document.createElement("article");
    item.className = "activity-item";
    item.innerHTML = `<strong>${escapeHtml(check.name)}</strong><div>${escapeHtml(check.detail)}</div><small>${check.ok ? "OK" : "Needs review"}</small>`;
    fragment.appendChild(item);
  }
  routingChecks.appendChild(fragment);
}

function renderDeviceViews(devices = filterDevices((state.data?.devices) || [])) {
  cardView.hidden = state.viewMode !== "cards";
  tableView.hidden = state.viewMode !== "table";
  if (state.viewMode === "cards") {
    renderCardView(devices);
    tableView.hidden = true;
  } else {
    renderTableView(devices);
    cardView.hidden = true;
  }
}

function renderCardView(devices) {
  const safeDevices = (devices || []).filter(Boolean);
  if (!safeDevices.length) {
    cardView.replaceChildren(createEmptyStateElement("div", "empty-state", "No devices match the current filters."));
    return;
  }

  const existingCards = mapChildrenBySerial(cardView, ".device-card[data-serial]");
  const fragment = document.createDocumentFragment();
  for (const device of safeDevices) {
    const signature = buildDeviceSignature(device);
    const existing = existingCards.get(device.serial);
    if (existing && existing.dataset.renderSig === signature) {
      fragment.appendChild(existing);
      continue;
    }
    fragment.appendChild(createDeviceCardElement(device, signature));
  }
  cardView.replaceChildren(fragment);
}

function renderTableView(devices) {
  const safeDevices = (devices || []).filter(Boolean);
  if (!safeDevices.length) {
    deviceTableBody.replaceChildren(createEmptyStateElement("tr", "table-empty", "No devices match the current filters.", 13));
    return;
  }

  const existingRows = mapChildrenBySerial(deviceTableBody, "tr[data-serial]");
  const fragment = document.createDocumentFragment();
  for (const device of safeDevices) {
    const signature = buildDeviceSignature(device);
    const existing = existingRows.get(device.serial);
    if (existing && existing.dataset.renderSig === signature) {
      fragment.appendChild(existing);
      continue;
    }
    fragment.appendChild(createDeviceTableRow(device, signature));
  }
  deviceTableBody.replaceChildren(fragment);
}

function createDeviceTableRow(device, signature = buildDeviceSignature(device)) {
  const row = document.createElement("tr");
  row.dataset.serial = device.serial;
  row.dataset.renderSig = signature;
  row.className = `table-row prep-${device.prepState || "idle"}`;
  row.innerHTML = `
    <td>
      <div class="table-device-cell">
        <strong>${escapeHtml(formatDeviceName(device))}</strong>
        <small>${escapeHtml(device.serial)}</small>
        <div class="table-subline table-subline-strong">${escapeHtml(device.transportId || device.serial)}</div>
      </div>
    </td>
    <td>
      <div class="table-stack">
        <strong class="table-code">${escapeHtml(device.serial)}</strong>
        <span class="table-subline">${escapeHtml(device.model || "Unknown model")}</span>
      </div>
    </td>
    <td>${renderBadgeMarkup(device.online ? "Online" : "Offline", device.online ? "badge-online" : "badge-offline")}</td>
    <td>${renderBadgeMarkup(formatRole(device.role), "badge-neutral")}</td>
    <td>
      <div class="table-stack">
        <strong>${escapeHtml(device.routerLabel || device.routerId || "Unassigned")}</strong>
        <span class="table-subline">${escapeHtml(device.routerSlot ? `Slot ${device.routerSlot}` : "No slot")}</span>
      </div>
    </td>
    <td>${renderBadgeMarkup(formatSession(device.sessionState), sessionBadgeClass(device.sessionState))}</td>
    <td>${renderBadgeMarkup((device.prepState || "idle").toUpperCase(), prepBadgeClass(device.prepState))}<div class="table-subline">${escapeHtml(formatPrepTimer(device))}</div><div class="table-subline">${escapeHtml(formatViewerLaunch(device.viewerLaunch))}</div></td>
    <td>
      <div class="table-stack">
        <strong>${escapeHtml(formatPrepProgressLabel(device))}</strong>
        <div class="prep-progress prep-progress-compact" aria-hidden="true">
          <div class="prep-progress-bar" style="width: ${computePrepProgress(device.prepElapsedMs || device.queueWaitMs || 0, device.prepState)}%"></div>
        </div>
      </div>
    </td>
    <td>
      <div class="table-stack">
        <strong>${escapeHtml(formatGmail(device.account))}</strong>
        <span class="table-subline">${escapeHtml(device.account?.status || "unknown")}</span>
      </div>
    </td>
    <td>
      <div class="table-stack">
        <strong class="table-code">${escapeHtml(device.publicIp?.currentIp || "Not checked")}</strong>
        <span class="table-subline">${escapeHtml((device.publicIp?.status || "unknown").toUpperCase())}</span>
      </div>
    </td>
    <td>
      <div class="table-stack">
        <strong>${escapeHtml(device.publicIp?.lastCheckedAt ? formatShortTime(device.publicIp.lastCheckedAt) : "-")}</strong>
        <span class="table-subline">${escapeHtml(device.publicIp?.lastCheckedAt ? formatDateTime(device.publicIp.lastCheckedAt) : "No successful check")}</span>
      </div>
    </td>
    <td>
      <div class="table-warning ${hasWarning(device) ? "table-warning-active" : ""}">
        <strong>${escapeHtml(isReused(device) ? "Cross-device IP reuse" : (device.routingRisk?.label || deviceWarningLabel(device)))}</strong>
        <span class="table-subline">${escapeHtml(buildCompactWarning(device))}</span>
      </div>
    </td>
    <td>
      <div class="table-actions">
        <button class="table-action" data-editor="true">Edit</button>
        ${renderTableActionButton(device, "open-control", "Open")}
        ${renderTableActionButton(device, "prep", "Prep", true)}
        ${renderTableActionButton(device, "connect-router", "Connect")}
        ${renderTableActionButton(device, "reset-uplink-ip", "Reset IP")}
        ${renderTableActionButton(device, "engage-airplane", "Airplane")}
        ${renderTableActionButton(device, "recover-radios", "Recover")}
        ${renderTableActionButton(device, "check-ip", "IP")}
        ${renderTableActionButton(device, "start-session", "Start")}
        ${renderTableActionButton(device, "stop-session", "Stop")}
      </div>
    </td>
  `;

  row.querySelector("[data-editor='true']")?.addEventListener("click", () => openDeviceEditor(device.serial));
  row.querySelectorAll("[data-action]").forEach(button => {
    if (shouldDisableAction(device, button.dataset.action)) {
      button.disabled = true;
    }
    button.addEventListener("click", () => invokeDeviceAction(device.serial, button.dataset.action));
  });

  return row;
}

function renderTableActionButton(device, action, label, primary = false) {
  const busy = isActionPending(device.serial, action);
  const disabled = shouldDisableAction(device, action);
  return `<button class="table-action${primary ? " table-action-primary" : ""}" data-action="${escapeHtml(action)}"${disabled ? " disabled" : ""}>${escapeHtml(busy ? "Working..." : label)}</button>`;
}

function buildCompactWarning(device) {
  if (!device.online) {
    return "This phone is offline in ADB and cannot be prepped until it reconnects.";
  }
  if (!device.routerId) {
    return "This phone is not assigned to a router yet.";
  }
  if (isReused(device)) {
    return device.publicIp?.reusePolicyLabel || "This IP was reused recently and should be rotated.";
  }
  if (state.data?.settings?.sessionPolicy?.restartRouterBeforeSession) {
    return "RouterFarm will restart the assigned router before session start and require a fresh IP.";
  }
  if (isDuplicate(device)) {
    return "Duplicate IP detected in the current set.";
  }
  if (device.prepState === "failed") {
    return device.prepMessage || "Prep failed.";
  }
  if (device.publicIp?.status === "failed") {
    return device.publicIp?.lastError || "IP check failed.";
  }
  if (device.activationLock?.allowed === false) {
    return device.activationLock.reason || "Activation is locked.";
  }
  return device.routingRisk?.detail || "No active warning.";
}

function renderDeviceCard(device) {
  if (!device || !template?.content) {
    return document.createDocumentFragment();
  }
  const fragment = template.content.cloneNode(true);
  const root = fragment.querySelector(".device-card");
  const kicker = fragment.querySelector(".device-kicker");
  const name = fragment.querySelector(".device-name");
  const serial = fragment.querySelector(".device-serial");
  const statusBadge = fragment.querySelector(".status-badge");
  const roleBadge = fragment.querySelector(".role-badge");
  const prepBadge = fragment.querySelector(".prep-badge");
  const duplicateBadge = fragment.querySelector(".duplicate-badge");
  const reuseBadge = fragment.querySelector(".reuse-badge");
  const gmailValue = fragment.querySelector(".gmail-value");
  const publicIpValue = fragment.querySelector(".public-ip-value");
  const lastCheckedValue = fragment.querySelector(".last-checked-value");
  const ipStatusValue = fragment.querySelector(".ip-status-value");
  const routerValue = fragment.querySelector(".router-value");
  const routeRiskValue = fragment.querySelector(".route-risk-value");
  const sessionValue = fragment.querySelector(".session-value");
  const prepTimerValue = fragment.querySelector(".prep-timer-value");
  const prepProgressBar = fragment.querySelector(".prep-progress-bar");
  const lastPrepValue = fragment.querySelector(".last-prep-value");
  const viewerLaunchValue = fragment.querySelector(".viewer-launch-value");
  const activationLockValue = fragment.querySelector(".activation-lock-value");
  const transportValue = fragment.querySelector(".transport-value");
  const changedState = fragment.querySelector(".state-changed");
  const duplicateState = fragment.querySelector(".state-duplicate");
  const ipHistoryState = fragment.querySelector(".state-ip-history");
  const viewerLaunchState = fragment.querySelector(".state-viewer-launch");
  const prepMessageState = fragment.querySelector(".state-prep-message");

  kicker.textContent = device.phoneNumber ? `Device ${String(device.phoneNumber).padStart(2, "0")}` : "Device";
  name.textContent = formatDeviceName(device);
  serial.textContent = device.serial;
  statusBadge.textContent = device.online ? "Online" : "Offline";
  statusBadge.className = `badge status-badge ${device.online ? "badge-online" : "badge-offline"}`;
  roleBadge.textContent = formatRole(device.role);
  roleBadge.className = "badge role-badge badge-neutral";
  prepBadge.textContent = (device.prepState || "idle").toUpperCase();
  prepBadge.className = `badge prep-badge ${prepBadgeClass(device.prepState)}`;
  gmailValue.textContent = formatGmail(device.account);
  publicIpValue.textContent = device.publicIp?.currentIp || "Not checked";
  lastCheckedValue.textContent = device.publicIp?.lastCheckedAt ? formatDateTime(device.publicIp.lastCheckedAt) : "-";
  ipStatusValue.textContent = (device.publicIp?.status || "unknown").toUpperCase();
  routerValue.textContent = device.routerLabel || device.routerId || "Unassigned";
  routeRiskValue.textContent = device.routingRisk?.label || "Unknown";
  sessionValue.textContent = formatSession(device.sessionState);
  prepTimerValue.textContent = formatPrepTimer(device);
  syncProgressBar(prepProgressBar, computePrepProgress(device.prepElapsedMs || device.queueWaitMs || 0, device.prepState));
  lastPrepValue.textContent = device.lastPrepDurationMs ? formatDuration(device.lastPrepDurationMs) : "No recorded prep";
  viewerLaunchValue.textContent = formatViewerLaunch(device.viewerLaunch);
  activationLockValue.textContent = device.activationLock?.allowed ? "Ready" : (device.activationLock?.reason || "Locked");
  transportValue.textContent = device.transportId || device.serial;
  changedState.textContent = `Changed since last prep/session: ${device.publicIp?.changedSinceLastPrep ? "Yes" : "No"}`;
  duplicateState.textContent = buildReuseWarning(device);
  duplicateState.classList.toggle("state-pill-danger", Boolean(device.publicIp?.reusedRecently));
  ipHistoryState.textContent = buildIpHistorySummary(device);
  viewerLaunchState.textContent = buildViewerLaunchDetails(device.viewerLaunch);
  viewerLaunchState.classList.toggle("state-pill-danger", device.viewerLaunch?.status === "failed");
  prepMessageState.textContent = device.prepMessage || "No prep message";
  duplicateBadge.hidden = !isDuplicate(device);
  reuseBadge.hidden = !isReused(device);

  root.classList.add(`prep-${device.prepState || "idle"}`);
  root.classList.add(`risk-${device.routingRisk?.level || "neutral"}`);
  if (device.prepState === "preparing") root.classList.add("is-preparing");
  if (device.prepState === "failed") root.classList.add("is-failed");

  bindCardAction(fragment.querySelector(".action-open"), device, "open-control", "Open Control");
  bindEditorAction(fragment.querySelector(".action-edit"), device);
  bindCardAction(fragment.querySelector(".action-prep"), device, "prep", "Prep Device");
  bindCardAction(fragment.querySelector(".action-connect-router"), device, "connect-router", "Connect Router");
  bindCardAction(fragment.querySelector(".action-reset-uplink"), device, "reset-uplink-ip", "Reset Uplink");
  bindCardAction(fragment.querySelector(".action-airplane"), device, "engage-airplane", "Engage Airplane");
  bindCardAction(fragment.querySelector(".action-recover"), device, "recover-radios", "Recover Radios");
  bindCardAction(fragment.querySelector(".action-check-ip"), device, "check-ip", "Check IP");
  bindCardAction(fragment.querySelector(".action-start"), device, "start-session", "Start Session");
  bindCardAction(fragment.querySelector(".action-stop"), device, "stop-session", "Stop Session");

  return fragment;
}

function createDeviceCardElement(device, signature = buildDeviceSignature(device)) {
  const fragment = renderDeviceCard(device);
  const root = fragment.querySelector(".device-card");
  if (!root) {
    const fallback = document.createElement("article");
    fallback.className = "device-card";
    fallback.dataset.serial = device?.serial || "";
    fallback.dataset.renderSig = signature;
    fallback.textContent = device?.serial ? `Unable to render ${device.serial}` : "Unable to render device";
    return fallback;
  }
  root.dataset.serial = device.serial;
  root.dataset.renderSig = signature;
  return root;
}

function bindCardAction(button, device, action, label) {
  if (!button || !device?.serial) {
    return;
  }
  const busy = isActionPending(device.serial, action);
  button.disabled = shouldDisableAction(device, action);
  button.textContent = busy ? "Working..." : label;
  button.addEventListener("click", () => invokeDeviceAction(device.serial, action));
}

function bindEditorAction(button, device) {
  if (!button || !device?.serial) {
    return;
  }
  button.addEventListener("click", () => openDeviceEditor(device.serial));
}

function filterDevices(devices) {
  return devices.filter(device => {
    const searchTarget = `${device.nickname || ""} ${device.serial} ${device.phoneNumber || ""} ${formatGmail(device.account)} ${device.publicIp?.currentIp || ""}`.toLowerCase();
    const routerTarget = `${device.routerLabel || ""} ${device.routerId || ""} ${device.routerSsid || ""}`.toLowerCase();
    const statusMatch =
      state.filters.status === "all" ||
      (state.filters.status === "online" && device.online) ||
      (state.filters.status === "offline" && !device.online) ||
      device.prepState === state.filters.status;
    const roleMatch = state.filters.role === "all" || (device.role || "sim-direct") === state.filters.role;
    const warningsMatch = !state.filters.warningsOnly || hasWarning(device);
    const readyMatch = !state.filters.readyOnly || device.prepState === "ready";
    const searchMatch = !state.filters.search || searchTarget.includes(state.filters.search) || routerTarget.includes(state.filters.search);
    return statusMatch && roleMatch && warningsMatch && readyMatch && searchMatch;
  });
}

function hasWarning(device) {
  return isDuplicate(device) ||
    isReused(device) ||
    device.activationLock?.allowed === false ||
    device.prepState === "failed" ||
    device.publicIp?.status === "failed" ||
    device.publicIp?.status === "changed" ||
    ["critical", "warning"].includes(device.routingRisk?.level);
}

function isDuplicate(device) {
  return Boolean(device.publicIp?.duplicateWith && device.publicIp.duplicateWith.length);
}

function isReused(device) {
  return Boolean(device.publicIp?.reusedRecently);
}

function buildReuseWarning(device) {
  if (!device.routerId) {
    return "Router assignment required before this phone can be activated.";
  }
  if (device.publicIp?.reusedRecently) {
    return `BIG WARNING: ${device.publicIp?.reusePolicyLabel || "this IP was reused recently"}. Reset the router and verify a fresh IP before starting a session.`;
  }
  return `Route risk: ${device.routingRisk?.detail || deviceWarningLabel(device)}`;
}

function buildIpHistorySummary(device) {
  const entries = device.publicIp?.last100History || [];
  if (!entries.length) {
    return "IP monitor: no successful history yet.";
  }
  const uniqueIps = new Set(entries.map(entry => entry.ip).filter(Boolean));
  if (device.publicIp?.reusedRecently) {
    return `IP monitor: ${entries.length} successful checks tracked in the active policy window. Reuse detected.`;
  }
  return `IP monitor: ${entries.length} successful checks across ${uniqueIps.size} unique IPs.`;
}

function deviceWarningLabel(device) {
  if (!device.online) return "Offline";
  if (!device.routerId) return "Router Needed";
  if (isDuplicate(device)) return "Duplicate IP";
  if (isReused(device)) return "Reused IP";
  if (device.activationLock?.allowed === false) return "Activation Locked";
  if (device.publicIp?.status === "changed") return "IP Changed";
  if (device.prepState === "failed") return "Prep Failed";
  if (device.publicIp?.status === "failed") return "IP Check Failed";
  return "None";
}

function buildRouterReachability(router) {
  const reachability = router.routerState?.reachability || {};
  const open = [];
  if (reachability.ssh) open.push("SSH");
  if (reachability.http) open.push("HTTP");
  if (reachability.https) open.push("HTTPS");
  return open.length ? open.join(" / ") : "No management ports detected";
}

function getRouterForDevice(device) {
  return (state.data?.routers || []).find(router => router.id === device?.routerId) || null;
}

function routerBlocksSession(router) {
  const routerState = router?.routerState || {};
  const routerMode = String(routerState.routerMode || "").toLowerCase();
  const uplinkMode = String(routerState.uplinkMode || "").toLowerCase();
  return routerState.healthStatus !== "online" ||
    (routerMode && routerMode !== "router") ||
    (uplinkMode && uplinkMode !== "router-uplink");
}

function shouldDisableAction(device, action) {
  if (!device?.serial) return true;
  if (isActionPending(device.serial, action)) return true;
  if (action === "prep") {
    return !device.online ||
      device.sessionState === "running" ||
      device.prepState === "queued" ||
      device.prepState === "preparing" ||
      Boolean(state.data?.routingGuard?.blocked);
  }
  if (action === "start-session") {
    const assignedRouter = getRouterForDevice(device);
    return Boolean(state.data?.routingGuard?.blocked) ||
      !device.activationLock?.allowed ||
      Boolean(state.data?.settings?.ipReusePolicy?.blockSessionStartOnReuse && device.publicIp?.reusePolicyViolation) ||
      (device.routerId && routerBlocksSession(assignedRouter));
  }
  if (action === "connect-router" || action === "reset-uplink-ip") {
    return !device.routerId;
  }
  return false;
}

function isActionPending(serial, action) {
  return Boolean(state.pendingActions[`${serial}:${action}`]);
}

function renderBadgeMarkup(label, className) {
  return `<span class="badge ${className}">${escapeHtml(label)}</span>`;
}

function prepBadgeClass(prepState) {
  if (prepState === "ready") return "badge-ready";
  if (prepState === "queued") return "badge-queued";
  if (prepState === "preparing") return "badge-preparing";
  if (prepState === "failed") return "badge-failed";
  return "badge-idle";
}

function sessionBadgeClass(sessionState) {
  if (sessionState === "running") return "badge-online";
  return "badge-idle";
}

function isOperatorEvent(event) {
  const text = `${event.category} ${event.message}`.toLowerCase();
  return ["prep", "scrcpy", "ip-check", "duplicate", "disconnect", "queue", "session", "recover", "airplane", "routing"]
    .some(keyword => text.includes(keyword));
}

async function invokeDeviceAction(serial, action, body = {}) {
  const pendingKey = `${serial}:${action}`;
  state.pendingActions[pendingKey] = true;
  try {
    render();
  } catch (error) {
    delete state.pendingActions[pendingKey];
    console.error("Device action preflight render failed", { serial, action, error });
    reportClientError({
      source: "invokeDeviceAction:preflight-render",
      message: error?.message || "Action preflight render failed",
      detail: error?.stack || "",
      serial
    });
    window.alert(error?.message || "Action preflight failed");
    return;
  }

  try {
    if (desktopBridge?.isDesktopApp && (action === "open-control" || action === "start-session")) {
      await invokeDesktopViewerAction(serial, action, body);
      await refresh();
      return;
    }

    const response = await apiRequest(`/api/devices/${encodeURIComponent(serial)}/${action}`, {
      method: "POST",
      body
    });

    if (!response.ok) {
      throw new Error(response.payload?.error || "Action failed");
    }

    await refresh();
  } catch (error) {
    reportClientError({
      source: `invokeDeviceAction:${action}`,
      message: error?.message || "Action failed",
      detail: error?.stack || "",
      serial
    });
    window.alert(error.message || "Action failed");
  } finally {
    delete state.pendingActions[pendingKey];
    render();
  }
}

function getDeviceBySerial(serial) {
  return (state.data?.devices || []).find(device => device.serial === serial) || null;
}

function openDeviceEditor(serial) {
  const device = getDeviceBySerial(serial);
  if (!device || !deviceEditorModal) {
    return;
  }
  state.editor.serial = serial;
  state.editor.saving = false;
  const routers = (state.data?.routers || []).slice().sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id)));
  editorRouterId.innerHTML = [
    `<option value="">Unassigned</option>`,
    ...routers.map(router => `<option value="${escapeHtml(router.id)}">${escapeHtml(router.label || router.id)}</option>`)
  ].join("");
  deviceEditorTitle.textContent = `Edit ${formatDeviceName(device)}`;
  deviceEditorSubtitle.textContent = `${device.serial} ${device.transportId ? `| Transport ${device.transportId}` : ""}`.trim();
  editorNickname.value = device.nickname || "";
  editorPhoneNumber.value = device.phoneNumber || "";
  editorRole.value = device.role || "sim-direct";
  editorRouterId.value = device.routerId || "";
  editorRouterSlot.value = device.routerSlot || "";
  editorParentHotspotSerial.value = device.parentHotspotSerial || "";
  deviceEditorSaveButton.textContent = "Save Device";
  setEditorBusy(false);
  deviceEditorModal.hidden = false;
}

function closeDeviceEditor() {
  if (!deviceEditorModal) {
    return;
  }
  state.editor.serial = null;
  state.editor.saving = false;
  deviceEditorModal.hidden = true;
}

function setEditorBusy(busy) {
  state.editor.saving = busy;
  if (!deviceEditorForm) {
    return;
  }
  deviceEditorForm.querySelectorAll("input, select, button").forEach(control => {
    if (control.id === "deviceEditorCloseButton" || control.id === "deviceEditorCancelButton") {
      control.disabled = false;
      return;
    }
    control.disabled = busy;
  });
  if (deviceEditorSaveButton) {
    deviceEditorSaveButton.textContent = busy ? "Saving..." : "Save Device";
  }
}

async function saveDeviceMetadata() {
  const serial = state.editor.serial;
  if (!serial) {
    return;
  }

  setEditorBusy(true);
  try {
    const response = await apiRequest(`/api/devices/${encodeURIComponent(serial)}/metadata`, {
      method: "POST",
      body: {
        nickname: editorNickname.value.trim(),
        phoneNumber: editorPhoneNumber.value ? Number(editorPhoneNumber.value) : null,
        role: editorRole.value,
        routerId: editorRouterId.value,
        routerSlot: editorRouterSlot.value ? Number(editorRouterSlot.value) : null,
        parentHotspotSerial: editorParentHotspotSerial.value.trim()
      }
    });
    if (!response.ok) {
      throw new Error(response.payload?.error || "Device update failed");
    }
    await refresh();
    closeDeviceEditor();
  } catch (error) {
    reportClientError({
      source: "saveDeviceMetadata",
      message: error?.message || "Device metadata save failed",
      detail: error?.stack || "",
      serial
    });
    window.alert(error.message || "Device update failed");
    setEditorBusy(false);
  }
}

async function invokeRouterAction(routerId, action, body = {}) {
  try {
    const response = await apiRequest(`/api/routers/${encodeURIComponent(routerId)}/${action}`, {
      method: "POST",
      body
    });

    if (!response.ok && action !== "router-health") {
      throw new Error(response.payload?.error || "Router action failed");
    }

    await refresh();
  } catch (error) {
    window.alert(error.message || "Router action failed");
  }
}

async function invokeDesktopViewerAction(serial, action, body = {}) {
  if (action === "start-session") {
    const startResponse = await apiRequest(`/api/devices/${encodeURIComponent(serial)}/start-session`, {
      method: "POST",
      body: { ...body, skipViewerLaunch: true }
    });

    if (!startResponse.ok) {
      throw new Error(startResponse.payload?.error || "Session start failed");
    }
  }

  try {
    const nativeLaunch = await desktopBridge.launchViewer(serial);
    const launch = nativeLaunch || {};
    await desktopBridge.syncViewerState({
      serial,
      sourceAction: action,
      status: launch.fallbackViewer ? "fallback" : (launch.windowReady ? "confirmed" : "unverified"),
      requestedAt: new Date().toISOString(),
      confirmedAt: launch.startedAt || new Date().toISOString(),
      pid: launch.pid || null,
      processName: launch.processName || "",
      filePath: launch.filePath || "",
      aliveAfterLaunch: Boolean(launch.aliveAfterLaunch),
      windowReady: Boolean(launch.windowReady),
      fallbackViewer: launch.fallbackViewer || "",
      manualSelectionRequired: Boolean(launch.manualSelectionRequired),
      lastError: launch.fallbackViewer ? (launch.scrcpyError || "") : ""
    });
  } catch (error) {
    if (action === "start-session") {
      await apiRequest(`/api/devices/${encodeURIComponent(serial)}/stop-session`, {
        method: "POST",
        body: {}
      }).catch(() => undefined);
    }
    throw error;
  }
}

function formatRole(role) {
  if (role === "hotspot-client") {
    return "Hotspot Client";
  }
  if (role === "opal-client") {
    return "Opal Client";
  }
  return "SIM Direct";
}

function formatDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function formatShortTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function formatNow() {
  return new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function formatGmail(account) {
  if (account?.gmail) {
    return account.gmail;
  }
  return "Gmail not assigned";
}

function formatSession(sessionState) {
  return sessionState === "running" ? "Running" : "Stopped";
}

function formatDeviceName(device) {
  if (device.nickname) {
    return device.nickname;
  }
  if (device.phoneNumber) {
    return `Phone ${String(device.phoneNumber).padStart(2, "0")}`;
  }
  return "Unassigned Device";
}

function formatPrepTimer(device) {
  if (device.prepState === "preparing") {
    return `Live ${formatDuration(device.prepElapsedMs || 0)}`;
  }
  if (device.prepState === "queued") {
    return `Waiting ${formatDuration(device.queueWaitMs || 0)}`;
  }
  if (device.lastPrepDurationMs) {
    return `Last ${formatDuration(device.lastPrepDurationMs)}`;
  }
  return "Not started";
}

function formatPrepProgressLabel(device) {
  if (device.prepState === "preparing") {
    return `${computePrepProgress(device.prepElapsedMs || 0, device.prepState)}% live`;
  }
  if (device.prepState === "queued") {
    return "Queued";
  }
  if (device.prepState === "ready") {
    return "Ready";
  }
  if (device.prepState === "failed") {
    return "Failed";
  }
  return "Idle";
}

function computePrepProgress(durationMs, prepState) {
  if (prepState === "ready" || prepState === "failed") {
    return 100;
  }
  if (prepState === "queued") {
    return 16;
  }
  if (prepState !== "preparing") {
    return 0;
  }

  const expectedMs = 90000;
  const scaled = Math.round((Math.max(0, durationMs || 0) / expectedMs) * 100);
  return Math.max(8, Math.min(scaled, 96));
}

function syncProgressBar(element, progress) {
  if (!element) {
    return;
  }
  element.style.width = `${progress}%`;
}

function formatViewerLaunch(viewerLaunch) {
  const status = viewerLaunch?.status || "unknown";
  if (status === "fallback") {
    return `Vysor Fallback${viewerLaunch?.pid ? ` PID ${viewerLaunch.pid}` : ""}`;
  }
  if (status === "confirmed") {
    return `Confirmed${viewerLaunch?.pid ? ` PID ${viewerLaunch.pid}` : ""}`;
  }
  if (status === "launching") {
    return "Launching";
  }
  if (status === "unverified") {
    return `Unverified${viewerLaunch?.pid ? ` PID ${viewerLaunch.pid}` : ""}`;
  }
  if (status === "failed") {
    return "Failed";
  }
  return "Unknown";
}

function buildViewerLaunchDetails(viewerLaunch) {
  const status = viewerLaunch?.status || "unknown";
  if (status === "fallback") {
    return `scrcpy failed, so Vysor was opened${viewerLaunch?.manualSelectionRequired ? " for manual device selection" : ""}.${viewerLaunch?.pid ? ` PID ${viewerLaunch.pid}` : ""}${viewerLaunch?.lastError ? ` | scrcpy: ${viewerLaunch.lastError}` : ""}`;
  }
  if (status === "confirmed" || status === "unverified") {
    const pidText = viewerLaunch?.pid ? `PID ${viewerLaunch.pid}` : "PID unknown";
    return `Viewer launch ${status}. ${pidText}${viewerLaunch?.filePath ? ` | ${viewerLaunch.filePath}` : ""}`;
  }
  if (status === "launching") {
    return `Viewer launch in progress since ${formatShortTime(viewerLaunch?.requestedAt)}`;
  }
  if (status === "failed") {
    return `Viewer launch failed: ${viewerLaunch?.lastError || "Unknown error"}`;
  }
  return "Viewer launch has not been tested yet.";
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.round((durationMs || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
