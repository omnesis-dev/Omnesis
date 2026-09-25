// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  focusedUnit,
  lintEnv,
  schedulerCommand,
  testProcessEnv,
  unitWorkers,
} from "./run-check.mjs";

import { progressArgs } from "./lib/check-progress.mjs";

const roots = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), "omnesis-check-test-"));
  roots.push(path);
  return path;
};
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
const runner = join(import.meta.dirname, "run-check.mjs");
function invoke(cwd, args, env = {}, entrypoint = runner) {
  return spawnSync(process.execPath, [entrypoint, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: {
      ...process.env,
      OMNESIS_TEST_SCHEDULER: "0",
      OMNESIS_TEST_SCHEDULER_ACTIVE: "",
      // These subprocesses exercise independent fixture trees, not the outer Nx plan.
      OMNESIS_FORCE_TEST_ADMISSION: "",
      OMNESIS_TREE_BASE: "",
      OMNESIS_TREE_FINGERPRINT: "",
      ...env,
    },
  });
}
function stub(cwd, name, code) {
  const path = join(cwd, "node_modules", name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, code);
  return path;
}

describe("portable check entrypoint", () => {
  test.each([0, 6])(
    "Nx scripts units build before testing and preserve build exit %s",
    (buildExit) => {
      const cwd = root();
      const output = join(cwd, "sequence");
      mkdirSync(join(cwd, "scripts"));
      writeFileSync(join(cwd, "scripts", "fixture.test.mjs"), "");
      // Exercise the real Nx command and queue-aware implementation in an
      // independent checkout; only the compiler/test executables are fixtures.
      writeFileSync(
        join(cwd, "scripts", "run-check.mjs"),
        `import { main } from ${JSON.stringify(pathToFileURL(runner).href)};\nprocess.exitCode = await main(process.argv.slice(2));\n`,
      );
      stub(
        cwd,
        "typescript/bin/tsc",
        `const fs = require("node:fs"); fs.appendFileSync(process.env.OUTPUT, JSON.stringify(["build", ...process.argv.slice(2)]) + "\\n"); process.exit(${buildExit});`,
      );
      stub(
        cwd,
        "vitest/vitest.mjs",
        'import fs from "node:fs"; fs.appendFileSync(process.env.OUTPUT, JSON.stringify(["test", ...process.argv.slice(2)]) + "\\n");',
      );
      const result = invoke(
        cwd,
        ["unit", "scripts"],
        { OUTPUT: output },
        join(import.meta.dirname, "nx", "run-project-task.mjs"),
      );
      expect(result.status, result.stderr).toBe(buildExit);
      const commands = readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(commands[0]).toEqual(["build", "--build"]);
      expect(commands).toHaveLength(buildExit === 0 ? 2 : 1);
      if (buildExit === 0) {
        expect(commands[1][0]).toBe("test");
        expect(commands[1]).toContain("scripts");
        expect(commands[1]).toContain("**/*.e2e.test.ts");
      }
    },
  );
  test("isolates fixture invocations from inherited Nx admission state", () => {
    vi.stubEnv("OMNESIS_FORCE_TEST_ADMISSION", "1");
    vi.stubEnv("OMNESIS_TREE_BASE", "fixture-parent-base");
    vi.stubEnv("OMNESIS_TREE_FINGERPRINT", "fixture-parent-fingerprint");
    try {
      const cwd = root();
      stub(
        cwd,
        "vitest/vitest.mjs",
        "process.stdout.write(JSON.stringify([process.env.OMNESIS_FORCE_TEST_ADMISSION, process.env.OMNESIS_TREE_BASE, process.env.OMNESIS_TREE_FINGERPRINT]));",
      );
      const result = invoke(cwd, ["unit", "packages/core"], {
        OMNESIS_TEST_SCHEDULER: "/does-not-exist",
      });
      expect(result.status, result.stderr).toBe(0);
      // Missing environment values serialize as null inside the fixture's array.
      expect(JSON.parse(result.stdout)).toEqual([null, null, null]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  test("an explicit config retains its own reporter policy", () => {
    const args = ["--config", "custom.config.ts", "extension"];
    expect(progressArgs(args)).toEqual(args);
  });
  test("aggregate units fail before execution when compiled prerequisites fail", () => {
    const cwd = root();
    stub(cwd, "typescript/bin/tsc", "process.exit(6)");
    const result = invoke(cwd, ["unit-all"]);
    expect(result.status).toBe(6);
    expect(result.stderr).toContain("failed: exit 6");
  });
  test("aggregate units validate compiled release artifacts before the full suite", () => {
    const cwd = root();
    const output = join(cwd, "vitest-args.json");
    stub(cwd, "typescript/bin/tsc", "process.exit(0)");
    stub(
      cwd,
      "vitest/vitest.mjs",
      'import fs from "node:fs"; fs.writeFileSync(process.env.OUTPUT, JSON.stringify(process.argv.slice(2))); process.exit(7);',
    );
    const result = invoke(cwd, ["unit-all"], { OUTPUT: output });
    expect(result.status).toBe(7);
    expect(JSON.parse(readFileSync(output))).toEqual([
      "run",
      "--maxWorkers=1",
      "scripts/release/stage-packages.test.mjs",
      "scripts/release/stage-runtime.test.mjs",
    ]);
    expect(result.stderr).toContain("failed: exit 7");
  });
  test("aggregate units continue to the full suite after release artifact validation", () => {
    const cwd = root();
    const sequence = join(cwd, "sequence");
    stub(
      cwd,
      "typescript/bin/tsc",
      'import fs from "node:fs"; fs.appendFileSync(process.env.SEQUENCE, "build\\n");',
    );
    stub(
      cwd,
      "vitest/vitest.mjs",
      'import fs from "node:fs"; fs.appendFileSync(process.env.SEQUENCE, "preflight\\n");',
    );
    const bin = join(cwd, "bin");
    mkdirSync(bin);
    const npm = join(bin, "npm");
    writeFileSync(
      npm,
      '#!/usr/bin/env node\nimport fs from "node:fs"; fs.appendFileSync(process.env.SEQUENCE, `npm ${process.argv.slice(2).join(" ")}\\n`);\n',
    );
    chmodSync(npm, 0o755);
    const result = invoke(cwd, ["unit-all"], {
      PATH: `${bin}:${process.env.PATH}`,
      SEQUENCE: sequence,
    });
    expect(result.status).toBe(0);
    expect(readFileSync(sequence, "utf8")).toBe("build\npreflight\nnpm run test:unit:raw\n");
  });
  test("progress reporting preserves a requested JSON reporter and literal filter boundary", () => {
    const args = progressArgs(["--reporter=json", "--", "extension"]);
    expect(args).not.toContain("--reporter=default");
    expect(args).toContain("--reporter=json");
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("extension");
    expect(args.filter((arg) => arg.includes("check-reporter.mjs"))).toHaveLength(1);
  });
  test("only actual narrow filters bypass admission", () => {
    expect(focusedUnit(["extension"])).toBe(true);
    expect(focusedUnit(["packages/core/"])).toBe(true);
    expect(focusedUnit(["packages/"])).toBe(false);
    expect(focusedUnit(["--outputFile", "/tmp/report.json"])).toBe(false);
    expect(focusedUnit(["--testNamePattern", "foo.bar"])).toBe(false);
    expect(focusedUnit(["--config", "other.config.ts", "extension"])).toBe(false);
  });
  test("aggregate units reject ambiguous filters and worker overrides cannot exceed focused budget", () => {
    const cwd = root();
    expect(invoke(cwd, ["unit-all", "extension"]).stderr).toContain("takes no arguments");
    const result = invoke(cwd, ["unit", "extension", "--maxWorkers=8"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unit --maxWorkers must be between");
  });
  test("bounds unit workers using available memory and validates override", () => {
    expect(unitWorkers({}, 64, 64 * 1024 ** 3)).toBe(4);
    expect(unitWorkers({}, 64, 3 * 1024 ** 3)).toBe(1);
    expect(unitWorkers({ OMNESIS_UNIT_WORKERS: "2" }, 64, 0)).toBe(2);
    expect(() => unitWorkers({ OMNESIS_UNIT_WORKERS: "0" })).toThrow(/1 to 8/);
  });
  test("lint preserves explicit heap settings and other Node options", () => {
    expect(lintEnv({ NODE_OPTIONS: "--enable-source-maps" }).NODE_OPTIONS).toBe(
      "--enable-source-maps --max-old-space-size=6144",
    );
    expect(lintEnv({ NODE_OPTIONS: "--max_old_space_size=8192" }).NODE_OPTIONS).toBe(
      "--max_old_space_size=8192",
    );
  });
  test("unit tests inherit reservation ownership without Nx orchestration inputs", () => {
    const env = testProcessEnv({
      OMNESIS_TEST_SCHEDULER_ACTIVE: "1",
      OMNESIS_TEST_SCHEDULER_CONFIG: "/tmp/scheduler.json",
      OMNESIS_FORCE_TEST_ADMISSION: "1",
      OMNESIS_TREE_BASE: "origin/main",
      OMNESIS_TREE_HEAD: "a".repeat(40),
      OMNESIS_TREE_FINGERPRINT: "b".repeat(64),
      OMNESIS_NATIVE_TREE_FINGERPRINT: "c".repeat(64),
    });
    expect(env).toMatchObject({
      OMNESIS_TEST_SCHEDULER_ACTIVE: "1",
      OMNESIS_TEST_SCHEDULER_CONFIG: "/tmp/scheduler.json",
    });
    expect(env).not.toHaveProperty("OMNESIS_FORCE_TEST_ADMISSION");
    expect(env).not.toHaveProperty("OMNESIS_TREE_BASE");
    expect(env).not.toHaveProperty("OMNESIS_TREE_HEAD");
    expect(env).not.toHaveProperty("OMNESIS_TREE_FINGERPRINT");
    expect(env).not.toHaveProperty("OMNESIS_NATIVE_TREE_FINGERPRINT");
  });
  test("missing adapter is optional but malformed configuration fails closed", () => {
    const cwd = root();
    const config = join(cwd, "scheduler.json");
    expect(schedulerCommand({ OMNESIS_TEST_SCHEDULER_CONFIG: config })).toBeNull();
    writeFileSync(config, JSON.stringify({ command: "shell command" }));
    expect(() => schedulerCommand({ OMNESIS_TEST_SCHEDULER_CONFIG: config })).toThrow(
      /command array/,
    );
  });
  test("delegates argv literally and propagates scheduler failure", () => {
    const cwd = root();
    const output = join(cwd, "args.json");
    const adapter = join(cwd, "adapter.mjs");
    writeFileSync(
      adapter,
      'import fs from "node:fs"; fs.writeFileSync(process.env.OUTPUT, JSON.stringify(process.argv.slice(2))); process.exitCode = 7;',
    );
    const config = join(cwd, "scheduler.json");
    writeFileSync(config, JSON.stringify({ command: [process.execPath, adapter] }));
    const result = invoke(cwd, ["typecheck", "literal $(touch unwanted)"], {
      OMNESIS_TEST_SCHEDULER: "",
      OMNESIS_TEST_SCHEDULER_CONFIG: config,
      OUTPUT: output,
    });
    expect(result.status).toBe(7);
    expect(JSON.parse(readFileSync(output))).toEqual([
      "run",
      "--kind",
      "typecheck",
      "--",
      process.execPath,
      runner,
      "typecheck",
      "literal $(touch unwanted)",
    ]);
  });
  test("Nx focused cache misses still acquire unit admission", () => {
    const cwd = root();
    const output = join(cwd, "args.json");
    const adapter = join(cwd, "adapter.mjs");
    writeFileSync(
      adapter,
      'import fs from "node:fs"; fs.writeFileSync(process.env.OUTPUT, JSON.stringify(process.argv.slice(2)));',
    );
    const config = join(cwd, "scheduler.json");
    writeFileSync(config, JSON.stringify({ command: [process.execPath, adapter] }));
    const result = invoke(cwd, ["unit", "packages/core"], {
      OMNESIS_TEST_SCHEDULER: "",
      OMNESIS_TEST_SCHEDULER_CONFIG: config,
      OMNESIS_FORCE_TEST_ADMISSION: "1",
      OUTPUT: output,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(output)).slice(0, 4)).toEqual(["run", "--kind", "unit", "--"]);
  });
  test("scoped unit invocation excludes E2E and limits workers without queueing", () => {
    const cwd = root();
    stub(cwd, "vitest/vitest.mjs", "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    const result = invoke(cwd, ["unit", "extension/src/"], {
      OMNESIS_TEST_SCHEDULER: "/does-not-exist",
      OMNESIS_UNIT_WORKERS: "8",
    });
    expect(result.status).toBe(0);
    const args = JSON.parse(result.stdout);
    expect(args).toContain("--maxWorkers=2");
    expect(args).toContain("**/*.e2e.test.ts");
    expect(args).toContain("extension/src/");
  });
  test.each([
    ["camel-case equals", ["--maxWorkers=1"]],
    ["camel-case separated", ["--maxWorkers", "1"]],
    ["kebab-case equals", ["--max-workers=1"]],
    ["kebab-case separated", ["--max-workers", "1"]],
  ])("scoped unit invocation preserves one explicit worker override (%s)", (_label, workerArgs) => {
    const cwd = root();
    stub(cwd, "vitest/vitest.mjs", "process.stdout.write(JSON.stringify(process.argv.slice(2)));");
    const result = invoke(cwd, ["unit", "extension/src/", ...workerArgs], {
      OMNESIS_TEST_SCHEDULER: "/does-not-exist",
      OMNESIS_UNIT_WORKERS: "8",
    });
    expect(result.status).toBe(0);
    const args = JSON.parse(result.stdout);
    const workerFlags = args.filter(
      (arg) =>
        arg === "--maxWorkers" ||
        arg.startsWith("--maxWorkers=") ||
        arg === "--max-workers" ||
        arg.startsWith("--max-workers="),
    );
    expect(workerFlags).toEqual([workerArgs[0]]);
    const index = args.indexOf(workerArgs[0]);
    expect(args.slice(index, index + workerArgs.length)).toEqual(workerArgs);
  });
  test("lint builds its compatibility dependency before ESLint and shares heap setting", () => {
    const cwd = root();
    stub(
      cwd,
      "typescript/bin/tsc",
      'require("node:fs").writeFileSync("built", process.argv.slice(2).join(" "));',
    );
    stub(
      cwd,
      "eslint/bin/eslint.js",
      'if (!require("node:fs").existsSync("built")) process.exit(9); process.stdout.write(process.env.NODE_OPTIONS);',
    );
    const result = invoke(cwd, ["lint"], { NODE_OPTIONS: "" });
    expect(result.status).toBe(0);
    expect(readFileSync(join(cwd, "built"), "utf8")).toBe("--build packages/agent-integration");
    expect(result.stdout).toContain("--max-old-space-size=6144");
  });
  test("failed prerequisite stops lint", () => {
    const cwd = root();
    stub(cwd, "typescript/bin/tsc", "process.exit(6)");
    const result = invoke(cwd, ["lint"]);
    expect(result.status).toBe(6);
    expect(result.stderr).toContain("failed: exit 6");
  });
});
