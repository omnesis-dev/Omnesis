// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  expect(uploads).toHaveLength(2);
  const names = matrix.flatMap(({ arch }) =>
    uploads.map((step) => {
      expect(step.with.name).toContain("${{ matrix.arch }}");
      return step.with.name.replaceAll("${{ matrix.arch }}", arch);
    }),
  );
  expect(new Set(names).size).toBe(4);
  expect(uploads[0].with.path).toBe("${{ runner.temp }}/Omnesis-unsigned.zip");
  expect(uploads[1].if).toBe("always()");
  expect(uploads[1].with.path.trim().split("\n")).toEqual([
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
