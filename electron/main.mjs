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
import { getProcessState, isProcessRunning, stopProcess } from "./services/system.mjs";
import { TorrentService } from "./services/torrent-service.mjs";
import { AppLogger } from "./services/app-logger.mjs";
import { ArchiveExtractor } from "./services/archive-extractor.mjs";

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
let isQuitting = false;
let shouldInstallUpdateOnQuit = false;
const runtime = {
  monitoringStarted: false,
  discoveryRunning: false,
  updateState: "idle"
};

let state = {
  scanRoots: [],
  discoveryCandidates: [],
  games: [],
  torrentReleaseSources: [],
  uiPreferences: {
    topView: "library",
    libraryTab: "summary",
    selectedGameId: null,
    libraryFilter: "",
    librarySort: "added-desc",
    discoveryCandidateFilter: "",
    selectedTorrentSourceUrl: null,
    selectedTorrentIndex: 0,
    torrentDefaultOutputDir: "",
    torrentDownloadOverrideDir: "",
    torrentExtractArchives: true,
    torrentDeleteArchivesAfterExtract: false,
    torrentAutoRefreshMinutes: 5,
    startupDismissed: false
  },
  manifestInfo: null,
  lastCloudSyncAt: null,
  offlineBackupDir: null,
  googleTokens: null
};

const stateStore = new StateStore({ app, env });
const logger = new AppLogger({ app, env });
const archiveExtractor = new ArchiveExtractor();
const driveService = new GoogleDriveService(env);
const restoreService = new RestoreService({
  stateStore,
  driveService,
  emit: emitToRenderer
});
const syncService = new SaveSyncService({
  env,
  emit: emitToRenderer,
  onSnapshot: handleSnapshotCaptured,
  log: logger
});
const autoImportedTorrentIds = new Set();

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
    autoHideMenuBar: true,
    backgroundColor: "#0d141c",
    title: env.APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.setMenuBarVisibility(false);

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

function logInfo(message, meta = null) {
  void logger.info(message, meta).catch(() => {});
}

function logWarning(message, meta = null) {
  void logger.warn(message, meta).catch(() => {});
}

function emitInfo(message, gameId = null) {
  logInfo(message, { gameId });
  emitToRenderer("sync:event", {
    type: "info",
    gameId,
    message
  });
}

function emitWarning(message, gameId = null) {
  logWarning(message, { gameId });
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
  autoUpdater.autoInstallOnAppQuit = false;

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
    shouldInstallUpdateOnQuit = true;
    runtime.updateState = "ready";
    emitInfo(`Actualizacion ${info.version} descargada. Se instalara al cerrar la app.`);
    void emitBootstrap();
  });

  autoUpdater.on("error", (error) => {
    shouldInstallUpdateOnQuit = false;
    runtime.updateState = "error";
    emitWarning(`Error al buscar actualizaciones: ${error.message}`);
    void emitBootstrap();
  });
}

function normalizeUiPreferences(preferences) {
  const topView = ["library", "discovery", "downloads", "cloud", "activity"].includes(preferences?.topView)
    ? preferences.topView
    : "library";
  const libraryTab = ["summary", "saves", "paths", "manage"].includes(preferences?.libraryTab)
    ? preferences.libraryTab
    : "summary";
  const librarySort = ["added-desc", "play-desc", "alpha-asc"].includes(preferences?.librarySort)
    ? preferences.librarySort
    : "added-desc";

  const legacyTorrentOutputDir =
    typeof preferences?.torrentOutputDir === "string" ? preferences.torrentOutputDir : "";

  return {
    topView,
    libraryTab,
    selectedGameId: typeof preferences?.selectedGameId === "string" ? preferences.selectedGameId : null,
    libraryFilter: typeof preferences?.libraryFilter === "string" ? preferences.libraryFilter : "",
    librarySort,
    discoveryCandidateFilter:
      typeof preferences?.discoveryCandidateFilter === "string" ? preferences.discoveryCandidateFilter : "",
    selectedTorrentSourceUrl: typeof preferences?.selectedTorrentSourceUrl === "string" ? preferences.selectedTorrentSourceUrl : null,
    selectedTorrentIndex: Number.isInteger(preferences?.selectedTorrentIndex) && preferences.selectedTorrentIndex >= 0
      ? preferences.selectedTorrentIndex
      : 0,
    torrentDefaultOutputDir:
      typeof preferences?.torrentDefaultOutputDir === "string"
        ? preferences.torrentDefaultOutputDir
        : legacyTorrentOutputDir,
    torrentDownloadOverrideDir:
      typeof preferences?.torrentDownloadOverrideDir === "string" ? preferences.torrentDownloadOverrideDir : "",
    torrentExtractArchives:
      typeof preferences?.torrentExtractArchives === "boolean" ? preferences.torrentExtractArchives : true,
    torrentDeleteArchivesAfterExtract:
      typeof preferences?.torrentDeleteArchivesAfterExtract === "boolean"
        ? preferences.torrentDeleteArchivesAfterExtract
        : false,
    torrentAutoRefreshMinutes:
      Number.isFinite(Number(preferences?.torrentAutoRefreshMinutes))
        ? Math.min(60, Math.max(1, Math.round(Number(preferences.torrentAutoRefreshMinutes))))
        : 5,
    startupDismissed: Boolean(preferences?.startupDismissed)
  };
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
    torrentReleaseSources: state.torrentReleaseSources,
    manifestInfo: state.manifestInfo,
    games: state.games,
    uiPreferences: state.uiPreferences,
    startup: {
      requiresStorageChoice: !driveService.isAuthenticated() && !state.offlineBackupDir
    },
    design: {
      accent: "#c76c4b",
      accentSoft: "#d59a7e",
      surface: "#0d141c",
      ink: "#d9e3ef"
    },
    torrentDownloads: torrentService.listDownloads()
  };
}

async function emitBootstrap() {
  emitToRenderer("state:updated", getBootstrapPayload(await detectGitStatus()));
}

async function persistLocalState() {
  await stateStore.save(state);
  await emitBootstrap();
}

async function persistState({ syncCloud = false } = {}) {
  await stateStore.save(state);
  syncService.setGames(state.games);
  if (runtime.monitoringStarted) {
    await syncService.start({ preservePendingTimers: true });
  }

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
      processStartedAt: null,
      trackedUntilAt: null,
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

async function pruneOfflineSnapshots(gameId, keepCount = 3) {
  const baseDir = await ensureOfflineBackupBase();
  if (!baseDir) {
    return { kept: 0, deleted: 0 };
  }

  const safeKeepCount = Math.max(1, Number(keepCount || 3));
  const gameDir = path.join(baseDir, "games", gameId);
  const metadataDir = path.join(gameDir, "metadata");
  if (!fs.existsSync(metadataDir)) {
    return { kept: 0, deleted: 0 };
  }

  const entries = await fs.promises.readdir(metadataDir, { withFileTypes: true });
  const metadataEntries = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) {
      continue;
    }

    try {
      const fullPath = path.join(metadataDir, entry.name);
      const metadata = JSON.parse(await fs.promises.readFile(fullPath, "utf8"));
      metadataEntries.push({ fullPath, metadata });
    } catch {
      // Ignora metadata dañada para no cortar la poda.
    }
  }

  metadataEntries.sort((left, right) => {
    const leftTime = new Date(left.metadata?.createdAt || 0).getTime();
    const rightTime = new Date(right.metadata?.createdAt || 0).getTime();
    return rightTime - leftTime;
  });

  const staleEntries = metadataEntries.slice(safeKeepCount);
  for (const entry of staleEntries) {
    if (entry.metadata?.archivePath) {
      await fs.promises.rm(entry.metadata.archivePath, { force: true });
    }
    await fs.promises.rm(entry.fullPath, { force: true });
  }

  return {
    kept: Math.min(metadataEntries.length, safeKeepCount),
    deleted: staleEntries.length
  };
}

async function handleSnapshotCaptured(game, localSnapshot) {
  await logger.info("Procesando snapshot capturado.", {
    gameId: game.id,
    title: game.title,
    snapshotId: localSnapshot.id,
    createdAt: localSnapshot.createdAt
  });
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
    const pruneResult = await driveService.pruneBackups(game.id, game.maxBackups || 3);
    if (pruneResult.deleted > 0) {
      emitInfo(
        `Se limpiaron ${pruneResult.deleted} backups antiguos de ${game.title}. Conservando ${pruneResult.kept}.`,
        game.id
      );
    }
  } else if (state.offlineBackupDir) {
    await persistOfflineSnapshot(game, localSnapshot);
    emitInfo(`Backup local guardado en ${state.offlineBackupDir} para ${game.title}.`, game.id);
    const pruneResult = await pruneOfflineSnapshots(game.id, game.maxBackups || 3);
    if (pruneResult.deleted > 0) {
      emitInfo(
        `Se limpiaron ${pruneResult.deleted} backups locales antiguos de ${game.title}. Conservando ${pruneResult.kept}.`,
        game.id
      );
    }
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
    addedAt: new Date().toISOString(),
    maxBackups: payload.maxBackups ?? 3,
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
    bannerPath: payload.bannerPath || "",
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
    addedAt: game.addedAt || null,
    maxBackups: Number.isInteger(game.maxBackups) ? Math.min(20, Math.max(1, game.maxBackups)) : 3,
    executablePath: game.executablePath || "",
    installRoot: game.installRoot || "",
    launchType: game.launchType || (game.executablePath ? "exe" : "exe"),
    launchTarget: game.launchTarget || game.executablePath || "",
    bannerPath: game.bannerPath || "",
    totalPlaySeconds: Number(game.totalPlaySeconds || 0),
    currentlyRunning: Boolean(game.currentlyRunning),
    sessionStartedAt: game.sessionStartedAt || null,
    lastPlayedAt: game.lastPlayedAt || null,
    processStartedAt: game.processStartedAt || null,
    trackedUntilAt: game.trackedUntilAt || null,
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
      maxBackups: current.maxBackups ?? game.maxBackups ?? 3,
      totalPlaySeconds: current.totalPlaySeconds || 0,
      latestLocalSave: current.latestLocalSave || null,
      latestRemoteSave: current.latestRemoteSave || null,
      lastPlayedAt: current.lastPlayedAt || null,
      bannerPath: current.bannerPath || game.bannerPath || "",
      addedAt: current.addedAt || game.addedAt || null
    });
    return state.games[existingIndex];
  }

  const normalized = normalizeGameRecord(game);
  state.games = [normalized, ...state.games];
  return normalized;
}

const ignoredAutoImportExeNames = new Set([
  "unins000.exe",
  "uninstall.exe",
  "setup.exe",
  "launcher.exe",
  "crashreporter.exe"
]);

async function findPrimaryExecutable(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) {
    return null;
  }

  const stack = [{ directoryPath: rootDir, depth: 0 }];
  const maxDepth = 5;
  let fallback = null;

  while (stack.length) {
    const current = stack.shift();
    if (!current) {
      continue;
    }

    let entries = [];
    try {
      entries = await fs.promises.readdir(current.directoryPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current.directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < maxDepth) {
          stack.push({ directoryPath: fullPath, depth: current.depth + 1 });
        }
        continue;
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".exe")) {
        continue;
      }

      const lowerName = entry.name.toLowerCase();
      if (ignoredAutoImportExeNames.has(lowerName)) {
        continue;
      }

      const score = current.depth === 0 ? 100 : Math.max(0, 50 - current.depth * 10);
      if (!fallback || score > fallback.score) {
        fallback = { path: fullPath, score };
      }
    }
  }

  return fallback?.path || null;
}

function buildDefaultSavePathFromProcess(processName) {
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || process.cwd(), "AppData", "Local");
  const stem = path.basename(processName || "", path.extname(processName || ""));
  if (!stem) {
    return "";
  }

  return path.join(localAppData, stem, "Saved", "SaveGames");
}

async function autoAddCompletedTorrentToLibrary(download) {
  if (!download || download.status !== "completed") {
    return;
  }

  const importKey = download.infoHash || download.id;
  if (autoImportedTorrentIds.has(importKey)) {
    return;
  }

  autoImportedTorrentIds.add(importKey);

  try {
    const installRoot = download.contentRoot || download.outputDir;
    const executablePath = await findPrimaryExecutable(installRoot);
    if (!executablePath) {
      emitWarning(
        `La descarga ${download.title} termino pero no se encontro un .exe para agregarla automaticamente a biblioteca.`
      );
      return;
    }

    const processName = path.basename(executablePath);
    const game = buildGameRecord({
      id: slugify(download.title),
      title: download.title,
      processName,
      executablePath,
      installRoot,
      savePath: buildDefaultSavePathFromProcess(processName),
      detectionSource: "manual",
      launchType: "exe",
      launchTarget: executablePath
    });

    upsertGame(game);
    await persistState({ syncCloud: driveService.isAuthenticated() });
    emitInfo(`Juego agregado automaticamente a biblioteca: ${download.title}.`, game.id);
  } catch (error) {
    emitWarning(
      `No se pudo agregar automaticamente ${download.title} a la biblioteca: ${error instanceof Error ? error.message : String(error)}.`
    );
  }
}

const torrentService = new TorrentService({
  app,
  env,
  archiveExtractor,
  emit: (downloads) => {
    emitToRenderer("torrent:updated", downloads);
  },
  onCompleted: (download) => autoAddCompletedTorrentToLibrary(download)
});

async function ensureMonitoringStarted() {
  if (runtime.monitoringStarted) {
    return;
  }

  syncService.setGames(state.games);
  await syncService.start();
  runtime.monitoringStarted = true;
  await logger.info("Monitoreo automatico iniciado.", {
    games: state.games.length,
    logFilePath: logger.logFilePath
  });
  await emitBootstrap();
}

function getElapsedSeconds(startedAt, now) {
  if (!startedAt) {
    return 0;
  }

  const startedAtMs = new Date(startedAt).getTime();
  if (Number.isNaN(startedAtMs)) {
    return 0;
  }

  return Math.max(0, Math.round((now - startedAtMs) / 1000));
}

async function flushRunningSessions({ preserveRunningProcesses = false } = {}) {
  if (state.games.length === 0) {
    return false;
  }

  const now = Date.now();
  let changed = false;
  let shouldSyncCloud = false;
  const updatedGames = [];

  for (const game of state.games) {
    if (!game.currentlyRunning) {
      updatedGames.push(game);
      continue;
    }

    const processState = preserveRunningProcesses ? await getProcessState(game.processName) : { running: false, startedAt: null };
    const elapsedSeconds = getElapsedSeconds(game.sessionStartedAt, now);
    const trackedUntilAt = new Date(now).toISOString();
    const runningAfterFlush = preserveRunningProcesses && processState.running;

    updatedGames.push({
      ...game,
      currentlyRunning: false,
      sessionStartedAt: null,
      totalPlaySeconds: Number(game.totalPlaySeconds || 0) + elapsedSeconds,
      lastPlayedAt: runningAfterFlush ? game.lastPlayedAt || null : trackedUntilAt,
      processStartedAt: runningAfterFlush ? processState.startedAt || game.processStartedAt || null : null,
      trackedUntilAt: runningAfterFlush ? trackedUntilAt : null
    });

    changed = true;
    shouldSyncCloud = true;
  }

  if (!changed) {
    return false;
  }

  state.games = updatedGames;
  await persistState({ syncCloud: shouldSyncCloud && driveService.isAuthenticated() });
  return true;
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
  let shouldSyncCloud = false;
  const now = Date.now();
  const updatedGames = [];

  for (const game of state.games) {
    const processState = await getProcessState(game.processName);
    const running = processState.running;
    let updated = game;

    if (running && !game.currentlyRunning) {
      const nextProcessStartedAt = processState.startedAt || game.processStartedAt || new Date(now).toISOString();
      const sameProcess =
        Boolean(game.processStartedAt) &&
        Boolean(processState.startedAt) &&
        new Date(game.processStartedAt).getTime() === new Date(processState.startedAt).getTime();
      const resumedSessionStart = sameProcess && game.trackedUntilAt
        ? game.trackedUntilAt
        : nextProcessStartedAt;

      updated = {
        ...game,
        currentlyRunning: true,
        sessionStartedAt: resumedSessionStart,
        processStartedAt: nextProcessStartedAt,
        trackedUntilAt: null
      };
      emitInfo(`Juego detectado en ejecucion: ${game.title}.`, game.id);
      changed = true;
    } else if (!running && game.currentlyRunning) {
      const elapsedSeconds = getElapsedSeconds(game.sessionStartedAt, now);
      updated = {
        ...game,
        currentlyRunning: false,
        sessionStartedAt: null,
        totalPlaySeconds: Number(game.totalPlaySeconds || 0) + elapsedSeconds,
        lastPlayedAt: new Date(now).toISOString(),
        processStartedAt: null,
        trackedUntilAt: null
      };
      emitInfo(`Juego cerrado detectado automaticamente: ${game.title}.`, game.id);
      syncService.schedulePostExitCapture(game.id);
      changed = true;
      shouldSyncCloud = true;
    } else if (!running && (game.processStartedAt || game.trackedUntilAt)) {
      updated = {
        ...game,
        processStartedAt: null,
        trackedUntilAt: null
      };
      changed = true;
    } else if (running && game.currentlyRunning && processState.startedAt && game.processStartedAt) {
      const existingStartMs = new Date(game.processStartedAt).getTime();
      const currentStartMs = new Date(processState.startedAt).getTime();

      if (!Number.isNaN(existingStartMs) && !Number.isNaN(currentStartMs) && existingStartMs !== currentStartMs) {
        const elapsedSeconds = getElapsedSeconds(game.sessionStartedAt, now);
        updated = {
          ...game,
          totalPlaySeconds: Number(game.totalPlaySeconds || 0) + elapsedSeconds,
          currentlyRunning: true,
          sessionStartedAt: processState.startedAt,
          processStartedAt: processState.startedAt,
          trackedUntilAt: null
        };
        changed = true;
        shouldSyncCloud = true;
      }
    }

    updatedGames.push(updated);
  }

  if (!changed) {
    return;
  }

  state.games = updatedGames;
  await persistState({ syncCloud: shouldSyncCloud && driveService.isAuthenticated() });
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

function normalizeTorrentReleasePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("La respuesta no contiene un objeto JSON valido.");
  }

  const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : "release";
  const downloads = Array.isArray(payload.downloads)
    ? payload.downloads
        .map((entry, index) => ({
          title:
            typeof entry?.title === "string" && entry.title.trim()
              ? entry.title.trim()
              : `Opcion ${index + 1}`,
          fileSize: typeof entry?.fileSize === "string" ? entry.fileSize : null,
          uploadDate: typeof entry?.uploadDate === "string" ? entry.uploadDate : null,
          uris: Array.isArray(entry?.uris)
            ? entry.uris.filter((uri) => typeof uri === "string" && uri.trim().length > 0)
            : []
        }))
        .filter((entry) => entry.uris.length > 0)
    : [];

  if (!downloads.length) {
    throw new Error("El JSON no contiene descargas validas con URIs.");
  }

  return {
    name,
    downloads
  };
}

function normalizeTorrentReleaseSourceRecord(source) {
  return {
    sourceUrl: source.sourceUrl,
    fetchedAt: source.fetchedAt,
    extractionPassword: typeof source.extractionPassword === "string" ? source.extractionPassword : "",
    release: source.release
  };
}

async function fetchTorrentRelease(input) {
  const url = typeof input === "string" ? input : input?.url;
  const extractionPassword =
    input && typeof input === "object" && typeof input.extractionPassword === "string"
      ? input.extractionPassword.trim()
      : "";
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("Escribe una URL valida.");
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Solo se admiten URLs http o https.");
  }

  const response = await fetch(parsedUrl, {
    headers: {
      accept: "application/json, text/plain;q=0.9, */*;q=0.8"
    }
  });

  if (!response.ok) {
    throw new Error(`La URL respondio con estado ${response.status}.`);
  }

  const raw = await response.text();
  let releasePayload;
  try {
    releasePayload = JSON.parse(raw);
  } catch {
    throw new Error("La pagina no devolvio un JSON valido.");
  }

  return {
    sourceUrl: parsedUrl.toString(),
    fetchedAt: new Date().toISOString(),
    extractionPassword,
    release: normalizeTorrentReleasePayload(releasePayload)
  };
}

ipcMain.handle("app:bootstrap", async () => {
  return getBootstrapPayload(await detectGitStatus());
});

ipcMain.handle("ui:save-preferences", async (_event, payload) => {
  state.uiPreferences = normalizeUiPreferences({
    ...state.uiPreferences,
    ...(payload && typeof payload === "object" ? payload : {})
  });
  await stateStore.save(state);
  return state.uiPreferences;
});

ipcMain.handle("dialog:pick-directory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"]
  });

  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("dialog:pick-image", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "Imagenes", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }
    ]
  });

  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("app:open-external", async (_event, url) => {
  if (!url || typeof url !== "string") {
    throw new Error("No se recibio una URL valida.");
  }

  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle("torrent:list", async () => {
  return torrentService.listDownloads();
});

ipcMain.handle("torrent:fetch-release", async (_event, url) => {
  const source = await fetchTorrentRelease(url);
  state.torrentReleaseSources = [
    normalizeTorrentReleaseSourceRecord(source),
    ...state.torrentReleaseSources
      .filter((entry) => entry?.sourceUrl !== source.sourceUrl)
      .map((entry) => normalizeTorrentReleaseSourceRecord(entry))
  ];
  await persistLocalState();
  return source;
});

ipcMain.handle("torrent:update-source-password", async (_event, payload) => {
  const sourceUrl = typeof payload?.sourceUrl === "string" ? payload.sourceUrl : "";
  const extractionPassword = typeof payload?.extractionPassword === "string" ? payload.extractionPassword.trim() : "";

  state.torrentReleaseSources = state.torrentReleaseSources.map((entry) =>
    entry?.sourceUrl === sourceUrl
      ? normalizeTorrentReleaseSourceRecord({
          ...entry,
          extractionPassword
        })
      : normalizeTorrentReleaseSourceRecord(entry)
  );

  await persistLocalState();
  return state.torrentReleaseSources;
});

ipcMain.handle("torrent:remove-source", async (_event, sourceUrl) => {
  state.torrentReleaseSources = state.torrentReleaseSources.filter((entry) => entry?.sourceUrl !== sourceUrl);
  await persistLocalState();
  return state.torrentReleaseSources;
});

ipcMain.handle("torrent:start", async (_event, payload) => {
  const download = await torrentService.startDownload(payload);
  emitInfo(`Descarga torrent iniciada: ${download.title}.`);
  await emitBootstrap();
  return download;
});

ipcMain.handle("torrent:pause", async (_event, downloadId) => {
  const download = torrentService.pauseDownload(downloadId);
  emitInfo(`Descarga pausada: ${download.title}.`);
  return download;
});

ipcMain.handle("torrent:resume", async (_event, downloadId) => {
  const download = torrentService.resumeDownload(downloadId);
  emitInfo(`Descarga reanudada: ${download.title}.`);
  return download;
});

ipcMain.handle("torrent:cancel", async (_event, downloadId) => {
  const download = await torrentService.cancelDownload(downloadId);
  emitInfo(`Descarga cancelada: ${download.title}.`);
  return download;
});

ipcMain.handle("torrent:open-folder", async (_event, downloadId) => {
  const outputDir = torrentService.getOutputDir(downloadId);
  if (!outputDir) {
    throw new Error("No se encontro la descarga solicitada.");
  }

  const openError = await shell.openPath(outputDir);
  if (openError) {
    throw new Error(openError);
  }

  return {
    ok: true,
    outputDir
  };
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
      maxBackups: payload.maxBackups ?? current.maxBackups,
      savePath: payload.savePath ?? current.savePath,
    processName: payload.processName ?? current.processName,
    executablePath: payload.executablePath ?? current.executablePath,
    installRoot: payload.installRoot ?? current.installRoot,
    filePatterns: payload.filePatterns?.length ? payload.filePatterns : current.filePatterns,
    launchType: payload.launchType ?? current.launchType,
    launchTarget: payload.launchTarget ?? current.launchTarget,
    bannerPath: payload.bannerPath ?? current.bannerPath
  });

  state.games[gameIndex] = updated;
  await persistState({ syncCloud: true });
  return updated;
});

ipcMain.handle("game:get-icon", async (_event, gameId) => {
  const game = state.games.find((item) => item.id === gameId);
  if (!game) {
    throw new Error("Juego no encontrado.");
  }

  const iconPath = game.executablePath || (game.launchType === "exe" ? game.launchTarget || "" : "");
  if (!iconPath || !fs.existsSync(iconPath)) {
    return null;
  }

  const icon = await app.getFileIcon(iconPath, { size: "normal" });
  return icon.isEmpty() ? null : icon.toDataURL();
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

ipcMain.handle("game:close", async (_event, gameId) => {
  const game = state.games.find((item) => item.id === gameId);
  if (!game) {
    throw new Error("Juego no encontrado.");
  }

  await stopProcess(game.processName);
  emitInfo(`Juego cerrado: ${game.title}.`, game.id);
  syncService.schedulePostExitCapture(game.id);
  setTimeout(() => {
    void pollRunningStates();
  }, 1000);

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
    await logger.info("Inicializando aplicacion.", {
      packaged: app.isPackaged,
      userData: app.getPath("userData"),
      logFilePath: logger.logFilePath
    });
    const loadedState = await stateStore.load();
    state = {
      ...loadedState,
      games: Array.isArray(loadedState.games) ? loadedState.games.map(normalizeGameRecord) : [],
      torrentReleaseSources: Array.isArray(loadedState.torrentReleaseSources) ? loadedState.torrentReleaseSources : [],
      uiPreferences: normalizeUiPreferences(loadedState.uiPreferences)
    };

    if (loadedState.googleTokens) {
      driveService.setTokens(loadedState.googleTokens);
    }

    await stateStore.cleanupTempBackups();
    syncService.setGames(state.games);
    await ensureMonitoringStarted();
    startSessionPolling();
    await pollRunningStates();
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

app.on("before-quit", (event) => {
  if (isQuitting) {
    return;
  }

  event.preventDefault();
  isQuitting = true;

  void (async () => {
    if (sessionPollTimer) {
      clearInterval(sessionPollTimer);
      sessionPollTimer = null;
    }

    await flushRunningSessions({ preserveRunningProcesses: true });

    if (discoveryWorker) {
      await discoveryWorker.terminate();
      discoveryWorker = null;
    }

    await syncService.stop();
    await torrentService.destroy();

    if (shouldInstallUpdateOnQuit) {
      autoUpdater.quitAndInstall(false, true);
      return;
    }

    app.quit();
  })().catch((error) => {
    console.error("No se pudo cerrar la aplicacion limpiamente:", error);
    app.exit(1);
  });
});
