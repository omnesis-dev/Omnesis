// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Explicit source/CI preparation, outside the installer lifecycle. Retain the
// locked dependency sources and encryption format for Windows recovery.
import { copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installParentShutdownHandler } from "../../packages/core/src/parent-shutdown.ts";
import { completeNodeHeaders, hasCleanupFailure, npmJavaScriptEntry } from "./npm-ci.mjs";
import { prepareWindowsNodeBuild, runWindowsBuildNode } from "./windows-native-build.mjs";

const PACKAGES = [
  ["better-sqlite3", "13.1.1"],
  ["better-sqlite3-multiple-ciphers", "13.0.3"],
];

export async function resolveSqlitePackages(cwd) {
  const checkout = await realpath(cwd);
  const require = createRequire(join(checkout, "packages/gateway/package.json"));
  return Promise.all(
    PACKAGES.map(async ([name, version]) => {
      const root = await realpath(dirname(require.resolve(`${name}/package.json`)));
      const local = relative(checkout, root);
      if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
        throw new Error(
          "Windows SQLite preparation requires dependencies inside its isolated checkout",
        );
      const meta = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      if (meta.name !== name || meta.version !== version)
        throw new Error(`Windows SQLite preparation requires ${name}@${version}`);
      return { name, root };
    }),
  );
}

async function publish(source, target) {
  const stage = `${target}.omnesis-${randomUUID()}.tmp`;
  try {
    await copyFile(source, stage);
    await rename(stage, target);
  } finally {
    await rm(stage, { force: true });
  }
}

export async function buildWindowsSqlite({
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  version = process.versions.node,
  nodePath = process.execPath,
  signal,
  run = runWindowsBuildNode,
  locate = resolveSqlitePackages,
  npmEntry = npmJavaScriptEntry,
  headersComplete = completeNodeHeaders,
  gypEntry = (npmCli) => createRequire(pathToFileURL(npmCli)).resolve("node-gyp/bin/node-gyp.js"),
} = {}) {
  if (platform !== "win32") throw new Error("Windows SQLite preparation requires Windows");
  if (!["x64", "arm64"].includes(arch)) throw new Error("Unsupported Windows SQLite architecture");
  const packages = await locate(cwd);
  const scratch = await mkdtemp(join(tmpdir(), "omnesis-windows-sqlite-"));
  const publications = [];
  let retained = false;
  try {
    const { headers, nodeGyp, options } = await prepareWindowsNodeBuild({
      scratch,
      cwd,
      env,
      arch,
      version,
      nodePath,
      signal,
      run,
      npmEntry,
      headersComplete,
      gypEntry,
    });
    for (const { name, root } of packages) {
      signal?.throwIfAborted();
      const source = await readFile(join(root, "deps/sqlite3/sqlite3.c"), "utf8");
      if (
        !source.includes("static int winZeroSharedMemory(") ||
        !source.includes("rc = winZeroSharedMemory(h);")
      )
        throw new Error(`${name} lacks the SQLite Windows shared-memory recovery fix`);
      if (
        (await run(
          [
            nodeGyp,
            "rebuild",
            "--release",
            "--force_build=1",
            `--nodedir=${headers}`,
            `--arch=${arch}`,
            "--jobs=2",
          ],
          { ...options, cwd: root, timeoutMs: 20 * 60_000 },
        )) !== 0
      )
        throw new Error(`Could not compile the patched Windows ${name} binding`);
      const built = join(root, "build/Release/better_sqlite3.node");
      const target = join(root, "prebuilds", `win32-${arch}.node`);
      await mkdir(dirname(target), { recursive: true });
      const backup = join(scratch, `${name}.previous.node`);
      let previous;
      try {
        await copyFile(target, backup);
        previous = backup;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await publish(built, target);
      publications.push({ target, previous });
      const digest = (data) => createHash("sha256").update(data).digest("hex");
      if (digest(await readFile(built)) !== digest(await readFile(target)))
        throw new Error("Installed Windows SQLite binding differs from its joined build output");
    }
    const probe = fileURLToPath(new URL("./probe-windows-sqlite.mjs", import.meta.url));
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
    if (
      (await run(["--import", loader, probe, scratch, ...packages.map(({ root }) => root)], {
        ...options,
        timeoutMs: 60_000,
      })) !== 0
    )
      throw new Error("Rebuilt Windows SQLite bindings failed their encryption/publication proof");
    return packages;
  } catch (error) {
    retained = hasCleanupFailure(error);
    if (!retained) {
      const rollbacks = await Promise.allSettled(
        publications.map(async ({ target, previous }) => {
          if (previous) await publish(previous, target);
          else await rm(target, { force: true });
        }),
      );
      const failed = rollbacks.filter((result) => result.status === "rejected");
      if (failed.length) {
        retained = true;
        throw new AggregateError(
          [error, ...failed.map((result) => result.reason)],
          "Windows SQLite preparation failed and its previous bindings could not be restored",
          { cause: error },
        );
      }
    }
    throw error;
  } finally {
    if (!retained) await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Windows SQLite preparation stopped by its owner"));
  const removeShutdown = installParentShutdownHandler(stop);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, stop);
  process.once("disconnect", stop);
  try {
    await buildWindowsSqlite({ signal: controller.signal });
    process.stdout.write("Windows SQLite bindings compiled and encryption/publication verified\n");
  } finally {
    removeShutdown();
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.off(signal, stop);
    process.off("disconnect", stop);
  }
}
