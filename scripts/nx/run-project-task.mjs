// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { waitForChild } from "../lib/check-process.mjs";
import { assertTreeFingerprint } from "./tree-state.mjs";

function run(command, args) {
  const child = spawn(command, args, { stdio: "inherit", env: process.env });
  return waitForChild(child);
}

export async function main([kind, projectRoot]) {
  if (!kind || !projectRoot) throw new Error("Expected task kind and project root");
  if (process.env.OMNESIS_TREE_FINGERPRINT) {
    assertTreeFingerprint(process.env.OMNESIS_TREE_BASE, process.env.OMNESIS_TREE_FINGERPRINT);
  }
  if (kind === "unit") {
    const hasTests =
      existsSync(projectRoot) &&
      [...walk(projectRoot)].some(
        (path) => /\.test\.(?:ts|mjs)$/.test(path) && !path.endsWith(".e2e.test.ts"),
      );
    if (!hasTests) {
      const allowlist = JSON.parse(readFileSync("scripts/nx/no-unit-test-projects.json", "utf8"));
      if (allowlist.includes(projectRoot)) {
        process.stdout.write(`[nx] ${projectRoot} has a reviewed no-unit-test exception.\n`);
        return 0;
      }
      throw new Error(
        `${projectRoot} has no unit tests and no reviewed exception; refusing a zero-test green task.`,
      );
    }
    return run(process.execPath, ["scripts/run-check.mjs", "unit", projectRoot]);
  }
  if (kind === "typecheck") {
    const configs = [
      join(projectRoot, "tsconfig.json"),
      join(projectRoot, "tsconfig.tests.json"),
    ].filter(existsSync);
    if (configs.length === 0) {
      process.stdout.write(`[nx] ${projectRoot} has no TypeScript config; typecheck is a no-op.\n`);
      return 0;
    }
    for (const config of configs) {
      const code = await run(process.execPath, ["scripts/run-check.mjs", "typecheck", config]);
      if (code !== 0) return code;
    }
    return 0;
  }
  throw new Error(`Unknown Nx project task: ${kind}`);
}

function* walk(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (["node_modules", "dist", ".build", "build"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => (process.exitCode = code))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
