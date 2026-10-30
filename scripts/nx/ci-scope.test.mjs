// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { bundleTestArgs } from "./bundles.mjs";
import { buildPlan, workspaceProjects } from "./checks.mjs";
import {
  E2E_SHARDS,
  EMBEDDER_E2E,
  LANES,
  MACOS_LANES,
  e2eMatrix,
  fullScope,
  planScope,
  pullRequestFullScope,
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
const linuxLanes = LANES.filter((lane) => !MACOS_LANES.includes(lane)).sort();
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

  test("a gateway wire change runs the native lanes its iOS and Android bundles select", () => {
    const file = "packages/gateway/src/http/routes/agent.ts";
    const plan = buildPlan({ base: "HEAD", files: [file] });
    expect(plan.bundles).toEqual(expect.arrayContaining(["ios-logic", "ios-e2e", "android-e2e"]));
    const scope = scopeOf([file]);
    expect(scope.apple).toBe("true");
    expect(scope.android).toBe("true");
    // With no app source changed, the linters and screenshot goldens give main's verdict.
    expect(scope.swift_lint).toBe("false");
    expect(scope.android_render).toBe("false");
  });

  test.each([
    "packages/gateway/src/search/hybrid.ts",
    "packages/gateway/portal/js/views/agent.js",
    "packages/gateway/src/http/routes/agent.test.ts",
  ])("%s selects no native bundle and leaves the native lanes off", (file) => {
    const plan = buildPlan({ base: "HEAD", files: [file] });
    expect(plan.bundles.filter((name) => /^(?:ios|android)-/.test(name))).toEqual([]);
    const scope = scopeOf([file]);
    expect(scope.apple).toBe("false");
    expect(scope.swift_lint).toBe("false");
    expect(scope.android).toBe("false");
  });

  test("the device WebSocket selects both native lanes", () => {
    const scope = scopeOf(["packages/gateway/src/ws.ts"]);
    expect(scope.apple).toBe("true");
    expect(scope.android).toBe("true");
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
  ])("%s runs every Linux lane and no macOS lane", (_label, file) => {
    const scope = scopeOf(["docs/conventions.md", file]);
    expect(scope.scope).toBe("full");
    expect(lanesOf(scope)).toEqual(linuxLanes);
    expect(scope.projects).toBe("");
    expect(JSON.parse(scope.e2e_matrix)).toHaveLength(E2E_SHARDS);
  });

  test.each([
    ["ios/Sources/Omnesis/App.swift", ["apple", "swift_lint"]],
    ["android/app/src/main/java/dev/omnesis/Ui.kt", ["android_render"]],
    ["scripts/install.sh", ["installer_coverage", "node_macos"]],
    ["packages/providers/apple-notes/src/index.ts", ["node_macos"]],
  ])("a core change beside %s still runs the macOS lanes that cover it", (file, lanes) => {
    const scope = scopeOf(["packages/core/src/index.ts", file]);
    expect(scope.scope).toBe("full");
    expect(lanesOf(scope)).toEqual([...linuxLanes, ...lanes].sort());
  });

  test("a planner failure runs every Linux lane, and the macOS lanes by path", () => {
    const failed = pullRequestFullScope("the affected plan could not be computed: boom", [
      "packages/gateway/src/index.ts",
    ]);
    expect(failed.scope).toBe("full");
    expect(lanesOf(failed)).toEqual(linuxLanes);
    const ios = pullRequestFullScope("boom", ["ios/Sources/Omnesis/App.swift"]);
    expect(lanesOf(ios)).toEqual([...linuxLanes, "apple", "swift_lint"].sort());
    // Without a file list nothing says a macOS lane is unneeded, so they run.
    expect(lanesOf(pullRequestFullScope("boom", null))).toEqual([...LANES].sort());
    expect(lanesOf(fullScope("boom"))).toEqual([...LANES].sort());
  });

  test("a core wire change runs the iOS lane its plan selects, beside every Linux lane", () => {
    const scope = scopeOf(["packages/core/src/pairing-protocol.ts"]);
    expect(scope.scope).toBe("full");
    expect(lanesOf(scope)).toEqual([...linuxLanes, "apple"].sort());
  });

  test("a plan that falls back selects every bundle, so iOS stays path-ruled", () => {
    const scope = scopeOf([".github/workflows/ci.yml", "packages/gateway/src/ws.ts"]);
    expect(scope.scope).toBe("full");
    expect(lanesOf(scope)).toEqual(linuxLanes);
  });

  test("the macOS lanes are exactly the lanes that take a macOS runner", () => {
    expect([...MACOS_LANES].sort()).toEqual(
      ["android_render", "apple", "installer_coverage", "node_macos", "swift_lint"].sort(),
    );
    for (const lane of MACOS_LANES) expect(LANES).toContain(lane);
  });

  test.each([
    ["ios/Sources/Omnesis/App.swift", ["apple", "swift_lint"]],
    ["scripts/ios-logic.sh", ["apple", "swift_lint"]],
    ["android/app/src/main/java/dev/omnesis/Ui.kt", ["android", "android_render"]],
    [
      "scripts/install.sh",
      [
        "docker_image",
        "docker_security",
        "docker_smoke",
        "install_smoke",
        "installer_coverage",
        "node_macos",
        "topology",
      ],
    ],
    [
      "packages/cli/src/commands/uninstall.ts",
      [
        "docker_image",
        "docker_security",
        "docker_smoke",
        "install_smoke",
        "installer_coverage",
        "node_macos",
        "topology",
      ],
    ],
    [
      "packages/cli/src/uninstall/harness-config.ts",
      [
        "docker_image",
        "docker_security",
        "docker_smoke",
        "harness",
        "install_smoke",
        "installer_coverage",
        "node_macos",
        "topology",
      ],
    ],
    ["scripts/docker-topology/run.sh", ["topology"]],
    ["scripts/docker-e2e/run.sh", ["docker_security"]],
    ["scripts/lib/patched-files.mjs", ["docker_smoke"]],
    ["scripts/docker/supervisor.mjs", ["docker_image", "docker_smoke"]],
    ["scripts/docker/image-smoke.sh", ["docker_image", "docker_smoke"]],
    ["integrations/openclaw-omnesis-plugin/index.ts", ["harness"]],
  ])("%s selects the lanes that cover it", (file, lanes) => {
    const scope = scopeOf([file]);
    expect(scope.scope).toBe("affected");
    const native = [
      "apple",
      "swift_lint",
      "android",
      "android_render",
      "node_macos",
      "docker_image",
      "docker_smoke",
      "install_smoke",
      "installer_coverage",
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

  test.each([
    "scripts/install.sh",
    "scripts/install-e2e/macos-variants.sh",
    "scripts/install-e2e/update-interruption.sh",
    "packages/cli/src/update/host.ts",
    "packages/cli/src/commands/update.ts",
  ])("%s requires the real installer coverage lane", (file) => {
    expect(scopeOf([file]).installer_coverage).toBe("true");
  });

  test("unrelated source and docs changes do not reserve an installer Mac", () => {
    for (const file of ["website/docs/search.html", "packages/gateway/src/search/hybrid.ts"]) {
      expect(scopeOf([file]).installer_coverage).toBe("false");
    }
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
