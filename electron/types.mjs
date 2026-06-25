/**
 * @typedef {{
 *   id: string;
 *   title: string;
 *   maxBackups?: number;
 *   savePath: string;
 *   processName: string;
 *   executablePath?: string;
 *   installRoot?: string;
 *   launchType?: "exe" | "steam" | "uri" | "command" | "proton";
 *   launchTarget?: string;
 *   protonVersion?: string;
 *   protonCompatDataPath?: string;
 *   launchEnvironment?: string;
 *   installed: boolean;
 *   platform: NodeJS.Platform | "windows";
 *   platformProfiles?: Record<string, {
 *     savePath?: string;
 *     processName?: string;
 *     executablePath?: string;
 *     installRoot?: string;
 *     filePatterns?: string[];
 *     launchType?: "exe" | "steam" | "uri" | "command" | "proton";
 *     launchTarget?: string;
 *     protonVersion?: string;
 *     protonCompatDataPath?: string;
 *     launchEnvironment?: string;
 *   }>;
 *   filePatterns: string[];
 *   lastLocalScanAt?: string;
 *   latestLocalSave?: SaveSnapshot | null;
 *   latestRemoteSave?: RemoteBackup | null;
 * }} GameConfig
 */

/**
 * @typedef {{
 *   id: string;
 *   gameId: string;
 *   createdAt: string;
 *   modifiedFiles: number;
 *   archiveName: string;
 *   archivePath: string;
 *   hash: string;
 *   sizeBytes: number;
 * }} SaveSnapshot
 */

/**
 * @typedef {{
 *   id: string;
 *   gameId: string;
 *   createdAt: string;
 *   driveFileId: string;
 *   metadataFileId: string;
 *   archiveName: string;
 *   hash: string;
 *   sizeBytes: number;
 *   deviceLabel: string;
 * }} RemoteBackup
 */

export {};
