const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sincgames", {
  getBootstrap: () => ipcRenderer.invoke("app:bootstrap"),
  startMonitoring: () => ipcRenderer.invoke("sync:start"),
  connectGoogleDrive: () => ipcRenderer.invoke("drive:connect"),
  pickDirectory: () => ipcRenderer.invoke("dialog:pick-directory"),
  addScanRoot: (directoryPath) => ipcRenderer.invoke("settings:add-scan-root", directoryPath),
  removeScanRoot: (directoryPath) => ipcRenderer.invoke("settings:remove-scan-root", directoryPath),
  setOfflineBackupDir: (directoryPath) => ipcRenderer.invoke("settings:set-offline-backup-dir", directoryPath),
  scanForGames: () => ipcRenderer.invoke("discovery:scan"),
  addGameFromCandidate: (candidateId) => ipcRenderer.invoke("game:add-from-candidate", candidateId),
  createManualGame: (payload) => ipcRenderer.invoke("game:create-manual", payload),
  updateGame: (payload) => ipcRenderer.invoke("game:update", payload),
  launchGame: (gameId) => ipcRenderer.invoke("game:launch", gameId),
  backupNow: (gameId) => ipcRenderer.invoke("sync:backup-now", gameId),
  restoreLatestRemote: (gameId) => ipcRenderer.invoke("game:restore-latest", gameId),
  onSyncEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("sync:event", listener);
    return () => ipcRenderer.removeListener("sync:event", listener);
  },
  onStateUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("state:updated", listener);
    return () => ipcRenderer.removeListener("state:updated", listener);
  },
  onDiscoveryStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("discovery:status", listener);
    return () => ipcRenderer.removeListener("discovery:status", listener);
  }
});
