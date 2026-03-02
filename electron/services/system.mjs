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

function getTaskImageName(processName) {
  const lookupName = normalizeProcessLookupName(processName);
  return lookupName ? `${lookupName}.exe` : "";
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
  const taskImageName = getTaskImageName(processName);
  if (!taskImageName) {
    return false;
  }

  const { stdout } = await execFileAsync("tasklist", ["/FI", `IMAGENAME eq ${taskImageName}`], {
    windowsHide: true
  });

  return stdout.toLowerCase().includes(taskImageName.toLowerCase());
}

export async function stopProcess(processName) {
  const lookupName = normalizeProcessLookupName(processName);
  const taskImageName = getTaskImageName(processName);
  if (!lookupName) {
    throw new Error("El juego no tiene un proceso valido para cerrar.");
  }

  if (!(await isProcessRunning(processName))) {
    throw new Error("El proceso no esta en ejecucion.");
  }

  try {
    await execFileAsync("taskkill", ["/IM", taskImageName, "/T", "/F"], {
      windowsHide: true
    });
  } catch {
    const script = [
      "$ErrorActionPreference='Stop'",
      `$procs = Get-Process -Name '${lookupName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue`,
      "if ($null -eq $procs) { throw 'El proceso no esta en ejecucion.' }",
      "$procs | Stop-Process -Force"
    ].join("; ");

    await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true
    });
  }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (!(await isProcessRunning(processName))) {
      return { ok: true };
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }

  throw new Error("No se pudo cerrar el proceso del juego.");
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
