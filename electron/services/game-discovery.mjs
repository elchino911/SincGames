import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const isLinux = process.platform === "linux";
const isWindows = process.platform === "win32";

const ignoredDirNames = new Set([
  "$recycle.bin",
  "windows",
  "programdata",
  "appdata",
  "temp",
  "logs",
  "redist",
  "_commonredist",
  "__installer",
  "sbin",
  "include"
]);

const ignoredExeNames = new Set([
  "unins000.exe",
  "uninstall.exe",
  "setup.exe",
  "launcher.exe",
  "crashreporter.exe",
  "uninstall",
  "setup.sh",
  "install.sh",
  "README",
  "LICENSE",
  "Changelog"
]);

const ignoredExeSubstrings = [
  "uninstall",
  "unins",
  "crash",
  "crashpad",
  "helper",
  "updater",
  "installer",
  "setup",
  "bootstrap",
  "redist",
  "prereq",
  "supporttool",
  "reporter",
  "bugreport",
  "webhelper",
  "cefprocess",
  "shadercompile",
  "easyanticheat",
  "eac",
  "battleye",
  "beclient",
  "beservice",
  "benchmark",
  "configtool",
  "patcher"
];

const ignoredPathSegments = [
  `${path.sep}engine${path.sep}`,
  `${path.sep}launcher${path.sep}`,
  `${path.sep}support${path.sep}`,
  `${path.sep}crashreport${path.sep}`,
  `${path.sep}crashreportclient${path.sep}`,
  `${path.sep}thirdparty${path.sep}`,
  `${path.sep}redistributables${path.sep}`,
  `${path.sep}redist${path.sep}`,
  `${path.sep}prereq${path.sep}`,
  `${path.sep}easyanticheat${path.sep}`,
  `${path.sep}battleye${path.sep}`
];

async function isExecutableFile(filePath) {
  if (isWindows) {
    return filePath.toLowerCase().endsWith(".exe");
  }

  try {
    const stats = await fs.promises.stat(filePath);
    return (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

async function isScriptExecutable(filePath) {
  if (isWindows) {
    return false;
  }

  const lowerName = filePath.toLowerCase();
  if (!lowerName.endsWith(".sh") && !lowerName.endsWith(".py")) {
    return false;
  }

  return isExecutableFile(filePath);
}

export class GameDiscoveryService {
  constructor({ env, manifestService }) {
    this.env = env;
    this.manifestService = manifestService;
  }

  async scanRoots(scanRoots, options = {}) {
    const maxDepth = Number(this.env.DISCOVERY_SCAN_DEPTH || 4);
    const candidates = [];
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
    const validRoots = scanRoots.filter((scanRoot) => scanRoot && fs.existsSync(scanRoot));
    let processedExecutables = 0;
    let lastWalkedPath = null;

    for (const [rootIndex, scanRoot] of validRoots.entries()) {
      if (onProgress) {
        onProgress({
          phase: "root-started",
          scanRoot,
          rootIndex: rootIndex + 1,
          rootCount: validRoots.length,
          processedExecutables,
          currentPath: scanRoot
        });
      }
      const exeFiles = await walkForExecutables(scanRoot, 0, maxDepth, {
        onDirectory: (currentPath) => {
          lastWalkedPath = currentPath;
          if (!onProgress) return;
          onProgress({
            phase: "walking",
            scanRoot,
            rootIndex: rootIndex + 1,
            rootCount: validRoots.length,
            processedExecutables,
            currentPath
          });
        }
      });
      for (const exePath of exeFiles) {
        const installRoot = path.dirname(exePath);
        const manifestMatch = await this.manifestService.matchExecutable({
          exePath,
          installRoot,
          scanRoot
        });

        const baseName = path.basename(exePath);
        const stem = isWindows
          ? path.basename(exePath, ".exe")
          : baseName.replace(/\.(sh|py)$/, "");

        candidates.push({
          id: crypto.randomUUID(),
          title: manifestMatch?.title || humanize(stem),
          executablePath: exePath,
          processName: baseName,
          installRoot,
          suggestedSavePath: manifestMatch?.savePath || "",
          filePatterns: manifestMatch?.filePatterns?.length ? manifestMatch.filePatterns : ["**/*"],
          detectionSource: manifestMatch ? "manifest" : "scan",
          confidence: manifestMatch?.confidence || 0
        });

        processedExecutables += 1;

        if (onProgress && processedExecutables % 10 === 0) {
          onProgress({
            phase: "matching",
            scanRoot,
            rootIndex: rootIndex + 1,
            rootCount: validRoots.length,
            processedExecutables,
            currentPath: lastWalkedPath
          });
        }
      }

      if (onProgress) {
        onProgress({
          phase: "root-completed",
          scanRoot,
          rootIndex: rootIndex + 1,
          rootCount: validRoots.length,
          processedExecutables,
          currentPath: lastWalkedPath || scanRoot
        });
      }
    }

    return dedupeCandidates(candidates).sort((left, right) => right.confidence - left.confidence);
  }
}

async function walkForExecutables(currentDir, depth, maxDepth, options = {}) {
  if (depth > maxDepth) {
    return [];
  }

  if (typeof options.onDirectory === "function") {
    options.onDirectory(currentDir);
  }

  const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoredDirNames.has(entry.name.toLowerCase())) {
        continue;
      }

      files.push(...(await walkForExecutables(path.join(currentDir, entry.name), depth + 1, maxDepth, options)));
      continue;
    }

    const executablePath = path.join(currentDir, entry.name);
    const lowerName = entry.name.toLowerCase();

    if (shouldIgnoreExecutable(lowerName, executablePath)) {
      continue;
    }

    if (isWindows) {
      if (!lowerName.endsWith(".exe")) {
        continue;
      }
      files.push(executablePath);
    } else {
      // Linux: also detect .exe files (Wine/Proton games)
      if (lowerName.endsWith(".exe")) {
        files.push(executablePath);
        continue;
      }

      if (await isExecutableFile(executablePath)) {
        const ext = path.extname(lowerName).toLowerCase();
        if (ext === ".so" || ext === ".o" || ext === ".a" || ext === ".dylib") {
          continue;
        }
        files.push(executablePath);
      } else if (await isScriptExecutable(executablePath)) {
        files.push(executablePath);
      }
    }
  }

  return files;
}

function shouldIgnoreExecutable(lowerName, executablePath) {
  if (ignoredExeNames.has(lowerName)) {
    return true;
  }

  if (ignoredExeSubstrings.some((fragment) => lowerName.includes(fragment))) {
    return true;
  }

  const normalizedPath = executablePath.toLowerCase();
  if (ignoredPathSegments.some((segment) => normalizedPath.includes(segment))) {
    return true;
  }

  return false;
}

function humanize(fileStem) {
  return fileStem
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeCandidates(candidates) {
  const byExecutable = new Map();

  for (const candidate of candidates) {
    const existing = byExecutable.get(candidate.executablePath);
    if (!existing || candidate.confidence > existing.confidence) {
      byExecutable.set(candidate.executablePath, candidate);
    }
  }

  return [...byExecutable.values()];
}
