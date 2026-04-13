const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("phoneFarmDesktop", {
  isDesktopApp: true,
  requestJson: request => ipcRenderer.invoke("phonefarm:request-json", request),
  launchViewer: serial => ipcRenderer.invoke("phonefarm:launch-viewer", { serial }),
  syncViewerState: payload => ipcRenderer.invoke("phonefarm:sync-viewer-state", payload)
});
