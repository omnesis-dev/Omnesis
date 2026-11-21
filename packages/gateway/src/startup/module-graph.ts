// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { setImmediate as nextTurn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { createLogger, resolveWorkerEntry } from "@omnesis/core";

const log = createLogger("gateway:startup:modules");

/** Each module's resolved imports in declaration order, and each module's format. */
export interface ModuleGraph {
  requests: Array<[parent: string, children: string[]]>;
  formats: Array<[url: string, format: string]>;
}

export type ModuleGraphMessage =
  { type: "graph"; graph: ModuleGraph } | { type: "error"; message: string };

/** Formats whose imports are part of the static graph V8 evaluates. */
const GRAPH_FORMATS = new Set(["module", "module-typescript"]);
/** Formats a step may import on their own: a plain `import()` takes them without attributes. */
const STEP_FORMATS = new Set([...GRAPH_FORMATS, "commonjs", "commonjs-typescript"]);

/** Main-thread work between two event-loop turns while the runtime loads. */
const STEP_SLICE_MS = 10;

/**
 * The modules to import, one after another, so that the root's graph evaluates
 * in exactly the order one `import(root)` would evaluate it.
 *
 * V8 evaluates a graph depth first: each module after the modules it imports,
 * in the order it declares them, skipping modules already evaluated or still
 * on the walk's path. Importing modules in that finishing order evaluates each
 * one on its own, except inside an import cycle: a cycle member that finishes
 * before the module where the walk entered the cycle imports that module,
 * which is not evaluated yet. So from the first such member up to the cycle's
 * entry module, nothing is imported on its own, and importing the entry module
 * evaluates that whole stretch, in the same order. JSON modules, which a step
 * could import only with import attributes and which run no code, and
 * built-ins, which are already loaded, are left to the modules that import them.
 */
export function evaluationSteps(root: string, graph: ModuleGraph): string[] {
  const children = new Map(graph.requests);
  const formats = new Map(graph.formats);
  const imports = (url: string): string[] =>
    GRAPH_FORMATS.has(formats.get(url) ?? "") ? (children.get(url) ?? []) : [];

  // One iterative depth-first walk in V8's order records the finishing order
  // and, by Tarjan's algorithm, each cycle member's entry module.
  const entered = new Map<string, number>();
  const lowest = new Map<string, number>();
  const finished: string[] = [];
  const onPath = new Set<string>();
  const tarjan: string[] = [];
  const cycleEntry = new Map<string, string>();
  const frames: Array<{ url: string; next: number }> = [];
  const enter = (url: string): void => {
    entered.set(url, entered.size);
    lowest.set(url, entered.get(url)!);
    tarjan.push(url);
    onPath.add(url);
    frames.push({ url, next: 0 });
  };
  enter(root);
  while (frames.length > 0) {
    const frame = frames[frames.length - 1]!;
    const deps = imports(frame.url);
    if (frame.next < deps.length) {
      const dep = deps[frame.next++]!;
      if (!entered.has(dep)) enter(dep);
      else if (onPath.has(dep)) {
        lowest.set(frame.url, Math.min(lowest.get(frame.url)!, entered.get(dep)!));
      }
      continue;
    }
    frames.pop();
    const url = frame.url;
    finished.push(url);
    const parent = frames[frames.length - 1];
    if (parent) lowest.set(parent.url, Math.min(lowest.get(parent.url)!, lowest.get(url)!));
    if (lowest.get(url) !== entered.get(url)) continue;
    // `url` entered a strongly connected set: everything above it on Tarjan's stack.
    for (let member = tarjan.pop()!; ; member = tarjan.pop()!) {
      onPath.delete(member);
      if (member === url) break;
      cycleEntry.set(member, url);
    }
  }

  const steps: string[] = [];
  let pendingEntry: string | undefined;
  for (const url of finished) {
    if (pendingEntry === undefined) pendingEntry = cycleEntry.get(url);
    if (pendingEntry === undefined || pendingEntry === url) {
      pendingEntry = undefined;
      if (STEP_FORMATS.has(formats.get(url) ?? "")) steps.push(url);
    }
  }
  return steps;
}

/**
 * Starts reading `root`'s static import graph on a worker thread, without
 * evaluating any of it. Resolves to `undefined`, never rejects, when the graph
 * cannot be read or `signal` aborts, so a caller can start it early and await
 * it later.
 */
export function readModuleGraph(
  root: string,
  signal: AbortSignal,
): Promise<ModuleGraph | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (graph: ModuleGraph | undefined, failure?: string): void => {
      if (settled) return;
      settled = true;
      if (failure !== undefined) {
        log.warn(`Cannot read the module graph of ${root} (${failure}); it loads in one step`);
      }
      resolve(graph);
    };
    if (signal.aborted) return settle(undefined);
    let worker: Worker;
    try {
      const entry = resolveWorkerEntry(
        "../workers/module-graph-worker.ts",
        import.meta.url,
        "../workers/register-tsx.mjs",
      );
      worker = new Worker(entry.url, { execArgv: entry.execArgv, workerData: { root } });
    } catch (error) {
      return settle(undefined, error instanceof Error ? error.message : String(error));
    }
    const stop = (): void => {
      settle(undefined);
      void worker.terminate().catch(() => undefined);
    };
    signal.addEventListener("abort", stop, { once: true });
    worker.on("message", (message: { type?: unknown; graph?: unknown; message?: unknown }) => {
      // The worker is left to exit on its own: in source mode it is still
      // writing the TypeScript transforms it made to the cache this thread reads.
      if (message.type === "graph" && isModuleGraph(message.graph)) settle(message.graph);
      else {
        settle(
          undefined,
          message.type === "error" && typeof message.message === "string"
            ? message.message
            : "the worker sent an invalid message",
        );
        void worker.terminate().catch(() => undefined);
      }
    });
    worker.on("error", (error) => settle(undefined, error.message));
    worker.once("exit", (code) => {
      signal.removeEventListener("abort", stop);
      worker.removeAllListeners();
      settle(undefined, `the worker exited with code ${code} and no graph`);
    });
  });
}

function isModuleGraph(value: unknown): value is ModuleGraph {
  if (typeof value !== "object" || value === null) return false;
  const graph = value as Record<string, unknown>;
  const pairs = (list: unknown, valid: (second: unknown) => boolean): boolean =>
    Array.isArray(list) &&
    list.every(
      (pair) =>
        Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "string" && valid(pair[1]),
    );
  return (
    pairs(
      graph.requests,
      (children) => Array.isArray(children) && children.every((url) => typeof url === "string"),
    ) && pairs(graph.formats, (format) => typeof format === "string")
  );
}

/**
 * `import(root)`, with the event loop turning while it loads.
 *
 * One dynamic import resolves, loads, compiles and evaluates its whole graph
 * on the calling thread without yielding, which for the gateway runtime is
 * seconds of a main thread that also answers the startup listener. Importing
 * the graph in the order {@link evaluationSteps} gives evaluates the same
 * modules in the same order, a few at a time, with a turn of the event loop
 * after every {@link STEP_SLICE_MS} of work. Without a graph, the root is
 * imported in one step.
 */
export async function importInSteps<T>(
  root: string,
  graph: Promise<ModuleGraph | undefined>,
  signal: AbortSignal,
): Promise<T> {
  const read = await graph;
  let sliceStart = performance.now();
  for (const step of read ? evaluationSteps(root, read) : []) {
    signal.throwIfAborted();
    await import(step);
    if (performance.now() - sliceStart >= STEP_SLICE_MS) {
      await nextTurn();
      sliceStart = performance.now();
    }
  }
  signal.throwIfAborted();
  return (await import(root)) as T;
}
