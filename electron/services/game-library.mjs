import path from "node:path";

const defaultFilePatterns = ["**/*"];

function pathTools(value = "") {
  return /\\|^[a-zA-Z]:/.test(value) ? path.win32 : path;
}

export function deriveInstallRoot(executablePath = "") {
  const trimmed = String(executablePath || "").trim();
  if (!trimmed) {
    return "";
  }

  const tools = pathTools(trimmed);
  const directory = tools.dirname(trimmed);
  return directory === "." ? "" : directory;
}

export function deriveProcessName(executablePath = "") {
  const trimmed = String(executablePath || "").trim();
  if (!trimmed) {
    return "";
  }

  return pathTools(trimmed).basename(trimmed);
}

export function prepareManualGamePayload(payload = {}) {
  const executablePath = String(payload.executablePath || "").trim();
  const launchType = payload.launchType || "exe";

  return {
    ...payload,
    title: String(payload.title || "").trim(),
    savePath: String(payload.savePath || "").trim(),
    processName: String(payload.processName || deriveProcessName(executablePath)).trim(),
    executablePath,
    installRoot: String(payload.installRoot || deriveInstallRoot(executablePath)).trim(),
    filePatterns: Array.isArray(payload.filePatterns) && payload.filePatterns.length
      ? payload.filePatterns
      : [...defaultFilePatterns],
    launchType,
    launchTarget: String(payload.launchTarget || (launchType === "exe" ? executablePath : "")).trim(),
    bannerPath: String(payload.bannerPath || "").trim()
  };
}

export function resolveGameRemoval({ game, deleteInstallFolder = false } = {}) {
  if (!game) {
    throw new Error("Juego no encontrado.");
  }

  const installRoot = String(game.installRoot || deriveInstallRoot(game.executablePath || "")).trim();
  return {
    gameId: game.id,
    installRootToDelete: deleteInstallFolder && installRoot ? installRoot : null
  };
}
