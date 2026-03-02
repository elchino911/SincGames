import fs from "node:fs";
import path from "node:path";

export class AppLogger {
  constructor({ app, env }) {
    this.app = app;
    this.env = env;
  }

  get logFilePath() {
    return path.join(this.app.getPath("userData"), "logs", "sincgames.log");
  }

  async write(level, message, meta = null) {
    const line = [
      `[${new Date().toISOString()}]`,
      `[${String(level || "info").toUpperCase()}]`,
      message
    ].join(" ");

    const payload = meta ? `${line} ${JSON.stringify(meta)}\n` : `${line}\n`;

    await fs.promises.mkdir(path.dirname(this.logFilePath), { recursive: true });
    await fs.promises.appendFile(this.logFilePath, payload, "utf8");
  }

  info(message, meta = null) {
    return this.write("info", message, meta);
  }

  warn(message, meta = null) {
    return this.write("warn", message, meta);
  }

  error(message, meta = null) {
    return this.write("error", message, meta);
  }
}
