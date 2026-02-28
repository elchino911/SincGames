import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import chokidar from "chokidar";
import archiver from "archiver";
import { collectFiles, hashFiles, isProcessRunning } from "./system.mjs";

export class SaveSyncService {
  constructor({ env, emit, onSnapshot }) {
    this.env = env;
    this.emit = emit;
    this.onSnapshot = onSnapshot;
    this.games = [];
    this.watchers = new Map();
    this.pendingTimers = new Map();
  }

  setGames(games) {
    this.games = games;
  }

  async start() {
    await this.stop();

    for (const game of this.games) {
      await this.watchGame(game);
    }
  }

  async stop() {
    for (const watcher of this.watchers.values()) {
      await watcher.close();
    }

    this.watchers.clear();
  }

  async captureNow(gameId) {
    const game = this.games.find((entry) => entry.id === gameId);
    if (!game) {
      throw new Error("Juego no encontrado para respaldo manual.");
    }

    const pending = this.pendingTimers.get(game.id);
    if (pending) {
      clearTimeout(pending);
      this.pendingTimers.delete(game.id);
    }

    return this.captureIfStable(game, { manual: true });
  }

  async watchGame(game) {
    if (!game.savePath || !fs.existsSync(game.savePath)) {
      this.emit("sync:event", {
        type: "warning",
        gameId: game.id,
        message: `La ruta ${game.savePath} no existe.`
      });
      return;
    }

    const watcher = chokidar.watch(game.savePath, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 1500,
        pollInterval: 250
      }
    });

    watcher.on("all", () => {
      this.queueSnapshot(game);
    });

    this.watchers.set(game.id, watcher);
  }

  queueSnapshot(game) {
    const previous = this.pendingTimers.get(game.id);
    if (previous) {
      clearTimeout(previous);
    }

    const timeout = setTimeout(async () => {
      await this.captureIfStable(game);
    }, Number(this.env.SYNC_STABILITY_WINDOW_MS || 10000));

    this.pendingTimers.set(game.id, timeout);
  }

  async captureIfStable(game, options = {}) {
    const running = await isProcessRunning(game.processName);
    if (running) {
      const message = options.manual
        ? `No se puede respaldar ${game.title} mientras ${game.processName} sigue abierto.`
        : `Se detectaron cambios, pero ${game.processName} sigue abierto.`;

      this.emit("sync:event", {
        type: "info",
        gameId: game.id,
        message
      });
      if (!options.manual) {
        this.queueSnapshot(game);
        return null;
      }

      throw new Error(message);
    }

    const files = await collectFiles(game.savePath, game.filePatterns);
    if (!files.length) {
      throw new Error(`No se encontraron archivos para respaldar en ${game.savePath}.`);
      return;
    }

    const hash = await hashFiles(game.savePath, files);
    const snapshotId = crypto.randomUUID();
    const archiveName = `${game.id}-${snapshotId}.zip`;
    const archivePath = path.join(os.tmpdir(), archiveName);
    const sizeBytes = await this.createArchive(game.savePath, archivePath, files);

    const localSnapshot = {
      id: snapshotId,
      gameId: game.id,
      createdAt: new Date().toISOString(),
      modifiedFiles: files.length,
      archiveName,
      archivePath,
      hash,
      sizeBytes
    };

    this.emit("sync:event", {
      type: "snapshot",
      gameId: game.id,
      message: `Nuevo save local detectado para ${game.title}.`,
      snapshot: localSnapshot
    });

    if (this.onSnapshot) {
      await this.onSnapshot(game, localSnapshot);
    }

    return localSnapshot;
  }

  async createArchive(rootDir, archivePath, files) {
    await fs.promises.mkdir(path.dirname(archivePath), { recursive: true });

    return new Promise((resolve, reject) => {
      let bytes = 0;
      const output = fs.createWriteStream(archivePath);
      const archive = archiver("zip", { zlib: { level: 9 } });

      output.on("close", () => {
        resolve(bytes);
      });

      archive.on("error", reject);
      archive.on("progress", (progress) => {
        bytes = progress.fs.processedBytes;
      });

      archive.pipe(output);

      for (const file of files) {
        archive.file(path.join(rootDir, file.relativePath), { name: file.relativePath });
      }

      archive.finalize();
    });
  }
}
