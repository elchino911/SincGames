/// <reference types="vite/client" />

declare global {
  interface Window {
    sincgames: {
      getBootstrap: () => Promise<BootstrapPayload>;
      openExternalUrl: (url: string) => Promise<{ ok: boolean }>;
      listTorrentDownloads: () => Promise<TorrentDownloadRecord[]>;
      fetchTorrentRelease: (url: string) => Promise<TorrentReleaseSourceRecord>;
      removeTorrentReleaseSource: (sourceUrl: string) => Promise<TorrentReleaseSourceRecord[]>;
      startTorrentDownload: (payload: TorrentDownloadPayload) => Promise<TorrentDownloadRecord>;
      pauseTorrentDownload: (downloadId: string) => Promise<TorrentDownloadRecord>;
      resumeTorrentDownload: (downloadId: string) => Promise<TorrentDownloadRecord>;
      cancelTorrentDownload: (downloadId: string) => Promise<TorrentDownloadRecord>;
      openTorrentFolder: (downloadId: string) => Promise<{ ok: boolean; outputDir: string }>;
      connectGoogleDrive: () => Promise<{ ok: boolean; authUrl: string | null }>;
      pickDirectory: () => Promise<string | null>;
      addScanRoot: (directoryPath: string) => Promise<string[]>;
      removeScanRoot: (directoryPath: string) => Promise<string[]>;
      setOfflineBackupDir: (directoryPath: string) => Promise<string>;
      saveGoogleOAuth: (payload: GoogleOAuthPayload) => Promise<{ ok: boolean; envFilePath: string }>;
      scanForGames: () => Promise<{ candidates: DiscoveryCandidate[]; manifestInfo: ManifestInfo | null }>;
      addGameFromCandidate: (candidateId: string) => Promise<GameRecord>;
      createManualGame: (payload: ManualGamePayload) => Promise<GameRecord>;
      updateGame: (payload: GameUpdatePayload) => Promise<GameRecord>;
      launchGame: (gameId: string) => Promise<{ ok: boolean }>;
      backupNow: (gameId: string) => Promise<{ ok: boolean; snapshot: LocalSnapshot | null }>;
      restoreLatestRemote: (gameId: string) => Promise<{ restoredAt: string; tempBackupDir: string }>;
      onSyncEvent: (callback: (payload: SyncEventPayload) => void) => () => void;
      onStateUpdated: (callback: (payload: BootstrapPayload) => void) => () => void;
      onDiscoveryStatus: (callback: (payload: DiscoveryStatusPayload) => void) => () => void;
      onTorrentUpdated: (callback: (payload: TorrentDownloadRecord[]) => void) => () => void;
    };
  }
}

export type LaunchType = "exe" | "steam" | "uri" | "command";

export interface RemoteBackup {
  id: string;
  gameId: string;
  createdAt: string;
  driveFileId: string;
  metadataFileId: string;
  archiveName: string;
  hash: string;
  sizeBytes: number;
  deviceLabel: string;
}

export interface LocalSnapshot {
  id: string;
  gameId: string;
  createdAt: string;
  modifiedFiles: number;
  archiveName: string;
  archivePath: string;
  hash: string;
  sizeBytes: number;
}

export interface GameRecord {
  id: string;
  title: string;
  savePath: string;
  processName: string;
  executablePath?: string;
  installRoot?: string;
  detectionSource?: "manual" | "manifest" | "scan";
  launchType?: LaunchType;
  launchTarget?: string;
  totalPlaySeconds?: number;
  currentlyRunning?: boolean;
  sessionStartedAt?: string | null;
  lastPlayedAt?: string | null;
  processStartedAt?: string | null;
  trackedUntilAt?: string | null;
  installed: boolean;
  platform: "windows";
  filePatterns: string[];
  latestLocalSave: LocalSnapshot | null;
  latestRemoteSave: RemoteBackup | null;
}

export interface DiscoveryCandidate {
  id: string;
  title: string;
  executablePath: string;
  processName: string;
  installRoot: string;
  suggestedSavePath: string;
  filePatterns: string[];
  detectionSource: "manifest" | "scan";
  confidence: number;
}

export interface ManifestInfo {
  source: string;
  loadedAt: string;
  totalGames: number;
}

export interface ManualGamePayload {
  id?: string;
  title: string;
  savePath: string;
  processName: string;
  executablePath?: string;
  installRoot?: string;
  filePatterns?: string[];
  launchType?: LaunchType;
  launchTarget?: string;
}

export interface GameUpdatePayload {
  gameId: string;
  title?: string;
  savePath?: string;
  processName?: string;
  executablePath?: string;
  installRoot?: string;
  filePatterns?: string[];
  launchType?: LaunchType;
  launchTarget?: string;
}

export interface BootstrapPayload {
  env: {
    appName: string;
    deviceLabel: string;
    driveRootFolderName: string;
    autoDownloadIfNoLocalSave: boolean;
    tempBackupRetentionDays: number;
    offlineBackupDir: string | null;
    oauthConfigPath: string;
    googleOauthClientId: string;
    googleOauthClientSecret: string;
    googleOauthRedirectUri: string;
  };
  capabilities: {
    gitReady: boolean;
    googleConfigured: boolean;
    googleAuthenticated: boolean;
    offlineFallbackConfigured: boolean;
  };
  runtime: {
    monitoringStarted: boolean;
    discoveryRunning: boolean;
  };
  scanRoots: string[];
  discoveryCandidates: DiscoveryCandidate[];
  torrentReleaseSources: TorrentReleaseSourceRecord[];
  manifestInfo: ManifestInfo | null;
  games: GameRecord[];
  torrentDownloads: TorrentDownloadRecord[];
  design: {
    accent: string;
    accentSoft: string;
    surface: string;
    ink: string;
  };
  startup: {
    requiresStorageChoice: boolean;
  };
}

export interface SyncEventPayload {
  type: "info" | "warning" | "snapshot";
  gameId: string | null;
  message: string;
  snapshot?: LocalSnapshot;
}

export interface DiscoveryStatusPayload {
  phase: "started" | "root-started" | "matching" | "root-completed" | "completed" | "failed";
  scanRoot: string | null;
  rootIndex: number;
  rootCount: number;
  processedExecutables: number;
  running: boolean;
  message?: string;
}

export interface GoogleOAuthPayload {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface TorrentDownloadPayload {
  sourceName: string;
  title: string;
  magnetUri: string;
  fileSizeLabel?: string | null;
  uploadDate?: string | null;
  outputDir?: string;
}

export interface TorrentDownloadRecord {
  id: string;
  sourceName: string;
  title: string;
  fileSizeLabel: string | null;
  uploadDate: string | null;
  outputDir: string;
  status: "starting" | "downloading" | "paused" | "completed" | "canceled" | "error";
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  downloadSpeed: number;
  numPeers: number;
  infoHash: string | null;
  errorMessage: string | null;
  warningMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface TorrentReleaseDownload {
  title: string;
  fileSize: string | null;
  uploadDate: string | null;
  uris: string[];
}

export interface TorrentReleasePayload {
  name: string;
  downloads: TorrentReleaseDownload[];
}

export interface TorrentReleaseSourceRecord {
  sourceUrl: string;
  fetchedAt: string;
  release: TorrentReleasePayload;
}

export {};
