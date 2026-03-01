import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { Worker } from "node:worker_threads";
import dotenv from "dotenv";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import electronUpdater from "electron-updater";
import { GoogleDriveService } from "./services/google-drive.mjs";
import { SaveSyncService } from "./services/save-sync.mjs";
import { StateStore } from "./services/state-store.mjs";
import { RestoreService } from "./services/restore-service.mjs";
import { isProcessRunning } from "./services/system.mjs";

const { autoUpdater } = electronUpdater;

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadEnvFiles() {
  const appDataEnvPath = path.join(
    process.env.APPDATA || process.cwd(),
    process.env.APP_NAME || "SincGames",
    ".env.local"
  );
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(path.dirname(process.execPath), ".env"),
    path.join(process.resourcesPath || "", ".env"),
    path.join(path.dirname(process.execPath), ".env.local"),
    appDataEnvPath
  ].filter(Boolean);

  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath, override: false });
    }
  }
}

loadEnvFiles();

const env = {
  APP_NAME: process.env.APP_NAME || "SincGames",
  DEVICE_LABEL: process.env.DEVICE_LABEL || "Este equipo",
  GOOGLE_DRIVE_ROOT_FOLDER_NAME: process.env.GOOGLE_DRIVE_ROOT_FOLDER_NAME || "SincGames Vault",
  GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
  GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
  GOOGLE_OAUTH_REDIRECT_URI: process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1:42813/oauth2/callback",
  GAME_MANIFEST_URL:
    process.env.GAME_MANIFEST_URL ||
    "https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml",
  SYNC_STABILITY_WINDOW_MS: Number(process.env.SYNC_STABILITY_WINDOW_MS || 10000),
  SYNC_POLL_INTERVAL_MS: Number(process.env.SYNC_POLL_INTERVAL_MS || 15000),
  AUTO_DOWNLOAD_IF_NO_LOCAL_SAVE: process.env.AUTO_DOWNLOAD_IF_NO_LOCAL_SAVE || "true",
  TEMP_BACKUP_RETENTION_DAYS: Number(process.env.TEMP_BACKUP_RETENTION_DAYS || 7),
  DISCOVERY_SCAN_DEPTH: Number(process.env.DISCOVERY_SCAN_DEPTH || 4)
};

function getUserEnvFilePath() {
  return path.join(process.env.APPDATA || process.cwd(), env.APP_NAME || "SincGames", ".env.local");
}

async function saveUserEnvFile() {
  const envFilePath = getUserEnvFilePath();
  const lines = [
    `APP_NAME=${env.APP_NAME}`,
    `DEVICE_LABEL=${env.DEVICE_LABEL || ""}`,
    `GOOGLE_DRIVE_ROOT_FOLDER_NAME=${env.GOOGLE_DRIVE_ROOT_FOLDER_NAME}`,
    `GOOGLE_OAUTH_CLIENT_ID=${env.GOOGLE_OAUTH_CLIENT_ID || ""}`,
    `GOOGLE_OAUTH_CLIENT_SECRET=${env.GOOGLE_OAUTH_CLIENT_SECRET || ""}`,
    `GOOGLE_OAUTH_REDIRECT_URI=${env.GOOGLE_OAUTH_REDIRECT_URI || ""}`,
    `GAME_MANIFEST_URL=${env.GAME_MANIFEST_URL}`,
    `SYNC_STABILITY_WINDOW_MS=${env.SYNC_STABILITY_WINDOW_MS}`,
    `SYNC_POLL_INTERVAL_MS=${env.SYNC_POLL_INTERVAL_MS}`,
    `AUTO_DOWNLOAD_IF_NO_LOCAL_SAVE=${env.AUTO_DOWNLOAD_IF_NO_LOCAL_SAVE}`,
    `TEMP_BACKUP_RETENTION_DAYS=${env.TEMP_BACKUP_RETENTION_DAYS}`,
    `DISCOVERY_SCAN_DEPTH=${env.DISCOVERY_SCAN_DEPTH}`
  ];

  await fs.promises.mkdir(path.dirname(envFilePath), { recursive: true });
  await fs.promises.writeFile(envFilePath, `${lines.join("\n")}\n`, "utf8");
  return envFilePath;
}

let mainWindow = null;
let discoveryWorker = null;
let sessionPollTimer = null;
const runtime = {
  monitoringStarted: false,
  discoveryRunning: false,
  updateState: "idle"
};

let state = {
  scanRoots: [],
  discoveryCandidates: [],
  games: [],
  manifestInfo: null,
  lastCloudSyncAt: null,
  offlineBackupDir: null,
  googleTokens: null
};

const stateStore = new StateStore({ app, env });
const driveService = new GoogleDriveService(env);
const restoreService = new RestoreService({
  stateStore,
  driveService,
  emit: emitToRenderer
});
const syncService = new SaveSyncService({
  env,
  emit: emitToRenderer,
  onSnapshot: handleSnapshotCaptured
});

driveService.setTokenPersistence(async (tokens) => {
  state.googleTokens = tokens;
  await stateStore.save(state);
  await emitBootstrap();
});

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: "#0d141c",
    title: env.APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const rendererUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";

  if (app.isPackaged) {
    await mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  } else {
    await mainWindow.loadURL(rendererUrl);
  }
}

function emitToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function emitInfo(message, gameId = null) {
  emitToRenderer("sync:event", {
    type: "info",
    gameId,
    message
  });
}

function emitWarning(message, gameId = null) {
  emitToRenderer("sync:event", {
    type: "warning",
    gameId,
    message
  });
}

function configureAutoUpdater() {
  if (!app.isPackaged) {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    runtime.updateState = "checking";
    emitInfo("Buscando actualizaciones...");
    void emitBootstrap();
  });

  autoUpdater.on("update-available", (info) => {
    runtime.updateState = "downloading";
    emitInfo(`Actualizacion disponible: ${info.version}. Descargando...`);
    void emitBootstrap();
  });

  autoUpdater.on("update-not-available", () => {
    runtime.updateState = "idle";
    emitInfo("No hay actualizaciones disponibles.");
    void emitBootstrap();
  });

  autoUpdater.on("update-downloaded", (info) => {
    runtime.updateState = "ready";
    emitInfo(`Actualizacion ${info.version} descargada. Se instalara al cerrar la app.`);
    void emitBootstrap();
  });

  autoUpdater.on("error", (error) => {
    runtime.updateState = "error";
    emitWarning(`Error al buscar actualizaciones: ${error.message}`);
    void emitBootstrap();
  });
}

function getBootstrapPayload(gitReady) {
  return {
    env: {
      appName: env.APP_NAME,
      deviceLabel: env.DEVICE_LABEL,
      driveRootFolderName: env.GOOGLE_DRIVE_ROOT_FOLDER_NAME,
      autoDownloadIfNoLocalSave: env.AUTO_DOWNLOAD_IF_NO_LOCAL_SAVE === "true",
      tempBackupRetentionDays: env.TEMP_BACKUP_RETENTION_DAYS,
      offlineBackupDir: state.offlineBackupDir,
      oauthConfigPath: getUserEnvFilePath(),
      googleOauthClientId: env.GOOGLE_OAUTH_CLIENT_ID || "",
      googleOauthClientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET || "",
      googleOauthRedirectUri: env.GOOGLE_OAUTH_REDIRECT_URI || ""
    },
    capabilities: {
      gitReady,
      googleConfigured: driveService.isConfigured(),
      googleAuthenticated: driveService.isAuthenticated(),
      offlineFallbackConfigured: Boolean(state.offlineBackupDir)
    },
    runtime: {
      ...runtime
    },
    scanRoots: state.scanRoots,
    discoveryCandidates: state.discoveryCandidates,
    manifestInfo: state.manifestInfo,
    games: state.games,
    startup: {
      requiresStorageChoice: !driveService.isAuthenticated() && !state.offlineBackupDir
    },
    design: {
      accent: "#c76c4b",
      accentSoft: "#d59a7e",
      surface: "#0d141c",
      ink: "#d9e3ef"
    }
  };
}

async function emitBootstrap() {
  emitToRenderer("state:updated", getBootstrapPayload(await detectGitStatus()));
}

async function persistState({ syncCloud = false } = {}) {
  await stateStore.save(state);
  syncService.setGames(state.games);

  if (state.offlineBackupDir) {
    await syncOfflineCatalog();
  }

  if (syncCloud && driveService.isAuthenticated()) {
    await driveService.syncCatalog(serializeCatalog());
    state.lastCloudSyncAt = new Date().toISOString();
    await stateStore.save(state);
  }

  await emitBootstrap();
}

function serializeCatalog() {
  return {
    appName: env.APP_NAME,
    updatedAt: new Date().toISOString(),
    deviceLabel: env.DEVICE_LABEL,
    scanRoots: state.scanRoots,
    games: state.games.map((game) => ({
      ...game,
      currentlyRunning: false,
      sessionStartedAt: null,
      latestLocalSave: null
    }))
  };
}

function mergeCloudCatalog(remoteCatalog) {
  const localSnapshotsByGame = new Map(state.games.map((game) => [game.id, game.latestLocalSave || null]));

  state = {
    ...state,
    scanRoots: Array.isArray(remoteCatalog?.scanRoots) ? remoteCatalog.scanRoots : state.scanRoots,
    games: Array.isArray(remoteCatalog?.games)
      ? remoteCatalog.games.map((game) => normalizeGameRecord({
          ...game,
          latestLocalSave: localSnapshotsByGame.get(game.id) || null
        }))
      : state.games
  };
}

async function refreshRemoteMetadata() {
  if (!driveService.isAuthenticated()) {
    return;
  }

  const updatedGames = [];

  for (const game of state.games) {
    try {
      const latestRemoteSave = await driveService.loadLatestBackupMetadata(game.id);
      updatedGames.push({
        ...game,
        latestRemoteSave: latestRemoteSave || game.latestRemoteSave || null
      });
    } catch {
      updatedGames.push(game);
    }
  }

  state.games = updatedGames;
}

async function ensureOfflineBackupBase() {
  if (!state.offlineBackupDir) {
    return null;
  }

  await fs.promises.mkdir(state.offlineBackupDir, { recursive: true });
  return state.offlineBackupDir;
}

async function syncOfflineCatalog() {
  const baseDir = await ensureOfflineBackupBase();
  if (!baseDir) {
    return;
  }

  const catalogPath = path.join(baseDir, "catalog.json");
  await fs.promises.writeFile(catalogPath, JSON.stringify(serializeCatalog(), null, 2), "utf8");
}

async function loadOfflineCatalog(directoryPath) {
  const catalogPath = path.join(directoryPath, "catalog.json");
  try {
    const raw = await fs.promises.readFile(catalogPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function persistOfflineSnapshot(game, localSnapshot) {
  const baseDir = await ensureOfflineBackupBase();
  if (!baseDir) {
    return null;
  }

  const gameDir = path.join(baseDir, "games", game.id);
  const snapshotsDir = path.join(gameDir, "snapshots");
  const metadataDir = path.join(gameDir, "metadata");
  await fs.promises.mkdir(snapshotsDir, { recursive: true });
  await fs.promises.mkdir(metadataDir, { recursive: true });

  const targetArchivePath = path.join(snapshotsDir, localSnapshot.archiveName);
  await fs.promises.copyFile(localSnapshot.archivePath, targetArchivePath);

  const metadata = {
    id: localSnapshot.id,
    gameId: game.id,
    createdAt: localSnapshot.createdAt,
    archiveName: localSnapshot.archiveName,
    archivePath: targetArchivePath,
    hash: localSnapshot.hash,
    sizeBytes: localSnapshot.sizeBytes,
    deviceLabel: env.DEVICE_LABEL
  };

  await fs.promises.writeFile(
    path.join(metadataDir, `${localSnapshot.id}.json`),
    JSON.stringify(metadata, null, 2),
    "utf8"
  );
  await fs.promises.writeFile(path.join(gameDir, "latest.json"), JSON.stringify(metadata, null, 2), "utf8");
  await syncOfflineCatalog();

  return metadata;
}

async function handleSnapshotCaptured(game, localSnapshot) {
  state.games = state.games.map((entry) =>
    entry.id === game.id ? { ...entry, latestLocalSave: localSnapshot } : entry
  );

  if (driveService.isAuthenticated()) {
    const upload = await driveService.uploadBackup({
      gameId: game.id,
      archivePath: localSnapshot.archivePath,
      archiveName: localSnapshot.archiveName,
      metadata: {
        id: localSnapshot.id,
        gameId: game.id,
        createdAt: localSnapshot.createdAt,
        archiveName: localSnapshot.archiveName,
        hash: localSnapshot.hash,
        sizeBytes: localSnapshot.sizeBytes,
        deviceLabel: env.DEVICE_LABEL
      }
    });

    state.games = state.games.map((entry) =>
      entry.id === game.id
        ? {
            ...entry,
            latestLocalSave: localSnapshot,
            latestRemoteSave: upload.metadata
          }
        : entry
    );

    emitInfo(`Backup subido a Google Drive para ${game.title}.`, game.id);
  } else if (state.offlineBackupDir) {
    await persistOfflineSnapshot(game, localSnapshot);
    emitInfo(`Backup local guardado en ${state.offlineBackupDir} para ${game.title}.`, game.id);
  } else {
    emitWarning(`Se detecto un save nuevo para ${game.title}, pero no hay sesion de Drive ni carpeta local de respaldo.`, game.id);
  }

  await persistState({ syncCloud: driveService.isAuthenticated() });
}

function buildGameRecord(payload) {
  const launchType = payload.launchType || (payload.executablePath ? "exe" : "exe");
  const launchTarget = payload.launchTarget || payload.executablePath || "";

  return normalizeGameRecord({
    id: payload.id || slugify(payload.title),
    title: payload.title,
    savePath: payload.savePath,
    processName: payload.processName,
    executablePath: payload.executablePath || "",
    installRoot: payload.installRoot || "",
    installed: true,
    platform: "windows",
    detectionSource: payload.detectionSource || "manual",
    filePatterns: payload.filePatterns?.length ? payload.filePatterns : ["**/*"],
    launchType,
    launchTarget,
    totalPlaySeconds: 0,
    currentlyRunning: false,
    sessionStartedAt: null,
    lastPlayedAt: null,
    latestLocalSave: null,
    latestRemoteSave: null
  });
}

function normalizeGameRecord(game) {
  return {
    ...game,
    executablePath: game.executablePath || "",
    installRoot: game.installRoot || "",
    launchType: game.launchType || (game.executablePath ? "exe" : "exe"),
    launchTarget: game.launchTarget || game.executablePath || "",
    totalPlaySeconds: Number(game.totalPlaySeconds || 0),
    currentlyRunning: false,
    sessionStartedAt: null,
    lastPlayedAt: game.lastPlayedAt || null,
    filePatterns: Array.isArray(game.filePatterns) && game.filePatterns.length ? game.filePatterns : ["**/*"]
  };
}

function upsertGame(game) {
  const existingIndex = state.games.findIndex(
    (entry) =>
      entry.id === game.id ||
      (entry.executablePath && game.executablePath && entry.executablePath === game.executablePath)
  );

  if (existingIndex >= 0) {
    const current = state.games[existingIndex];
    state.games[existingIndex] = normalizeGameRecord({
      ...current,
      ...game,
      totalPlaySeconds: current.totalPlaySeconds || 0,
      latestLocalSave: current.latestLocalSave || null,
      latestRemoteSave: current.latestRemoteSave || null,
      lastPlayedAt: current.lastPlayedAt || null
    });
    return state.games[existingIndex];
  }

  const normalized = normalizeGameRecord(game);
  state.games = [normalized, ...state.games];
  return normalized;
}

async function ensureMonitoringStarted() {
  if (runtime.monitoringStarted) {
    return;
  }

  syncService.setGames(state.games);
  await syncService.start();
  runtime.monitoringStarted = true;
  await emitBootstrap();
}

function startSessionPolling() {
  if (sessionPollTimer) {
    clearInterval(sessionPollTimer);
  }

  sessionPollTimer = setInterval(() => {
    void pollRunningStates();
  }, Math.max(5000, env.SYNC_POLL_INTERVAL_MS));
}

async function pollRunningStates() {
  if (state.games.length === 0) {
    return;
  }

  let changed = false;
  const now = Date.now();
  const updatedGames = [];

  for (const game of state.games) {
    const running = await isProcessRunning(game.processName);
    let updated = game;

    if (running && !game.currentlyRunning) {
      updated = {
        ...game,
        currentlyRunning: true,
        sessionStartedAt: new Date(now).toISOString()
      };
      changed = true;
    } else if (!running && game.currentlyRunning) {
      const startedAt = game.sessionStartedAt ? new Date(game.sessionStartedAt).getTime() : now;
      const elapsedSeconds = Math.max(0, Math.round((now - startedAt) / 1000));
      updated = {
        ...game,
        currentlyRunning: false,
        sessionStartedAt: null,
        totalPlaySeconds: Number(game.totalPlaySeconds || 0) + elapsedSeconds,
        lastPlayedAt: new Date(now).toISOString()
      };
      changed = true;
    }

    updatedGames.push(updated);
  }

  if (!changed) {
    return;
  }

  state.games = updatedGames;
  await persistState({ syncCloud: false });
}

function runDiscoveryScan(scanRoots) {
  if (discoveryWorker) {
    throw new Error("Ya hay un escaneo en curso.");
  }

  return new Promise((resolve, reject) => {
    const workerPath = new URL("./workers/discovery-worker.mjs", import.meta.url);
    const worker = new Worker(workerPath, {
      workerData: {
        env,
        scanRoots
      }
    });

    discoveryWorker = worker;
    runtime.discoveryRunning = true;

    worker.on("message", (message) => {
      if (message.type === "progress") {
        emitToRenderer("discovery:status", {
          ...message,
          running: true
        });
        return;
      }

      if (message.type === "completed") {
        discoveryWorker = null;
        runtime.discoveryRunning = false;
        resolve({
          candidates: message.candidates,
          manifestInfo: message.manifestInfo
        });
        return;
      }

      if (message.type === "failed") {
        discoveryWorker = null;
        runtime.discoveryRunning = false;
        reject(new Error(message.message));
      }
    });

    worker.on("error", (error) => {
      discoveryWorker = null;
      runtime.discoveryRunning = false;
      reject(error);
    });

    worker.on("exit", (code) => {
      if (code !== 0 && discoveryWorker) {
        discoveryWorker = null;
        runtime.discoveryRunning = false;
        reject(new Error(`El worker de escaneo termino con codigo ${code}.`));
      }
    });
  });
}

function resolveLaunchConfiguration(game) {
  const launchType = game.launchType || "exe";
  const target = game.launchTarget || game.executablePath || "";

  if (launchType === "exe") {
    return {
      kind: "path",
      target
    };
  }

  if (launchType === "steam") {
    return {
      kind: "external",
      target: target.startsWith("steam://") ? target : `steam://rungameid/${target}`
    };
  }

  if (launchType === "uri") {
    return {
      kind: "external",
      target
    };
  }

  return {
    kind: "command",
    target
  };
}

ipcMain.handle("app:bootstrap", async () => {
  return getBootstrapPayload(await detectGitStatus());
});

ipcMain.handle("dialog:pick-directory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"]
  });

  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("settings:add-scan-root", async (_event, directoryPath) => {
  if (!directoryPath) {
    return state.scanRoots;
  }

  state.scanRoots = [...new Set([...state.scanRoots, directoryPath])];
  await persistState({ syncCloud: true });
  return state.scanRoots;
});

ipcMain.handle("settings:remove-scan-root", async (_event, directoryPath) => {
  state.scanRoots = state.scanRoots.filter((item) => item !== directoryPath);
  await persistState({ syncCloud: true });
  return state.scanRoots;
});

ipcMain.handle("settings:set-offline-backup-dir", async (_event, directoryPath) => {
  if (!directoryPath) {
    throw new Error("Selecciona una carpeta valida para el respaldo local.");
  }

  const offlineCatalog = await loadOfflineCatalog(directoryPath);
  state.offlineBackupDir = directoryPath;

  if (offlineCatalog?.games?.length || offlineCatalog?.scanRoots?.length) {
    mergeCloudCatalog(offlineCatalog);
    emitInfo("Catalogo restaurado desde la carpeta local de respaldo.");
  }

  await persistState({ syncCloud: driveService.isAuthenticated() });
  emitInfo(`Carpeta de respaldo local configurada: ${directoryPath}.`);
  return state.offlineBackupDir;
});

ipcMain.handle("settings:save-google-oauth", async (_event, payload) => {
  env.GOOGLE_OAUTH_CLIENT_ID = payload.clientId?.trim() || "";
  env.GOOGLE_OAUTH_CLIENT_SECRET = payload.clientSecret?.trim() || "";
  env.GOOGLE_OAUTH_REDIRECT_URI =
    payload.redirectUri?.trim() || "http://127.0.0.1:42813/oauth2/callback";

  process.env.GOOGLE_OAUTH_CLIENT_ID = env.GOOGLE_OAUTH_CLIENT_ID;
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = env.GOOGLE_OAUTH_CLIENT_SECRET;
  process.env.GOOGLE_OAUTH_REDIRECT_URI = env.GOOGLE_OAUTH_REDIRECT_URI;

  driveService.setTokens(null);
  driveService.updateConfig(env);
  state.googleTokens = null;

  const envFilePath = await saveUserEnvFile();
  await stateStore.save(state);
  await emitBootstrap();

  emitInfo(`Credenciales OAuth guardadas en ${envFilePath}.`);
  return {
    ok: true,
    envFilePath
  };
});

ipcMain.handle("discovery:scan", async () => {
  if (state.scanRoots.length === 0) {
    throw new Error("Agrega al menos una carpeta de escaneo antes de buscar juegos.");
  }

  emitToRenderer("discovery:status", {
    phase: "started",
    scanRoot: null,
    rootIndex: 0,
    rootCount: state.scanRoots.length,
    processedExecutables: 0,
    running: true
  });
  await emitBootstrap();

  try {
    const result = await runDiscoveryScan(state.scanRoots);
    state.discoveryCandidates = result.candidates;
    state.manifestInfo = result.manifestInfo;
    await persistState({ syncCloud: true });
    emitToRenderer("discovery:status", {
      phase: "completed",
      scanRoot: null,
      rootIndex: state.scanRoots.length,
      rootCount: state.scanRoots.length,
      processedExecutables: result.candidates.length,
      running: false
    });
    return {
      candidates: state.discoveryCandidates,
      manifestInfo: state.manifestInfo
    };
  } catch (error) {
    runtime.discoveryRunning = false;
    await emitBootstrap();
    emitToRenderer("discovery:status", {
      phase: "failed",
      scanRoot: null,
      rootIndex: 0,
      rootCount: state.scanRoots.length,
      processedExecutables: 0,
      running: false,
      message: error.message || "No se pudo completar el escaneo."
    });
    emitWarning(error.message || "No se pudo completar el escaneo.");
    throw error;
  }
});

ipcMain.handle("game:add-from-candidate", async (_event, candidateId) => {
  const candidate = state.discoveryCandidates.find((item) => item.id === candidateId);
  if (!candidate) {
    throw new Error("No se encontro el candidato seleccionado.");
  }

  const game = buildGameRecord({
    id: slugify(candidate.title),
    title: candidate.title,
    savePath: candidate.suggestedSavePath,
    processName: candidate.processName,
    executablePath: candidate.executablePath,
    installRoot: candidate.installRoot,
    filePatterns: candidate.filePatterns,
    detectionSource: candidate.detectionSource,
    launchType: "exe",
    launchTarget: candidate.executablePath
  });

  upsertGame(game);
  await persistState({ syncCloud: true });
  return game;
});

ipcMain.handle("game:create-manual", async (_event, payload) => {
  const game = buildGameRecord({
    id: payload.id || slugify(payload.title || crypto.randomUUID()),
    title: payload.title,
    savePath: payload.savePath,
    processName: payload.processName,
    executablePath: payload.executablePath || "",
    installRoot: payload.installRoot || "",
    filePatterns: payload.filePatterns || ["**/*"],
    detectionSource: "manual",
    launchType: payload.launchType || (payload.executablePath ? "exe" : "uri"),
    launchTarget: payload.launchTarget || payload.executablePath || ""
  });

  upsertGame(game);
  await persistState({ syncCloud: true });
  return game;
});

ipcMain.handle("game:update", async (_event, payload) => {
  const gameIndex = state.games.findIndex((item) => item.id === payload.gameId);
  if (gameIndex < 0) {
    throw new Error("Juego no encontrado.");
  }

  const current = state.games[gameIndex];
  const updated = normalizeGameRecord({
    ...current,
    title: payload.title ?? current.title,
    savePath: payload.savePath ?? current.savePath,
    processName: payload.processName ?? current.processName,
    executablePath: payload.executablePath ?? current.executablePath,
    installRoot: payload.installRoot ?? current.installRoot,
    filePatterns: payload.filePatterns?.length ? payload.filePatterns : current.filePatterns,
    launchType: payload.launchType ?? current.launchType,
    launchTarget: payload.launchTarget ?? current.launchTarget
  });

  state.games[gameIndex] = updated;
  await persistState({ syncCloud: true });
  return updated;
});

ipcMain.handle("game:restore-latest", async (_event, gameId) => {
  const game = state.games.find((item) => item.id === gameId);
  if (!game) {
    throw new Error("Juego no encontrado.");
  }

  const result = await restoreService.restoreLatestRemote(game);
  await persistState({ syncCloud: false });
  return result;
});

ipcMain.handle("game:launch", async (_event, gameId) => {
  const game = state.games.find((item) => item.id === gameId);
  if (!game) {
    throw new Error("Juego no encontrado.");
  }

  const launch = resolveLaunchConfiguration(game);
  if (!launch.target) {
    throw new Error("Este juego no tiene configuracion de lanzamiento.");
  }

  await ensureMonitoringStarted();

  if (launch.kind === "path") {
    if (!fs.existsSync(launch.target)) {
      throw new Error("La ruta del ejecutable no existe.");
    }

    const launchError = await shell.openPath(launch.target);
    if (launchError) {
      throw new Error(launchError);
    }
  } else if (launch.kind === "external") {
    await shell.openExternal(launch.target);
  } else {
    await execAsync(launch.target, {
      cwd: game.installRoot || undefined,
      windowsHide: true
    });
  }

  emitInfo(`Juego iniciado: ${game.title}.`, game.id);
  setTimeout(() => {
    void pollRunningStates();
  }, 4000);

  return { ok: true };
});

ipcMain.handle("sync:start", async () => {
  await ensureMonitoringStarted();
  return { ok: true };
});

ipcMain.handle("sync:backup-now", async (_event, gameId) => {
  const game = state.games.find((item) => item.id === gameId);
  if (!game) {
    throw new Error("Juego no encontrado.");
  }

  const snapshot = await syncService.captureNow(gameId);
  emitInfo(`Respaldo manual completado para ${game.title}.`, game.id);

  return {
    ok: true,
    snapshot
  };
});

ipcMain.handle("drive:connect", async () => {
  const authResult = await driveService.startDesktopAuthFlow(async () => {
    const remoteCatalog = await driveService.loadCatalog();

    if (remoteCatalog?.games?.length) {
      mergeCloudCatalog(remoteCatalog);
      emitInfo("Catalogo remoto cargado desde Google Drive.");
    } else {
      await driveService.syncCatalog(serializeCatalog());
      emitInfo("Se creo el catalogo inicial en Google Drive.");
    }

    await refreshRemoteMetadata();
    await persistState({ syncCloud: false });
  });

  if (authResult?.authUrl) {
    await shell.openExternal(authResult.authUrl);
  }

  return {
    ok: true,
    authUrl: authResult?.authUrl || null
  };
});

async function detectGitStatus() {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: path.join(__dirname, ".."),
      windowsHide: true
    });

    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

app.whenReady()
  .then(async () => {
    const loadedState = await stateStore.load();
    state = {
      ...loadedState,
      games: Array.isArray(loadedState.games) ? loadedState.games.map(normalizeGameRecord) : []
    };

    if (loadedState.googleTokens) {
      driveService.setTokens(loadedState.googleTokens);
    }

    await stateStore.cleanupTempBackups();
    syncService.setGames(state.games);
    startSessionPolling();
    configureAutoUpdater();
    await createWindow();
    if (app.isPackaged) {
      void autoUpdater.checkForUpdatesAndNotify();
    }
  })
  .catch((error) => {
    console.error("No se pudo iniciar la aplicacion:", error);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  if (sessionPollTimer) {
    clearInterval(sessionPollTimer);
    sessionPollTimer = null;
  }

  if (discoveryWorker) {
    await discoveryWorker.terminate();
    discoveryWorker = null;
  }

  await syncService.stop();
});
