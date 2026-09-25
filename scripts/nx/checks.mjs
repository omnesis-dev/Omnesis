// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { waitForChild } from "../lib/check-process.mjs";
import {
  allE2EBundles,
  allNativeBundles,
  behavioralBundles,
  bundles,
  bundleTestArgs,
  uncoveredE2ETests,
} from "./bundles.mjs";
import { assertTreeFingerprint, treeFingerprint } from "./tree-state.mjs";

const nx = join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "nx.cmd" : "nx",
);

function option(args, name, fallback) {
  const equals = args.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function jsonCommand(command, args) {
  return JSON.parse(
    execFileSync(command, args, {
      encoding: "utf8",
      env: { ...process.env, NX_DAEMON: "false" },
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
}

export async function execute(command, args, env = process.env) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env,
    detached: process.platform !== "win32",
  });
  return waitForChild(child);
}

function isGlobal(file) {
  return (
    (file.startsWith("scripts/nx/") && !isTargetedTooling(file)) ||
    /(?:^|\/)package\.json$/.test(file) ||
    /^(?:package-lock\.json|nx\.json|tsconfig(?:\..+)?\.json|vitest\.config\.ts|eslint\.config\.js|scripts\/(?:run-check\.mjs|test-env\.sh)|\.github\/workflows\/)/.test(
      file,
    )
  );
}

function isTargetedTooling(file) {
  return (
    /^scripts\/nx\/(?:checks|bundles|check-product-version)(?:\.test|-metadata\.test)?\.mjs$/.test(
      file,
    ) ||
    /^scripts\/run-e2e(?:\.test)?\.mjs$/.test(file) ||
    /^scripts\/release\/check-product-version(?:\.test)?\.mjs$/.test(file)
  );
}

function isKnown(file) {
  if (file.startsWith("packages/")) {
    const parts = file.split("/");
    const root = ["providers", "providers-synth"].includes(parts[1])
      ? parts.slice(0, 3).join("/")
      : parts.slice(0, 2).join("/");
    return parts.length > 2 && existsSync(join(root, "package.json"));
  }
  return (
    /^(?:extension|ios|android|scripts|e2e|evals|integrations|plugins|website|docs|bench|privacy|assets|patches|\.github|\.claude|\.claude-plugin|\.cursor-plugin|\.agents|\.changeset)\//.test(
      file,
    ) ||
    /^(?:AGENTS|CLAUDE|README|CONTRIBUTING|ARCHITECTURE|SECURITY|SUPPORT|CODE_OF_CONDUCT|CHANGELOG|CLA|LICENSE|THIRD_PARTY_NOTICES|TRADEMARKS)\.md$/.test(
      file,
    ) ||
    /^(?:package(?:-lock)?\.json|nx\.json|tsconfig.*\.json|vitest\.config\.ts|eslint\.config\.js|lefthook\.yml|playwright\.config\.ts|Dockerfile|worker\.js|wrangler\.jsonc|\.(?:gitignore|gitattributes|dockerignore|editorconfig|prettierignore|prettierrc\.json|nvmrc|swiftformat|swiftlint\.yml|swiftlint-baseline\.json))$/.test(
      file,
    )
  );
}

function parseJson(contents) {
  const value = JSON.parse(contents);
  if (!plainObject(value)) throw new Error("Expected a JSON object");
  return value;
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function baseContents(mergeBase, file) {
  return execFileSync("git", ["show", `${mergeBase}:${file}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function workspacePaths(rootManifest) {
  if (!Array.isArray(rootManifest.workspaces)) throw new Error("Missing npm workspaces");
  return rootManifest.workspaces;
}

function isWorkspaceManifest(file, workspaces) {
  if (!file.endsWith("/package.json")) return false;
  const directory = file.slice(0, -"/package.json".length);
  return workspaces.some((pattern) => {
    if (typeof pattern !== "string") return false;
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1);
      const suffix = directory.slice(prefix.length);
      return directory.startsWith(prefix) && suffix.length > 0 && !suffix.includes("/");
    }
    return pattern === directory;
  });
}

function isReleaseManifest(file, workspaces) {
  return (
    isWorkspaceManifest(file, workspaces) ||
    file === "integrations/openclaw-omnesis-plugin/package.json"
  );
}

function withoutVersion(value) {
  if (!plainObject(value) || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version))
    throw new Error("Missing or invalid package version");
  const copy = { ...value };
  delete copy.version;
  return copy;
}

function versionOnlyManifestChange(mergeBase, file) {
  const before = parseJson(baseContents(mergeBase, file));
  const after = parseJson(readFileSync(file, "utf8"));
  return isDeepStrictEqual(withoutVersion(before), withoutVersion(after));
}

const releaseJsonVersions = new Map([
  ["extension/public/manifest.json", "version"],
  ["extension/release-contract.json", "productVersion"],
  ["plugins/omnesis-claude/.claude-plugin/plugin.json", "version"],
  ["plugins/omnesis/plugin.json", "version"],
]);
const releaseYamlVersion = "packages/agent-integration/hermes/plugin.yaml";
const nativeVersionPatterns = new Map([
  [
    "android/app/build.gradle.kts",
    [/^(\s*versionName\s*=\s*")([^"]+)(".*)$/gmu, /^(\s*versionCode\s*=\s*)(\d+)(.*)$/gmu],
  ],
  [
    "ios/project.yml",
    [
      /^(\s*MARKETING_VERSION:\s*["']?)([^"'\s]+)(["']?.*)$/gmu,
      /^(\s*CURRENT_PROJECT_VERSION:\s*["']?)(\d+)(["']?.*)$/gmu,
    ],
  ],
  ...["ios/Info.plist", "ios/Info-Demo.plist"].map((file) => [
    file,
    [
      /(<key>CFBundleShortVersionString<\/key>\s*<string>)([^<]+)(<\/string>)/gu,
      /(<key>CFBundleVersion<\/key>\s*<string>)([^<]+)(<\/string>)/gu,
    ],
  ]),
]);

function versionOnlyJsonChange(mergeBase, file, field) {
  const before = parseJson(baseContents(mergeBase, file));
  const after = parseJson(readFileSync(file, "utf8"));
  if (typeof before[field] !== "string" || typeof after[field] !== "string") return false;
  delete before[field];
  delete after[field];
  return isDeepStrictEqual(before, after);
}

function versionOnlyYamlChange(mergeBase, file) {
  const withoutYamlVersion = (contents) => {
    const matches = [...contents.matchAll(/^version:[ \t]*([0-9]+\.[0-9]+\.[0-9]+)[ \t]*$/gmu)];
    if (matches.length !== 1) throw new Error("Missing or ambiguous plugin version");
    return contents.replace(/^version:[ \t]*[0-9]+\.[0-9]+\.[0-9]+[ \t]*$/mu, "version: <version>");
  };
  return (
    withoutYamlVersion(baseContents(mergeBase, file)) ===
    withoutYamlVersion(readFileSync(file, "utf8"))
  );
}

function versionOnlyNativeChange(mergeBase, file, patterns) {
  const normalize = (contents) => {
    for (const pattern of patterns) {
      if ([...contents.matchAll(pattern)].length !== 1)
        throw new Error(`Missing or ambiguous native version in ${file}`);
      contents = contents.replace(
        pattern,
        (_, prefix, _version, suffix) => `${prefix}<version>${suffix}`,
      );
    }
    return contents;
  };
  return normalize(baseContents(mergeBase, file)) === normalize(readFileSync(file, "utf8"));
}

function versionOnlyLockChange(mergeBase, workspaces) {
  const before = parseJson(baseContents(mergeBase, "package-lock.json"));
  const after = parseJson(readFileSync("package-lock.json", "utf8"));
  if (!plainObject(before.packages) || !plainObject(after.packages))
    throw new Error("Missing lockfile packages");
  for (const lock of [before, after]) {
    lock.packages = { ...lock.packages };
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!isWorkspaceManifest(`${path}/package.json`, workspaces)) continue;
      if (lock === after) {
        const manifest = parseJson(readFileSync(`${path}/package.json`, "utf8"));
        if (manifest.version !== entry.version) throw new Error("Manifest/lock version mismatch");
      }
      lock.packages[path] = withoutVersion(entry);
    }
  }
  return isDeepStrictEqual(before, after);
}

/** Keep release prose and proven version-only metadata in the fingerprint and
 * repository guards, but do not turn them into product test dependencies. */
export function selectionFiles(mergeBase, files) {
  let workspaces;
  try {
    workspaces = workspacePaths(parseJson(readFileSync("package.json", "utf8")));
  } catch {
    return [...files];
  }
  return files.filter((file) => {
    if (/^\.changeset\/[^/]+\.md$/.test(file) || /(?:^|\/)CHANGELOG\.md$/.test(file)) return false;
    try {
      if (isReleaseManifest(file, workspaces)) return !versionOnlyManifestChange(mergeBase, file);
      if (file === "package-lock.json") return !versionOnlyLockChange(mergeBase, workspaces);
      if (releaseJsonVersions.has(file))
        return !versionOnlyJsonChange(mergeBase, file, releaseJsonVersions.get(file));
      if (file === releaseYamlVersion) return !versionOnlyYamlChange(mergeBase, file);
      if (nativeVersionPatterns.has(file))
        return !versionOnlyNativeChange(mergeBase, file, nativeVersionPatterns.get(file));
    } catch {
      // A missing, malformed, renamed or otherwise ambiguous input stays broad.
    }
    return true;
  });
}

export function hasVersionMetadata(files, selectedFiles) {
  return files.some(
    (file) =>
      !selectedFiles.includes(file) &&
      (file === "package-lock.json" ||
        /(?:^|\/)package\.json$/.test(file) ||
        releaseJsonVersions.has(file) ||
        file === releaseYamlVersion ||
        nativeVersionPatterns.has(file)),
  );
}

export function buildPlan({ base = "origin/main", extraBundles = [], files: filesOverride } = {}) {
  const uncovered = uncoveredE2ETests();
  if (uncovered.length) {
    throw new Error(`E2E tests are not assigned to a bundle: ${uncovered.join(", ")}`);
  }
  const state = treeFingerprint(base);
  if (filesOverride) state.files = [...new Set(filesOverride)].sort();
  const selectedFiles = selectionFiles(state.mergeBase, state.files);
  const nxFiles = selectedFiles.filter((file) => !isTargetedTooling(file));
  let projects = [];
  if (nxFiles.length) {
    projects = jsonCommand(nx, [
      "show",
      "projects",
      "--affected",
      `--files=${nxFiles.join(",")}`,
      "--json",
    ]);
  }
  if (selectedFiles.some(isTargetedTooling)) projects.push("omnesis-workspace");
  const unsupported = selectedFiles.filter((file) => !isKnown(file));
  const broad = unsupported.length > 0 || selectedFiles.some(isGlobal);
  if (broad) projects = jsonCommand(nx, ["show", "projects", "--json"]);
  const selectedBundles = new Set(
    broad ? [...allE2EBundles, ...allNativeBundles] : behavioralBundles(selectedFiles),
  );
  for (const name of extraBundles) {
    if (!bundles[name])
      throw new Error(`Unknown bundle '${name}'. Available: ${Object.keys(bundles).join(", ")}`);
    selectedBundles.add(name);
  }
  const portalOnly =
    selectedFiles.some((file) => file.startsWith("packages/gateway/portal/")) &&
    selectedFiles.every(
      (file) =>
        file.startsWith("packages/gateway/portal/") ||
        /^(?:docs|\.claude|\.agents(?!\/plugins\/)|\.changeset)\//.test(file) ||
        /^(?:AGENTS|CLAUDE|README|CONTRIBUTING)\.md$/.test(file),
    );
  let validationProjects = broad
    ? []
    : portalOnly
      ? ["omnesis-portal"]
      : projects.filter((name) => name !== "omnesis-workspace" && name !== "omnesis-portal").sort();
  if (
    !broad &&
    !portalOnly &&
    ((projects.includes("omnesis-workspace") &&
      selectedFiles.some((file) => !/^(?:packages|extension)\//.test(file))) ||
      selectedFiles.some((file) =>
        /^(?:scripts|e2e|evals|integrations|plugins|skills|website|privacy|assets|patches|bench|\.claude-plugin|\.cursor-plugin|\.agents\/plugins|\.github\/plugin)\//.test(
          file,
        ),
      ))
  ) {
    validationProjects.push("omnesis-workspace");
  }
  validationProjects = [...new Set(validationProjects)].sort();
  const releaseMetadata =
    hasVersionMetadata(state.files, selectedFiles) ||
    state.files.includes("packages/cli/CHANGELOG.md") ||
    state.files.some((file) => /^\.changeset\/[^/]+\.md$/.test(file));
  const tasks = [
    ...(state.files.length ? ["omnesis-workspace:nx-guards"] : []),
    ...(releaseMetadata ? ["release-metadata"] : []),
    ...(selectedFiles.length
      ? [
          "omnesis-workspace:nx-lint",
          ...(broad
            ? ["omnesis-workspace:nx-unit-all", "omnesis-workspace:nx-typecheck-all"]
            : validationProjects.flatMap((name) =>
                ["nx-unit", "nx-typecheck"].map((target) => `${name}:${target}`),
              )),
        ]
      : []),
    ...[...selectedBundles].sort().map((name) => `omnesis-workspace:nx-bundle-${name}`),
  ];
  const taskReasons = Object.fromEntries(
    tasks.map((task) => {
      if (task.endsWith(":nx-guards"))
        return [task, `cheap repository guards cover ${state.files.length} changed input(s)`];
      if (task === "release-metadata")
        return [task, "release versions, changesets, and product notes must be valid"];
      const bundle = task.match(/:nx-bundle-(.+)$/)?.[1];
      if (bundle) {
        const matching = selectedFiles.filter((file) => behavioralBundles([file]).includes(bundle));
        return [
          task,
          matching.length
            ? `declared behavioral edge from ${matching.join(", ")}`
            : "explicitly requested bundle",
        ];
      }
      return [task, "Nx affected project or dependent project"];
    }),
  );
  const needsNative = [...selectedBundles].some((name) => bundles[name].kind === "native");
  return {
    version: 1,
    base,
    mergeBase: state.mergeBase,
    head: gitHead(),
    dirtyState: state.fingerprint,
    files: state.files,
    selectionFiles: selectedFiles,
    affectedProjects: validationProjects,
    bundles: [...selectedBundles].sort(),
    tasks,
    taskReasons,
    nativeSource: nativeSourceIdentity(needsNative),
    fallback: broad
      ? {
          reason: unsupported.length ? "unsupported paths" : "global validation input",
          paths: unsupported.length ? unsupported : selectedFiles.filter(isGlobal),
        }
      : null,
    prerequisites: [
      "Node 24+",
      "npm dependencies installed",
      ...(needsNative ? ["configured omnesis-native-job dispatcher"] : []),
    ],
    estimates: {
      source: "measured timings appear after execution; no ETA is guessed",
      tasks: tasks.length,
    },
  };
}

function gitHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function nativeSourceIdentity(required) {
  if (!required) return null;
  const command = process.env.OMNESIS_NATIVE_DISPATCHER || "omnesis-native-job";
  try {
    return JSON.parse(
      execFileSync(command, ["fingerprint", "--checkout", process.cwd(), "--json"], {
        encoding: "utf8",
      }),
    );
  } catch {
    return { unavailable: true, reason: `${command} does not provide source fingerprinting` };
  }
}

function printPlan(plan, jsonOnly = false) {
  mkdirSync(".nx", { recursive: true });
  writeFileSync(".nx/omnesis-plan.json", `${JSON.stringify(plan, null, 2)}\n`);
  if (jsonOnly) return process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  process.stdout.write(`Nx affected plan ${plan.dirtyState.slice(0, 12)}\n`);
  process.stdout.write(
    `Base ${plan.base} (${plan.mergeBase.slice(0, 12)}), head ${plan.head.slice(0, 12)}\n`,
  );
  process.stdout.write(`Changed inputs: ${plan.files.length ? plan.files.join(", ") : "none"}\n`);
  if (plan.fallback)
    process.stdout.write(
      `Conservative fallback: ${plan.fallback.reason} (${plan.fallback.paths.join(", ")})\n`,
    );
  process.stdout.write(
    `Projects: ${plan.affectedProjects.length ? plan.affectedProjects.join(", ") : "none"}\n`,
  );
  process.stdout.write(`Bundles: ${plan.bundles.length ? plan.bundles.join(", ") : "none"}\n`);
  process.stdout.write(
    `Tasks (${plan.tasks.length}):\n${plan.tasks
      .map((task) => `  - ${task}: ${plan.taskReasons[task]}`)
      .join("\n")}\n`,
  );
  process.stdout.write("JSON: .nx/omnesis-plan.json\n");
}

async function runPlan(plan) {
  if (plan.tasks.length === 0) return 0;
  if (
    plan.bundles.some((name) => bundles[name].kind === "native") &&
    !plan.nativeSource?.fingerprint
  ) {
    throw new Error(plan.nativeSource?.reason || "Native source fingerprinting is unavailable");
  }
  const startedAt = new Date().toISOString();
  const finish = (code) => {
    writeFileSync(
      ".nx/omnesis-result.json",
      `${JSON.stringify(
        {
          version: 1,
          dirtyState: plan.dirtyState,
          head: plan.head,
          tasks: plan.tasks,
          outcome: code === 0 ? "passed" : "failed",
          exitCode: code,
          startedAt,
          endedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    return code;
  };
  const env = {
    ...process.env,
    NX_DAEMON: "false",
    NX_TASKS_RUNNER_DYNAMIC_OUTPUT: "false",
    OMNESIS_TREE_BASE: plan.base,
    OMNESIS_TREE_HEAD: plan.head,
    OMNESIS_TREE_FINGERPRINT: plan.dirtyState,
    ...(plan.nativeSource?.fingerprint
      ? { OMNESIS_NATIVE_TREE_FINGERPRINT: plan.nativeSource.fingerprint }
      : {}),
    OMNESIS_FORCE_TEST_ADMISSION: "1",
  };
  let code;
  if (plan.tasks.includes("omnesis-workspace:nx-guards")) {
    assertTreeFingerprint(plan.base, plan.dirtyState);
    code = await execute(nx, ["run", "omnesis-workspace:nx-guards"], env);
    if (code !== 0) return finish(code);
  }
  if (plan.tasks.includes("release-metadata")) {
    assertTreeFingerprint(plan.base, plan.dirtyState);
    code = await execute(process.execPath, ["scripts/nx/check-product-version.mjs"], env);
    if (code !== 0) return finish(code);
  }
  if (plan.tasks.includes("omnesis-workspace:nx-lint")) {
    assertTreeFingerprint(plan.base, plan.dirtyState);
    code = await execute(nx, ["run", "omnesis-workspace:nx-lint"], env);
    if (code !== 0) return finish(code);
  }
  for (const target of ["nx-unit-all", "nx-typecheck-all"]) {
    if (!plan.tasks.includes(`omnesis-workspace:${target}`)) continue;
    assertTreeFingerprint(plan.base, plan.dirtyState);
    code = await execute(nx, ["run", `omnesis-workspace:${target}`], env);
    if (code !== 0) return finish(code);
  }
  if (plan.affectedProjects.length) {
    assertTreeFingerprint(plan.base, plan.dirtyState);
    code = await execute(
      nx,
      [
        "run-many",
        "--targets=nx-unit,nx-typecheck",
        `--projects=${plan.affectedProjects.join(",")}`,
        "--parallel=3",
      ],
      env,
    );
    if (code !== 0) return finish(code);
  }
  const selectedE2E = [];
  for (const name of plan.bundles) {
    assertTreeFingerprint(plan.base, plan.dirtyState);
    code = await execute(nx, ["run", `omnesis-workspace:nx-bundle-${name}`], {
      ...env,
      OMNESIS_E2E_ALREADY_SELECTED: selectedE2E.join("\n"),
    });
    if (code !== 0) return finish(code);
    if (bundles[name].kind === "e2e") selectedE2E.push(...bundleTestArgs(name));
  }
  assertTreeFingerprint(plan.base, plan.dirtyState);
  return finish(0);
}

export async function main(args = process.argv.slice(2)) {
  const [mode, ...rest] = args;
  const base = option(rest, "--base", "origin/main");
  const positional = rest.filter(
    (arg, index) => !arg.startsWith("--") && rest[index - 1] !== "--base",
  );
  if (mode === "plan") {
    printPlan(buildPlan({ base, extraBundles: positional }), rest.includes("--json"));
    return 0;
  }
  if (mode === "affected") {
    const plan = buildPlan({ base, extraBundles: positional });
    printPlan(plan);
    return runPlan(plan);
  }
  if (mode === "bundle") {
    if (!positional.length)
      throw new Error(`Provide at least one bundle: ${Object.keys(bundles).join(", ")}`);
    const plan = buildPlan({ base, extraBundles: positional });
    plan.affectedProjects = [];
    plan.bundles = positional;
    plan.tasks = positional.map((name) => `omnesis-workspace:nx-bundle-${name}`);
    printPlan(plan);
    return runPlan(plan);
  }
  if (mode === "full") {
    // Full validation selects no affected range. Bind only the exact HEAD plus
    // index/worktree/untracked state so a shallow or offline checkout needs no
    // remote merge base.
    const fullBase = "HEAD";
    const state = treeFingerprint(fullBase);
    const source = nativeSourceIdentity(true);
    if (!source?.fingerprint)
      throw new Error(source?.reason || "Native source fingerprinting is unavailable");
    return execute(nx, ["run", "omnesis-workspace:nx-full", "--skip-nx-cache"], {
      ...process.env,
      NX_DAEMON: "false",
      NX_TASKS_RUNNER_DYNAMIC_OUTPUT: "false",
      OMNESIS_TREE_BASE: fullBase,
      OMNESIS_TREE_HEAD: gitHead(),
      OMNESIS_TREE_FINGERPRINT: state.fingerprint,
      OMNESIS_NATIVE_TREE_FINGERPRINT: source.fingerprint,
      OMNESIS_FORCE_TEST_ADMISSION: "1",
    });
  }
  throw new Error("Expected checks mode: plan, affected, bundle, full");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => (process.exitCode = code))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
