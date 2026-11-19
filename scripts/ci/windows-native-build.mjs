// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { bootstrapWindowsPlatform } from "../lib/bootstrap-platform.mjs";

/** Every compiler/probe is a finite owned root; uncertainty cannot publish a binary. */
export async function runWindowsBuildNode(args, options) {
  const { runWindowsJob } = await bootstrapWindowsPlatform();
  const result = await runWindowsJob(process.execPath, args, {
    ...options,
    completion: "root",
    stdout: "inherit",
    onStderr: (bytes) => process.stderr.write(bytes),
  });
  if (result.failure || Object.hasOwn(result, "cleanupFailure")) {
    const error = new Error(
      `Windows native build subprocess ${result.failure ?? "cleanup unconfirmed"}`,
      {
        cause: result,
      },
    );
    if (Object.hasOwn(result, "cleanupFailure")) error.cleanupFailure = result.cleanupFailure;
    throw error;
  }
  return result.exitCode ?? 1;
}

/** The caller owns scratch until every operation using these headers positively joins. */
export async function prepareWindowsNodeBuild({
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
}) {
  signal?.throwIfAborted();
  const nodeGyp = gypEntry(await npmEntry(env, nodePath, cwd));
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (
      /^npm_(?:package_config_node_gyp|config)_(?:arch|target|target_arch|nodedir|devdir)$/iu.test(
        key,
      )
    )
      delete childEnv[key];
  }
  const devdir = join(scratch, "headers");
  const headers = join(devdir, version);
  const options = { cwd, env: childEnv, signal, timeoutMs: 180_000, completion: "root" };
  if (
    (await run(
      [nodeGyp, "install", version, `--devdir=${devdir}`, `--arch=${arch}`, "--ensure"],
      options,
    )) !== 0 ||
    !(await headersComplete(headers, version, "win32", arch))
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
  return { headers, nodeGyp, options };
}
