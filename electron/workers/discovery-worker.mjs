import { parentPort, workerData } from "node:worker_threads";
import { GameManifestService } from "../services/game-manifest.mjs";
import { GameDiscoveryService } from "../services/game-discovery.mjs";

const { env, scanRoots } = workerData;

async function main() {
  const manifestService = new GameManifestService({ env });
  const discoveryService = new GameDiscoveryService({ env, manifestService });

  const candidates = await discoveryService.scanRoots(scanRoots, {
    onProgress(progress) {
      parentPort.postMessage({
        type: "progress",
        ...progress
      });
    }
  });

  const manifestInfo = await manifestService.getManifestInfo();

  parentPort.postMessage({
    type: "completed",
    candidates,
    manifestInfo
  });
}

main().catch((error) => {
  parentPort.postMessage({
    type: "failed",
    message: error instanceof Error ? error.message : "El escaneo fallo."
  });
});
