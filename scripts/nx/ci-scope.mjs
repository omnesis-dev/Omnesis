// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Which full-validation lanes a CI run executes.
 *
 * A push to `main` and a manual run execute every lane. A pull request runs the
 * lanes its change affects: the Node lanes follow the same Nx affected plan as
 * `npm run checks:plan` (projects through the dependency graph, E2E files through
 * the declared behavioral bundles), and the native, install, Docker, harness and
 * security lanes follow path rules for what each one covers. Anything the plan
 * cannot decide narrowly — a global toolchain input, an unsupported path, a
 * change to `packages/core`, or a planner failure — runs every Linux lane. The
 * macOS lanes (`MACOS_LANES`) run on a pull request only for the paths they
 * cover: GitHub lends the repository a few macOS runners at a time, and `main`
 * runs them on every push, so a platform-only regression a pull request could
 * not see reddens `main` within the hour instead of queueing every pull
 * request behind a Mac.
 *
 * `node scripts/nx/ci-scope.mjs` writes the decision to `$GITHUB_OUTPUT`;
 * `node scripts/nx/ci-scope.mjs static` runs the pull-request floor of format
 * and lint over the changed files named in `$CHANGED_FILES`.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";

export const E2E_SHARDS = 8;
/**
 * The lanes that each take one of GitHub's few macOS runners: the macOS Node
 * lane, the Swift linters and the iOS app, the Android screenshot goldens and
 * the Mac installer scenarios. A pull request runs them by path rule only.
 */
export const MACOS_LANES = ["node_macos", "apple", "android_render", "installer_coverage"];
/** Keep a scoped shard no longer than a full-suite shard (~160 files / 8). */
const FILES_PER_SHARD = 20;
export const EMBEDDER_E2E = [
  "packages/collector/src/e2e/search-quality.e2e.test.ts",
  "packages/collector/src/e2e/embedder-swap.e2e.test.ts",
];

/** Every boolean lane switch full-validation.yml reads from the scope job. */
export const LANES = [
  "unit",
  "portal",
  "embedder",
  "node_macos",
  "knip",
  "apple",
  "android",
  "android_render",
  "docker_image",
  "docker_smoke",
  "install_smoke",
  "installer_coverage",
  "topology",
  "docker_security",
  "harness",
  "security_static",
];

const fullE2EMatrix = Array.from({ length: E2E_SHARDS }, (_, index) => ({
  shard: index + 1,
  total: E2E_SHARDS,
  files: "",
}));

export function fullScope(reason) {
  return {
    scope: "full",
    reason,
    projects: "",
    changed_files: "[]",
    e2e_matrix: JSON.stringify(fullE2EMatrix),
    ...Object.fromEntries(LANES.map((lane) => [lane, "true"])),
  };
}

/**
 * Every Linux lane of a pull request the plan cannot narrow, with the macOS
 * lanes by the path rules of `files`. Without a file list (the planner and
 * `git diff` both failed) the macOS lanes run: nothing says they are unneeded.
 */
export function pullRequestFullScope(reason, files) {
  const scope = fullScope(reason);
  if (files === null) return scope;
  const paths = pathLanes(files);
  for (const lane of MACOS_LANES) scope[lane] = String(paths[lane]);
  return scope;
}

// Inputs every lane depends on, or that decide the selection itself: the
// dependency manifests and lockfile, the root toolchain configs, the workflows,
// the core package everything imports, and the check runners and planner.
const sharedInputs =
  /^(?:package-lock\.json$|(?:.+\/)?package\.json$|nx\.json$|tsconfig[^/]*\.json$|vitest\.config\.ts$|eslint\.config\.js$|\.github\/workflows\/|packages\/core\/|scripts\/nx\/|scripts\/lib\/check-|scripts\/run-(?:check|e2e)\.mjs$|scripts\/test-env\.sh$)/;

const any = (files, pattern) => files.some((file) => pattern.test(file));

// The packaging and install surface every deployment lane exercises: the image
// build, the installer, updater and uninstaller, release staging and dependency
// patches.
const deployment =
  /^(?:Dockerfile$|\.dockerignore$|patches\/|scripts\/release\/|scripts\/install\.sh$|website\/install\.sh$|scripts\/hardened-gateway[^/]*\.sh$|packages\/cli\/src\/(?:service|update|uninstall)\/|packages\/cli\/src\/commands\/uninstall\.ts$)/;
const appleOnly =
  /^(?:ios\/|\.swiftlint|\.swiftformat|scripts\/run-ios-e2e\.sh$|scripts\/ios-|scripts\/synth-gateway\.sh$|evals\/universes\/e2e-minimal\/)/;
const nodeMacOS =
  /^(?:scripts\/install\.sh$|website\/install\.sh$|packages\/cli\/src\/(?:service|update|uninstall)\/|packages\/cli\/src\/commands\/uninstall\.ts$|packages\/providers\/apple-[^/]+\/)/;
const securitySensitive =
  /^packages\/(?:cli|gateway|collector)\/src\/.*(?:keyring|secret|encrypt|backup|restore|recovery|passphrase)/i;
const harnessPaths =
  /^(?:integrations\/|plugins\/|packages\/cli\/src\/harness-|packages\/cli\/src\/uninstall\/harness-|packages\/collector\/src\/e2e\/harness-plugin-conformance)/;
const sourceCode = /\.(?:[cm]?[jt]sx?)$/;

/** The lanes that follow path rules alone, from a pull request's changed files. */
export function pathLanes(files) {
  const deploys = any(files, deployment);
  return {
    node_macos: any(files, nodeMacOS),
    apple: any(files, appleOnly),
    android_render: any(files, /^android\//),
    docker_image: deploys || any(files, /^(?:scripts\/docker\/|compose(?:\.[^/]+)?\.yaml$)/),
    docker_smoke:
      deploys ||
      any(files, /^(?:scripts\/docker\/|compose(?:\.[^/]+)?\.yaml$)/) ||
      any(
        files,
        /^scripts\/(?:docker-(?:install-smoke\.sh|runtime-smoke\.mjs)|lib\/patched-files\.mjs)$/,
      ),
    install_smoke: deploys,
    installer_coverage:
      deploys ||
      any(files, /^scripts\/install-e2e\//) ||
      any(files, /^packages\/cli\/src\/commands\/(?:update|service)\./),
    topology: deploys || any(files, /^scripts\/docker-topology\//),
    docker_security:
      deploys || any(files, /^scripts\/docker-e2e\//) || any(files, securitySensitive),
  };
}

/** Split the selected E2E files round-robin across as few shards as keep each short. */
export function e2eMatrix(files) {
  if (files.length === 0) return [];
  const total = Math.min(E2E_SHARDS, Math.ceil(files.length / FILES_PER_SHARD));
  const groups = Array.from({ length: total }, () => []);
  [...files].sort().forEach((file, index) => groups[index % total].push(file));
  return groups.map((group, index) => ({ shard: index + 1, total, files: group.join(" ") }));
}

/**
 * The lanes a pull request runs, from its changed files, its Nx plan, the E2E
 * files of the plan's bundles (`bundleFiles(name)`) and the workspace's Nx
 * project count. When the change reaches half the projects or more, `projects`
 * is `all`: one pooled whole-repository unit run and typecheck cost less than
 * dozens of per-project ones, while the E2E selection stays narrow.
 */
export function pullRequestScope(files, plan, bundleFiles, projectCount) {
  if (plan.fallback)
    return pullRequestFullScope(
      `${plan.fallback.reason}: ${plan.fallback.paths.slice(0, 5).join(", ")}`,
      files,
    );
  const shared = files.filter((file) => sharedInputs.test(file));
  if (shared.length)
    return pullRequestFullScope(`shared input changed: ${shared.slice(0, 5).join(", ")}`, files);

  const projects = plan.affectedProjects;
  const e2eFiles = [
    ...new Set(
      plan.bundles.filter((name) => !isNativeBundle(name)).flatMap((name) => bundleFiles(name)),
    ),
  ];
  const sharded = e2eFiles.filter((file) => !EMBEDDER_E2E.includes(file));
  const lanes = {
    ...pathLanes(files),
    unit: projects.length > 0,
    portal:
      projects.includes("@omnesis/gateway") ||
      any(files, /^(?:packages\/gateway\/|e2e\/|playwright\.config\.ts$)/),
    embedder: e2eFiles.some((file) => EMBEDDER_E2E.includes(file)),
    knip: any(files, sourceCode) || files.includes("knip.json"),
    android: any(files, /^android\//) || plan.bundles.some((name) => name.startsWith("android-")),
    harness: projects.includes("@omnesis/agent-integration") || any(files, harnessPaths),
    security_static: any(files, sourceCode) || any(files, /^scripts\/security\//),
  };
  return {
    scope: "affected",
    reason: `${files.length} changed file(s); projects: ${projects.join(", ") || "none"}; bundles: ${plan.bundles.join(", ") || "none"}`,
    projects: projects.length * 2 >= projectCount ? "all" : projects.join(","),
    changed_files: JSON.stringify(files),
    e2e_matrix: JSON.stringify(e2eMatrix(sharded)),
    ...Object.fromEntries(LANES.map((lane) => [lane, String(lanes[lane])])),
  };
}

function isNativeBundle(name) {
  return /^(?:ios|android)-/.test(name);
}

/** The pull-request scope of the checked-out merge commit against its first parent. */
export async function planScope(event = process.env.EVENT) {
  if (event !== "pull_request") return fullScope(`${event || "unknown"} event runs every lane`);
  try {
    const { buildPlan, workspaceProjects } = await import("./checks.mjs");
    const { bundleTestArgs } = await import("./bundles.mjs");
    const plan = buildPlan({ base: "HEAD^1" });
    if (plan.files.length === 0) return fullScope("no changed files were found against the base");
    return pullRequestScope(
      plan.files,
      plan,
      (name) => bundleTestArgs(name),
      workspaceProjects().length,
    );
  } catch (error) {
    return pullRequestFullScope(
      `the affected plan could not be computed: ${error.message.split("\n")[0]}`,
      changedFiles(),
    );
  }
}

/** The merge commit's changed files against its first parent, or null when git cannot say. */
function changedFiles() {
  const diff = spawnSync("git", ["diff", "--name-only", "HEAD^1", "HEAD"], { encoding: "utf8" });
  if (diff.status !== 0) return null;
  return diff.stdout.split("\n").filter(Boolean);
}

/** Files the pull-request floor formats and lints: changed and still present. */
export function staticTargets(files) {
  const present = files.filter((file) => existsSync(file));
  return { format: present, lint: present.filter((file) => sourceCode.test(file)) };
}

function run(command, args, env = process.env) {
  process.stdout.write(`$ ${command} ${args.join(" ")}\n`);
  return spawnSync(command, args, { stdio: "inherit", env }).status ?? 1;
}

function runStatic() {
  const { format, lint } = staticTargets(JSON.parse(process.env.CHANGED_FILES || "[]"));
  const bin = (name) => `node_modules/.bin/${name}`;
  let code = format.length
    ? run(bin("prettier"), ["--check", "--ignore-unknown", "--", ...format])
    : 0;
  if (lint.length) {
    // Type-aware lint resolves the agent-integration build output, as `npm run lint` does.
    code ||= run(bin("tsc"), ["--build", "packages/agent-integration"]);
    code ||= run(bin("eslint"), ["--no-warn-ignored", "--", ...lint], {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=6144`.trim(),
    });
  }
  return code;
}

export function summary(scope) {
  const shards = JSON.parse(scope.e2e_matrix);
  return [
    "## Validation scope",
    "",
    `**${scope.scope}** — ${scope.reason}`,
    "",
    "| Lane | Runs |",
    "| --- | --- |",
    ...LANES.map((lane) => `| ${lane} | ${scope[lane]} |`),
    `| e2e shards | ${shards.length} |`,
    "",
  ].join("\n");
}

async function main(mode = process.argv[2]) {
  if (mode === "static") return runStatic();
  const scope = await planScope();
  const lines = Object.entries(scope).map(([key, value]) => `${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(scope));
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => (process.exitCode = code),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
