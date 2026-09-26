// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { bundleTestArgs } from "./bundles.mjs";
import { buildPlan, workspaceProjects } from "./checks.mjs";
import {
  E2E_SHARDS,
  EMBEDDER_E2E,
  LANES,
  e2eMatrix,
  fullScope,
  planScope,
  pullRequestScope,
  staticTargets,
} from "./ci-scope.mjs";

const projectCount = workspaceProjects().length;

/** The scope of a pull request changing `files`, planned against this checkout. */
function scopeOf(files) {
  const plan = buildPlan({ base: "HEAD", files });
  return pullRequestScope(files, plan, (name) => bundleTestArgs(name), projectCount);
}

const lanesOf = (scope) => LANES.filter((lane) => scope[lane] === "true").sort();
const shardFiles = (scope) =>
  JSON.parse(scope.e2e_matrix).flatMap((shard) => shard.files.split(" "));

describe("CI lane scope", { timeout: 30_000 }, () => {
  test("a push to main and a manual run execute every lane", async () => {
    for (const event of ["push", "workflow_dispatch"]) {
      const scope = await planScope(event);
      expect(scope.scope).toBe("full");
      expect(lanesOf(scope)).toEqual([...LANES].sort());
      expect(JSON.parse(scope.e2e_matrix)).toEqual(
        Array.from({ length: E2E_SHARDS }, (_, index) => ({
          shard: index + 1,
          total: E2E_SHARDS,
          files: "",
        })),
      );
    }
  });

  test("a docs-only pull request runs the floor: no E2E, no native, install or Docker lane", () => {
    const scope = scopeOf(["docs/conventions.md", "website/docs/search.html"]);
    expect(scope.scope).toBe("affected");
    // The workspace owns the root docs, so its script suites are the only unit work.
    expect(scope.projects).toBe("omnesis-workspace");
    expect(lanesOf(scope)).toEqual(["unit"]);
    expect(scope.e2e_matrix).toBe("[]");
    expect(JSON.parse(scope.changed_files)).toEqual([
      "docs/conventions.md",
      "website/docs/search.html",
    ]);
  });

  test("a portal-only pull request runs the portal unit, E2E and Playwright lanes", () => {
    const scope = scopeOf(["packages/gateway/portal/js/app.js"]);
    expect(scope.scope).toBe("affected");
    expect(scope.projects).toBe("omnesis-portal");
    expect(lanesOf(scope)).toEqual(["knip", "portal", "security_static", "unit"]);
    expect(shardFiles(scope)).toEqual(["packages/collector/src/e2e/portal.e2e.test.ts"]);
  });

  test("a gateway change runs its dependents and the bundles its paths declare", () => {
    const scope = scopeOf(["packages/gateway/src/search/hybrid.ts"]);
    expect(scope.projects.split(",")).toEqual(
      expect.arrayContaining(["@omnesis/gateway", "@omnesis/collector"]),
    );
    expect(lanesOf(scope)).toEqual(["embedder", "knip", "portal", "security_static", "unit"]);
    const files = shardFiles(scope);
    expect(files).toContain("packages/collector/src/e2e/golden-corpus.e2e.test.ts");
    expect(files).toContain("packages/collector/src/e2e/cli.e2e.test.ts");
    // The embedder suites run on their own job, never in a shard.
    for (const suite of EMBEDDER_E2E) expect(files).not.toContain(suite);
    expect(files).not.toContain("packages/collector/src/e2e/brain-bench-smoke.e2e.test.ts");
    expect(JSON.parse(scope.e2e_matrix).length).toBeLessThan(E2E_SHARDS);
  });

  test("a change most projects depend on widens unit and typecheck to the whole repository", () => {
    const scope = scopeOf(["packages/types/src/privacy.ts"]);
    expect(scope.scope).toBe("affected");
    expect(scope.projects).toBe("all");
    expect(scope.unit).toBe("true");
  });

  test.each([
    ["the lockfile", "package-lock.json"],
    ["a package manifest", "packages/gateway/package.json"],
    ["a workflow", ".github/workflows/ci.yml"],
    ["a root toolchain config", "tsconfig.base.json"],
    ["the core package", "packages/core/src/index.ts"],
    ["the planner", "scripts/nx/bundles.mjs"],
    ["the check runner", "scripts/run-e2e.mjs"],
    ["an unsupported path", "unknown-root-file.txt"],
  ])("%s runs everything", (_label, file) => {
    const scope = scopeOf(["docs/conventions.md", file]);
    expect(scope.scope).toBe("full");
    expect(lanesOf(scope)).toEqual([...LANES].sort());
    expect(scope.projects).toBe("");
  });

  test("a planner failure runs everything", () => {
    const failed = fullScope("the affected plan could not be computed: boom");
    expect(lanesOf(failed)).toEqual([...LANES].sort());
  });

  test.each([
    ["ios/Sources/Omnesis/App.swift", ["apple"]],
    ["android/app/src/main/java/dev/omnesis/Ui.kt", ["android", "android_render"]],
    [
      "scripts/install.sh",
      [
        "docker_image",
        "docker_security",
        "docker_smoke",
        "install_smoke",
        "node_macos",
        "topology",
      ],
    ],
    ["scripts/docker-topology/run.sh", ["topology"]],
    ["scripts/docker-e2e/run.sh", ["docker_security"]],
    ["integrations/openclaw-omnesis-plugin/index.ts", ["harness"]],
  ])("%s selects the lanes that cover it", (file, lanes) => {
    const scope = scopeOf([file]);
    expect(scope.scope).toBe("affected");
    const native = [
      "apple",
      "android",
      "android_render",
      "node_macos",
      "docker_image",
      "docker_smoke",
      "install_smoke",
      "topology",
      "docker_security",
      "harness",
    ];
    expect(lanesOf(scope).filter((lane) => native.includes(lane))).toEqual(lanes);
  });

  test("splits selected E2E files round-robin into as few shards as keep each short", () => {
    const files = Array.from({ length: 45 }, (_, i) => `f${String(i).padStart(2, "0")}`);
    const shards = e2eMatrix(files);
    expect(shards.map((shard) => shard.total)).toEqual([3, 3, 3]);
    expect(shards.flatMap((shard) => shard.files.split(" ")).sort()).toEqual(files);
    expect(e2eMatrix([])).toEqual([]);
    const many = Array.from({ length: 500 }, (_, i) => `f${i}`);
    expect(e2eMatrix(many)).toHaveLength(E2E_SHARDS);
  });

  test("formats every present changed file and lints only source files", () => {
    expect(
      staticTargets(["scripts/nx/ci-scope.mjs", "docs/conventions.md", "packages/gone.ts"]),
    ).toEqual({
      format: ["scripts/nx/ci-scope.mjs", "docs/conventions.md"],
      lint: ["scripts/nx/ci-scope.mjs"],
    });
  });
});
