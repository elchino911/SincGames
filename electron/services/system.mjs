import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function isProcessRunning(processName) {
  if (!processName) {
    return false;
  }

  const { stdout } = await execFileAsync("tasklist", ["/FI", `IMAGENAME eq ${processName}`], {
    windowsHide: true
  });

  return stdout.toLowerCase().includes(processName.toLowerCase());
}

export async function collectFiles(rootDir, patterns = []) {
  const files = [];

  async function walk(currentDir) {
    const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      const relativePath = path.relative(rootDir, fullPath);
      if (patterns.length === 0 || patterns.some((pattern) => matchesPattern(relativePath, pattern))) {
        const stats = await fs.promises.stat(fullPath);
        files.push({
          fullPath,
          relativePath,
          sizeBytes: stats.size,
          modifiedAt: stats.mtime.toISOString()
        });
      }
    }
  }

  await walk(rootDir);

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export async function hashFiles(rootDir, files) {
  const hash = crypto.createHash("sha256");

  for (const file of files) {
    hash.update(file.relativePath);
    hash.update(file.modifiedAt);
    const buffer = await fs.promises.readFile(path.join(rootDir, file.relativePath));
    hash.update(buffer);
  }

  return hash.digest("hex");
}

function matchesPattern(relativePath, pattern) {
  if (!pattern || pattern === "**/*") {
    return true;
  }

  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^\\\\/]*")
    .replace(/\?/g, ".");

  return new RegExp(`^${escaped}$`, "i").test(relativePath);
}
