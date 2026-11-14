// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";
import { hermesTestInvocation } from "../test-hermes.mjs";
import {
  FOCUSED_E2E_FILES,
  FOCUSED_UNIT_FILES,
  INSTALLER_TEST_EXCLUSIONS,
  windowsCheckTasks,
  runWindowsCheckTasks,
} from "./windows-checks.mjs";

const workflow = () =>
  parse(readFileSync(new URL("../../.github/workflows/windows.yml", import.meta.url), "utf8"));

describe("Windows CI coverage", () => {
  test("every PR gets bounded runtime coverage and each daily/manual sweep gets the complete lanes", () => {
    const config = workflow();
    expect(config.on.pull_request.branches).toEqual(["main"]);
    expect(config.on.schedule).toEqual([{ cron: "43 4 * * *" }]);
    expect(config.on).toHaveProperty("workflow_dispatch");
    const expression = config.jobs.windows.strategy.matrix.include.slice(3, -2);
    const matrix = (event, lane = "all") =>
      JSON.parse(
        JSON.stringify(
          runInNewContext(expression, {
            github: { event_name: event },
            inputs: { lane },
            fromJSON: JSON.parse,
          }),
        ),
      );
    expect(matrix("pull_request")).toEqual([{ name: "Windows focused", lane: "focused" }]);
    for (const event of ["schedule", "workflow_dispatch"]) {
      expect(matrix(event).map(({ lane, shard }) => [lane, shard ?? null])).toEqual([
        ["unit", null],
        ["e2e", "1/2"],
        ["e2e", "2/2"],
        ["portal", null],
      ]);
    }
    expect(config.on.workflow_dispatch.inputs.lane).toMatchObject({
      type: "choice",
      default: "all",
      options: ["all", "unit", "e2e", "portal"],
    });
    expect(matrix("workflow_dispatch", "unit").map(({ lane }) => lane)).toEqual(["unit"]);
    expect(matrix("workflow_dispatch", "e2e").map(({ shard }) => shard)).toEqual(["1/2", "2/2"]);
    expect(matrix("workflow_dispatch", "portal").map(({ lane }) => lane)).toEqual(["portal"]);
    // A diagnostic input cannot reduce scheduled or pull-request coverage.
    expect(matrix("schedule", "unit")).toEqual(matrix("schedule"));
    expect(matrix("pull_request", "portal")).toEqual(matrix("pull_request"));
    expect(config.jobs.windows.strategy["max-parallel"]).toBe(4);
  });

  test("runs exact public revisions on hosted Windows with pinned actions and read-only credentials", () => {
    const config = workflow();
    expect(config.permissions).toEqual({ contents: "read" });
    expect(config.jobs.windows["runs-on"]).toBe("windows-latest");
    for (const step of config.jobs.windows.steps.filter(({ uses }) => uses)) {
      expect(step.uses).toMatch(/@[0-9a-f]{40}$/u);
    }
    const checkout = config.jobs.windows.steps.find(({ uses }) =>
      uses?.startsWith("actions/checkout@"),
    );
    expect(checkout.with).toEqual({ ref: "${{ github.sha }}", "persist-credentials": false });
    expect(config.on).not.toHaveProperty("pull_request_target");
    expect(JSON.stringify(config)).not.toContain("secrets.");
  });

  test("focused runtime coverage names existing suites and real gateway/collector integration", () => {
    for (const file of [...FOCUSED_UNIT_FILES, ...FOCUSED_E2E_FILES])
      expect(existsSync(file), file).toBe(true);
    const [unit, e2e] = windowsCheckTasks("focused");
    expect(unit).toEqual(["scripts/run-check.mjs", "unit", ...FOCUSED_UNIT_FILES]);
    expect(e2e).toEqual(["scripts/run-check.mjs", "e2e", ...FOCUSED_E2E_FILES]);
    expect(FOCUSED_E2E_FILES).toContain("packages/collector/src/e2e/synth-pipeline.e2e.test.ts");
    expect(FOCUSED_E2E_FILES).toContain("packages/collector/src/e2e/gateway-lifecycle.e2e.test.ts");
  });

  test("every Windows lane proves the rebuilt vector binding before running source checks", () => {
    const config = workflow();
    expect(config.on.pull_request.paths).toContain("patches/**");
    expect(config.on.pull_request.paths).toContain(".gitattributes");
    const steps = config.jobs.windows.steps;
    const dependencies = steps.findIndex(({ id }) => id === "dependencies");
    const prepare = steps.findIndex(
      ({ run }) => run === "node scripts/ci/build-windows-usearch.mjs",
    );
    expect(prepare).toBe(dependencies + 1);
    expect(steps[prepare]).not.toHaveProperty("if");
    expect(steps[prepare]).not.toHaveProperty("continue-on-error");
    for (const file of [
      "packages/gateway/src/indexer/usearch-index.test.ts",
      "packages/gateway/src/indexer/usearch-read-registry.test.ts",
      "packages/gateway/src/indexer/usearch-sidecar-integration.test.ts",
    ])
      expect(FOCUSED_UNIT_FILES).toContain(file);
  });

  test("focused checks retain shutdown ownership and generic Local Files coverage", () => {
    for (const file of [
      "packages/core/src/parent-shutdown.test.ts",
      "packages/core/src/windows-process-tree.test.ts",
      "packages/core/src/child-termination.test.ts",
      "packages/collector/src/e2e/subprocess-reaper.test.ts",
      "packages/providers/local-files",
    ])
      expect(FOCUSED_UNIT_FILES).toContain(file);
  });

  test("daily unit coverage builds source declarations and checks every suite config", () => {
    const step = workflow().jobs.windows.steps.find(
      ({ name }) => name === "Typecheck all TypeScript source and test projects",
    );
    expect(step.if).toBe("${{ matrix.lane == 'unit' }}");
    expect(step.shell).toBe("bash");
    expect(step.run).toBe("exec node scripts/run-check.mjs types-tests");
    expect(step).not.toHaveProperty("continue-on-error");
    const dependencyStep = workflow().jobs.windows.steps.find(({ id }) => id === "dependencies");
    expect(dependencyStep.name).toBe("Install dependencies");
    const runtimeStep = workflow().jobs.windows.steps.find(
      ({ name }) => name === "Full Windows unit and adapter tests",
    );
    expect(runtimeStep.if).toBe(
      "${{ !cancelled() && matrix.lane == 'unit' && steps.dependencies.outcome == 'success' }}",
    );
  });

  test("full units are discovered normally and exclude only explicitly documented installation tests", () => {
    const [unit, smoke, adapter, hermes] = windowsCheckTasks("unit");
    for (const file of [
      "packages/cli/src/update/build-heap.test.ts",
      "packages/cli/src/update/source-launcher.test.ts",
    ])
      expect(INSTALLER_TEST_EXCLUSIONS.some(({ pattern }) => pattern === file)).toBe(false);
    for (const file of [
      "packages/cli/src/update/build-heap-install-shell.test.ts",
      "packages/cli/src/update/source-launcher-install-shell.test.ts",
    ])
      expect(INSTALLER_TEST_EXCLUSIONS.some(({ pattern }) => pattern === file)).toBe(true);

    expect(unit.slice(0, 2)).toEqual(["scripts/run-check.mjs", "unit"]);
    expect(unit.slice(2)).toEqual(
      INSTALLER_TEST_EXCLUSIONS.flatMap(({ pattern }) => ["--exclude", pattern]),
    );
    for (const { pattern, reason } of INSTALLER_TEST_EXCLUSIONS) {
      expect(reason).toMatch(/install/iu);
      if (pattern.startsWith("packages/")) {
        expect([
          "packages/cli/src/update/build-heap-install-shell.test.ts",
          "packages/cli/src/update/source-launcher-install-shell.test.ts",
        ]).toContain(pattern);
      } else expect(pattern).toMatch(/^scripts\/(?:install-e2e|release)\//u);
    }
    expect(smoke).toEqual(["scripts/run-check.mjs", "smoke"]);
    expect(adapter).toEqual(["packages/agent-integration/test/openclaw_gateway_probe.mjs"]);
    expect(hermes).toEqual(["scripts/test-hermes.mjs"]);
  });

  test("full E2E shards and portal runs have no test exclusions or name filters", () => {
    for (const shard of ["1/2", "2/2"]) {
      expect(windowsCheckTasks("e2e", shard)).toEqual([
        ["scripts/run-check.mjs", "e2e", `--shard=${shard}`],
      ]);
    }
    expect(windowsCheckTasks("portal")).toEqual([["scripts/run-check.mjs", "portal"]]);
    expect(() => windowsCheckTasks("e2e", "1/3")).toThrow(/shard/);
    expect(() => windowsCheckTasks("focused", "1/2")).toThrow(/shard/);
    expect(() => windowsCheckTasks("unknown")).toThrow(/lane/);
  });

  test("both daily E2E shards use the real reference embedder", () => {
    const step = workflow().jobs.windows.steps.find(
      ({ name }) => name === "Full Windows E2E shard with the real reference embedder",
    );
    expect(step.run).toBe(
      "node scripts/ci/with-test-embedder.mjs scripts/ci/windows-checks.mjs e2e --shard=$env:SHARD",
    );
    expect(step.env.SHARD).toBe("${{ matrix.shard }}");
    expect(step.env).toHaveProperty("OMNESIS_TEST_EMBEDDER_CACHE");
  });
});

test("portal gateway settings are environment values, including paths containing shell syntax", () => {
  const directory = mkdtempSync(join(tmpdir(), "portal config & "));
  try {
    const configDirectory = join(directory, "private state");
    const source = `const { default: imported } = await import(${JSON.stringify(new URL("../../playwright.config.ts", import.meta.url).href)}); const config = imported.default ?? imported; process.stdout.write(JSON.stringify(config.webServer));`;
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const result = spawnSync(
      process.execPath,
      ["--import", tsx, "--input-type=module", "-e", source],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OMNESIS_PORTAL_TEST_CONFIG_DIR: configDirectory,
          OMNESIS_PORTAL_TEST_PORT: "17899",
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const server = JSON.parse(result.stdout);
    expect(server.command).toBe("node --import tsx packages/gateway/src/index.ts");
    expect(server.command).not.toContain(configDirectory);
    expect(server.env).toMatchObject({
      OMNESIS_CONFIG_DIR: configDirectory,
      OMNESIS_GATEWAY_PORT: "17899",
      OMNESIS_DB_PATH: join(configDirectory, "omnesis.db"),
      OMNESIS_ANALYTICS_DB_PATH: join(configDirectory, "analytics.db"),
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Hermes adapter tests use native Python and preserve argument boundaries on every platform", () => {
  const windows = hermesTestInvocation("win32", ["-k", "a test name"]);
  const posix = hermesTestInvocation("linux", ["-k", "a test name"]);
  expect(windows.command).toBe("python");
  expect(posix.command).toBe("python3");
  expect(windows.args).toEqual(posix.args);
  expect(windows.args[0]).toBe("-B");
  expect(existsSync(windows.args[1])).toBe(true);
  expect(windows.args.slice(2)).toEqual(["-k", "a test name"]);
  const scripts = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ).scripts;
  expect(scripts["test:hermes"]).toBe("node scripts/test-hermes.mjs");
});

test("independent Windows suites run after a failure and preserve the first nonzero verdict", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omnesis-windows-suite-status-"));
  const receipt = join(directory, "phase receipt.txt");
  const script =
    "require('node:fs').appendFileSync(process.argv[1],process.argv[2]+'\\n');process.exit(Number(process.argv[3]));";
  try {
    const tasks = [
      ["unit", 7],
      ["smoke", 0],
      ["adapter", 3],
      ["hermes", 0],
    ].map(([name, code]) => ["-e", script, receipt, name, String(code)]);
    expect(await runWindowsCheckTasks(tasks)).toBe(7);
    expect(readFileSync(receipt, "utf8")).toBe("unit\nsmoke\nadapter\nhermes\n");
    expect(await runWindowsCheckTasks([["-e", "process.exit(0)"]])).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
