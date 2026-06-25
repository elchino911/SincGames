import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const isLinux = process.platform === "linux";
const isWindows = process.platform === "win32";

async function commandExists(commandName) {
  try {
    await execFileAsync(commandName, ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function readLinuxProcesses() {
  try {
    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,comm=,lstart=,args="], {
      maxBuffer: 1024 * 1024 * 10
    });

    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\S+)\s+(.{24})\s+(.*)$/);
        if (!match) return null;
        return {
          pid: Number(match[1]),
          comm: match[2],
          startedAt: match[3].trim(),
          args: match[4] || ""
        };
      })
      .filter((processInfo) => processInfo && Number.isFinite(processInfo.pid));
  } catch {
    return [];
  }
}

async function findWinePidForExe(exePath) {
  if (!exePath) return null;
  const baseName = path.basename(exePath);
  const lowerBaseName = baseName.toLowerCase();
  const processes = await readLinuxProcesses();
  const match = processes.find((processInfo) => {
    const command = processInfo.comm.toLowerCase();
    const args = processInfo.args.toLowerCase();
    return (command === "wine" || command === "wine64" || command.includes("proton")) && args.includes(lowerBaseName);
  });

  return match?.pid || null;
}

async function findLinuxPidByName(lookupName) {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-n", "-x", lookupName]);
    const pid = Number(stdout.trim().split("\n").filter(Boolean).at(-1));
    if (Number.isFinite(pid) && pid > 0) return pid;
  } catch {}

  return null;
}

async function getLinuxProcessStart(pid) {
  const processes = await readLinuxProcesses();
  const processInfo = processes.find((entry) => entry.pid === pid);
  if (!processInfo?.startedAt) return null;

  const startedAt = new Date(processInfo.startedAt);
  return Number.isNaN(startedAt.getTime()) ? null : startedAt.toISOString();
}

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

async function getProcessStateLinux(lookupName, executablePath) {
  try {
    let pid = null;

    if (executablePath && path.extname(executablePath).toLowerCase() === ".exe") {
      pid = await findWinePidForExe(executablePath);
    }

    if (!pid) {
      pid = await findLinuxPidByName(lookupName);
    }

    if (!pid) {
      return { running: false, startedAt: null };
    }

    return { running: true, startedAt: await getLinuxProcessStart(pid) };
  } catch {
    return { running: false, startedAt: null };
  }
}

async function getProcessStateWindows(lookupName) {
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
      running: await isProcessRunningWindows(`${lookupName}.exe`),
      startedAt: null
    };
  }
}

export async function getProcessState(processName, executablePath) {
  const lookupName = normalizeProcessLookupName(processName);
  if (!lookupName) {
    return {
      running: false,
      startedAt: null
    };
  }

  if (isLinux) {
    return getProcessStateLinux(lookupName, executablePath);
  }

  return getProcessStateWindows(lookupName);
}

async function isProcessRunningLinux(lookupName, executablePath) {
  try {
    if (executablePath && path.extname(executablePath).toLowerCase() === ".exe") {
      const pid = await findWinePidForExe(executablePath);
      if (pid) return true;
    }

    return Boolean(await findLinuxPidByName(lookupName));
  } catch {
    return false;
  }
}

async function isProcessRunningWindows(taskImageName) {
  if (!taskImageName) {
    return false;
  }

  const { stdout } = await execFileAsync("tasklist", ["/FI", `IMAGENAME eq ${taskImageName}`], {
    windowsHide: true
  });

  return stdout.toLowerCase().includes(taskImageName.toLowerCase());
}

export async function isProcessRunning(processName, executablePath) {
  const lookupName = normalizeProcessLookupName(processName);
  if (!lookupName) {
    return false;
  }

  if (isLinux) {
    return isProcessRunningLinux(lookupName, executablePath);
  }

  const taskImageName = getTaskImageName(processName);
  return isProcessRunningWindows(taskImageName);
}

async function stopProcessLinux(lookupName, executablePath) {
  try {
    if (executablePath && path.extname(executablePath).toLowerCase() === ".exe") {
      const pid = await findWinePidForExe(executablePath);
      if (pid) {
        process.kill(pid, "SIGTERM");
      }
    } else {
      await execFileAsync("pkill", ["-x", lookupName]);
    }
  } catch {
    try {
      await execFileAsync("killall", [lookupName]);
    } catch {}
  }

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (!(await isProcessRunningLinux(lookupName, executablePath))) {
      return { ok: true };
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }

  throw new Error("No se pudo cerrar el proceso del juego.");
}

async function stopProcessWindows(lookupName, taskImageName) {
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
    if (!(await isProcessRunningWindows(taskImageName))) {
      return { ok: true };
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }

  throw new Error("No se pudo cerrar el proceso del juego.");
}

export async function stopProcess(processName, executablePath) {
  const lookupName = normalizeProcessLookupName(processName);
  if (!lookupName) {
    throw new Error("El juego no tiene un proceso valido para cerrar.");
  }

  if (!(await isProcessRunning(processName, executablePath))) {
    throw new Error("El proceso no esta en ejecucion.");
  }

  if (isLinux) {
    return stopProcessLinux(lookupName, executablePath);
  }

  const taskImageName = getTaskImageName(processName);
  return stopProcessWindows(lookupName, taskImageName);
}

export async function getWineBinary() {
  if (!isLinux) return null;

  if (await commandExists("wine64")) {
    return "wine64";
  }

  if (await commandExists("wine")) {
    return "wine";
  }

  return null;
}

export async function getSteamPath() {
  if (!isLinux) return null;

  const candidates = [
    path.join(os.homedir(), ".local", "share", "Steam"),
    path.join(os.homedir(), ".steam", "steam"),
    path.join(os.homedir(), ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam"),
    "/usr/share/steam",
    "/opt/steam"
  ];

  for (const candidate of candidates) {
    const hasSteamApps = await fs.promises.access(path.join(candidate, "steamapps")).then(() => true).catch(() => false);
    const hasSteamScript = await fs.promises.access(path.join(candidate, "steam.sh")).then(() => true).catch(() => false);
    if (hasSteamApps || hasSteamScript) {
      return candidate;
    }
  }

  return null;
}

async function findProtonTools(steamPath) {
  const toolRoots = [
    path.join(steamPath, "compatibilitytools.d"),
    path.join(steamPath, "steamapps", "common")
  ];
  const tools = [];

  for (const root of toolRoots) {
    const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const versionDir = path.join(root, entry.name);
      const protonCandidates = [
        path.join(versionDir, "proton"),
        path.join(versionDir, "dist", "proton")
      ];
      const protonPath = protonCandidates.find((candidate) => fs.existsSync(candidate));
      if (!protonPath) continue;

      const isSteamRuntimeTool = root.endsWith(path.join("steamapps", "common"));
      if (isSteamRuntimeTool && !entry.name.toLowerCase().includes("proton")) {
        continue;
      }

      tools.push({
        name: entry.name,
        path: protonPath
      });
    }
  }

  return tools.sort((left, right) => left.name.localeCompare(right.name));
}

export async function listProtonVersions() {
  const steamPath = await getSteamPath();
  if (!steamPath) return { steamPath: null, versions: [] };

  const tools = await findProtonTools(steamPath);
  return { steamPath, versions: [...new Set(tools.map((tool) => tool.name))] };
}

export async function getProtonExecutablePath(protonVersion) {
  const steamPath = await getSteamPath();
  if (!steamPath || !protonVersion) return null;

  const tools = await findProtonTools(steamPath);
  return tools.find((tool) => tool.name === protonVersion)?.path || null;
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
