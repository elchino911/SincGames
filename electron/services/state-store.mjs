import fs from "node:fs";
import path from "node:path";

const defaultState = {
  scanRoots: [],
  discoveryCandidates: [],
  games: [],
  manifestInfo: null,
  lastCloudSyncAt: null,
  offlineBackupDir: null,
  googleTokens: null
};

export class StateStore {
  constructor({ app, env }) {
    this.app = app;
    this.env = env;
  }

  get stateFilePath() {
    return path.join(this.app.getPath("userData"), "state.json");
  }

  get tempBackupDir() {
    return path.join(this.app.getPath("userData"), "temp-backups");
  }

  async load() {
    try {
      const raw = await fs.promises.readFile(this.stateFilePath, "utf8");
      const parsed = JSON.parse(raw);
      return {
        ...defaultState,
        ...parsed,
        scanRoots: Array.isArray(parsed.scanRoots) ? parsed.scanRoots : [],
        discoveryCandidates: Array.isArray(parsed.discoveryCandidates) ? parsed.discoveryCandidates : [],
        games: Array.isArray(parsed.games) ? parsed.games : [],
        offlineBackupDir: typeof parsed.offlineBackupDir === "string" ? parsed.offlineBackupDir : null,
        googleTokens: parsed.googleTokens && typeof parsed.googleTokens === "object" ? parsed.googleTokens : null
      };
    } catch {
      return structuredClone(defaultState);
    }
  }

  async save(state) {
    await fs.promises.mkdir(path.dirname(this.stateFilePath), { recursive: true });
    await fs.promises.writeFile(this.stateFilePath, JSON.stringify(state, null, 2), "utf8");
    return state;
  }

  async cleanupTempBackups() {
    const retentionDays = Number(this.env.TEMP_BACKUP_RETENTION_DAYS || 7);
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    await fs.promises.mkdir(this.tempBackupDir, { recursive: true });
    const entries = await fs.promises.readdir(this.tempBackupDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(this.tempBackupDir, entry.name);
      const stats = await fs.promises.stat(fullPath);
      if (stats.mtimeMs < cutoffMs) {
        await fs.promises.rm(fullPath, { recursive: true, force: true });
      }
    }
  }
}
