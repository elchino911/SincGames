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
  constructor({ app, env, emit }) {
    this.app = app;
    this.env = env;
    this.emit = emit;
    this.client = null;
    this.clientPromise = null;
    this.downloads = new Map();
    this.torrents = new Map();
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

  async startDownload(payload) {
    const magnetUri = String(payload?.magnetUri || "").trim();
    if (!magnetUri.startsWith("magnet:?")) {
      throw new Error("Solo se admiten enlaces magnet validos.");
    }

    const sourceName = String(payload?.sourceName || "release").trim() || "release";
    const title = String(payload?.title || "torrent").trim() || "torrent";
    const outputDir = path.resolve(
      String(payload?.outputDir || "").trim() || this.getSuggestedOutputDir(sourceName, title)
    );

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
      status: "starting",
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      downloadSpeed: 0,
      numPeers: 0,
      infoHash: null,
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
      download.status = download.status === "completed" || download.status === "canceled"
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
      const download = this.downloads.get(downloadId);
      if (!download) {
        return;
      }

      updateFromTorrent(true);
      download.status = "completed";
      download.progress = 1;
      download.downloadSpeed = 0;
      download.completedAt = new Date().toISOString();
      this.emitState();
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
      status: download.status,
      progress: download.progress,
      downloadedBytes: download.downloadedBytes,
      totalBytes: download.totalBytes,
      downloadSpeed: download.downloadSpeed,
      numPeers: download.numPeers,
      infoHash: download.infoHash,
      errorMessage: download.errorMessage,
      warningMessage: download.warningMessage,
      createdAt: download.createdAt,
      completedAt: download.completedAt
    };
  }
}
