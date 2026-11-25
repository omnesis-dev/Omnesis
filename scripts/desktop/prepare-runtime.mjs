#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compileRuntimeClosure,
  localRuntimeClosure,
  stageRuntime,
} from "../runtime/stage-runtime.mjs";
import { acquireNodeArchive, extractNodeArchive, NODE_RUNTIME } from "./node-runtime.mjs";
import { inventoryBundle } from "./native-inventory.mjs";
import { copyNodeTools, copyProductionDependencies } from "./runtime-assets.mjs";
import { parseArguments } from "./arguments.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Build and install on the target Mac; never install dependencies into the source checkout. */
export async function prepareRuntime({ architecture = process.arch, output, cache, build = true }) {
  if (process.platform !== "darwin" || process.arch !== architecture)
    throw new Error("Prepare the desktop runtime on macOS with the target architecture");
  if (process.versions.node !== NODE_RUNTIME.version)
    throw new Error(`Build using pinned Node ${NODE_RUNTIME.version}`);
  const target = resolve(output);
  if (existsSync(target)) throw new Error("Runtime output must not already exist");
  mkdirSync(dirname(target), { recursive: true });
  const scratch = `${target}.preparing-${process.pid}`;
  mkdirSync(scratch);
  let ownsTarget = false;
  try {
    const archive = await acquireNodeArchive(architecture, cache);
    const distribution = await extractNodeArchive(
      archive,
      architecture,
      join(scratch, "node-distribution"),
    );
    const node = join(distribution, "bin/node");
    const npm = join(distribution, "lib/node_modules/npm/bin/npm-cli.js");
    const input = join(scratch, "input");
    mkdirSync(input);
    for (const item of ["package.json", "package-lock.json", "packages", "patches", "scripts"]) {
      cpSync(join(repo, item), join(input, item), {
        recursive: true,
        filter: (path) =>
          !path
            .split(/[\\/]/)
            .some((part) => ["node_modules", ".git", "dist", ".build"].includes(part)),
      });
    }
    const manifest = JSON.parse(readFileSync(join(input, "package.json"), "utf8"));
    delete manifest.scripts.prepare;
    delete manifest.scripts.postinstall;
    writeFileSync(join(input, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const env = {
      ...process.env,
      PATH: `${join(distribution, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    };
    execFileSync(
      node,
      [
        npm,
        "ci",
        "--omit=dev",
        "--omit=peer",
        "--workspace",
        "@omnesis/gateway",
        "--workspace",
        "@omnesis/collector",
        "--workspace",
        "omnesis",
        "--include-workspace-root=false",
      ],
      { cwd: input, env, stdio: "inherit" },
    );
    // The source checkout's pinned development tool applies production patches,
    // including removal of provider libraries' sensitive console dumps.
    execFileSync(node, [join(repo, "node_modules/patch-package/index.js"), "--error-on-fail"], {
      cwd: input,
      env,
      stdio: "inherit",
    });
    const entries = localRuntimeClosure(["omnesis"]);
    if (build) compileRuntimeClosure(entries);
    const staged = stageRuntime(target, entries);
    ownsTarget = true;
    copyProductionDependencies(join(input, "node_modules"), join(target, "node_modules"));
    for (const entry of entries) {
      const source = join(input, entry.dir, "node_modules");
      if (existsSync(source))
        copyProductionDependencies(source, join(target, entry.dir, "node_modules"));
    }
    const extensions = join(input, "packages/gateway/duckdb-extensions");
    if (existsSync(extensions))
      cpSync(extensions, join(target, "packages/gateway/duckdb-extensions"), { recursive: true });
    copyNodeTools(distribution, target);
    for (const notice of ["LICENSE", "THIRD_PARTY_NOTICES.md", "TRADEMARKS.md"])
      cpSync(join(repo, notice), join(target, notice));
    const inventory = await inventoryBundle(target, architecture);
    writeFileSync(
      join(target, "desktop-runtime.json"),
      `${JSON.stringify(
        {
          format: 1,
          architecture,
          nodeVersion: NODE_RUNTIME.version,
          ...staged,
          inventory,
        },
        null,
        2,
      )}\n`,
    );
    return target;
  } catch (error) {
    // target is exclusively created by stageRuntime during this invocation.
    if (ownsTarget) rmSync(target, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = parseArguments(process.argv.slice(2), {
    values: ["out", "cache", "arch"],
    booleans: ["no-build"],
    required: ["out", "cache"],
  });
  await prepareRuntime({
    output: args.get("out"),
    cache: args.get("cache"),
    architecture: args.get("arch") ?? process.arch,
    build: !args.has("no-build"),
  });
}
