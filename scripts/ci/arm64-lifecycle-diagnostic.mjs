// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
  const deadline = Date.now() + 45 * 60_000;
  const rebuild = (paths) => {
    controller.signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error("The ARM dependency lifecycle budget expired");
    return runWindowsBuildNode(
      [npmCli, "rebuild", ...paths, "--foreground-scripts", "--no-audit", "--no-fund"],
      {
        ...options,
        env: {
          ...options.env,
          npm_package_config_node_gyp_jobs: "2",
          CMAKE_BUILD_PARALLEL_LEVEL: "2",
        },
        timeoutMs: Math.max(1, deadline - Date.now()),
      },
    );
  };
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  const required = [];
  const optional = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!entry.hasInstallScript) continue;
    const absolute = resolve(path || ".");
    const inside = relative(process.cwd(), absolute);
    if (isAbsolute(inside) || inside === ".." || inside.startsWith(`..${sep}`))
      throw new Error("Dependency lifecycle path leaves its checkout");
    try {
      if (!(await stat(join(absolute, "package.json"))).isFile())
        throw new Error("Dependency lifecycle manifest is not a regular file");
    } catch (error) {
      if (entry.optional && error.code === "ENOENT") continue;
      throw error;
    }
    if (entry.optional) optional.push({ path, absolute, version: entry.version });
    else required.push(absolute);
  }
  // Directory specs select exact installed nodes. npm rebuild without specs
  // makes an optional install failure fatal, unlike npm ci. Build required
  // lifecycles together, then attempt every installed optional independently.
  const code = await rebuild(required);
  if (code !== 0) throw new Error(`Required ARM64 dependency lifecycle failed with status ${code}`);
  const outcomes = [];
  for (const entry of optional) {
    const code = await rebuild([entry.absolute]);
    outcomes.push({ path: entry.path, version: entry.version, exitCode: code });
    process.stdout.write(`ARM64 optional lifecycle: ${JSON.stringify(outcomes.at(-1))}\n`);
    // A failed optional package must be absent, as after npm ci, rather than
    // exposing a half-built engine. rebuild returned only after its Job joined.
    if (code !== 0) await rm(entry.absolute, { recursive: true, force: true });
  }
  await writeFile(
    join(process.env.RUNNER_TEMP ?? tmpdir(), "omnesis-arm64-optional-lifecycles.json"),
    JSON.stringify(outcomes, null, 2) + "\n",
  );
} catch (error) {
  if (hasCleanupFailure(error)) cleanupConfirmed = false;
  throw error;
} finally {
  removeParentShutdown();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, stop);
  process.removeListener("disconnect", stop);
  if (cleanupConfirmed) await rm(buildScratch, { recursive: true, force: true });
}
