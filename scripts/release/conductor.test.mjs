// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  assertDesktopRecoveryRun,
  desktopRecoveryArchitectures,
  readDesktopRecoveryRun,
  parseArgs,
} from "./conductor.mjs";
import { formatReleasePrBody, formatTagDryRun, formatVersionDryRun } from "./plan.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const conductor = join(scriptDir, "conductor.mjs");

function runConductor(args) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [conductor, ...args], { encoding: "utf8" }),
    };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

test("parses the subcommand, its version argument and every flag", () => {
  expect(parseArgs(["version", "1.2.3", "--dry-run"])).toEqual({
    subcommand: "version",
    options: { dryRun: true, sign: false, allowFailedInstallE2e: false, requestedVersion: "1.2.3" },
  });
  expect(parseArgs(["tag", "--sign"]).options.sign).toBe(true);
  expect(parseArgs(["tag", "--allow-failed-install-e2e"]).options.allowFailedInstallE2e).toBe(true);
  expect(parseArgs(["status", "--registry", "http://localhost:4873"]).options.registry).toBe(
    "http://localhost:4873",
  );
  expect(parseArgs(["status", "--store-versions", '{"ios":"1.2.3"}']).options.storeVersions).toBe(
    '{"ios":"1.2.3"}',
  );
  expect(parseArgs(["github-release", "1.2.3", "--run", "42"]).options).toMatchObject({
    requestedVersion: "1.2.3",
    runId: "42",
  });
});

test("rejects an unknown flag and a second positional argument", () => {
  expect(() => parseArgs(["plan", "--publish"])).toThrow(/Unknown flag/u);
  expect(() => parseArgs(["tag", "1.2.3", "1.2.4"])).toThrow(/Unexpected argument/u);
});

test("a version dry run prints the exact sequence the real run would execute", () => {
  const rendered = formatVersionDryRun({
    productVersion: "0.4.0",
    targetVersion: "0.5.0",
    pendingCount: 2,
    staleNativePaths: ["ios/project.yml", "android/app/build.gradle.kts"],
  });
  expect(rendered).toContain("npx changeset version   (2 pending)");
  expect(rendered).toContain("npm install --package-lock-only");
  expect(rendered).toContain("write 0.5.0 into ios/project.yml");
  expect(rendered).toContain("write 0.5.0 into android/app/build.gradle.kts");
  expect(rendered).toContain("check-product-version.mjs v0.5.0");
  expect(rendered).toMatch(/Dry run — nothing written\.$/u);
});

test("a version dry run with nothing pending omits the changeset step", () => {
  const rendered = formatVersionDryRun({
    productVersion: "0.5.0",
    targetVersion: "0.5.0",
    pendingCount: 0,
    staleNativePaths: [],
  });
  expect(rendered).not.toContain("changeset version");
  expect(rendered).toContain("native project files already carry this version");
});

test("a settled dry run does not promise a lockfile refresh the real run skips", () => {
  const rendered = formatVersionDryRun({
    productVersion: "0.5.0",
    targetVersion: "0.5.0",
    pendingCount: 0,
    staleNativePaths: [],
    settled: true,
  });
  expect(rendered).not.toContain("--package-lock-only");
  expect(rendered).toContain("sync-plugin-versions.mjs");
});

test("a tag dry run never suggests pushing, and says whether it would sign", () => {
  const unsigned = formatTagDryRun({ tag: "v0.5.0", version: "0.5.0", sign: false });
  expect(unsigned).toContain('git tag -a v0.5.0 -m "Omnesis 0.5.0"');
  expect(unsigned).toContain("never pushed by this script");
  expect(unsigned).not.toContain("git push");
  expect(formatTagDryRun({ tag: "v0.5.0", version: "0.5.0", sign: true })).toContain("git tag -s");
});

test("the PR body carries the changelog section and what merging sets in motion", () => {
  const body = formatReleasePrBody("0.5.0", "- Something shipped.");
  expect(body).toContain("Release `v0.5.0`.");
  expect(body).toContain("- Something shipped.");
  expect(body).toContain("npm run release -- tag");
  expect(formatReleasePrBody("0.5.0", null)).toContain("No changelog section for this version yet");
});

test("an unknown subcommand prints the usage and exits non-zero", () => {
  const result = runConductor(["publish"]);
  expect(result.code).toBe(2);
  expect(result.out).toMatch(/Unknown subcommand: publish/u);
  expect(result.out).toMatch(/npm run release -- <subcommand>/u);
});

test("no subcommand prints the usage", () => {
  expect(runConductor([]).out).toMatch(/plan \[x\.y\.z\]/u);
});

test("the tag dry run changes nothing in the repository", () => {
  const before = execFileSync("git", ["status", "--porcelain"], {
    cwd: join(scriptDir, "..", ".."),
    encoding: "utf8",
  });
  const result = runConductor(["tag", "99.0.0", "--dry-run"]);
  expect(result.code).toBe(0);
  expect(result.out).toContain("Would preflight and create v99.0.0");
  expect(
    execFileSync("git", ["status", "--porcelain"], {
      cwd: join(scriptDir, "..", ".."),
      encoding: "utf8",
    }),
  ).toBe(before);
});

test("the version command refuses a version that is not strict SemVer", () => {
  const result = runConductor(["version", "1.2", "--dry-run"]);
  expect(result.code).toBe(1);
  expect(result.out).toMatch(/strict SemVer/u);
});

const desktopRecoveryBinding = { version: "1.2.3", sha: "a".repeat(40) };
const completedReleaseJobs = [
  { name: "verify", conclusion: "success" },
  { name: "packages", conclusion: "success" },
  { name: "images (gateway, amd64)", conclusion: "success" },
  { name: "images-manifest (gateway)", conclusion: "success" },
  { name: "desktop (arm64)", conclusion: "success" },
  { name: "desktop (x64)", conclusion: "success" },
];
test("manual desktop recovery cannot bypass same-run policy, both architectures or source binding", () => {
  const policy = { ...desktopRecoveryBinding, format: 1, enabled: true };
  expect(
    desktopRecoveryArchitectures(completedReleaseJobs, policy, desktopRecoveryBinding),
  ).toEqual(["arm64", "x64"]);
  expect(() =>
    desktopRecoveryArchitectures(completedReleaseJobs, null, desktopRecoveryBinding),
  ).toThrow(/missing/);
  expect(() =>
    desktopRecoveryArchitectures(
      completedReleaseJobs,
      { ...policy, sha: "b".repeat(40) },
      desktopRecoveryBinding,
    ),
  ).toThrow(/another release/);
  expect(() =>
    desktopRecoveryArchitectures(
      completedReleaseJobs,
      { ...policy, enabled: false },
      desktopRecoveryBinding,
    ),
  ).toThrow(/conflicts/);
  for (const conclusion of ["skipped", "failure"])
    expect(() =>
      desktopRecoveryArchitectures(
        completedReleaseJobs.map((job) =>
          job.name === "desktop (x64)" ? { ...job, conclusion } : job,
        ),
        policy,
        desktopRecoveryBinding,
      ),
    ).toThrow(/desktop/);
});
test("legacy and explicitly disabled headless recovery do not require desktop artifacts", () => {
  const legacy = completedReleaseJobs.filter((job) => !job.name.startsWith("desktop"));
  expect(desktopRecoveryArchitectures(legacy, null, desktopRecoveryBinding)).toEqual([]);
  expect(
    desktopRecoveryArchitectures(
      legacy,
      { ...desktopRecoveryBinding, enabled: false },
      desktopRecoveryBinding,
    ),
  ).toEqual([]);
});

test("desktop recovery rejects foreign-repository and lookalike-workflow evidence", () => {
  const run = {
    html_url: "https://github.com/omnesis-dev/Omnesis/actions/runs/123",
    path: ".github/workflows/release.yml",
    event: "push",
    head_sha: desktopRecoveryBinding.sha,
    head_branch: "v1.2.3",
  };
  expect(() => assertDesktopRecoveryRun(run, "123", desktopRecoveryBinding.sha)).not.toThrow();
  for (const change of [
    { html_url: "https://github.com/example/fork/actions/runs/123" },
    { path: ".github/workflows/lookalike.yml" },
    { head_sha: "b".repeat(40) },
    { event: "pull_request" },
    { event: "workflow_dispatch", head_branch: "feature" },
  ])
    expect(() =>
      assertDesktopRecoveryRun({ ...run, ...change }, "123", desktopRecoveryBinding.sha),
    ).toThrow();
  expect(() =>
    assertDesktopRecoveryRun(
      { ...run, event: "workflow_dispatch", head_branch: "main" },
      "123",
      desktopRecoveryBinding.sha,
    ),
  ).not.toThrow();
});

test("enabled recovery replaces hostile default-host success with actual canonical job evidence", () => {
  const claimed = {
    workflowName: "release",
    url: "https://github.com/omnesis-dev/Omnesis/actions/runs/123",
    jobs: completedReleaseJobs,
  };
  const calls = [];
  const read = (command, args) => {
    calls.push(args);
    if (args[0] === "run")
      return JSON.stringify({
        ...claimed,
        jobs: completedReleaseJobs.map((job) =>
          job.name === "desktop (x64)" ? { ...job, conclusion: "failure" } : job,
        ),
      });
    return JSON.stringify({
      html_url: claimed.url,
      path: ".github/workflows/release.yml",
      event: "push",
      head_sha: desktopRecoveryBinding.sha,
    });
  };
  expect(() => readDesktopRecoveryRun("123", desktopRecoveryBinding.sha, read)).toThrow(/desktop/);
  expect(calls[0]).toContain("github.com/omnesis-dev/Omnesis");
  expect(calls[1][calls[1].indexOf("--hostname") + 1]).toBe("github.com");
  expect(claimed.jobs.every((job) => job.conclusion === "success")).toBe(true);
});
