// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  allE2EBundles,
  behavioralBundles,
  bundleTestArgs,
  repositoryE2ETests,
} from "./bundles.mjs";
import { assertTreeFingerprint, treeFingerprint } from "./tree-state.mjs";
import { buildPlan } from "./checks.mjs";

const originalCwd = process.cwd();
const roots = [];
afterEach(() => {
  vi.unstubAllEnvs();
  process.chdir(originalCwd);
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omnesis-nx-tree-"));
  roots.push(root);
  process.chdir(root);
  execFileSync("git", ["init", "-q", "-b", "main"]);
  execFileSync("git", ["config", "user.email", "maya.reeves@example.com"]);
  execFileSync("git", ["config", "user.name", "fixture-author"]);
  writeFileSync("kept.ts", "one\n");
  writeFileSync("deleted.ts", "gone\n");
  writeFileSync("renamed.ts", "rename\n");
  execFileSync("git", ["add", "."]);
  execFileSync("git", ["commit", "-qm", "fixture"]);
  return root;
}

function buildFixturePlan(files) {
  return buildPlan({ base: "HEAD", files });
}

describe("Nx change selection", () => {
  test("maps representative product areas to behavioral bundles", () => {
    expect(behavioralBundles(["packages/providers/google/src/index.ts"])).toEqual([
      "ingestion-providers",
      "source-lifecycle",
    ]);
    expect(behavioralBundles(["packages/gateway/src/search/hybrid.ts"])).toContain("search-graph");
    expect(behavioralBundles(["packages/config/src/config-schema.ts"])).toContain("gateway-core");
    expect(behavioralBundles(["packages/gateway/portal/js/view.ts"])).toEqual(["portal"]);
    expect(behavioralBundles(["ios/Sources/Omnesis/App.swift"])).toEqual(["ios-logic"]);
    expect(behavioralBundles(["ios/Sources/Omnesis/UI/SettingsView.swift"])).toEqual([
      "ios-logic",
      "ios-snapshot",
    ]);
    expect(behavioralBundles(["ios/Sources/Omnesis/UI/Agent/SpeechRecognizer.swift"])).toEqual([
      "ios-logic",
      "ios-snapshot",
    ]);
    expect(behavioralBundles(["docs/brain.md", "website/docs/search.html"])).toEqual([]);
  });

  test("runs each native bridge in its native lane without unrelated backend E2E", () => {
    const bridges = {
      "scripts/ios-logic.sh": "ios-logic",
      "scripts/ios-snapshot.sh": "ios-snapshot",
      "scripts/run-ios-e2e.sh": "ios-e2e",
      "scripts/android-logic.sh": "android-logic",
      "scripts/android-render.sh": "android-render",
      "scripts/run-android-e2e.sh": "android-e2e",
    };
    for (const [file, bundle] of Object.entries(bridges)) {
      expect(behavioralBundles([file])).toEqual([bundle]);
    }
    expect(behavioralBundles(["packages/collector/src/snapshot-absence.ts"])).toContain(
      "source-lifecycle",
    );
  });

  test("planner and E2E launcher edits select only workspace script checks", () => {
    const plan = buildFixturePlan([
      "scripts/nx/checks.mjs",
      "scripts/nx/bundles.mjs",
      "scripts/run-e2e.mjs",
      "scripts/release/check-product-version.mjs",
    ]);
    expect(plan.affectedProjects).toEqual(["omnesis-workspace"]);
    expect(plan.bundles).toEqual([]);
    expect(plan.fallback).toBeNull();
    expect(plan.tasks).toEqual([
      "omnesis-workspace:nx-guards",
      "omnesis-workspace:nx-lint",
      "omnesis-workspace:nx-unit",
      "omnesis-workspace:nx-typecheck",
    ]);
  });

  test("plugin marketplace edits run the workspace plugin checks", () => {
    for (const file of [
      ".claude-plugin/marketplace.json",
      ".cursor-plugin/marketplace.json",
      ".agents/plugins/marketplace.json",
      ".github/plugin/marketplace.json",
    ]) {
      const plan = buildFixturePlan([file]);
      expect(plan.fallback).toBeNull();
      expect(plan.tasks).toContain("omnesis-workspace:nx-unit");
    }
    const withPortal = buildFixturePlan([
      "packages/gateway/portal/js/views/access/connect-dialog.js",
      ".agents/plugins/marketplace.json",
    ]);
    expect(withPortal.tasks).toContain("omnesis-workspace:nx-unit");
  });

  test("version-only native release inputs request metadata validation without device tests", () => {
    const plan = buildFixturePlan([
      "android/app/build.gradle.kts",
      "ios/project.yml",
      "ios/Info.plist",
    ]);
    expect(plan.selectionFiles).toEqual([]);
    expect(plan.bundles).toEqual([]);
    expect(plan.tasks).toEqual(["omnesis-workspace:nx-guards", "release-metadata"]);
  });

  test("narrative release files do not request behavioral bundles", () => {
    expect(
      behavioralBundles([
        ".changeset/example.md",
        "packages/agent/CHANGELOG.md",
        "packages/watch/README.md",
      ]),
    ).toEqual([]);
    process.chdir(originalCwd);
    const changeset = buildFixturePlan([".changeset/example.md"]);
    expect(changeset.fallback).toBeNull();
    expect(changeset.bundles).toEqual([]);
  });

  test("global and workspace-owned inputs retain their script validation", () => {
    process.chdir(originalCwd);
    const broad = buildFixturePlan(["nx.json"]);
    expect(broad.affectedProjects).toEqual([]);
    expect(broad.tasks).toEqual(
      expect.arrayContaining([
        "omnesis-workspace:nx-unit-all",
        "omnesis-workspace:nx-typecheck-all",
      ]),
    );
    expect(broad.tasks.some((task) => /@omnesis\/.+:nx-unit$/.test(task))).toBe(false);
    expect(buildFixturePlan(["website/index.html"]).affectedProjects).toEqual([
      "omnesis-workspace",
    ]);
    expect(buildFixturePlan(["docs/brain.md"]).bundles).toEqual([]);
    const unmapped = buildFixturePlan(["packages/new-area/src/index.ts"]);
    expect(unmapped.fallback).toMatchObject({
      reason: "unsupported paths",
      paths: ["packages/new-area/src/index.ts"],
    });
    expect(unmapped.tasks).toContain("omnesis-workspace:nx-unit-all");
  });

  test("plans repository lint once instead of once per affected project", () => {
    process.chdir(originalCwd);
    const plan = buildFixturePlan(["packages/core/src/index.ts"]);
    expect(plan.tasks.filter((task) => task.endsWith(":nx-lint"))).toEqual([
      "omnesis-workspace:nx-lint",
    ]);
  });

  test("representative Nx plans narrow leaf, portal, search and native changes", () => {
    process.chdir(originalCwd);
    const provider = buildFixturePlan(["packages/providers/google/src/index.ts"]);
    expect(provider.affectedProjects).toEqual([
      "@omnesis/collector",
      "@omnesis/provider-google",
      "@omnesis/provider-google-synth",
      "omnesis",
    ]);
    expect(provider.bundles).toEqual(["ingestion-providers", "source-lifecycle"]);

    const portal = buildFixturePlan(["packages/gateway/portal/js/app.js"]);
    expect(portal.affectedProjects).toEqual(["omnesis-portal"]);
    expect(portal.bundles).toEqual(["portal"]);

    expect(buildFixturePlan(["packages/gateway/src/search/query.ts"]).bundles).toContain(
      "search-graph",
    );
    const ios = buildFixturePlan(["ios/Sources/Omnesis/UI/SettingsView.swift"]);
    expect(ios.affectedProjects).toEqual(["omnesis-workspace"]);
    expect(ios.bundles).toEqual(["ios-logic", "ios-snapshot"]);
  });

  test("every E2E test is reachable from at least one full bundle", () => {
    process.chdir(originalCwd);
    const all = repositoryE2ETests();
    const covered = new Set(allE2EBundles.flatMap((name) => bundleTestArgs(name)));
    expect(all.filter((file) => !covered.has(file))).toEqual([]);
  });

  test("bundle discovery includes untracked tests and excludes deleted tests", () => {
    fixture();
    mkdirSync("packages/collector/src/e2e", { recursive: true });
    const deleted = "packages/collector/src/e2e/browser-deleted.e2e.test.ts";
    const added = "packages/collector/src/e2e/browser-added.e2e.test.ts";
    writeFileSync(deleted, "deleted\n");
    execFileSync("git", ["add", deleted]);
    execFileSync("git", ["commit", "-qm", "add fixture e2e"]);
    rmSync(deleted);
    writeFileSync(added, "added\n");
    expect(bundleTestArgs("browser-capture")).toContain(added);
    expect(bundleTestArgs("browser-capture")).not.toContain(deleted);
  });

  test("includes staged, unstaged, untracked, deleted and both rename paths", () => {
    fixture();
    writeFileSync("kept.ts", "two\n");
    writeFileSync("staged.ts", "staged\n");
    execFileSync("git", ["add", "staged.ts"]);
    writeFileSync("untracked.ts", "new\n");
    execFileSync("git", ["rm", "-q", "deleted.ts"]);
    renameSync("renamed.ts", "destination.ts");
    const state = treeFingerprint("main");
    expect(state.files).toEqual(
      expect.arrayContaining([
        "kept.ts",
        "staged.ts",
        "untracked.ts",
        "deleted.ts",
        "renamed.ts",
        "destination.ts",
      ]),
    );
  });

  test("rejects evidence after a queued checkout changes", () => {
    fixture();
    writeFileSync("kept.ts", "planned\n");
    const planned = treeFingerprint("main");
    writeFileSync("kept.ts", "changed while queued\n");
    expect(() => assertTreeFingerprint("main", planned.fingerprint)).toThrow(
      /changed after planning/,
    );
  });

  test("a full-run fingerprint needs only HEAD and dirty state", () => {
    fixture();
    writeFileSync("kept.ts", "full dirty input\n");
    const state = treeFingerprint("HEAD");
    expect(state.mergeBase).toMatch(/^[0-9a-f]{40}$/);
    expect(state.files).toContain("kept.ts");
  });

  test("the Nx parent forwards cancellation and exits after child cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "omnesis-nx-cancel-"));
    roots.push(root);
    const ready = join(root, "ready");
    const terminated = join(root, "terminated");
    const childScript = join(root, "child.mjs");
    const parentScript = join(root, "parent.mjs");
    writeFileSync(
      childScript,
      `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(ready)}, "ready");
process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(terminated)}, "terminated"); process.exit(0); });
setInterval(() => {}, 1000);
`,
    );
    writeFileSync(
      parentScript,
      `import { execute } from ${JSON.stringify(pathToFileURL(join(originalCwd, "scripts/nx/checks.mjs")).href)};
try { process.exitCode = await execute(process.execPath, [${JSON.stringify(childScript)}]); }
catch { process.exitCode = 1; }
`,
    );
    const parent = spawn(process.execPath, [parentScript], {
      cwd: originalCwd,
      stdio: "ignore",
    });
    for (let attempt = 0; attempt < 100 && !existsSync(ready); attempt += 1) await sleep(20);
    expect(existsSync(ready)).toBe(true);
    parent.kill("SIGTERM");
    const exit = await new Promise((resolve, reject) => {
      parent.once("error", reject);
      parent.once("exit", (code, signal) => resolve({ code, signal }));
    });
    expect(exit).toEqual({ code: 1, signal: null });
    expect(readFileSync(terminated, "utf8")).toBe("terminated");
  });

  test.each([false, true])(
    "the Android render validation bundle verifies tracked goldens (inherited plan: %s)",
    (inheritedPlan) => {
      if (inheritedPlan) {
        vi.stubEnv("OMNESIS_TREE_BASE", "HEAD");
        vi.stubEnv("OMNESIS_TREE_FINGERPRINT", "fixture-parent-fingerprint");
        vi.stubEnv("OMNESIS_TREE_HEAD", "fixture-parent-head");
        vi.stubEnv("OMNESIS_NATIVE_TREE_FINGERPRINT", "fixture-parent-native-fingerprint");
      }
      const root = mkdtempSync(join(tmpdir(), "omnesis-nx-native-"));
      roots.push(root);
      const output = join(root, "args.json");
      const dispatcher = join(root, "native-dispatcher.mjs");
      writeFileSync(
        dispatcher,
        `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(process.env.OMNESIS_ARGS_OUTPUT, JSON.stringify(process.argv.slice(2)));
`,
      );
      chmodSync(dispatcher, 0o755);

      execFileSync(process.execPath, ["scripts/nx/run-bundle.mjs", "android-render"], {
        cwd: originalCwd,
        env: {
          ...process.env,
          // This stub verifies argv independently of the enclosing managed plan.
          OMNESIS_TREE_BASE: "",
          OMNESIS_TREE_FINGERPRINT: "",
          OMNESIS_TREE_HEAD: "",
          OMNESIS_NATIVE_TREE_FINGERPRINT: "",
          OMNESIS_ARGS_OUTPUT: output,
          OMNESIS_NATIVE_DISPATCHER: dispatcher,
        },
      });

      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual([
        "run",
        "--host",
        "auto",
        "--kind",
        "android-render",
        "--checkout",
        originalCwd,
        "--",
        "--verify",
      ]);
    },
  );
});
