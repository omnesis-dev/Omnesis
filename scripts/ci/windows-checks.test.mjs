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
  windowsE2EFiles,
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
    const matrix = (event, lane = "all", e2eFiles = "") =>
      JSON.parse(
        JSON.stringify(
          runInNewContext(expression, {
            github: { event_name: event },
            inputs: { lane, e2e_files: e2eFiles },
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
    const selected = JSON.stringify(["packages/collector/src/e2e/cli.e2e.test.ts"]);
    expect(matrix("workflow_dispatch", "e2e", selected)).toEqual([
      { name: "Windows E2E diagnosis", lane: "e2e" },
    ]);
    expect(matrix("schedule", "e2e", selected)).toEqual(matrix("schedule"));
    expect(matrix("pull_request", "e2e", selected)).toEqual(matrix("pull_request"));
    expect(matrix("workflow_dispatch", "all", selected)).toEqual(matrix("schedule"));
    const e2eStep = config.jobs.windows.steps.find(
      ({ name }) => name === "Full Windows E2E shard with the real reference embedder",
    );
    expect(e2eStep.env.OMNESIS_WINDOWS_E2E_FILES).toContain(
      "github.event_name == 'workflow_dispatch'",
    );
    expect(e2eStep.run).not.toContain("inputs.e2e_files");

    // A diagnostic input cannot reduce scheduled or pull-request coverage.
    expect(matrix("schedule", "unit")).toEqual(matrix("schedule"));
    expect(matrix("pull_request", "portal")).toEqual(matrix("pull_request"));
    expect(config.jobs.windows.strategy["max-parallel"]).toBe(4);
  });

  test("the complete unit lane configures real native ASR without expanding focused PR work", () => {
    const steps = workflow().jobs.windows.steps;
    const index = steps.findIndex(
      ({ name }) => name === "Prepare real native Whisper acceptance inputs",
    );
    expect(index).toBeGreaterThan(-1);
    expect(steps[index].if).toBe("${{ matrix.lane == 'unit' }}");
    expect(steps[index].run).toBe("node scripts/ci/prepare-whisper-test-inputs.mjs");
    expect(index).toBeLessThan(
      steps.findIndex(({ name }) => name === "Full Windows unit and adapter tests"),
    );
  });

  test("the complete unit lane requires verified native OCR and the default throughput benchmark", () => {
    const steps = workflow().jobs.windows.steps;
    const prepare = steps.findIndex(({ id }) => id === "native_ocr");
    const verify = steps.findIndex(({ id }) => id === "verify_ocr");
    const unit = steps.findIndex(({ name }) => name === "Full Windows unit and adapter tests");
    expect(prepare).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(prepare);
    expect(unit).toBeGreaterThan(verify);
    expect(steps[prepare].run).toBe("./scripts/ci/prepare-tesseract-test-inputs.ps1");
    expect(steps[verify].run).toBe("node --import tsx scripts/ci/verify-tesseract-test-inputs.mjs");
    for (const index of [prepare, verify]) {
      expect(steps[index].if).toBe("${{ matrix.lane == 'unit' }}");
      expect(steps[index]).not.toHaveProperty("continue-on-error");
    }
    expect(steps[unit].if).toContain("steps.native_ocr.outcome == 'success'");
    expect(steps[unit].if).toContain("steps.verify_ocr.outcome == 'success'");
    expect(steps[unit].env.OMNESIS_INDEXER_BENCH).toBe("1");
  });

  test("daily native hosts share one runner after the broad matrix and never expand focused PR checks", () => {
    const job = workflow().jobs["native-integrations"];
    const enabled = (event, lane = "all", cancelled = false) =>
      runInNewContext(job.if.slice(3, -2), {
        github: { event_name: event },
        inputs: { lane },
        cancelled: () => cancelled,
      });
    expect(enabled("schedule")).toBe(true);
    expect(enabled("workflow_dispatch")).toBe(true);
    for (const lane of ["unit", "e2e", "portal"]) {
      expect(enabled("workflow_dispatch", lane)).toBe(false);
      expect(enabled("schedule", lane)).toBe(true);
    }
    expect(enabled("pull_request")).toBe(false);
    expect(enabled("schedule", "all", true)).toBe(false);
    expect(job.needs).toBe("windows");
    expect(job["runs-on"]).toBe("windows-latest");
    expect(job.strategy).toBeUndefined();
    const hosts = job.steps.filter(({ env }) => env?.OMNESIS_HARNESS_CONFORMANCE);
    expect(hosts.map(({ env }) => env.OMNESIS_HARNESS_CONFORMANCE)).toEqual(["openclaw", "hermes"]);
    for (const host of hosts) {
      expect(host.run).toBe(
        "node scripts/run-check.mjs e2e packages/collector/src/e2e/harness-plugin-conformance.e2e.test.ts",
      );
      expect(host.if).toContain("!cancelled()");
      expect(host.if).toContain("steps.native_bindings.outcome == 'success'");
      expect(host).not.toHaveProperty("continue-on-error");
    }
    expect(hosts[1].if).toContain("steps.hermes.outcome == 'success'");
    for (const step of job.steps.filter(({ uses }) => uses))
      expect(step.uses).toMatch(/@[0-9a-f]{40}$/u);
    expect(job.steps.find(({ uses }) => uses?.startsWith("actions/checkout@")).with).toEqual({
      ref: "${{ github.sha }}",
      "persist-credentials": false,
    });
  });

  test("full E2E supplies Go and proves actual peer transports once without expanding PR builds", () => {
    const steps = workflow().jobs.windows.steps;
    const go = steps.find(({ uses }) => uses?.startsWith("actions/setup-go@"));
    const proofIndex = steps.findIndex(
      ({ run }) => run === "node scripts/ci/portable-transports-proof.mjs",
    );
    expect(proofIndex).toBeGreaterThan(-1);
    const enabled = (step, matrix) => runInNewContext(step.if.slice(3, -2), { matrix });
    for (const matrix of [
      { lane: "e2e", shard: "1/2" },
      { lane: "e2e", shard: "2/2" },
      { lane: "e2e" },
    ]) {
      expect(enabled(go, matrix)).toBe(true);
      expect(enabled(steps[proofIndex], matrix)).toBe(matrix.shard !== "2/2");
    }
    for (const lane of ["focused", "unit", "portal"])
      expect(enabled(steps[proofIndex], { lane })).toBe(false);
    const e2eIndex = steps.findIndex(
      ({ name }) => name === "Full Windows E2E shard with the real reference embedder",
    );
    expect(proofIndex).toBeLessThan(e2eIndex);
    expect(steps[proofIndex].env.OMNESIS_TAILNET_TOOLS_DIR).toBe(
      steps[e2eIndex].env.OMNESIS_TAILNET_TOOLS_DIR,
    );
    for (const file of [
      "packages/collector/src/e2e/portable-tailnet-actor.test.ts",
      "packages/collector/src/e2e/tailnet-machine-env.test.ts",
      "packages/collector/src/e2e/tailnet-fixture-cleanup.test.ts",
      "packages/cli/src/tailscale-join.test.ts",
    ])
      expect(FOCUSED_UNIT_FILES).toContain(file);
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
    for (const file of [
      "packages/gateway/src/tailscale-embed/service.integration.test.ts",
      "packages/gateway/src/tailscale-embed/service.ownership.test.ts",
      "packages/gateway/src/tailscale-embed/socket-server.test.ts",
      "packages/gateway/src/tailscale-embed/supervisor.test.ts",
      "packages/collector/src/e2e/connect-process.test.ts",
      "packages/collector/src/e2e/enrollment-fixture-cleanup.test.ts",
      "packages/collector/src/e2e/e2e-buffered-command.test.ts",
      "packages/collector/src/e2e/enrollment-terminal-fixture.test.ts",
      "packages/collector/src/e2e/enrollment-terminal-cohort.windows.test.ts",
      "packages/collector/src/e2e/multi-collector-harness-cleanup.test.ts",
      "packages/core/src/config-private-cleanup.test.ts",
      "packages/core/src/secret-file-cache.test.ts",
      "packages/collector/src/auth-subprocess-env.test.ts",
      "packages/collector/src/auth-process.test.ts",
      "packages/core/src/owned-child-process.test.ts",
      "packages/gateway/src/transcribe/whisper-transcriber.test.ts",
      "packages/gateway/src/transcribe/whisper-transcriber.ownership.test.ts",
      "packages/gateway/src/transcribe/whisper-worker-protocol.test.ts",
      "packages/gateway/src/transcribe/whisper-worker-process.physical.test.ts",
      "packages/gateway/src/transcribe/transcribe-service.test.ts",
      "packages/gateway/src/transcribe/transcribe-service.ownership.test.ts",
      "packages/collector/src/source-ws-handlers.test.ts",
      "packages/collector/src/source-ws-handlers.auth-begin.test.ts",
      "packages/collector/src/source-ws-handlers.ownership.test.ts",
      "packages/collector/src/source-ws-handlers.physical-ownership.test.ts",
      "packages/providers/whatsapp/src/import/importer.test.ts",
      "packages/providers/whatsapp/src/import/importer-ownership.test.ts",
      "packages/cloud-relay/src/relay-dos-limits.test.ts",
      "packages/cloud-relay/src/certificate-monitor.test.ts",
      "packages/cloud-relay/src/certificate-monitor-poller.test.ts",
      "packages/cloud-relay/src/gateway-certificate-monitor.test.ts",
      "packages/cloud-relay/src/certificate-monitor-crtsh.test.ts",
    ]) {
      expect(FOCUSED_UNIT_FILES).toContain(file);
    }
  });

  test("every Windows lane proves rebuilt SQLite and vector bindings before source checks", () => {
    const config = workflow();
    expect(config.on.pull_request.paths).toContain("patches/**");
    expect(config.on.pull_request.paths).toContain(".gitattributes");
    const steps = config.jobs.windows.steps;
    const dependencies = steps.findIndex(({ id }) => id === "dependencies");
    const prepare = steps.findIndex(
      ({ run }) => run === "node scripts/ci/build-windows-usearch.mjs",
    );
    const selection = steps.findIndex(({ name }) => name === "Validate optional E2E selection");
    expect(selection).toBe(dependencies + 1);
    const sqlite = steps.findIndex(({ run }) => run === "node scripts/ci/build-windows-sqlite.mjs");
    expect(sqlite).toBe(selection + 1);
    expect(prepare).toBe(sqlite + 1);
    expect(steps[sqlite].id).toBe("native_sqlite");
    expect(steps[sqlite]).not.toHaveProperty("if");
    expect(steps[sqlite]).not.toHaveProperty("continue-on-error");
    expect(steps[selection]).not.toHaveProperty("continue-on-error");
    expect(steps[prepare]).not.toHaveProperty("if");
    expect(steps[prepare]).not.toHaveProperty("continue-on-error");
    expect(steps[prepare].id).toBe("native_vector");
    const unit = steps.find(({ name }) => name === "Full Windows unit and adapter tests");
    expect(unit.if).toContain("steps.native_vector.outcome == 'success'");
    expect(unit.if).toContain("steps.native_sqlite.outcome == 'success'");

    for (const file of [
      "packages/gateway/src/sqlite-windows-wal-recovery.test.ts",
      "scripts/ci/build-windows-sqlite.test.mjs",
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

  test("expensive decision matrices use the complete Windows sweep alongside focused native boundaries", () => {
    for (const file of [
      "packages/cli/src/commands/connect.test.ts",
      "packages/cloud-relay/src/management-service.test.ts",
      "packages/gateway/src/http/services/BackupService.test.ts",
      "packages/cli/src/commands/secure-docker.test.ts",
      "packages/gateway/src/workers/indexer-worker-boot.test.ts",
      "packages/gateway/src/storage-encryption.test.ts",
    ]) {
      expect(FOCUSED_UNIT_FILES).not.toContain(file);
      expect(INSTALLER_TEST_EXCLUSIONS.some(({ pattern }) => pattern === file)).toBe(false);
    }
    for (const file of [
      "packages/cli/src/commands/connect.integration.test.ts",
      "packages/cloud-relay/src/management-ownership-boundaries.test.ts",
      "packages/core/src/encrypted-artifact-publication.test.ts",
      "packages/gateway/src/workers/worker-module-graph.test.ts",
    ]) {
      expect(FOCUSED_UNIT_FILES).toContain(file);
    }
    expect(windowsCheckTasks("unit")[0].slice(2)).toEqual(
      INSTALLER_TEST_EXCLUSIONS.flatMap(({ pattern }) => ["--exclude", pattern]),
    );
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
      "${{ !cancelled() && matrix.lane == 'unit' && steps.dependencies.outcome == 'success' && steps.native_sqlite.outcome == 'success' && steps.native_vector.outcome == 'success' }}",
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
    expect(step.run).toContain(
      "@('scripts/ci/with-test-embedder.mjs', 'scripts/ci/windows-checks.mjs', 'e2e')",
    );
    expect(step.run).toContain('if ($env:SHARD) { $checkArgs += "--shard=$env:SHARD" }');
    expect(step.run).toContain("node @checkArgs");
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

describe("manual Windows E2E selection", () => {
  const file = "packages/collector/src/e2e/cli.e2e.test.ts";
  test("keeps default coverage and passes selected files as literal Node arguments", () => {
    expect(windowsE2EFiles("")).toEqual([]);
    const files = windowsE2EFiles(JSON.stringify([file]));
    expect(windowsCheckTasks("e2e", undefined, files)).toEqual([
      ["scripts/run-check.mjs", "e2e", file],
    ]);
    expect(() => windowsCheckTasks("unit", undefined, files)).toThrow(/unsharded/);
    expect(() => windowsCheckTasks("e2e", "1/2", files)).toThrow(/unsharded/);
  });
  test.each([
    "  ",
    "not json",
    "{}",
    "[]",
    "[null]",
    "[1]",
    JSON.stringify([file, file]),
    JSON.stringify(Array(17).fill(file)),
    JSON.stringify(["../collector.e2e.test.ts"]),
    JSON.stringify(["packages/a/../../collector.e2e.test.ts"]),
    JSON.stringify(["packages/a/./collector.e2e.test.ts"]),
    JSON.stringify(["packages/a//collector.e2e.test.ts"]),
    JSON.stringify(["C:\\tests\\collector.e2e.test.ts"]),
    JSON.stringify(["packages/a/collector.test.ts"]),
    JSON.stringify(["packages/a/collector.e2e.test.ts;unexpected"]),
  ])("refuses an unsafe or empty selection %s", (input) => {
    expect(() => windowsE2EFiles(input, () => true)).toThrow();
  });
  test("refuses missing files rather than silently expanding coverage", () => {
    expect(() => windowsE2EFiles(JSON.stringify([file]), () => false)).toThrow(/existing/);
  });
  test("the real CLI lists only the selected test without launching a runner", () => {
    const result = spawnSync(process.execPath, ["scripts/ci/windows-checks.mjs", "e2e", "--list"], {
      encoding: "utf8",
      env: { ...process.env, OMNESIS_WINDOWS_E2E_FILES: JSON.stringify([file]) },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([["scripts/run-check.mjs", "e2e", file]]);
  });
});
