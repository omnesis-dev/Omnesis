// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installParentShutdownHandler } from "../../packages/core/src/parent-shutdown.ts";
import { completeNodeHeaders, hasCleanupFailure, npmJavaScriptEntry } from "./npm-ci.mjs";
import { prepareWindowsNodeBuild, runWindowsBuildNode } from "./windows-native-build.mjs";

if (process.platform !== "win32" || process.arch !== "arm64")
  throw new Error("This diagnostic requires native Windows ARM64 Node");

const controller = new AbortController();
const stop = () => controller.abort(new Error("Dependency lifecycle diagnostic stopped"));
const removeParentShutdown = installParentShutdownHandler(stop);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, stop);
process.once("disconnect", stop);
const buildScratch = await mkdtemp(join(tmpdir(), "omnesis-arm64-lifecycle-"));
let cleanupConfirmed = true;
try {
  const npmCli = await npmJavaScriptEntry();
  const { options } = await prepareWindowsNodeBuild({
    scratch: buildScratch,
    cwd: process.cwd(),
    env: process.env,
    arch: process.arch,
    version: process.versions.node,
    nodePath: process.execPath,
    signal: controller.signal,
    run: runWindowsBuildNode,
    npmEntry: npmJavaScriptEntry,
    headersComplete: completeNodeHeaders,
    gypEntry: (entry) => createRequire(pathToFileURL(entry)).resolve("node-gyp/bin/node-gyp.js"),
  });
  // All dependency and root lifecycle scripts run after the pinned patches
  // have been applied. Foreground mode serializes package lifecycle scripts.
  const code = await runWindowsBuildNode(
    [npmCli, "rebuild", "--foreground-scripts", "--no-audit", "--no-fund"],
    {
      ...options,
      env: {
        ...options.env,
        npm_package_config_node_gyp_jobs: "2",
        CMAKE_BUILD_PARALLEL_LEVEL: "2",
      },
      timeoutMs: 45 * 60_000,
    },
  );
  if (code !== 0) throw new Error(`Windows ARM64 dependency lifecycle failed with status ${code}`);
} catch (error) {
  if (hasCleanupFailure(error)) cleanupConfirmed = false;
  throw error;
} finally {
  removeParentShutdown();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, stop);
  process.removeListener("disconnect", stop);
  if (cleanupConfirmed) await rm(buildScratch, { recursive: true, force: true });
}
