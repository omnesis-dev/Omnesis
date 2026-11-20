// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Explicit source/CI preparation; this does not run from the install lifecycle.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installParentShutdownHandler } from "../../packages/core/src/parent-shutdown.ts";
import {
  runWindowsBuildNode as runNode,
  prepareWindowsNodeBuild,
} from "./windows-native-build.mjs";
export { runNode };
import { resolveUsearch } from "../native-vector-compat.mjs";
import { completeNodeHeaders, hasCleanupFailure, npmJavaScriptEntry } from "./npm-ci.mjs";

/** Compile against this Node's complete headers, then prove the resulting installed binary. */
export async function buildWindowsUsearch({
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  version = process.versions.node,
  nodePath = process.execPath,
  signal,
  run = runNode,
  locate = resolveUsearch,
  npmEntry = npmJavaScriptEntry,
  headersComplete = completeNodeHeaders,
  gypEntry = (npmCli) => createRequire(pathToFileURL(npmCli)).resolve("node-gyp/bin/node-gyp.js"),
} = {}) {
  if (platform !== "win32") throw new Error("Windows vector preparation requires Windows");
  const { root, entry } = locate(join(cwd, "packages/gateway"));
  const scratch = await mkdtemp(join(tmpdir(), "omnesis-windows-vector-"));
  let cleanupConfirmed = true;
  try {
    const { nodeGyp, headers, options } = await prepareWindowsNodeBuild({
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
    const built = await run(
      [nodeGyp, "rebuild", `--nodedir=${headers}`, `--arch=${arch}`, "--jobs=2"],
      {
        ...options,
        cwd: root,
        timeoutMs: 20 * 60_000,
      },
    );
    if (built !== 0)
      throw new Error("Could not compile the patched Windows USearch binding with MSVC");
    const mappingProof = join(scratch, "mapping-proof");
    await mkdir(mappingProof);
    await writeFile(
      join(mappingProof, "binding.gyp"),
      JSON.stringify({
        targets: [
          {
            target_name: "usearch-mapping-proof",
            type: "executable",
            sources: [
              fileURLToPath(new URL("./usearch-windows-mapping-proof.cc", import.meta.url)),
            ],
            include_dirs: [join(root, "include")],
            msvs_settings: {
              VCCLCompilerTool: {
                ExceptionHandling: 1,
                AdditionalOptions: ["/std:c++17", "/Zc:preprocessor"],
              },
            },
          },
          {
            target_name: "usearch_abort_proof",
            sources: [fileURLToPath(new URL("./usearch-windows-abort-proof.cc", import.meta.url))],
            msvs_settings: {
              VCCLCompilerTool: {
                ExceptionHandling: 1,
                AdditionalOptions: ["/std:c++17", "/Zc:preprocessor"],
              },
            },
          },
        ],
      }),
    );
    if (
      (await run([nodeGyp, "rebuild", `--nodedir=${headers}`, `--arch=${arch}`, "--jobs=2"], {
        ...options,
        cwd: mappingProof,
        timeoutMs: 180_000,
      })) !== 0
    )
      throw new Error(
        "Could not compile the Windows 64-bit mapping proof and native abort diagnostic",
      );
    const probe = fileURLToPath(new URL("./probe-windows-usearch.mjs", import.meta.url));
    const executable = join(mappingProof, "build/Release/usearch-mapping-proof.exe");
    if (
      (await run(
        [
          probe,
          entry,
          root,
          executable,
          join(mappingProof, "build/Release/usearch_abort_proof.node"),
        ],
        { ...options, timeoutMs: 60_000 },
      )) !== 0
    )
      throw new Error("Rebuilt Windows USearch binding failed its native publication proof");
    return { root, entry };
  } catch (error) {
    if (hasCleanupFailure(error)) cleanupConfirmed = false;
    throw error;
  } finally {
    if (cleanupConfirmed) await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Windows vector preparation stopped by its owner"));
  const removeShutdown = installParentShutdownHandler(stop);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, stop);
  process.once("disconnect", stop);
  try {
    const result = await buildWindowsUsearch({ signal: controller.signal });
    process.stdout.write(
      `Windows vector binding compiled and publication verified: ${dirname(result.entry)}\n`,
    );
  } finally {
    removeShutdown();
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.off(signal, stop);
    process.off("disconnect", stop);
  }
}
