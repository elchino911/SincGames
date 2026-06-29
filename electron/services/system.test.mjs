import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { after, describe, it } from "node:test";

import { getProcessState } from "./system.mjs";

const spawned = [];

after(() => {
  for (const child of spawned) {
    if (!child.killed) {
      child.kill();
    }
  }
});

describe("getProcessState", () => {
  it("detects Windows exe names running through Linux process metadata", { skip: process.platform !== "linux" }, async () => {
    const sleepPath = "/usr/bin/sleep";
    await fs.promises.access(sleepPath, fs.constants.X_OK);

    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sincgames-process-"));
    const exePath = path.join(tempDir, "SpeciesUnknown.exe");
    await fs.promises.symlink(sleepPath, exePath);

    const child = spawn(exePath, ["20"], {
      detached: false,
      stdio: "ignore"
    });
    spawned.push(child);

    await new Promise((resolve) => setTimeout(resolve, 250));

    const state = await getProcessState("SpeciesUnknown.exe", exePath);
    assert.equal(state.running, true);
    assert.match(state.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});
