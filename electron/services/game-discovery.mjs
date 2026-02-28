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

    for (const [rootIndex, scanRoot] of validRoots.entries()) {
      if (onProgress) {
        onProgress({
          phase: "root-started",
          scanRoot,
          rootIndex,
          rootCount: validRoots.length,
          processedExecutables
        });
      }
      const exeFiles = await walkForExecutables(scanRoot, 0, maxDepth);
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
            rootIndex,
            rootCount: validRoots.length,
            processedExecutables
          });
        }
      }

      if (onProgress) {
        onProgress({
          phase: "root-completed",
          scanRoot,
          rootIndex,
          rootCount: validRoots.length,
          processedExecutables
        });
      }
    }

    return dedupeCandidates(candidates).sort((left, right) => right.confidence - left.confidence);
  }
}

async function walkForExecutables(currentDir, depth, maxDepth) {
  if (depth > maxDepth) {
    return [];
  }

  const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoredDirNames.has(entry.name.toLowerCase())) {
        continue;
      }

      files.push(...(await walkForExecutables(path.join(currentDir, entry.name), depth + 1, maxDepth)));
      continue;
    }

    const lowerName = entry.name.toLowerCase();
    if (!lowerName.endsWith(".exe") || ignoredExeNames.has(lowerName)) {
      continue;
    }

    files.push(path.join(currentDir, entry.name));
  }

  return files;
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
