// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { expect, test } from "vitest";

const workflow = parse(
  await readFile(new URL("../../.github/workflows/macos-desktop.yml", import.meta.url), "utf8"),
);
const job = workflow.jobs["native-desktop"];
const matrix = [
  { arch: "arm64", os: "macos-26" },
  { arch: "x64", os: "macos-26-intel" },
];

test("desktop CI runs the full native job independently on ARM and Intel", () => {
  expect(job.strategy).toEqual({ "fail-fast": false, matrix: { include: matrix } });
  expect(job["runs-on"]).toBe("${{ matrix.os }}");
  expect(job["timeout-minutes"]).toBe(60);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(job.steps[0].with).toEqual({
    "persist-credentials": false,
    ref: "${{ inputs.target_sha || github.sha }}",
  });
  for (const step of job.steps.filter((step) => step.uses))
    expect(step.uses).toMatch(/@[a-f0-9]{40}$/u);
  expect(job.steps.map((step) => step.name)).toEqual(
    expect.arrayContaining([
      "Keep tests off production services",
      "Prepare verified Node process fixture",
      "Prepare production backend composition fixture",
      "Test portable native models",
      "Build and exercise native application",
      "Assemble complete unsigned app and exercise bundled runtime",
      "Verify production network isolation",
    ]),
  );
  expect(
    job.steps.some((step) =>
      step.run?.includes("node scripts/desktop/prepare-codex-keychain-test-fixture.mjs"),
    ),
  ).toBe(true);
  expect(job.steps.find((step) => step.name === "Test portable native models").run).toBe(
    "swift test --disable-automatic-resolution",
  );
  expect(
    job.steps.find((step) => step.name === "Build and exercise native application").run,
  ).toContain("test-without-building");
  expect(
    job.steps.find(
      (step) => step.name === "Assemble complete unsigned app and exercise bundled runtime",
    ).run,
  ).toContain("node scripts/desktop/smoke-runtime.mjs");
});

test("architecture is checked with configured Node before any dependency or native fixture preparation", () => {
  const index = job.steps.findIndex((step) => step.name === "Verify runner architecture");
  expect(index).toBeGreaterThan(
    job.steps.findIndex((step) => step.uses?.startsWith("actions/setup-node@")),
  );
  expect(index).toBeLessThan(
    job.steps.findIndex((step) => step.name === "Install build dependencies"),
  );
  for (const step of job.steps.filter((step) => step.name?.startsWith("Prepare ")))
    expect(job.steps.indexOf(step)).toBeGreaterThan(index);
  expect(job.steps[index]?.env).toEqual({ EXPECTED_NODE_ARCH: "${{ matrix.arch }}" });
  const restore = job.steps.find((step) => step.uses?.startsWith("actions/cache/restore@"));
  expect(restore.with.key).toContain("${{ runner.arch }}");
  expect(restore.with["restore-keys"]).toContain("${{ runner.arch }}");
});

test("each architecture retains distinct unsigned app and complete native evidence artifacts", () => {
  const uploads = job.steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
  expect(uploads).toHaveLength(3);
  const names = matrix.flatMap(({ arch }) =>
    uploads.map((step) => {
      expect(step.with.name).toContain("${{ matrix.arch }}");
      return step.with.name.replaceAll("${{ matrix.arch }}", arch);
    }),
  );
  expect(new Set(names).size).toBe(6);
  const coreEvidence = uploads.find(
    (step) => step.name === "Upload partial Core lifecycle observations",
  );
  expect(coreEvidence).toMatchObject({ if: "always()", "continue-on-error": true });
  expect(coreEvidence.with.path).toBe("evidence/readiness-diagnostics/fixture-phase-*/latest.json");
  const coreIndex = job.steps.findIndex((step) => step.id === "core");
  expect(job.steps[coreIndex + 1]).toBe(coreEvidence);
  const unsigned = uploads.find((step) => step.name === "Upload unsigned app for isolated QA");
  expect(unsigned.with.path).toBe("${{ runner.temp }}/Omnesis-unsigned.zip");
  const renderedEvidence = uploads.find(
    (step) => step.name === "Upload native renders and test results",
  );
  expect(renderedEvidence.if).toBe("always()");
  expect(renderedEvidence.with.path.trim().split("\n")).toEqual([
    "/tmp/omnesis-macos-snapshots/",
    "macos/build/DesktopTests.xcresult",
    "macos/build/test-runner-signature-after.json",
    "evidence/readiness-diagnostics/",
  ]);
  expect(job.steps.find((step) => step.name === "Verify production network isolation").if).toBe(
    "${{ always() && steps.production-network.outcome == 'success' }}",
  );
});

test.skipIf(process.platform === "win32").each([
  ["arm64", "arm64", 0],
  ["x64", "x64", 0],
  ["arm64", "x64", 1],
  ["x64", "arm64", 1],
])(
  "actual architecture guard shell rejects a mismatched Node (%s expected %s)",
  async (actual, expected, status) => {
    const guard = job.steps.find((step) => step.name === "Verify runner architecture");
    expect(guard).toBeDefined();
    const root = await mkdtemp(join(tmpdir(), "omnesis-desktop-ci-"));
    try {
      const node = join(root, "node");
      const receipt = join(root, "invocation");
      await writeFile(
        node,
        `#!/bin/sh\nprintf '%s\\n' "$*" > "$GUARD_NODE_RECEIPT"\nprintf '%s\\n' '${actual}'\n`,
        { mode: 0o700 },
      );
      await chmod(node, 0o700);
      const result = spawnSync(
        "/bin/bash",
        ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", guard.run],
        {
          cwd: fileURLToPath(new URL("../..", import.meta.url)),
          env: {
            PATH: `${root}:/usr/bin:/bin`,
            EXPECTED_NODE_ARCH: expected,
            GUARD_NODE_RECEIPT: receipt,
          },
          encoding: "utf8",
          timeout: 3000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(status);
      expect(await readFile(receipt, "utf8")).toBe("-p process.arch\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("desktop UI evidence can follow a completed Core failure but packaging requires the actual Core outcome", () => {
  const names = job.steps.map((step) => step.name);
  const core = job.steps.find((step) => step.id === "core");
  expect(core).toMatchObject({
    name: "Test portable native models",
    "continue-on-error": true,
    "working-directory": "macos",
    run: "swift test --disable-automatic-resolution",
  });
  expect(core).not.toHaveProperty("if");
  const gate = job.steps.find((step) => step.name === "Require successful portable native models");
  expect(gate.if).toBe("${{ !cancelled() }}");
  expect(gate.env).toEqual({ CORE_OUTCOME: "${{ steps.core.outcome }}" });
  expect(gate).not.toHaveProperty("continue-on-error");
  const sequence = [
    "Resolve SwiftPM packages",
    "Test portable native models",
    "Install XcodeGen",
    "Generate native project",
    "Build and exercise native application",
    "Require successful portable native models",
    "Assemble complete unsigned app and exercise bundled runtime",
    "Upload unsigned app for isolated QA",
  ];
  for (let index = 1; index < sequence.length; index++) {
    expect(names.indexOf(sequence[index])).toBeGreaterThan(names.indexOf(sequence[index - 1]));
  }
  // Default success gating keeps earlier setup failures from running UI, and any
  // UI/gate failure from assembling or uploading a package.
  const defaultGated = [
    ...job.steps.filter((step) => step.name?.startsWith("Prepare ")),
    ...[
      "Install build dependencies",
      "Resolve SwiftPM packages",
      ...sequence.slice(2, 5),
      ...sequence.slice(6),
    ].map((name) => job.steps.find((step) => step.name === name)),
  ];
  for (const step of defaultGated) {
    expect(step).toBeDefined();
    expect(step, step.name).not.toHaveProperty("if");
    expect(step, step.name).not.toHaveProperty("continue-on-error");
  }
});

test.skipIf(process.platform === "win32").each([
  ["success", 0],
  ["failure", 1],
  ["skipped", 1],
  ["cancelled", 1],
  ["", 1],
  ["unknown", 1],
])("actual Core outcome gate accepts only success (%s)", (outcome, status) => {
  const gate = job.steps.find((step) => step.name === "Require successful portable native models");
  const result = spawnSync(
    "/bin/bash",
    ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", gate.run],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { PATH: "/usr/bin:/bin", CORE_OUTCOME: outcome },
      encoding: "utf8",
      timeout: 3000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(status);
  if (status !== 0) expect(result.stderr).toContain("Portable native models did not pass");
});

test.skipIf(process.platform === "win32").each([
  { build: 0, testExit: 0, expected: 0 },
  { build: 0, testExit: 23, expected: 23 },
  { build: 19, testExit: 0, expected: 19 },
])(
  "actual CI build/schema/test chain preserves failure precedence (%j)",
  async ({ build, testExit, expected }) => {
    const root = await mkdtemp(join(tmpdir(), "omnesis-schema-ci-"));
    try {
      await mkdir(join(root, "build"));
      const script = job.steps.find(
        (step) => step.name === "Build and exercise native application",
      ).run;
      const result = spawnSync(
        "/bin/bash",
        [
          "--noprofile",
          "--norc",
          "-e",
          "-o",
          "pipefail",
          "-c",
          `
xcodebuild() { printf '%s\\n' "\${@: -1}" >> "$RECEIPT"; if [ "\${@: -1}" = build-for-testing ]; then return "$BUILD_EXIT"; fi; return "$TEST_EXIT"; }
python3() { printf 'schema\\n' >> "$RECEIPT"; return 77; }
node() { printf '{}\\n'; }
` + script,
        ],
        {
          cwd: root,
          env: {
            PATH: "/usr/bin:/bin",
            RECEIPT: join(root, "steps"),
            BUILD_EXIT: String(build),
            TEST_EXIT: String(testExit),
          },
          encoding: "utf8",
          timeout: 3000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(expected);
      expect((await readFile(join(root, "steps"), "utf8")).trim().split("\n")).toEqual(
        build === 0
          ? ["build-for-testing", "schema", "test-without-building"]
          : ["build-for-testing"],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("external AX control app is reachable only from the testing scheme action", async () => {
  const spec = parse(await readFile(new URL("../../macos/project.yml", import.meta.url), "utf8"));
  const fixture = "OmnesisAXControlFixture";
  const source = "Tests/Fixtures/ExternalAXControlApp.swift";
  const target = spec.targets[fixture];
  expect(target.type).toBe("application");
  expect(target.platform).toBe("macOS");
  expect(target.sources).toEqual([{ path: source }]);
  expect(target.dependencies ?? []).toEqual([]);
  expect(target.settings.base.SKIP_INSTALL).toBe("YES");
  expect(target.settings.base.PRODUCT_BUNDLE_IDENTIFIER).toBe(
    "dev.omnesis.desktop.ax-control-fixture",
  );
  const graph = (roots) => {
    const visited = new Set();
    const pending = [...roots];
    while (pending.length) {
      const name = pending.pop();
      if (visited.has(name)) continue;
      visited.add(name);
      for (const dependency of spec.targets[name]?.dependencies ?? []) {
        if (dependency.target) pending.push(dependency.target);
      }
    }
    return visited;
  };
  for (const scheme of Object.values(spec.schemes)) {
    const entries = Object.entries(scheme.build.targets);
    expect(entries.find(([name]) => name === fixture)?.[1]).toEqual(["test"]);
    for (const action of [
      "run",
      "running",
      "profile",
      "profiling",
      "analyze",
      "analyzing",
      "archive",
      "archiving",
    ]) {
      const roots = entries
        .filter(
          ([, selected]) =>
            selected === "all" || (Array.isArray(selected) && selected.includes(action)),
        )
        .map(([name]) => name);
      expect(graph(roots).has(fixture)).toBe(false);
    }
  }
  // The production application and both existing test bundles keep their source boundaries.
  for (const name of graph(["OmnesisDesktop", "OmnesisDesktopTests", "OmnesisDesktopUITests"])) {
    const current = spec.targets[name];
    for (const item of current.sources ?? []) {
      const path = typeof item === "string" ? item : item.path;
      expect(source === path || source.startsWith(path + "/")).toBe(false);
    }
    expect(JSON.stringify(current.postBuildScripts ?? [])).not.toContain(fixture);
  }
});

test("external AX diagnosis has an independent hosted job and runner-only opt-in", () => {
  const diagnostic = workflow.jobs["external-ax-control"];
  expect(diagnostic["runs-on"]).toBe("macos-26-intel");
  expect(diagnostic["timeout-minutes"]).toBe(20);
  expect(diagnostic).not.toHaveProperty("needs");
  expect(diagnostic).not.toHaveProperty("continue-on-error");
  expect(diagnostic).not.toHaveProperty("env");
  expect(diagnostic.steps[0].with).toEqual(job.steps[0].with);
  for (const step of diagnostic.steps.filter((step) => step.uses))
    expect(step.uses).toMatch(/@[a-f0-9]{40}$/u);
  const selected = diagnostic.steps.find((step) => step.id === "control-test");
  expect(selected.env).toEqual({ TEST_RUNNER_OMNESIS_EXTERNAL_AX_CONTROL_DIAGNOSTIC: "1" });
  expect(selected).not.toHaveProperty("continue-on-error");
  expect(selected.run.match(/-only-testing:[^\s]+/gu)).toEqual([
    "-only-testing:OmnesisDesktopUITests/DesktopExternalAXControlUITests/testStandardAppKitThenOwnedOmnesisCanBeQueriedInOneRunnerMethod",
  ]);
  for (const step of [...job.steps, ...diagnostic.steps.filter((step) => step !== selected)]) {
    expect(step.env ?? {}).not.toHaveProperty("TEST_RUNNER_OMNESIS_EXTERNAL_AX_CONTROL_DIAGNOSTIC");
    expect(step.env ?? {}).not.toHaveProperty("OMNESIS_EXTERNAL_AX_CONTROL_DIAGNOSTIC");
  }
  expect(
    diagnostic.steps.some((step) =>
      /swift test|prepare-runtime|smoke-runtime|assemble-app/u.test(step.run ?? ""),
    ),
  ).toBe(false);
  expect(diagnostic.steps.find((step) => step.id === "production-network").run).toBe(
    "scripts/ci/production-network.sh isolate",
  );
  expect(
    diagnostic.steps.find((step) => step.name === "Verify production network isolation").if,
  ).toBe("${{ always() && steps.production-network.outcome == 'success' }}");
  const upload = diagnostic.steps.find(
    (step) => step.name === "Upload bounded diagnostic receipts",
  );
  expect(upload.if).toBe("always()");
  expect(upload.with.path).toBe("evidence/external-ax-control/");
});

test.skipIf(process.platform === "win32").each([
  [{ totalTestCount: 1, passedTests: 1, failedTests: 0, skippedTests: 0 }, 0, 0],
  [{ totalTestCount: 0, passedTests: 0, failedTests: 0, skippedTests: 0 }, 0, 1],
  [{ totalTestCount: 1, passedTests: 0, failedTests: 0, skippedTests: 1 }, 0, 1],
  [{ totalTestCount: 1, passedTests: 0, failedTests: 1, skippedTests: 0 }, 0, 1],
  [{ totalTestCount: 2, passedTests: 2, failedTests: 0, skippedTests: 0 }, 0, 1],
  [{ totalTestCount: 1, passedTests: 1, failedTests: 0, skippedTests: 1 }, 0, 1],
  [{ totalTestCount: 1, passedTests: 1 }, 0, 1],
  ["invalid-json", 0, 1],
  [{ totalTestCount: 1, passedTests: 1, failedTests: 0, skippedTests: 0 }, 17, 1],
])(
  "actual diagnostic summary gate requires precisely one pass (%j, tool %s)",
  async (summary, toolExit, expected) => {
    const root = await mkdtemp(join(tmpdir(), "omnesis-ax-summary-"));
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      await writeFile(
        join(bin, "xcrun"),
        `#!/bin/sh\nprintf '%s' "$CONTROL_SUMMARY"\nexit "$CONTROL_TOOL_EXIT"\n`,
        { mode: 0o700 },
      );
      const gate = workflow.jobs["external-ax-control"].steps.find(
        (step) => step.name === "Require exactly one passed diagnostic and no skip",
      );
      expect(gate.if).toBe("${{ always() && steps.control-build.outcome == 'success' }}");
      const script = gate.run.split("node --input-type=module <<'NODE'\n")[1].split("\nNODE")[0];
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: root,
        env: {
          PATH: bin + ":/usr/bin:/bin",
          CONTROL_SUMMARY: typeof summary === "string" ? summary : JSON.stringify(summary),
          CONTROL_TOOL_EXIT: String(toolExit),
        },
        encoding: "utf8",
        timeout: 3000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(expected);
      const receipt = JSON.parse(
        await readFile(join(root, "evidence/external-ax-control/qualification.json"), "utf8"),
      );
      expect(receipt.qualified).toBe(expected === 0);
      expect(receipt.scope).toBe("external-ax-control-diagnostic-only");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32").each([0, 23])(
  "diagnostic signing receipt never masks xcodebuild status %s",
  async (status) => {
    const root = await mkdtemp(join(tmpdir(), "omnesis-ax-status-"));
    try {
      await mkdir(join(root, "evidence/external-ax-control"), { recursive: true });
      await mkdir(join(root, "macos"));
      const script = workflow.jobs["external-ax-control"].steps.find(
        (step) => step.id === "control-test",
      ).run;
      const result = spawnSync(
        "/bin/bash",
        [
          "--noprofile",
          "--norc",
          "-e",
          "-o",
          "pipefail",
          "-c",
          `
xcodebuild() { return "$CONTROL_XCODE_STATUS"; }
node() { printf '{}\n'; }
` + script,
        ],
        {
          cwd: join(root, "macos"),
          env: { PATH: "/usr/bin:/bin", CONTROL_XCODE_STATUS: String(status) },
          encoding: "utf8",
          timeout: 3000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(status);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
