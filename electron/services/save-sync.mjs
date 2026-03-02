import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import chokidar from "chokidar";
import archiver from "archiver";
import { collectFiles, hashFiles, isProcessRunning } from "./system.mjs";

export class SaveSyncService {
  constructor({ env, emit, onSnapshot, log }) {
    this.env = env;
    this.emit = emit;
    this.onSnapshot = onSnapshot;
    this.log = log;
    this.games = [];
    this.watchers = new Map();
    this.watcherPaths = new Map();
    this.pendingTimers = new Map();
  }

  setGames(games) {
    this.games = games;
  }

  async start(options = {}) {
    const desiredGames = new Map(this.games.map((game) => [game.id, game]));

    for (const [gameId, watcher] of this.watchers.entries()) {
      const game = desiredGames.get(gameId);
      const currentPath = this.watcherPaths.get(gameId) || "";
      if (!game || !game.savePath || game.savePath !== currentPath) {
        await watcher.close();
        this.watchers.delete(gameId);
        this.watcherPaths.delete(gameId);
        if (!options.preservePendingTimers) {
          const pending = this.pendingTimers.get(gameId);
          if (pending) {
            clearTimeout(pending);
            this.pendingTimers.delete(gameId);
          }
        }
      }
    }

    for (const game of this.games) {
      const currentPath = this.watcherPaths.get(game.id) || "";
      if (this.watchers.has(game.id) && currentPath === (game.savePath || "")) {
        continue;
      }

      await this.watchGame(game);
    }
  }

  async stop(options = {}) {
    if (!options.preservePendingTimers) {
      for (const pending of this.pendingTimers.values()) {
        clearTimeout(pending);
      }

      this.pendingTimers.clear();
    }

    for (const watcher of this.watchers.values()) {
      await watcher.close();
    }

    this.watchers.clear();
    this.watcherPaths.clear();
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
      if (this.log) {
        await this.log.warn("Ruta de save no disponible para watcher.", {
          gameId: game.id,
          title: game.title,
          savePath: game.savePath
        });
      }
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

    watcher.on("error", async (error) => {
      if (this.log) {
        await this.log.error("Error en watcher de saves.", {
          gameId: game.id,
          title: game.title,
          savePath: game.savePath,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      this.emit("sync:event", {
        type: "warning",
        gameId: game.id,
        message: `Error monitoreando saves de ${game.title}.`
      });
    });

    this.watchers.set(game.id, watcher);
    this.watcherPaths.set(game.id, game.savePath);

    if (this.log) {
      await this.log.info("Watcher de saves iniciado.", {
        gameId: game.id,
        title: game.title,
        savePath: game.savePath
      });
    }
  }

  queueSnapshot(game, reason = "save-change") {
    const previous = this.pendingTimers.get(game.id);
    if (previous) {
      clearTimeout(previous);
    }

    const timeout = setTimeout(async () => {
      this.pendingTimers.delete(game.id);
      try {
        await this.captureIfStable(game, { reason });
      } catch (error) {
        if (this.log) {
          await this.log.error("Fallo la captura automatica de save.", {
            gameId: game.id,
            title: game.title,
            reason,
            error: error instanceof Error ? error.message : String(error)
          });
        }

        this.emit("sync:event", {
          type: "warning",
          gameId: game.id,
          message: error instanceof Error ? error.message : "No se pudo procesar el save automaticamente."
        });
      }
    }, Number(this.env.SYNC_STABILITY_WINDOW_MS || 10000));

    this.pendingTimers.set(game.id, timeout);
  }

  schedulePostExitCapture(gameId) {
    const game = this.games.find((entry) => entry.id === gameId);
    if (!game) {
      return;
    }

    if (this.log) {
      void this.log.info("Captura post-cierre agendada.", {
        gameId: game.id,
        title: game.title
      }).catch(() => {});
    }

    this.queueSnapshot(game, "process-exit");
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
      if (this.log) {
        await this.log.info("Captura pospuesta porque el juego sigue abierto.", {
          gameId: game.id,
          title: game.title,
          processName: game.processName,
          reason: options.reason || (options.manual ? "manual" : "save-change")
        });
      }
      if (!options.manual) {
        this.queueSnapshot(game, options.reason || "retry-while-running");
        return null;
      }

      throw new Error(message);
    }

    const files = await collectFiles(game.savePath, game.filePatterns);
    if (!files.length) {
      throw new Error(`No se encontraron archivos para respaldar en ${game.savePath}.`);
    }

    const hash = await hashFiles(game.savePath, files);
    if (game.latestLocalSave?.hash && game.latestLocalSave.hash === hash) {
      const message = `No hubo cambios nuevos en los saves de ${game.title}.`;
      this.emit("sync:event", {
        type: "info",
        gameId: game.id,
        message
      });
      if (this.log) {
        await this.log.info("Captura omitida por hash sin cambios.", {
          gameId: game.id,
          title: game.title,
          reason: options.reason || (options.manual ? "manual" : "save-change"),
          hash
        });
      }
      return null;
    }

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

    if (this.log) {
      await this.log.info("Nuevo snapshot local creado.", {
        gameId: game.id,
        title: game.title,
        reason: options.reason || (options.manual ? "manual" : "save-change"),
        files: files.length,
        hash,
        archiveName,
        sizeBytes
      });
    }

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
