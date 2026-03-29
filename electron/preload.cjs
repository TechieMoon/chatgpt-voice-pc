const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopBridge", {
  isDesktop: true,
  getApiKeyState: () => ipcRenderer.invoke("desktop:get-api-key-state"),
  saveApiKey: (apiKey, persist) => ipcRenderer.invoke("desktop:save-api-key", { apiKey, persist }),
  clearApiKey: () => ipcRenderer.invoke("desktop:clear-api-key"),
  createRealtimeSession: (offerSdp) => ipcRenderer.invoke("desktop:create-realtime-session", offerSdp),
  listCaptureSources: () => ipcRenderer.invoke("desktop:list-capture-sources"),
  getAppMeta: () => ipcRenderer.invoke("desktop:get-app-meta"),
});
