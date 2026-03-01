import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { google } from "googleapis";

export class GoogleDriveService {
  constructor(env) {
    this.env = env;
    this.oauth2Client = new google.auth.OAuth2(
      env.GOOGLE_OAUTH_CLIENT_ID,
      env.GOOGLE_OAUTH_CLIENT_SECRET,
      env.GOOGLE_OAUTH_REDIRECT_URI
    );
    this.drive = google.drive({
      version: "v3",
      auth: this.oauth2Client
    });
    this.tokens = null;
    this.pendingAuthServer = null;
    this.onTokensChanged = null;

    this.oauth2Client.on("tokens", (tokens) => {
      if (!tokens) {
        return;
      }

      this.setTokens({
        ...this.tokens,
        ...tokens
      });
    });
  }

  getAuthUrl() {
    return this.oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/drive.file"]
    });
  }

  isConfigured() {
    return Boolean(this.env.GOOGLE_OAUTH_CLIENT_ID && this.env.GOOGLE_OAUTH_CLIENT_SECRET);
  }

  isAuthenticated() {
    return Boolean(this.tokens?.access_token || this.tokens?.refresh_token);
  }

  setTokenPersistence(handler) {
    this.onTokensChanged = handler;
  }

  setTokens(tokens) {
    if (!tokens) {
      this.tokens = null;
      this.oauth2Client.setCredentials({});
      return;
    }

    this.tokens = {
      ...this.tokens,
      ...tokens
    };
    this.oauth2Client.setCredentials(this.tokens);

    if (this.onTokensChanged) {
      void this.onTokensChanged(this.tokens);
    }
  }

  async exchangeCode(code) {
    const { tokens } = await this.oauth2Client.getToken(code);
    this.setTokens(tokens);
    return tokens;
  }

  async startDesktopAuthFlow(onConnected) {
    if (!this.isConfigured()) {
      throw new Error("Faltan credenciales OAuth de Google. Copia un archivo .env junto al ejecutable y completa GOOGLE_OAUTH_CLIENT_ID y GOOGLE_OAUTH_CLIENT_SECRET.");
    }

    const authUrl = this.getAuthUrl();
    const redirectUrl = new URL(this.env.GOOGLE_OAUTH_REDIRECT_URI);

    if (this.pendingAuthServer) {
      this.pendingAuthServer.close();
    }

    this.pendingAuthServer = http.createServer(async (req, res) => {
      try {
        const currentUrl = new URL(req.url, this.env.GOOGLE_OAUTH_REDIRECT_URI);
        const code = currentUrl.searchParams.get("code");

        if (!code) {
          res.statusCode = 400;
          res.end("No se recibio el codigo OAuth.");
          return;
        }

        const tokens = await this.exchangeCode(code);
        res.statusCode = 200;
        res.end("Autenticacion completada. Puedes cerrar esta ventana.");

        if (this.pendingAuthServer) {
          this.pendingAuthServer.close();
          this.pendingAuthServer = null;
        }

        if (onConnected) {
          await onConnected(tokens);
        }
      } catch {
        res.statusCode = 500;
        res.end("Error al completar la autenticacion.");
        if (this.pendingAuthServer) {
          this.pendingAuthServer.close();
          this.pendingAuthServer = null;
        }
      }
    });

    await new Promise((resolve) => {
      this.pendingAuthServer.listen(Number(redirectUrl.port), redirectUrl.hostname, resolve);
    });

    return { authUrl };
  }

  async ensureAppFolders() {
    const rootId = await this.ensureFolder(this.env.GOOGLE_DRIVE_ROOT_FOLDER_NAME);
    const libraryId = await this.ensureFolder("library", rootId);
    const backupsId = await this.ensureFolder("backups", rootId);

    return { rootId, libraryId, backupsId };
  }

  async ensureFolder(name, parentId = null) {
    const q = [
      `name = '${name.replace(/'/g, "\\'")}'`,
      "mimeType = 'application/vnd.google-apps.folder'",
      "trashed = false"
    ];

    if (parentId) {
      q.push(`'${parentId}' in parents`);
    }

    const existing = await this.drive.files.list({
      q: q.join(" and "),
      fields: "files(id, name)"
    });

    if (existing.data.files?.length) {
      return existing.data.files[0].id;
    }

    const created = await this.drive.files.create({
      requestBody: {
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: parentId ? [parentId] : undefined
      },
      fields: "id"
    });

    return created.data.id;
  }

  async findFileByName({ folderId, name }) {
    const response = await this.drive.files.list({
      q: [`name = '${name.replace(/'/g, "\\'")}'`, `'${folderId}' in parents`, "trashed = false"].join(" and "),
      fields: "files(id, name)"
    });

    return response.data.files?.[0] || null;
  }

  async uploadFile({ name, folderId, filePath, mimeType }) {
    const response = await this.drive.files.create({
      requestBody: {
        name,
        parents: [folderId]
      },
      media: {
        mimeType,
        body: fs.createReadStream(filePath)
      },
      fields: "id, name"
    });

    return response.data;
  }

  async upsertFile({ name, folderId, filePath, mimeType }) {
    const existing = await this.findFileByName({ folderId, name });
    if (existing) {
      const updated = await this.drive.files.update({
        fileId: existing.id,
        media: {
          mimeType,
          body: fs.createReadStream(filePath)
        },
        fields: "id, name"
      });

      return updated.data;
    }

    return this.uploadFile({ name, folderId, filePath, mimeType });
  }

  async upsertJson({ name, folderId, payload }) {
    const tempFile = path.join(process.cwd(), `.tmp-drive-${crypto.randomUUID()}.json`);
    await fs.promises.writeFile(tempFile, JSON.stringify(payload, null, 2), "utf8");

    try {
      return await this.upsertFile({
        name,
        folderId,
        filePath: tempFile,
        mimeType: "application/json"
      });
    } finally {
      await fs.promises.rm(tempFile, { force: true });
    }
  }

  async syncCatalog(payload) {
    const { libraryId } = await this.ensureAppFolders();
    return this.upsertJson({
      name: "games.json",
      folderId: libraryId,
      payload
    });
  }

  async loadCatalog() {
    const { libraryId } = await this.ensureAppFolders();
    const file = await this.findFileByName({ folderId: libraryId, name: "games.json" });
    if (!file) {
      return null;
    }

    const content = await this.drive.files.get(
      { fileId: file.id, alt: "media" },
      { responseType: "text" }
    );

    return JSON.parse(content.data);
  }

  async uploadBackup({ gameId, archivePath, archiveName, metadata }) {
    const { backupsId } = await this.ensureAppFolders();
    const gameFolderId = await this.ensureFolder(gameId, backupsId);
    const snapshotsId = await this.ensureFolder("snapshots", gameFolderId);
    const metadataId = await this.ensureFolder("metadata", gameFolderId);

    const archiveFile = await this.uploadFile({
      name: archiveName,
      folderId: snapshotsId,
      filePath: archivePath,
      mimeType: "application/zip"
    });

    const resolvedMetadata = {
      ...metadata,
      driveFileId: archiveFile.id
    };

    const metadataFile = await this.upsertJson({
      name: `${metadata.id}.json`,
      folderId: metadataId,
      payload: resolvedMetadata
    });

    resolvedMetadata.metadataFileId = metadataFile.id;

    await this.upsertJson({
      name: "latest.json",
      folderId: gameFolderId,
      payload: resolvedMetadata
    });

    return {
      archiveFile,
      metadataFile,
      metadata: resolvedMetadata
    };
  }

  async loadLatestBackupMetadata(gameId) {
    const { backupsId } = await this.ensureAppFolders();
    const gameFolderId = await this.ensureFolder(gameId, backupsId);
    const latestFile = await this.findFileByName({ folderId: gameFolderId, name: "latest.json" });
    if (!latestFile) {
      return null;
    }

    const content = await this.drive.files.get(
      { fileId: latestFile.id, alt: "media" },
      { responseType: "text" }
    );

    return JSON.parse(content.data);
  }

  async downloadFile({ fileId, targetPath }) {
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

    const response = await this.drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(targetPath);
      response.data
        .on("error", reject)
        .pipe(output)
        .on("error", reject)
        .on("finish", resolve);
    });

    return targetPath;
  }
}
