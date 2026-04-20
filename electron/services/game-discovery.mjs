import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ignoredDirNames = new Set([
  "$recycle.bin",
  "windows",
  "programdata",
  "appdata",
  "temp",
  "logs",
  "redist",
  "_commonredist",
  "__installer"
]);

const ignoredExeNames = new Set([
  "unins000.exe",
  "uninstall.exe",
  "setup.exe",
  "launcher.exe",
  "crashreporter.exe"
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

        candidates.push({
          id: crypto.randomUUID(),
          title: manifestMatch?.title || humanize(path.basename(exePath, ".exe")),
          executablePath: exePath,
          processName: path.basename(exePath),
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

    const lowerName = entry.name.toLowerCase();
    const executablePath = path.join(currentDir, entry.name);
    if (!lowerName.endsWith(".exe") || shouldIgnoreExecutable(lowerName, executablePath)) {
      continue;
    }

    files.push(executablePath);
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
