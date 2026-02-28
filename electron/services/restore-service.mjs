import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import extract from "extract-zip";
import { isProcessRunning } from "./system.mjs";

export class RestoreService {
  constructor({ stateStore, driveService, emit }) {
    this.stateStore = stateStore;
    this.driveService = driveService;
    this.emit = emit;
  }

  async restoreLatestRemote(game) {
    if (!game.latestRemoteSave?.driveFileId) {
      throw new Error("No hay un backup remoto disponible para restaurar.");
    }

    if (await isProcessRunning(game.processName)) {
      throw new Error(`Cierra ${game.processName} antes de restaurar el save.`);
    }

    const restoreId = crypto.randomUUID();
    const tempDir = path.join(this.stateStore.tempBackupDir, `${game.id}-${restoreId}`);
    const archivePath = path.join(tempDir, "remote-save.zip");
    const localBackupDir = path.join(tempDir, "local-backup");

    await fs.promises.mkdir(tempDir, { recursive: true });

    if (game.savePath && fs.existsSync(game.savePath)) {
      await fs.promises.mkdir(localBackupDir, { recursive: true });
      await fs.promises.cp(game.savePath, localBackupDir, { recursive: true, force: true });
    }

    try {
      await this.driveService.downloadFile({
        fileId: game.latestRemoteSave.driveFileId,
        targetPath: archivePath
      });

      await fs.promises.mkdir(game.savePath, { recursive: true });
      await emptyDirectory(game.savePath);
      await extract(archivePath, { dir: game.savePath });

      this.emit("sync:event", {
        type: "info",
        gameId: game.id,
        message: `Backup remoto restaurado para ${game.title}.`
      });

      return {
        restoredAt: new Date().toISOString(),
        tempBackupDir: tempDir
      };
    } catch (error) {
      if (fs.existsSync(localBackupDir)) {
        await emptyDirectory(game.savePath);
        const backupEntries = await fs.promises.readdir(localBackupDir, { withFileTypes: true });
        for (const entry of backupEntries) {
          await fs.promises.cp(path.join(localBackupDir, entry.name), path.join(game.savePath, entry.name), {
            recursive: true,
            force: true
          });
        }
      }

      throw error;
    }
  }
}

async function emptyDirectory(targetDir) {
  await fs.promises.mkdir(targetDir, { recursive: true });
  const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });

  for (const entry of entries) {
    await fs.promises.rm(path.join(targetDir, entry.name), { recursive: true, force: true });
  }
}
