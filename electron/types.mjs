/**
 * @typedef {{
 *   id: string;
 *   title: string;
 *   savePath: string;
 *   processName: string;
 *   executablePath?: string;
 *   installed: boolean;
 *   platform: "windows";
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
