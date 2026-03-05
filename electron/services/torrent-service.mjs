import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function sanitizePathSegment(value, fallback = "download") {
  const normalized = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return normalized || fallback;
}

function normalizeMessage(error) {
  if (!error) {
    return "Error desconocido.";
  }

  return error instanceof Error ? error.message : String(error);
}

export class TorrentService {
  constructor({ app, env, emit, archiveExtractor, onCompleted }) {
    this.app = app;
    this.env = env;
    this.emit = emit;
    this.archiveExtractor = archiveExtractor;
    this.onCompleted = typeof onCompleted === "function" ? onCompleted : null;
    this.client = null;
    this.clientPromise = null;
    this.downloads = new Map();
    this.torrents = new Map();
    this.finalizingDownloads = new Set();
  }

  listDownloads() {
    return [...this.downloads.values()]
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .map((entry) => this.serializeDownload(entry));
  }

  getOutputDir(downloadId) {
    const download = this.downloads.get(downloadId);
    return download?.outputDir || null;
  }

  getDownload(downloadId) {
    return this.downloads.get(downloadId) || null;
  }

  getSuggestedOutputDir(sourceName, title) {
    return path.join(
      this.app.getPath("downloads"),
      sanitizePathSegment(this.env.APP_NAME || "SincGames"),
      "Torrents",
      sanitizePathSegment(sourceName, "release"),
      sanitizePathSegment(title, "download")
    );
  }

  resolveOutputDir(sourceName, title, payload) {
    const explicitOutputDir = String(payload?.outputDir || "").trim();
    if (explicitOutputDir) {
      return path.resolve(explicitOutputDir);
    }

    const defaultOutputDir = String(payload?.defaultOutputDir || "").trim();
    if (defaultOutputDir) {
      return path.resolve(
        defaultOutputDir,
        sanitizePathSegment(sourceName, "release"),
        sanitizePathSegment(title, "download")
      );
    }

    return this.getSuggestedOutputDir(sourceName, title);
  }

  async startDownload(payload) {
    const magnetUri = String(payload?.magnetUri || "").trim();
    if (!magnetUri.startsWith("magnet:?")) {
      throw new Error("Solo se admiten enlaces magnet validos.");
    }

    const sourceName = String(payload?.sourceName || "release").trim() || "release";
    const title = String(payload?.title || "torrent").trim() || "torrent";
    const outputDir = this.resolveOutputDir(sourceName, title, payload);
    const extractRarOnComplete = payload?.extractRarOnComplete !== false;
    const deleteArchivesAfterExtract = Boolean(payload?.deleteArchivesAfterExtract);
    const extractionPassword = String(payload?.extractionPassword || "").trim();

    await fs.promises.mkdir(outputDir, { recursive: true });
    await this.ensureClient();

    const downloadId = crypto.randomUUID();
    const download = {
      id: downloadId,
      sourceName,
      title,
      fileSizeLabel: payload?.fileSizeLabel || null,
      uploadDate: payload?.uploadDate || null,
      magnetUri,
      outputDir,
      contentRoot: outputDir,
      status: "starting",
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      downloadSpeed: 0,
      numPeers: 0,
      infoHash: null,
      extractRarOnComplete,
      deleteArchivesAfterExtract,
      extractionPassword,
      hasExtractionPassword: Boolean(extractionPassword),
      extractorName: null,
      extractedArchiveCount: 0,
      postProcessMessage: null,
      errorMessage: null,
      warningMessage: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      lastEmitAt: 0
    };

    const torrent = this.client.add(magnetUri, { path: outputDir });

    this.downloads.set(downloadId, download);
    this.torrents.set(downloadId, torrent);
    this.attachTorrentListeners(downloadId, torrent);
    this.emitState();

    return this.serializeDownload(download);
  }

  pauseDownload(downloadId) {
    const torrent = this.torrents.get(downloadId);
    const download = this.downloads.get(downloadId);

    if (!torrent || !download) {
      throw new Error("No se encontro la descarga solicitada.");
    }

    if (download.status === "completed") {
      return this.serializeDownload(download);
    }

    torrent.pause();
    for (const wire of [...torrent.wires]) {
      wire.destroy();
    }
    download.status = "paused";
    download.downloadSpeed = 0;
    download.numPeers = 0;
    download.lastEmitAt = Date.now();
    this.emitState();
    return this.serializeDownload(download);
  }

  async cancelDownload(downloadId) {
    const torrent = this.torrents.get(downloadId);
    const download = this.downloads.get(downloadId);

    if (!download) {
      throw new Error("No se encontro la descarga solicitada.");
    }

    if (!torrent) {
      download.status = "canceled";
      download.downloadSpeed = 0;
      download.numPeers = 0;
      download.completedAt = download.completedAt || new Date().toISOString();
      this.emitState();
      return this.serializeDownload(download);
    }

    torrent.pause();
    for (const wire of [...torrent.wires]) {
      wire.destroy();
    }

    await new Promise((resolve) => {
      torrent.destroy({ destroyStore: false }, () => resolve());
    });

    this.torrents.delete(downloadId);
    download.status = "canceled";
    download.downloadSpeed = 0;
    download.numPeers = 0;
    download.completedAt = new Date().toISOString();
    download.lastEmitAt = Date.now();
    this.emitState();
    return this.serializeDownload(download);
  }

  resumeDownload(downloadId) {
    const torrent = this.torrents.get(downloadId);
    const download = this.downloads.get(downloadId);

    if (!torrent || !download) {
      throw new Error("No se encontro la descarga solicitada.");
    }

    if (download.status === "completed") {
      return this.serializeDownload(download);
    }

    torrent.resume();
    download.status = download.totalBytes ? "downloading" : "starting";
    download.lastEmitAt = Date.now();
    this.emitState();
    return this.serializeDownload(download);
  }

  async destroy() {
    const client = this.client;
    this.client = null;
    this.clientPromise = null;

    if (!client) {
      return;
    }

    await new Promise((resolve) => {
      client.destroy(() => resolve());
    });
  }

  async ensureClient() {
    if (this.client) {
      return this.client;
    }

    if (!this.clientPromise) {
      this.clientPromise = import("webtorrent")
        .then((module) => {
          const WebTorrent = module.default || module;
          this.client = new WebTorrent();
          this.client.on("error", (error) => {
            const message = normalizeMessage(error);
            for (const download of this.downloads.values()) {
              if (download.status === "completed" || download.status === "error") {
                continue;
              }

              download.status = "error";
              download.errorMessage = message;
            }
            this.emitState();
          });
          return this.client;
        })
        .catch((error) => {
          this.clientPromise = null;
          throw error;
        });
    }

    return this.clientPromise;
  }

  async releaseTorrent(downloadId) {
    const torrent = this.torrents.get(downloadId);
    if (!torrent) {
      return;
    }

    this.torrents.delete(downloadId);
    await new Promise((resolve, reject) => {
      torrent.destroy({ destroyStore: false }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  attachTorrentListeners(downloadId, torrent) {
    const updateFromTorrent = (force = false) => {
      const download = this.downloads.get(downloadId);
      if (!download) {
        return;
      }

      const now = Date.now();
      if (!force && now - download.lastEmitAt < 800) {
        return;
      }

      download.title = torrent.name || download.title;
      download.status = download.status === "completed" ||
        download.status === "canceled" ||
        download.status === "finalizing" ||
        download.status === "extracting"
        ? download.status
        : torrent.paused
          ? "paused"
          : (download.totalBytes || torrent.length ? "downloading" : "starting");
      download.progress = Number.isFinite(torrent.progress) ? torrent.progress : download.progress;
      download.downloadedBytes = Number(torrent.downloaded || 0);
      download.totalBytes = Number(torrent.length || 0);
      download.downloadSpeed = torrent.paused ? 0 : Number(torrent.downloadSpeed || 0);
      download.numPeers = torrent.paused ? 0 : Number(torrent.numPeers || 0);
      download.infoHash = torrent.infoHash || download.infoHash;
      download.lastEmitAt = now;
      this.emitState();
    };

    torrent.on("metadata", () => {
      updateFromTorrent(true);
    });

    torrent.on("download", () => {
      updateFromTorrent(false);
    });

    torrent.on("done", () => {
      void this.handleTorrentDone(downloadId, updateFromTorrent);
    });

    torrent.on("warning", (warning) => {
      const download = this.downloads.get(downloadId);
      if (!download) {
        return;
      }

      download.warningMessage = normalizeMessage(warning);
      this.emitState();
    });

    torrent.on("error", (error) => {
      const download = this.downloads.get(downloadId);
      if (!download) {
        return;
      }

      download.status = "error";
      download.errorMessage = normalizeMessage(error);
      download.completedAt = download.completedAt || new Date().toISOString();
      this.emitState();
    });
  }

  async handleTorrentDone(downloadId, updateFromTorrent) {
    if (this.finalizingDownloads.has(downloadId)) {
      return;
    }

    this.finalizingDownloads.add(downloadId);

    try {
      const download = this.downloads.get(downloadId);
      if (!download) {
        return;
      }

      updateFromTorrent(true);
      download.status = "finalizing";
      download.progress = 1;
      download.downloadedBytes = download.totalBytes || download.downloadedBytes;
      download.downloadSpeed = 0;
      download.numPeers = 0;
      download.postProcessMessage = "Liberando archivos descargados para que queden disponibles.";
      this.emitState();

      try {
        await this.releaseTorrent(downloadId);
      } catch (error) {
        download.warningMessage = normalizeMessage(error);
      }

      if (download.extractRarOnComplete) {
        download.status = "extracting";
        download.postProcessMessage = "Buscando archivos .rar para descomprimir.";
        this.emitState();

        try {
          const extractionResult = await this.archiveExtractor.extractRarArchives({
            directoryPath: download.outputDir,
            deleteArchivesAfterExtract: download.deleteArchivesAfterExtract,
            extractionPassword: download.extractionPassword,
            onProgress: ({ extractorName, extractedArchiveCount, archiveName }) => {
              const current = this.downloads.get(downloadId);
              if (!current) {
                return;
              }

              current.status = "extracting";
              current.extractorName = extractorName || current.extractorName;
              current.extractedArchiveCount = extractedArchiveCount;
              current.postProcessMessage = archiveName
                ? `Descomprimiendo ${archiveName} con ${extractorName}.`
                : "Descomprimiendo archivos .rar.";
              this.emitState();
            }
          });

          download.extractorName = extractionResult.extractorName;
          download.extractedArchiveCount = extractionResult.extractedArchiveCount;
          download.contentRoot = extractionResult.normalizedRootDir || download.outputDir;

          if (extractionResult.skippedReason) {
            download.warningMessage = extractionResult.skippedReason;
            download.postProcessMessage = extractionResult.skippedReason;
          } else if (!extractionResult.foundArchiveCount) {
            download.postProcessMessage = "No se encontraron archivos .rar para descomprimir.";
          } else {
            const fixMergeSuffix = extractionResult.mergedFixDirectoryCount
              ? ` Se aplicaron ${extractionResult.mergedFixDirectoryCount} carpeta(s) Fix sobre ${extractionResult.mergedFixDestinationName || "la carpeta principal"}.`
              : "";
            const cleanedSuffix = download.deleteArchivesAfterExtract && extractionResult.deletedArchiveCount
              ? ` y se limpiaron ${extractionResult.deletedArchiveCount} archivo(s) .rar`
              : "";
            download.postProcessMessage =
              `Se descomprimieron ${extractionResult.extractedArchiveCount} archivo(s) con ${extractionResult.extractorName}${cleanedSuffix}.${fixMergeSuffix}`;
          }
        } catch (error) {
          download.warningMessage = normalizeMessage(error);
          download.postProcessMessage = "La descarga termino, pero la descompresion automatica fallo.";
        }
      } else {
        download.postProcessMessage = "Descarga finalizada. La descompresion automatica esta desactivada.";
      }

      download.status = "completed";
      download.progress = 1;
      download.completedAt = new Date().toISOString();
      this.emitState();
      if (this.onCompleted) {
        void this.onCompleted(this.serializeDownload(download));
      }
    } finally {
      this.finalizingDownloads.delete(downloadId);
    }
  }

  emitState() {
    this.emit(this.listDownloads());
  }

  serializeDownload(download) {
    return {
      id: download.id,
      sourceName: download.sourceName,
      title: download.title,
      fileSizeLabel: download.fileSizeLabel,
      uploadDate: download.uploadDate,
      outputDir: download.outputDir,
      contentRoot: download.contentRoot || download.outputDir,
      status: download.status,
      progress: download.progress,
      downloadedBytes: download.downloadedBytes,
      totalBytes: download.totalBytes,
      downloadSpeed: download.downloadSpeed,
      numPeers: download.numPeers,
      infoHash: download.infoHash,
      extractRarOnComplete: download.extractRarOnComplete,
      deleteArchivesAfterExtract: download.deleteArchivesAfterExtract,
      hasExtractionPassword: download.hasExtractionPassword,
      extractorName: download.extractorName,
      extractedArchiveCount: download.extractedArchiveCount,
      postProcessMessage: download.postProcessMessage,
      errorMessage: download.errorMessage,
      warningMessage: download.warningMessage,
      createdAt: download.createdAt,
      completedAt: download.completedAt
    };
  }
}
