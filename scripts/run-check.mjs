// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Portable check entrypoint; shared-host admission is an optional local adapter. */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCLI } from "vitest/node";
import { waitForChild } from "./lib/check-process.mjs";
import { progressArgs, progressEnvironment } from "./lib/check-progress.mjs";
import { assertTreeFingerprint } from "./nx/tree-state.mjs";

export function schedulerCommand(env = process.env) {
  if (env.OMNESIS_TEST_SCHEDULER === "0") return null;
  if (env.OMNESIS_TEST_SCHEDULER) return [env.OMNESIS_TEST_SCHEDULER];
  const path =
    env.OMNESIS_TEST_SCHEDULER_CONFIG ?? join(homedir(), ".config/omnesis-dev/scheduler.json");
  if (!existsSync(path)) return null;
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (
    !config ||
    !Array.isArray(config.command) ||
    config.command.length === 0 ||
    config.command.some((arg) => typeof arg !== "string" || arg.length === 0)
  ) {
    throw new Error(`Invalid scheduler command array in ${path}`);
  }
  return config.command;
}

export function unitWorkers(
  env = process.env,
  cpuCount = availableParallelism(),
  available = process.availableMemory(),
) {
  if (env.OMNESIS_UNIT_WORKERS !== undefined) {
    const count = Number(env.OMNESIS_UNIT_WORKERS);
    if (!Number.isInteger(count) || count < 1 || count > 8)
      throw new Error("OMNESIS_UNIT_WORKERS must be an integer from 1 to 8");
    return count;
  }
  return Math.max(1, Math.min(4, cpuCount, Math.floor(available / (2 * 1024 ** 3))));
}

export function lintEnv(env = process.env) {
  return {
    ...env,
    NODE_OPTIONS: /--max[-_]old[-_]space[-_]size(?:=|\s)/.test(env.NODE_OPTIONS ?? "")
      ? env.NODE_OPTIONS
      : `${env.NODE_OPTIONS ?? ""} --max-old-space-size=6144`.trim(),
  };
}

export function testProcessEnv(env = process.env) {
  const child = progressEnvironment(env);
  // The runner has already verified these orchestration-only inputs and owns
  // the reservation. Let tests supply their own fixture values without
  // inheriting a real checkout fingerprint or native source identity.
  for (const name of [
    "OMNESIS_FORCE_TEST_ADMISSION",
    "OMNESIS_TREE_BASE",
    "OMNESIS_TREE_HEAD",
    "OMNESIS_TREE_FINGERPRINT",
    "OMNESIS_NATIVE_TREE_FINGERPRINT",
  ]) {
    delete child[name];
  }
  return child;
}

function run(command, args, env) {
  return waitForChild(
    spawn(command, args, { stdio: "inherit", env, detached: process.platform !== "win32" }),
  );
}

export function focusedUnit(args) {
  const { filter, options } = parseCLI(["vitest", "run", ...args]);
  if (
    options.config ||
    options.root ||
    options.workspace ||
    options.project ||
    options.changed ||
    options.related
  )
    return false;
  return (
    filter.length > 0 &&
    filter.every((path) => {
      const normalized = path.replace(/\/$/, "");
      return (
        normalized === "extension" ||
        normalized.startsWith("extension/") ||
        /^(packages\/[^/]+(?:\/[^/]+)?|scripts\/[^/]+|plugins\/[^/]+)(?:\/|$)/.test(normalized) ||
        /\.test\.(ts|mjs)$/.test(normalized)
      );
    })
  );
}

export async function main(argv = process.argv.slice(2)) {
  const [kind, ...args] = argv;
  const adapter = schedulerCommand();
  if (kind === "status" || kind === "cancel") {
    if (!adapter) {
      if (kind === "cancel")
        throw new Error(
          "No shared-host scheduler is configured; cancel the check through its owning terminal.",
        );
      process.stderr.write(
        "No shared-host scheduler configured. E2E lane status: npm run test:e2e -- --who\n",
      );
      return 0;
    }
    return run(adapter[0], [...adapter.slice(1), kind, ...args], process.env);
  }
  const supported = [
    "unit-all",
    "unit",
    "smoke",
    "e2e",
    "lint",
    "typecheck",
    "portal",
    "types-tests",
    "deadcode",
  ];
  if (!supported.includes(kind))
    throw new Error(`Expected check kind: ${supported.join(", ")}, status, cancel`);
  if (process.env.OMNESIS_TEST_SCHEDULER_ACTIVE && process.env.OMNESIS_TREE_FINGERPRINT) {
    assertTreeFingerprint(process.env.OMNESIS_TREE_BASE, process.env.OMNESIS_TREE_FINGERPRINT);
  }
  if (kind === "unit-all" && args.length)
    throw new Error(
      "Use test:unit:vitest -- <path> for scoped tests; test:unit takes no arguments.",
    );
  const focused = kind === "unit" && focusedUnit(args);
  const forceAdmission = process.env.OMNESIS_FORCE_TEST_ADMISSION === "1";
  const inspection =
    kind === "e2e" && args.some((arg) => ["--who", "--help", "--version"].includes(arg));
  if (
    adapter &&
    !process.env.OMNESIS_TEST_SCHEDULER_ACTIVE &&
    (!focused || forceAdmission) &&
    !inspection
  ) {
    const admissionKind =
      kind.startsWith("unit") || kind === "smoke"
        ? "unit"
        : kind === "portal"
          ? "e2e"
          : kind === "types-tests"
            ? "typecheck"
            : kind === "deadcode"
              ? "other"
              : kind;
    return run(
      adapter[0],
      [
        ...adapter.slice(1),
        "run",
        "--kind",
        admissionKind,
        "--",
        process.execPath,
        fileURLToPath(import.meta.url),
        kind,
        ...args,
      ],
      { ...process.env, OMNESIS_TEST_SCHEDULER_ACTIVE: "1" },
    );
  }
  const started = Date.now();
  const report = (state) =>
    process.stderr.write(
      `[check] ${kind} ${state} (${Math.round((Date.now() - started) / 1000)}s)\n`,
    );
  if (!inspection) report("running");
  const heartbeat = inspection ? null : setInterval(() => report("running"), 30_000);
  const nodeModule = (name) => join(process.cwd(), "node_modules", name);
  const env = ["unit", "smoke"].includes(kind) ? testProcessEnv(process.env) : { ...process.env };
  try {
    let code;
    if (kind === "unit-all") {
      // Release staging suites exercise compiled workspace artifacts. Run their
      // cheap validation first so stale dist output fails before the broad suite.
      code = await run(process.execPath, [nodeModule("typescript/bin/tsc"), "--build"], env);
      if (code === 0)
        code = await run(
          process.execPath,
          [
            nodeModule("vitest/vitest.mjs"),
            "run",
            "--maxWorkers=1",
            "scripts/release/stage-packages.test.mjs",
            "scripts/release/stage-runtime.test.mjs",
          ],
          env,
        );
      if (code === 0) code = await run("npm", ["run", "test:unit:raw"], env);
    } else if (kind === "unit" || kind === "smoke") {
      const workers = focused ? Math.min(2, unitWorkers()) : unitWorkers();
      const { filter, options } = parseCLI(["vitest", "run", ...args]);
      const requested = options.maxWorkers;
      if (
        requested !== undefined &&
        (!Number.isInteger(Number(requested)) ||
          Number(requested) < 1 ||
          Number(requested) > workers)
      ) {
        throw new Error(`Unit --maxWorkers must be between 1 and ${workers} for this invocation`);
      }
      // The scripts project includes release staging tests against workspace
      // dist output. Build inside the admitted job, before Vitest can start.
      code = 0;
      if (kind === "unit" && filter.some((path) => resolve(path) === resolve("scripts"))) {
        code = await run(process.execPath, [nodeModule("typescript/bin/tsc"), "--build"], env);
      }
      const selection =
        kind === "smoke"
          ? ["scripts/dev-scripts-smoke.test.mjs"]
          : ["--exclude", "**/*.e2e.test.ts", "--exclude", "scripts/dev-scripts-smoke.test.mjs"];
      if (code === 0)
        code = await run(
          process.execPath,
          [
            nodeModule("vitest/vitest.mjs"),
            "run",
            ...progressArgs([
              ...(requested === undefined ? [`--maxWorkers=${workers}`] : []),
              ...selection,
              ...args,
            ]),
          ],
          { ...env, OMNESIS_LOG_LEVEL: env.OMNESIS_LOG_LEVEL ?? "warn" },
        );
    } else if (kind === "types-tests") code = await run("npm", ["run", "typecheck:tests:raw"], env);
    else if (kind === "deadcode")
      code = await run(process.execPath, [nodeModule("knip/bin/knip.js"), ...args], env);
    else if (kind === "e2e")
      code = await run(process.execPath, [join(import.meta.dirname, "run-e2e.mjs"), ...args], env);
    else if (kind === "typecheck")
      code = await run(
        process.execPath,
        [nodeModule("typescript/bin/tsc"), "--build", ...args],
        env,
      );
    else if (kind === "portal")
      code = await run(
        process.execPath,
        [nodeModule("@playwright/test/cli.js"), "test", ...args],
        env,
      );
    else {
      code = await run(
        process.execPath,
        [nodeModule("typescript/bin/tsc"), "--build", "packages/agent-integration"],
        env,
      );
      if (code === 0)
        code = await run(
          process.execPath,
          [nodeModule("eslint/bin/eslint.js"), ".", ...args],
          lintEnv(env),
        );
    }
    if (!inspection) report(code === 0 ? "passed" : `failed: exit ${code}`);
    return code;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
