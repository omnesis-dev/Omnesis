// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Reads the static import graph of one module without evaluating any of it, so
// the gateway's main thread can load that graph in steps (`startup/module-graph.ts`).
//
// Node loads a dynamic import's whole graph in one synchronous step before
// evaluating it. This worker imports a one-line module that asks the root for
// an export no module can have: Node resolves and loads every module of the
// graph, through the same loader hooks the gateway uses, and then fails to
// link it, so no module code runs. The hooks record each import edge in the
// order the importing module declares it, and each module's format.
//
// This entry imports only Node built-ins: a module this worker had already
// loaded would not be resolved again, and its edges would be missing.

import { registerHooks } from "node:module";
import { parentPort, workerData } from "node:worker_threads";
import type { ModuleGraph, ModuleGraphMessage } from "../startup/module-graph.js";

/** An export name no module declares, so linking the probe always fails. */
const PROBE_EXPORT = "omnesis module graph probe";

// No code runs here, so no stack trace needs mapping; this thread's setting
// only spares it from indexing every transformed module's source map.
process.setSourceMapsEnabled(false);
const root = (workerData as { root: string }).root;
const requests = new Map<string, string[]>();
const formats = new Map<string, string>();

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const parent = context.parentURL;
    if (parent && !parent.startsWith("data:")) {
      let children = requests.get(parent);
      if (!children) requests.set(parent, (children = []));
      if (!children.includes(resolved.url)) children.push(resolved.url);
    }
    return resolved;
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (loaded.format) formats.set(url, loaded.format);
    return loaded;
  },
});

function post(message: ModuleGraphMessage): void {
  parentPort?.postMessage(message);
}

const probe = `import { ${JSON.stringify(PROBE_EXPORT)} as probe } from ${JSON.stringify(root)};`;
try {
  await import(`data:text/javascript,${encodeURIComponent(probe)}`);
  post({ type: "error", message: "The module graph probe linked unexpectedly" });
} catch (error) {
  if (error instanceof SyntaxError && error.message.includes(PROBE_EXPORT)) {
    const graph: ModuleGraph = { requests: [...requests], formats: [...formats] };
    post({ type: "graph", graph });
  } else {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}
