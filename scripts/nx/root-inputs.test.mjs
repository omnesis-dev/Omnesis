// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const require = createRequire(join(process.cwd(), "package.json"));
const nxRoot = join(process.cwd(), "node_modules/nx/dist/src");
const { readNxJson } = require(join(nxRoot, "config/nx-json.js"));
const { createTaskHasher } = require(join(nxRoot, "hasher/create-task-hasher.js"));
const { createProjectGraphAsync } = require(join(nxRoot, "project-graph/project-graph.js"));
const { createTaskGraph } = require(join(nxRoot, "tasks-runner/create-task-graph.js"));

const rootTargets = ["nx-guards", "nx-lint", "nx-typecheck-all"];
const nestedInputs = [
  "packages/cli/src/commands/connect.ts",
  "packages/cli/src/commands/connect.test.ts",
  "packages/collector/src/e2e/brain-rhythm.e2e.test.ts",
  "extension/src/push/client.ts",
];

describe("root-wide Nx cache inputs", () => {
  test("hash every nested production and test input", async () => {
    process.env.NX_DAEMON = "false";
    const graph = await createProjectGraphAsync();
    const taskGraph = createTaskGraph(graph, {}, ["omnesis-workspace"], rootTargets, undefined, {});
    const hasher = createTaskHasher(graph, readNxJson());

    for (const task of Object.values(taskGraph.tasks)) {
      const result = await hasher.hashTask(task, taskGraph, process.env, process.cwd(), true);
      const files = result.inputs.files;
      expect(files, task.target.target).toEqual(expect.arrayContaining(nestedInputs));
    }
  });

  test("keeps universe validation in the affected repository guard", () => {
    const guard = readFileSync("scripts/nx/run-global-guards.mjs", "utf8");
    expect(guard).toContain('run("npm", ["run", "validate-universes"])');
  });
});
