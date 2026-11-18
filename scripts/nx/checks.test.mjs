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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  allE2EBundles,
  behavioralBundles,
  bundleTestArgs,
  repositoryE2ETests,
} from "./bundles.mjs";
import { assertTreeFingerprint, treeFingerprint } from "./tree-state.mjs";
import { buildPlan, jsonCommand } from "./checks.mjs";

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
    expect(behavioralBundles(["packages/platform/src/windows-job.ts"])).toContain("gateway-core");
    expect(behavioralBundles(["packages/gateway/portal/js/view.ts"])).toEqual(["portal"]);
    expect(behavioralBundles(["ios/Sources/Omnesis/App.swift"])).toEqual(["ios-logic"]);
    expect(behavioralBundles(["ios/Sources/Omnesis/UI/SettingsView.swift"])).toEqual([
      "ios-logic",
      "ios-snapshot",
    ]);
    expect(behavioralBundles(["ios/Sources/Omnesis/UI/Agent/AgentView.swift"])).toEqual([
      "ios-logic",
      "ios-snapshot",
    ]);
    expect(behavioralBundles(["docs/brain.md", "website/docs/search.html"])).toEqual([]);
  });

  test("the subscription runtime services select the agent bundle", () => {
    for (const file of [
      "packages/gateway/src/models/codex-runtime-service.ts",
      "packages/gateway/src/models/claude-code-service.ts",
    ])
      expect(behavioralBundles([file])).toContain("agent-brain-watch");
    expect(behavioralBundles(["packages/gateway/src/models/routes.ts"])).not.toContain(
      "agent-brain-watch",
    );
  });

  test("selects the native client bundles for the gateway wire the apps decode", () => {
    const native = (file) =>
      behavioralBundles([file]).filter((name) => /^(?:ios|android)-/.test(name));
    const clients = ["android-e2e", "android-logic", "ios-e2e", "ios-logic"];
    for (const file of [
      "packages/gateway/src/http/routes/agent.ts",
      "packages/gateway/src/ws.ts",
      "packages/gateway/src/brain/tasks/http.ts",
      "packages/gateway/src/realtime/route.ts",
      "packages/gateway-client/src/gateway-ws-client.ts",
      "packages/core/src/pairing-protocol.ts",
      "packages/core/src/wire-fixtures.ts",
      "packages/core/src/agent-tool-cards.ts",
      "packages/core/src/push/message.ts",
      "packages/gateway/src/auth-flows.ts",
    ])
      expect(native(file), file).toEqual(clients);
    // Words that merely contain a wire word, the portal, and tests are not the wire.
    for (const file of [
      "packages/gateway/portal/js/views/agent.js",
      "packages/gateway/src/http/routes/agent.test.ts",
      "packages/gateway/src/brain/tasks/views.ts",
      "packages/gateway/src/search/browse.ts",
      "packages/gateway/src/brain/cognition/workflows.ts",
      "packages/gateway/src/import-flows.ts",
      "packages/gateway/src/sources/omnesis-notes/browser-note.ts",
    ])
      expect(native(file), file).toEqual([]);
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

  test.each([false, true])("fingerprints directory skill links (staged: %s)", (staged) => {
    fixture();
    mkdirSync(".agents/skills/review", { recursive: true });
    mkdirSync(".claude/skills", { recursive: true });
    writeFileSync(".agents/skills/review/SKILL.md", "Review the changes.\n");
    const link = ".claude/skills/review";
    symlinkSync("../../.agents/skills/review", link);
    if (staged) execFileSync("git", ["add", "."]);
    const planned = treeFingerprint("main");
    expect(planned.files).toContain(link);
    expect(() => assertTreeFingerprint("main", planned.fingerprint)).not.toThrow();

    writeFileSync(".agents/skills/review/SKILL.md", "Review all the changes.\n");
    expect(() => assertTreeFingerprint("main", planned.fingerprint)).toThrow(
      /changed after planning/,
    );
  });

  test("rejects retargeted dangling links before following their targets", () => {
    fixture();
    symlinkSync("missing-skill", "review");
    const planned = treeFingerprint("main");
    rmSync("review");
    symlinkSync("other-missing-skill", "review");
    expect(() => assertTreeFingerprint("main", planned.fingerprint)).toThrow(
      /changed after planning/,
    );
  });

  test("fingerprints deleted children when a directory is replaced by a file", () => {
    fixture();
    mkdirSync("old-directory");
    writeFileSync("old-directory/removed.md", "Removed content.\n");
    execFileSync("git", ["add", "."]);
    execFileSync("git", ["commit", "-qm", "directory fixture"]);
    rmSync("old-directory", { recursive: true });
    writeFileSync("old-directory", "Replacement file.\n");
    const planned = treeFingerprint("main");
    expect(planned.files).toContain("old-directory/removed.md");
    expect(() => assertTreeFingerprint("main", planned.fingerprint)).not.toThrow();
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

  // Windows does not deliver catchable POSIX SIGTERM to a Node child.
  // Owned Windows job cancellation and descendant joining have portable tests.
  test.skipIf(process.platform === "win32")(
    "the POSIX Nx parent forwards cancellation and exits after child cleanup",
    async () => {
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
    },
  );

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

describe("Nx query failures", () => {
  beforeEach(() => vi.stubEnv("FORCE_COLOR", "0"));
  /** A command that behaves as `script` says, with `runs` counting its starts. */
  function command(script) {
    const root = mkdtempSync(join(tmpdir(), "omnesis-nx-query-"));
    roots.push(root);
    const count = join(root, "runs");
    writeFileSync(count, "");
    const path = join(root, "query.mjs");
    writeFileSync(
      path,
      `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(count)}, "x");
const run = readFileSync(${JSON.stringify(count)}, "utf8").length;
${script}
`,
    );
    chmodSync(path, 0o755);
    return { path, runs: () => readFileSync(count, "utf8").length };
  }

  /** What `fn` throws, with stderr held back from the test output. */
  function failure(fn) {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      fn();
    } catch (error) {
      return error;
    }
    throw new Error("expected the query to fail");
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("a process that dies without a word gets one more try, and the log keeps how it ended", () => {
    const query = command(`
if (run === 1) process.kill(process.pid, "SIGKILL");
console.log(JSON.stringify(["alpha"]));
`);
    const warned = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(jsonCommand(query.path, ["show"])).toEqual(["alpha"]);

    expect(query.runs()).toBe(2);
    const warning = warned.mock.calls.map(([text]) => String(text)).join("");
    if (process.platform === "win32") expect(warning).toMatch(/show exited [1-9]\d*/u);
    else expect(warning).toContain(`${query.path} show was killed by SIGKILL`);
    expect(warning).toContain("Trying once more.");
  });

  test("a second silent death fails, naming how it ended on the first line", () => {
    const query = command(`process.exit(7);`);

    const error = failure(() => jsonCommand(query.path, ["show"]));

    expect(query.runs()).toBe(2);
    expect(error.message.split("\n")[0]).toBe(`${query.path} show exited 7`);
  });

  test("what a failure printed on stdout reaches the error", () => {
    const query = command(`
console.log("The current directory is not part of a workspace.");
process.exit(1);
`);

    const error = failure(() => jsonCommand(query.path, ["show"]));

    expect(error.message).toContain("stdout:\nThe current directory is not part of a workspace.");
  });

  test("a failure the command explains on stderr is not tried again", () => {
    const query = command(`
console.error("Failed to process project graph.");
process.exit(1);
`);

    const error = failure(() => jsonCommand(query.path, ["show"]));

    expect(query.runs()).toBe(1);
    expect(error.message).toContain("stderr:\nFailed to process project graph.");
  });

  test("a command that cannot start says so and is not tried again", () => {
    const missing = join(tmpdir(), "omnesis-nx-query-missing", "nx");

    const error = failure(() => jsonCommand(missing, ["show"]));

    expect(error.message).toContain(`${missing} show could not run:`);
    expect(error.message).toContain("ENOENT");
    expect(process.stderr.write).not.toHaveBeenCalledWith(
      expect.stringContaining("Trying once more."),
    );
  });

  test("output that is not JSON is not tried again", () => {
    const query = command(`console.log("not json");`);

    const error = failure(() => jsonCommand(query.path, ["show"]));

    expect(error).toBeInstanceOf(SyntaxError);
    expect(query.runs()).toBe(1);
  });
});
