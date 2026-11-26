#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import * as ts from "typescript";
import { isEntryScript } from "../lib/is-entry-script.mjs";
import { parseArguments } from "./arguments.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const owner = "omnesis-desktop-codex-backend-test-fixture";

/** Compile production code once as build input; tests neither fetch nor invent an OS authority. */
export async function codexBackendTestFiles() {
  const [policy, compatibility] = await Promise.all([
    readFile(join(root, "packages/agent/src/codex-managed-policy-version.ts"), "utf8"),
    readFile(join(root, "packages/agent/src/codex-compat.ts"), "utf8"),
  ]);
  const qualifiedRuntimeVersion =
    /MANAGED_CODEX_QUALIFIED_VERSION\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"/u.exec(policy)?.[1];
  const requestedRuntimeVersion = /testedVersion:\s*"([0-9]+\.[0-9]+\.[0-9]+)"/u.exec(
    compatibility,
  )?.[1];
  if (!qualifiedRuntimeVersion || qualifiedRuntimeVersion !== requestedRuntimeVersion)
    throw new Error("The managed SDK package needs exact-version policy qualification");
  const result = await build({
    entryPoints: [join(root, "scripts/desktop/codex-backend-test-program.mjs")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    write: false,
    metafile: true,
    logLevel: "silent",
    banner: {
      js: 'import {createRequire as __fixtureCreateRequire} from "node:module"; const require=__fixtureCreateRequire(import.meta.url);',
    },
    plugins: [
      {
        name: "single-production-launcher",
        setup(builder) {
          builder.onResolve({ filter: /node-command(?:\.[cm]?[jt]s)?$/ }, (args) => {
            if (
              args.path === "@omnesis/core/node-command" ||
              args.importer.startsWith(join(root, "packages/core/"))
            )
              return { path: "./packages/core/dist/node-command.js", external: true };
          });
        },
      },
    ],
  });
  const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports);
  if (
    imports.some(
      (item) =>
        item.external &&
        !item.path.startsWith("node:") &&
        item.path !== "./packages/core/dist/node-command.js",
    )
  )
    throw new Error("Backend test input has an unsupported external dependency");
  if (Object.keys(result.metafile.inputs).some((path) => /(?:^|\/)node-command\.ts$/u.test(path)))
    throw new Error("Backend test input duplicated the production launcher registry");
  const files = {
    "program.mjs": result.outputFiles[0].text,
    "package.json": '{"type":"module"}\n',
  };
  for (const name of ["node-command", "managed-runtime-bootstrap"]) {
    const source = await readFile(join(root, `packages/core/src/${name}.ts`), "utf8");
    const compiled = ts.transpileModule(source, {
      fileName: name + ".ts",
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    });
    if (compiled.diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error))
      throw new Error("The production launcher test input did not compile");
    files[`packages/core/dist/${name}.js`] = compiled.outputText;
  }
  const hashes = Object.fromEntries(
    Object.entries(files).map(([name, value]) => [
      name,
      createHash("sha256").update(value).digest("hex"),
    ]),
  );
  return { files, hashes, qualifiedRuntimeVersion };
}

export async function prepareCodexBackendTestFixture({ output }) {
  output = resolve(output);
  const fixture = await codexBackendTestFiles();
  try {
    const info = await lstat(output);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Backend test fixture output is unsafe");
    const marker = await lstat(join(output, "backend-fixture.json"));
    if (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1 || marker.size > 4096)
      throw new Error("Backend test fixture ownership is unsafe");
    const metadata = JSON.parse(await readFile(join(output, "backend-fixture.json"), "utf8"));
    if (metadata.format !== 1 || metadata.owner !== owner)
      throw new Error("Backend test fixture output is not owned");
    let same =
      metadata.qualifiedRuntimeVersion === fixture.qualifiedRuntimeVersion &&
      JSON.stringify(metadata.hashes) === JSON.stringify(fixture.hashes);
    for (const [name, hash] of Object.entries(fixture.hashes)) {
      const file = join(output, name),
        info = await lstat(file).catch(() => null);
      if (
        !info?.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex") !== hash
      )
        same = false;
    }
    if (same) return output;
    await rm(output, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      await lstat(output);
      throw new Error("Backend test fixture ownership is missing", { cause: error });
    } catch (missing) {
      if (missing.code !== "ENOENT") throw missing;
    }
  }
  await mkdir(dirname(output), { recursive: true });
  const stage = `${output}.stage-${randomUUID()}`;
  try {
    await mkdir(stage, { mode: 0o700 });
    for (const [name, value] of Object.entries(fixture.files)) {
      await mkdir(dirname(join(stage, name)), { recursive: true, mode: 0o700 });
      await writeFile(join(stage, name), value, { mode: 0o600 });
    }
    await writeFile(
      join(stage, "backend-fixture.json"),
      JSON.stringify({
        format: 1,
        owner,
        hashes: fixture.hashes,
        qualifiedRuntimeVersion: fixture.qualifiedRuntimeVersion,
      }),
      { mode: 0o600 },
    );
    await rename(stage, output);
    return output;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (isEntryScript(import.meta.url)) {
  try {
    const args = parseArguments(process.argv.slice(2), { values: ["out"], required: ["out"] });
    await prepareCodexBackendTestFixture({ output: args.get("out") });
  } catch {
    process.stderr.write("The production backend test fixture could not be prepared\n");
    process.exitCode = 1;
  }
}
