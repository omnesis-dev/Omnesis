// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);

/** Discover suite configs in workspace packages, including nested provider groups. */
export function suiteTypecheckConfigs(root = ROOT) {
  const configs = [];
  const visit = (directory) => {
    if (existsSync(join(directory, "package.json"))) {
      const config = join(directory, "tsconfig.tests.json");
      if (existsSync(config)) configs.push(relative(root, config).split(sep).join("/"));
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name))
        visit(join(directory, entry.name));
    }
  };
  visit(join(root, "packages"));
  if (existsSync(join(root, "extension", "tsconfig.tests.json")))
    configs.push("extension/tsconfig.tests.json");
  return configs.sort();
}

/** Build production declarations, then fail on the first failing suite config. */
export function runSuiteTypechecks({ root = ROOT, compilerPath, run = spawnSync } = {}) {
  const compiler =
    compilerPath ??
    createRequire(pathToFileURL(join(root, "package.json"))).resolve("typescript/bin/tsc");
  const commands = [["--build"], ...suiteTypecheckConfigs(root).map((config) => ["-p", config])];
  for (const args of commands) {
    const result = run(process.execPath, [compiler, ...args], { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.signal) return 128 + (constants.signals[result.signal] ?? 0);
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = runSuiteTypechecks();
