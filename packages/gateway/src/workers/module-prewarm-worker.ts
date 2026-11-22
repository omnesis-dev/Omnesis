// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Loads the static import graph of one module without evaluating any of it, so
// that the TypeScript loader's transform cache holds every module of the graph
// before the gateway's main thread imports it (`startup/module-prewarm.ts`).
//
// The worker imports a one-line module that asks the root for an export no
// module has: Node resolves, reads and transforms every module of the graph,
// through the loader hooks this thread inherited from the gateway, and then
// fails to link it, so no module code runs. The thread then exits once the
// loader's pending cache writes have finished.
//
// This entry imports only Node built-ins, so every module of the graph is
// loaded here for the first time.

import { parentPort, workerData } from "node:worker_threads";

/** An export name no module declares, so linking the probe always fails. */
const PROBE_EXPORT = "omnesis module prewarm probe";

const root = (workerData as { prewarmRoot: string }).prewarmRoot;
const probe = `import { ${JSON.stringify(PROBE_EXPORT)} as probe } from ${JSON.stringify(root)};`;
try {
  await import(`data:text/javascript,${encodeURIComponent(probe)}`);
  parentPort?.postMessage({ type: "error", message: "the prewarm probe linked unexpectedly" });
} catch (error) {
  if (error instanceof SyntaxError && error.message.includes(PROBE_EXPORT)) {
    parentPort?.postMessage({ type: "loaded" });
  } else {
    parentPort?.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
