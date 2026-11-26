// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireNodeArchive, extractNodeArchive, NODE_RUNTIME } from "./node-runtime.mjs";
import { parseArguments } from "./arguments.mjs";
import { isEntryScript } from "../lib/is-entry-script.mjs";

/** Deliberately excludes host configuration, signing inputs, Git and installed dependencies. */
export const PACKAGE_INPUTS = [
  "packages",
  "scripts",
  "patches",
  "extension",
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "TRADEMARKS.md",
];

export function packageEnvironment({ home, distribution, temporary, developerDirectory }) {
  return {
    HOME: home,
    PATH: `${join(distribution, "bin")}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: temporary,
    LANG: "en_US.UTF-8",
    NPM_CONFIG_USERCONFIG: join(home, "npm-user.npmrc"),
    NPM_CONFIG_GLOBALCONFIG: join(home, "npm-global.npmrc"),
    ...(developerDirectory ? { DEVELOPER_DIR: developerDirectory } : {}),
  };
}

/** npm distinguishes config layers by filename, even when both layers are empty. */
export async function createPackageNpmConfigs(home) {
  await requirePrivateDirectory(home);
  const paths = {
    userConfig: join(home, "npm-user.npmrc"),
    globalConfig: join(home, "npm-global.npmrc"),
  };
  for (const path of Object.values(paths)) await writeFile(path, "", { flag: "wx", mode: 0o600 });
  return paths;
}

async function requirePrivateDirectory(path) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0 ||
    (info.mode & 0o700) !== 0o700 ||
    (await realpath(path)) !== path
  )
    throw new Error("Package directories must be private owned canonical directories");
}
async function requirePackageScratch(scratch) {
  await requirePrivateDirectory(scratch);
  if ((await readFile(join(scratch, ".omnesis-desktop-scratch"), "utf8")) !== "desktop-native-v1\n")
    throw new Error("Package qualification requires its private native scratch");
}
/** The bridge pre-creates this shared cache. Reuse never adopts a link, file or public directory. */
export async function ensureNativePackageCache(scratch) {
  scratch = resolve(scratch);
  await requirePackageScratch(scratch);
  const cache = join(scratch, "package-cache");
  try {
    await mkdir(cache, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await requirePrivateDirectory(cache);
  return cache;
}

/** Runs only inside the native pool's owned scratch and existing build reservation. */
export async function buildNativePackage(
  { scratch, architecture = process.arch },
  run = execFileSync,
) {
  if (process.platform !== "darwin") throw new Error("Package qualification requires macOS");
  scratch = resolve(scratch);
  await requirePackageScratch(scratch);
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  if (source !== join(scratch, "package-source/source"))
    throw new Error("Package source is outside its owned scratch");
  // Each attempt owns a new output: never clear another build or reuse a partial app.
  const attempt = `package-${Date.now()}-${process.pid}`;
  const output = join(scratch, attempt);
  await mkdir(output, { mode: 0o700 });
  const home = join(output, "home");
  const temporary = join(output, "tmp");
  await mkdir(home, { mode: 0o700 });
  await mkdir(temporary, { mode: 0o700 });
  await createPackageNpmConfigs(home);
  const cache = await ensureNativePackageCache(scratch);
  const archive = await acquireNodeArchive(architecture, cache);
  const distribution = join(output, "node-distribution");
  await extractNodeArchive(archive, architecture, distribution);
  const node = join(distribution, "bin/node");
  const env = packageEnvironment({
    home,
    distribution,
    temporary,
    developerDirectory: process.env.DEVELOPER_DIR,
  });
  const invoke = (command, args) => run(command, args, { cwd: source, env, stdio: "inherit" });
  // This is production compilation, never a backend test/typecheck lane moved to a Mac.
  invoke("/bin/bash", ["scripts/ci/npm-ci.sh"]);
  const runtime = join(output, "runtime");
  invoke(node, [
    "scripts/desktop/prepare-runtime.mjs",
    "--out",
    runtime,
    "--cache",
    cache,
    "--runtime-exec",
    join(scratch, "macos/build/Build/Products/Release/OmnesisRuntimeExec"),
  ]);
  invoke(node, ["scripts/desktop/smoke-runtime.mjs", "--runtime", runtime]);
  const version = JSON.parse(
    await readFile(join(source, "packages/core/package.json"), "utf8"),
  ).version;
  const app = join(output, "Omnesis.app");
  invoke(node, [
    "scripts/desktop/assemble-app.mjs",
    "--runtime",
    runtime,
    "--shell-app",
    join(scratch, "macos/build/Build/Products/Release/Omnesis.app"),
    "--out",
    app,
    "--arch",
    architecture,
    "--version",
    version,
  ]);
  invoke(node, [
    "scripts/desktop/smoke-runtime.mjs",
    "--runtime",
    join(app, "Contents/Resources/runtime"),
  ]);
  // This lane qualifies an ephemeral build. Distribution owns any archive;
  // native hosts must not accumulate completed archives on their build disk.
  const artifact = join(scratch, "evidence", attempt);
  await mkdir(artifact, { mode: 0o700 });
  await writeFile(
    join(artifact, "qualification.json"),
    JSON.stringify(
      {
        format: 1,
        scope: "unsigned-release-package",
        architecture,
        nodeVersion: NODE_RUNTIME.version,
        productVersion: version,
        runtimeSmoke: "passed",
        assembledRuntimeSmoke: "passed",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  return artifact;
}

if (isEntryScript(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2), {
    values: ["scratch"],
    required: ["scratch"],
  });
  await buildNativePackage({ scratch: args.get("scratch") });
}
