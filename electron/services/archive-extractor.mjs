import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WINRAR_PATHS = [
  "C:\\Program Files\\WinRAR\\WinRAR.exe",
  "C:\\Program Files (x86)\\WinRAR\\WinRAR.exe"
];

const ZIP7_PATHS = [
  "C:\\Program Files\\7-Zip\\7z.exe",
  "C:\\Program Files (x86)\\7-Zip\\7z.exe",
  "C:\\Program Files\\7-Zip\\7za.exe",
  "C:\\Program Files (x86)\\7-Zip\\7za.exe"
];

function ensureTrailingSlash(directoryPath) {
  return /[\\/]$/.test(directoryPath) ? directoryPath : `${directoryPath}\\`;
}

function createWinRarTool(command) {
  return {
    name: "WinRAR",
    command,
    buildArgs: (archivePath, targetDir, password) => [
      "x",
      "-ibck",
      "-inul",
      "-o+",
      "-y",
      password ? `-p${password}` : "-p-",
      archivePath,
      ensureTrailingSlash(targetDir)
    ]
  };
}

function createSevenZipTool(command) {
  return {
    name: "7-Zip",
    command,
    buildArgs: (archivePath, targetDir, password) => [
      "x",
      "-y",
      password ? `-p${password}` : "-p",
      `-o${targetDir}`,
      archivePath
    ]
  };
}

function getArchiveGroupKey(filePath) {
  const baseName = path.basename(filePath).toLowerCase();
  const multipartMatch = baseName.match(/^(.*)\.part(\d+)\.rar$/i);
  if (multipartMatch) {
    return {
      groupKey: `${path.dirname(filePath).toLowerCase()}|${multipartMatch[1]}`,
      partNumber: Number(multipartMatch[2])
    };
  }

  return {
    groupKey: `${path.dirname(filePath).toLowerCase()}|${baseName.replace(/\.rar$/i, "")}`,
    partNumber: null
  };
}

function normalizeFolderToken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(v?\d+([._-]\d+)*)\b/g, " ")
    .replace(/\b(build|release|final|portable|update|hotfix|fix)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

async function findCommandOnPath(commandName) {
  try {
    const { stdout } = await execFileAsync("where.exe", [commandName], { windowsHide: true });
    const resolved = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return resolved || null;
  } catch {
    return null;
  }
}

async function getDirectorySize(directoryPath) {
  let totalSize = 0;
  const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      totalSize += await getDirectorySize(fullPath);
      continue;
    }

    if (entry.isFile()) {
      const stats = await fs.promises.stat(fullPath);
      totalSize += stats.size;
    }
  }

  return totalSize;
}

async function moveEntryReplace(sourcePath, targetPath) {
  await fs.promises.rm(targetPath, { recursive: true, force: true });

  try {
    await fs.promises.rename(sourcePath, targetPath);
  } catch (error) {
    if (error?.code !== "EXDEV") {
      throw error;
    }

    const stats = await fs.promises.stat(sourcePath);
    if (stats.isDirectory()) {
      await copyDirectoryReplace(sourcePath, targetPath);
      await fs.promises.rm(sourcePath, { recursive: true, force: true });
      return;
    }

    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.copyFile(sourcePath, targetPath);
    await fs.promises.rm(sourcePath, { force: true });
  }
}

async function copyDirectoryReplace(sourceDir, targetDir) {
  await fs.promises.mkdir(targetDir, { recursive: true });
  const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryReplace(sourcePath, targetPath);
      continue;
    }

    await fs.promises.rm(targetPath, { recursive: true, force: true });
    await fs.promises.copyFile(sourcePath, targetPath);
  }
}

async function mergeDirectoryContents(sourceDir, targetDir) {
  await fs.promises.mkdir(targetDir, { recursive: true });
  const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      if (fs.existsSync(targetPath)) {
        const targetStats = await fs.promises.stat(targetPath);
        if (targetStats.isDirectory()) {
          await mergeDirectoryContents(sourcePath, targetPath);
          await fs.promises.rm(sourcePath, { recursive: true, force: true });
          continue;
        }
      }

      await moveEntryReplace(sourcePath, targetPath);
      continue;
    }

    await moveEntryReplace(sourcePath, targetPath);
  }
}

async function getDirectoryShape(directoryPath) {
  const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  const files = entries.filter((entry) => entry.isFile());
  return { directories, files };
}

export class ArchiveExtractor {
  constructor() {
    this.cachedTool = undefined;
  }

  async resolveTool() {
    if (this.cachedTool !== undefined) {
      return this.cachedTool;
    }

    for (const candidate of WINRAR_PATHS) {
      if (fs.existsSync(candidate)) {
        this.cachedTool = createWinRarTool(candidate);
        return this.cachedTool;
      }
    }

    for (const candidate of ZIP7_PATHS) {
      if (fs.existsSync(candidate)) {
        this.cachedTool = createSevenZipTool(candidate);
        return this.cachedTool;
      }
    }

    const winRarOnPath = await findCommandOnPath("WinRAR.exe");
    if (winRarOnPath) {
      this.cachedTool = createWinRarTool(winRarOnPath);
      return this.cachedTool;
    }

    const zip7OnPath = (await findCommandOnPath("7z.exe")) || (await findCommandOnPath("7za.exe"));
    if (zip7OnPath) {
      this.cachedTool = createSevenZipTool(zip7OnPath);
      return this.cachedTool;
    }

    this.cachedTool = null;
    return this.cachedTool;
  }

  async extractRarArchives({ directoryPath, deleteArchivesAfterExtract = false, extractionPassword = "", onProgress }) {
    const archiveGroups = await this.findRarArchiveGroups(directoryPath);
    if (!archiveGroups.length) {
      return {
        foundArchiveCount: 0,
        extractedArchiveCount: 0,
        deletedArchiveCount: 0,
        extractorName: null,
        skippedReason: null
      };
    }

    const tool = await this.resolveTool();
    if (!tool) {
      return {
        foundArchiveCount: archiveGroups.length,
        extractedArchiveCount: 0,
        deletedArchiveCount: 0,
        extractorName: null,
        skippedReason: "No se encontro WinRAR o 7-Zip instalado para descomprimir archivos .rar automaticamente."
      };
    }

    let extractedArchiveCount = 0;
    let deletedArchiveCount = 0;

    for (const group of archiveGroups) {
      onProgress?.({
        extractorName: tool.name,
        extractedArchiveCount,
        archiveName: path.basename(group.primaryArchivePath)
      });

      await execFileAsync(tool.command, tool.buildArgs(group.primaryArchivePath, group.targetDir, extractionPassword), {
        windowsHide: true
      });

      extractedArchiveCount += 1;

      if (deleteArchivesAfterExtract) {
        for (const archivePath of group.partPaths) {
          await fs.promises.rm(archivePath, { force: true });
          deletedArchiveCount += 1;
        }
      }
    }

    const fixMergeResult = await this.mergeFixDirectories(directoryPath);
    const normalizedRootDir = await this.normalizeRedundantRootWrapper(directoryPath);

    return {
      foundArchiveCount: archiveGroups.length,
      extractedArchiveCount,
      deletedArchiveCount,
      extractorName: tool.name,
      skippedReason: null,
      mergedFixDirectoryCount: fixMergeResult.mergedFixDirectoryCount,
      mergedFixDestinationName: fixMergeResult.destinationDirName,
      normalizedRootDir
    };
  }

  async findRarArchiveGroups(rootDir) {
    const archivePaths = await this.collectRarFiles(rootDir);
    const groups = new Map();

    for (const archivePath of archivePaths) {
      const { groupKey, partNumber } = getArchiveGroupKey(archivePath);
      const group = groups.get(groupKey) || {
        primaryArchivePath: null,
        partPaths: [],
        targetDir: path.dirname(archivePath)
      };

      group.partPaths.push(archivePath);

      if (partNumber === 1) {
        group.primaryArchivePath = archivePath;
      } else if (partNumber === null && !group.primaryArchivePath) {
        group.primaryArchivePath = archivePath;
      }

      groups.set(groupKey, group);
    }

    return [...groups.values()]
      .filter((group) => group.primaryArchivePath)
      .sort((left, right) => left.primaryArchivePath.localeCompare(right.primaryArchivePath));
  }

  async collectRarFiles(rootDir) {
    if (!rootDir || !fs.existsSync(rootDir)) {
      return [];
    }

    const found = [];
    const stack = [rootDir];

    while (stack.length) {
      const currentDir = stack.pop();
      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }

        if (entry.isFile() && /\.rar$/i.test(entry.name)) {
          found.push(fullPath);
        }
      }
    }

    return found;
  }

  async mergeFixDirectories(rootDir) {
    if (!rootDir || !fs.existsSync(rootDir)) {
      return {
        mergedFixDirectoryCount: 0,
        destinationDirName: null
      };
    }

    const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        fullPath: path.join(rootDir, entry.name)
      }));

    let mergedFixDirectoryCount = 0;
    const destinationNames = new Set();
    const fixDirectories = directories.filter((entry) => /fix/i.test(entry.name));
    const normalDirectories = directories.filter((entry) => !/fix/i.test(entry.name));

    if (fixDirectories.length && normalDirectories.length) {
      const sizedDirectories = await Promise.all(
        normalDirectories.map(async (entry) => ({
          ...entry,
          size: await getDirectorySize(entry.fullPath)
        }))
      );

      sizedDirectories.sort((left, right) => right.size - left.size);
      const destination = sizedDirectories[0];
      destinationNames.add(destination.name);

      for (const fixDirectory of fixDirectories) {
        await mergeDirectoryContents(fixDirectory.fullPath, destination.fullPath);
        await fs.promises.rm(fixDirectory.fullPath, { recursive: true, force: true });
        mergedFixDirectoryCount += 1;
      }
    }

    for (const directory of normalDirectories) {
      const nestedResult = await this.mergeFixDirectories(directory.fullPath);
      mergedFixDirectoryCount += nestedResult.mergedFixDirectoryCount;
      if (nestedResult.destinationDirName) {
        for (const name of nestedResult.destinationDirName.split(", ")) {
          if (name.trim()) {
            destinationNames.add(name.trim());
          }
        }
      }
    }

    return {
      mergedFixDirectoryCount,
      destinationDirName: destinationNames.size ? [...destinationNames].join(", ") : null
    };
  }

  async normalizeRedundantRootWrapper(rootDir) {
    if (!rootDir || !fs.existsSync(rootDir)) {
      return rootDir;
    }

    let currentRoot = rootDir;
    let iterations = 0;

    while (iterations < 4) {
      const shape = await getDirectoryShape(currentRoot);
      if (shape.files.length > 0 || shape.directories.length !== 1) {
        break;
      }

      const onlyChild = shape.directories[0];
      const childDirPath = path.join(currentRoot, onlyChild.name);
      const parentName = path.basename(currentRoot);
      const parentToken = normalizeFolderToken(parentName);
      const childToken = normalizeFolderToken(onlyChild.name);
      const tokensMatch =
        parentToken &&
        childToken &&
        (parentToken === childToken || parentToken.includes(childToken) || childToken.includes(parentToken));

      if (!tokensMatch) {
        break;
      }

      await mergeDirectoryContents(childDirPath, currentRoot);
      await fs.promises.rm(childDirPath, { recursive: true, force: true });
      iterations += 1;
    }

    return currentRoot;
  }
}
