import os from "node:os";
import path from "node:path";
import { parse } from "yaml";

export class GameManifestService {
  constructor({ env }) {
    this.env = env;
    this.cache = null;
  }

  async loadManifest() {
    if (this.cache) {
      return this.cache;
    }

    const response = await fetch(this.env.GAME_MANIFEST_URL);
    if (!response.ok) {
      throw new Error(`No se pudo descargar el manifest externo: ${response.status}`);
    }

    const manifestText = await response.text();
    const parsed = parse(manifestText);
    const entries = Object.entries(parsed || {}).map(([title, config]) => ({
      title,
      config
    }));

    this.cache = {
      source: this.env.GAME_MANIFEST_URL,
      loadedAt: new Date().toISOString(),
      entries
    };

    return this.cache;
  }

  async getManifestInfo() {
    const manifest = await this.loadManifest();
    return {
      source: manifest.source,
      loadedAt: manifest.loadedAt,
      totalGames: manifest.entries.length
    };
  }

  async matchExecutable({ exePath, installRoot, scanRoot }) {
    const manifest = await this.loadManifest();
    const stem = path.basename(exePath, path.extname(exePath));
    const normalizedStem = normalize(stem);
    const normalizedInstallRoot = normalize(path.basename(installRoot));

    let bestMatch = null;

    for (const entry of manifest.entries) {
      const installNames = Object.keys(entry.config.installDir || {});
      const normalizedTitle = normalize(entry.title);
      const normalizedInstallNames = installNames.map((name) => normalize(name));

      let score = 0;
      if (normalizedTitle === normalizedStem) {
        score += 10;
      }
      if (normalizedInstallNames.includes(normalizedInstallRoot)) {
        score += 12;
      }
      if (normalizedTitle.includes(normalizedStem) || normalizedStem.includes(normalizedTitle)) {
        score += 4;
      }
      if (normalizedInstallNames.some((name) => name.includes(normalizedStem) || normalizedStem.includes(name))) {
        score += 5;
      }

      if (!bestMatch || score > bestMatch.score) {
        bestMatch = {
          title: entry.title,
          config: entry.config,
          score
        };
      }
    }

    if (!bestMatch || bestMatch.score < 8) {
      return null;
    }

    const saveRules = extractSaveRules(bestMatch.config);
    const resolvedSavePaths = saveRules
      .map((rule) => resolveManifestPath(rule, { exePath, installRoot, scanRoot }))
      .filter(Boolean);

    const savePathDetails = resolvedSavePaths
      .map((candidatePath) => deriveWatchConfiguration(candidatePath))
      .filter(Boolean);

    if (savePathDetails.length === 0) {
      return {
        title: bestMatch.title,
        confidence: bestMatch.score,
        savePath: "",
        filePatterns: ["**/*"]
      };
    }

    return {
      title: bestMatch.title,
      confidence: bestMatch.score,
      savePath: savePathDetails[0].savePath,
      filePatterns: unique(savePathDetails.map((item) => item.filePattern))
    };
  }
}

function extractSaveRules(config) {
  const rules = [];
  const files = config.files || {};

  for (const [rulePath, metadata] of Object.entries(files)) {
    const tags = Array.isArray(metadata?.tags) ? metadata.tags : [];
    const windowsAllowed = matchesWindowsConstraint(metadata?.when);
    if (windowsAllowed && tags.includes("save")) {
      rules.push(rulePath);
    }
  }

  return rules;
}

function matchesWindowsConstraint(when) {
  if (!when) {
    return true;
  }

  if (Array.isArray(when)) {
    return when.some((entry) => !entry?.os || entry.os === "windows");
  }

  return !when.os || when.os === "windows";
}

function resolveManifestPath(rulePath, { exePath, installRoot, scanRoot }) {
  const home = os.homedir();
  const substitutions = {
    "<home>": home,
    "<winAppData>": process.env.APPDATA || path.join(home, "AppData", "Roaming"),
    "<winLocalAppData>": process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"),
    "<winDocuments>": path.join(home, "Documents"),
    "<winSavedGames>": path.join(home, "Saved Games"),
    "<game>": installRoot,
    "<base>": installRoot,
    "<root>": scanRoot,
    "<storeUserId>": "*"
  };

  let resolved = rulePath;

  for (const [token, value] of Object.entries(substitutions)) {
    resolved = resolved.split(token).join(value);
  }

  if (resolved.includes("<")) {
    return null;
  }

  return resolved.replaceAll("/", path.sep);
}

function deriveWatchConfiguration(candidatePath) {
  const wildcardIndex = candidatePath.search(/[*?]/);
  let stablePath = candidatePath;

  if (wildcardIndex >= 0) {
    const lastSeparator = candidatePath.slice(0, wildcardIndex).lastIndexOf(path.sep);
    stablePath = candidatePath.slice(0, Math.max(0, lastSeparator));
  }

  const parsed = path.parse(stablePath);
  const looksLikeFile = Boolean(parsed.ext);
  const savePath = looksLikeFile ? parsed.dir : stablePath;
  if (!savePath) {
    return null;
  }

  let filePattern = "**/*";
  if (wildcardIndex >= 0) {
    filePattern = normalizePattern(path.relative(savePath, candidatePath));
  } else if (looksLikeFile) {
    filePattern = normalizePattern(parsed.base);
  }

  return {
    savePath,
    filePattern
  };
}

function normalize(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizePattern(value) {
  const normalized = value.replaceAll("\\", "/");
  return normalized === "" ? "**/*" : normalized;
}

function unique(values) {
  return [...new Set(values)];
}
