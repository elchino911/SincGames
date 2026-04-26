import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { prepareManualGamePayload, resolveGameRemoval } from "./game-library.mjs";

describe("prepareManualGamePayload", () => {
  it("derives process, install root, launch target, and default file patterns from the executable", () => {
    const prepared = prepareManualGamePayload({
      title: "Hollow Knight",
      savePath: "C:\\Users\\Jesus\\AppData\\LocalLow\\Team Cherry\\Hollow Knight",
      executablePath: "D:\\Games\\Hollow Knight\\hollow_knight.exe"
    });

    assert.equal(prepared.processName, "hollow_knight.exe");
    assert.equal(prepared.installRoot, "D:\\Games\\Hollow Knight");
    assert.equal(prepared.launchType, "exe");
    assert.equal(prepared.launchTarget, "D:\\Games\\Hollow Knight\\hollow_knight.exe");
    assert.deepEqual(prepared.filePatterns, ["**/*"]);
  });

  it("keeps explicit advanced values when they are provided", () => {
    const prepared = prepareManualGamePayload({
      title: "Custom Launcher",
      savePath: "C:\\Saves\\Custom",
      executablePath: "D:\\Games\\Custom\\game.exe",
      processName: "custom-runtime.exe",
      installRoot: "D:\\Games\\Custom",
      launchType: "command",
      launchTarget: "\"D:\\Games\\Custom\\launcher.exe\" --play",
      filePatterns: ["profile/*.sav"]
    });

    assert.equal(prepared.processName, "custom-runtime.exe");
    assert.equal(prepared.installRoot, "D:\\Games\\Custom");
    assert.equal(prepared.launchType, "command");
    assert.equal(prepared.launchTarget, "\"D:\\Games\\Custom\\launcher.exe\" --play");
    assert.deepEqual(prepared.filePatterns, ["profile/*.sav"]);
  });
});

describe("resolveGameRemoval", () => {
  it("removes only the catalog record when folder deletion is not requested", () => {
    const result = resolveGameRemoval({
      game: {
        id: "celeste",
        title: "Celeste",
        installRoot: "D:\\Games\\Celeste",
        executablePath: "D:\\Games\\Celeste\\Celeste.exe"
      },
      deleteInstallFolder: false
    });

    assert.equal(result.installRootToDelete, null);
  });

  it("uses install root when deleting the game folder", () => {
    const result = resolveGameRemoval({
      game: {
        id: "celeste",
        title: "Celeste",
        installRoot: "D:\\Games\\Celeste",
        executablePath: "D:\\Games\\Celeste\\Celeste.exe"
      },
      deleteInstallFolder: true
    });

    assert.equal(result.installRootToDelete, "D:\\Games\\Celeste");
  });

  it("falls back to the executable directory when install root is missing", () => {
    const result = resolveGameRemoval({
      game: {
        id: "celeste",
        title: "Celeste",
        executablePath: "D:\\Games\\Celeste\\Celeste.exe"
      },
      deleteInstallFolder: true
    });

    assert.equal(result.installRootToDelete, "D:\\Games\\Celeste");
  });
});
