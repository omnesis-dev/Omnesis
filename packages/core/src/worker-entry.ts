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

import { fileURLToPath } from "node:url";

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
  /** Executable to spawn (`node` itself in compiled mode, `npx` in source mode). */
  command: string;
  /** Leading argv: loader args + the resolved entry script path. */
  args: string[];
}

/**
 * Resolve a Node subprocess entry point relative to the calling module.
 * Source mode spawns `npx tsx <entry.ts>` (tsx resolves from the workspace);
 * compiled mode spawns `process.execPath <entry.js>` directly.
 */
export function resolveSubprocessEntry(tsRelPath: string, importMetaUrl: string): SubprocessEntry {
  assertTsPath(tsRelPath);
  if (isCompiledModule(importMetaUrl)) {
    const scriptPath = fileURLToPath(new URL(swapTsForJs(tsRelPath), importMetaUrl));
    return { command: process.execPath, args: [scriptPath] };
  }
  const scriptPath = fileURLToPath(new URL(tsRelPath, importMetaUrl));
  return { command: "npx", args: ["tsx", scriptPath] };
}

function assertTsPath(relPath: string): void {
  if (!relPath.endsWith(".ts")) {
    throw new Error(`Worker entry must be a .ts path, got: ${relPath}`);
  }
}

function swapTsForJs(relPath: string): string {
  return `${relPath.slice(0, -3)}.js`;
}
