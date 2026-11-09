// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Helpers for spawning sibling worker threads / subprocesses whose entry
 * files live next to the calling module.
 *
 * Omnesis runs in two modes:
 *   - **Source mode** — dev checkouts run `.ts` files directly under tsx
 *     (`npm run gateway`, vitest). Worker entries are the `.ts` sources and
 *     each worker must preload a tsx ESM-resolver hook so its own `.js`
 *     import specifiers resolve back to `.ts` files.
 *   - **Compiled mode** — published packages run the `tsc`-emitted
 *     `dist/*.js`. Worker entries are the emitted `.js` siblings and no
 *     loader hook is needed (or available: tsx is a devDependency).
 *
 * Callers pass their own `import.meta.url`; the mode is derived from the
 * calling module's extension, which is `.ts` exactly when running from
 * source.
 */

import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

/** True when the calling module is running from compiled `.js` output. */
export function isCompiledModule(importMetaUrl: string): boolean {
  return /\.(?:js|mjs|cjs)$/.test(new URL(importMetaUrl).pathname);
}

export interface WorkerEntry {
  /** Resolved URL of the worker entry file (`.ts` in source mode, `.js` compiled). */
  url: URL;
  /** `execArgv` for `new Worker(...)` — the tsx preload in source mode, empty compiled. */
  execArgv: string[];
}

/**
 * Resolve a worker-thread entry point relative to the calling module.
 *
 * @param tsRelPath  Path of the worker's `.ts` source relative to the caller
 *                   (e.g. `"./workers/writer-worker.ts"`).
 * @param importMetaUrl  The caller's `import.meta.url`.
 * @param tsxRegisterRelPath  Path of the tsx-register preload module (an
 *                   `.mjs` shipped next to the worker source) relative to the
 *                   caller. Only used in source mode.
 */
export function resolveWorkerEntry(
  tsRelPath: string,
  importMetaUrl: string,
  tsxRegisterRelPath: string,
): WorkerEntry {
  assertTsPath(tsRelPath);
  if (isCompiledModule(importMetaUrl)) {
    return { url: new URL(swapTsForJs(tsRelPath), importMetaUrl), execArgv: [] };
  }
  return {
    url: new URL(tsRelPath, importMetaUrl),
    execArgv: ["--import", new URL(tsxRegisterRelPath, importMetaUrl).href],
  };
}

export interface SubprocessEntry {
  /** Executable to spawn: this process's `node`, in both modes. */
  command: string;
  /** Leading argv: the tsx loader in source mode, then the resolved entry script path. */
  args: string[];
}

/**
 * Resolve a Node subprocess entry point relative to the calling module.
 * Compiled mode spawns `process.execPath <entry.js>`. Source mode spawns
 * `process.execPath --import <tsx loader> <entry.ts>`, with the loader resolved
 * from this module: a source-mode process was itself loaded through it. `npx`
 * would look for tsx from the child's working directory and, finding none
 * outside the workspace, fetch one from the registry or fail with exit 1.
 */
export function resolveSubprocessEntry(tsRelPath: string, importMetaUrl: string): SubprocessEntry {
  assertTsPath(tsRelPath);
  if (isCompiledModule(importMetaUrl)) {
    const scriptPath = fileURLToPath(new URL(swapTsForJs(tsRelPath), importMetaUrl));
    return { command: process.execPath, args: [scriptPath] };
  }
  const scriptPath = fileURLToPath(new URL(tsRelPath, importMetaUrl));
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  return { command: process.execPath, args: ["--import", tsxLoader, scriptPath] };
}

function assertTsPath(relPath: string): void {
  if (!relPath.endsWith(".ts")) {
    throw new Error(`Worker entry must be a .ts path, got: ${relPath}`);
  }
}

function swapTsForJs(relPath: string): string {
  return `${relPath.slice(0, -3)}.js`;
}
