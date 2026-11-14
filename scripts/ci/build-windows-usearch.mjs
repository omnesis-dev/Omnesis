// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Explicit source/CI preparation; this does not run from the install lifecycle.
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installParentShutdownHandler } from "../../packages/core/src/parent-shutdown.ts";
import { bootstrapWindowsPlatform } from "../lib/bootstrap-platform.mjs";
import { resolveUsearch } from "../native-vector-compat.mjs";
import { completeNodeHeaders, npmJavaScriptEntry } from "./npm-ci.mjs";

async function runNode(args, options) {
  const { runWindowsJob } = await bootstrapWindowsPlatform();
  const result = await runWindowsJob(process.execPath, args, {
    ...options,
    stdout: "inherit",
    onStderr: (bytes) => process.stderr.write(bytes),
  });
  if (result.failure) throw new Error(`Windows vector build subprocess ${result.failure}`);
  return result.exitCode ?? 1;
}

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
  const npmCli = await npmEntry(env, nodePath, cwd);
  const nodeGyp = gypEntry(npmCli);
  const scratch = await mkdtemp(join(tmpdir(), "omnesis-windows-vector-"));
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (
      /^npm_(?:package_config_node_gyp|config)_(?:arch|target|target_arch|nodedir|devdir)$/iu.test(
        key,
      )
    )
      delete childEnv[key];
  }
  try {
    signal?.throwIfAborted();
    const devdir = join(scratch, "headers");
    const headers = join(devdir, version);
    const options = { cwd, env: childEnv, signal, timeoutMs: 180_000 };
    if (
      (await run(
        [nodeGyp, "install", version, `--devdir=${devdir}`, `--arch=${arch}`, "--ensure"],
        options,
      )) !== 0 ||
      !(await headersComplete(headers, version, platform, arch))
    )
      throw new Error(
        "Could not prepare complete headers for the running Node version and architecture",
      );
    for (const configuration of ["Release", "Debug"]) {
      await mkdir(join(headers, configuration), { recursive: true });
      await copyFile(join(headers, arch, "node.lib"), join(headers, configuration, "node.lib"));
    }
    childEnv.npm_package_config_node_gyp_arch = arch;
    childEnv.npm_package_config_node_gyp_target = version;
    childEnv.npm_package_config_node_gyp_nodedir = headers;
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
      throw new Error("Could not compile the Windows 64-bit mapping proof");
    const probe = fileURLToPath(new URL("./probe-windows-usearch.mjs", import.meta.url));
    const executable = join(mappingProof, "build/Release/usearch-mapping-proof.exe");
    if ((await run([probe, entry, root, executable], { ...options, timeoutMs: 60_000 })) !== 0)
      throw new Error("Rebuilt Windows USearch binding failed its native publication proof");
    return { root, entry };
  } finally {
    await rm(scratch, { recursive: true, force: true });
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
