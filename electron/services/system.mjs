import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function normalizeProcessLookupName(processName) {
  if (!processName) {
    return "";
  }

  return path.basename(processName, path.extname(processName)).trim();
}

export async function getProcessState(processName) {
  const lookupName = normalizeProcessLookupName(processName);
  if (!lookupName) {
    return {
      running: false,
      startedAt: null
    };
  }

  try {
    const script = [
      "$ErrorActionPreference='Stop'",
      `$proc = Get-Process -Name '${lookupName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1`,
      "if ($null -eq $proc) { '{\"running\":false,\"startedAt\":null}' }",
      "else { [pscustomobject]@{ running = $true; startedAt = $proc.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress }"
    ].join("; ");

    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true
    });
    const parsed = JSON.parse(stdout.trim());

    return {
      running: Boolean(parsed.running),
      startedAt: parsed.startedAt || null
    };
  } catch {
    return {
      running: await isProcessRunning(processName),
      startedAt: null
    };
  }
}

export async function isProcessRunning(processName) {
  const lookupName = normalizeProcessLookupName(processName);
  if (!lookupName) {
    return false;
  }

  const taskImageName = `${lookupName}.exe`;
  const { stdout } = await execFileAsync("tasklist", ["/FI", `IMAGENAME eq ${taskImageName}`], {
    windowsHide: true
  });

  return stdout.toLowerCase().includes(taskImageName.toLowerCase());
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
