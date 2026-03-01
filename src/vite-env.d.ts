/// <reference types="vite/client" />

declare global {
  interface Window {
    sincgames: {
      getBootstrap: () => Promise<BootstrapPayload>;
      startMonitoring: () => Promise<{ ok: boolean }>;
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
  manifestInfo: ManifestInfo | null;
  games: GameRecord[];
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

export {};
