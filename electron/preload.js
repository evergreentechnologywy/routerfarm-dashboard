const { contextBridge, ipcRenderer } = require("electron");

const bridge = {
  isDesktopApp: true,
  requestJson: request => ipcRenderer.invoke("routerfarm:request-json", request),
  launchViewer: serial => ipcRenderer.invoke("routerfarm:launch-viewer", { serial }),
  syncViewerState: payload => ipcRenderer.invoke("routerfarm:sync-viewer-state", payload)
};

contextBridge.exposeInMainWorld("routerFarmDesktop", bridge);
contextBridge.exposeInMainWorld("phoneFarmDesktop", bridge);
