// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  attachedChecksums,
  composeReleaseNotes,
  releaseRunEvidence,
  writeReleaseFiles,
} from "./github-release.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function releaseDir(installer = "#!/bin/sh\n") {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-github-release-test-"));
  dirs.push(dir);
  mkdirSync(join(dir, "artifacts"));
  writeFileSync(join(dir, "artifacts/install.sh"), installer);
  const sum = createHash("sha256").update(installer).digest("hex");
  writeFileSync(
    join(dir, "SHA256SUMS.txt"),
    `${sum}  artifacts/install.sh\n${"b".repeat(64)}  tarballs/omnesis-1.2.3.tgz\n`,
  );
  return dir;
}

test("lists the tarball sums only when the packages were published", () => {
  const sums = `${"a".repeat(64)}  artifacts/install.sh\n${"b".repeat(64)}  tarballs/x-1.2.3.tgz\n`;
  expect(attachedChecksums(sums, true)).toBe(sums);
  expect(attachedChecksums(sums, false)).toBe(`${"a".repeat(64)}  artifacts/install.sh\n`);
  expect(() => attachedChecksums(`${"b".repeat(64)}  tarballs/x.tgz\n`, false)).toThrow(
    /exactly once/u,
  );
});

test("the notes are the changelog section, then the attached checksums", () => {
  expect(composeReleaseNotes("- a change", "abc  artifacts/install.sh\n")).toBe(
    "- a change\n\n## Checksums (SHA-256)\n\n```\nabc  artifacts/install.sh\n```\n",
  );
  expect(composeReleaseNotes(null, "abc  x\n")).toMatch(/^_No changelog section/u);
});

test("writes the narrowed checksum list and the notes beside the artifacts", () => {
  const dir = releaseDir();
  const notes = writeReleaseFiles(dir, "- a change", false);
  expect(readFileSync(join(dir, "SHA256SUMS.txt"), "utf8")).not.toContain("tarballs/");
  expect(readFileSync(join(dir, "NOTES.md"), "utf8")).toBe(notes);
});

test("refuses an installer that does not match its checksum", () => {
  const dir = releaseDir();
  writeFileSync(join(dir, "artifacts/install.sh"), "#!/bin/sh\necho changed\n");
  expect(() => writeReleaseFiles(dir, "- a change", false)).toThrow(/does not match/u);
});

const job = (name, conclusion, steps = []) => ({ name, conclusion, steps });
const finished = [
  job("verify", "success"),
  job("packages", "success", [{ name: "Publish to npmjs with provenance", conclusion: "skipped" }]),
  job("images (gateway, amd64)", "success"),
  job("images (gateway, arm64)", "success"),
  job("images-manifest (gateway)", "success"),
  job("github-release", "failure"),
];

test("a run is finishable once the jobs the release page waits for succeeded", () => {
  expect(releaseRunEvidence(finished)).toEqual({ packagesPublished: false });
  // A rehearsal without image publication skips the manifest jobs.
  const rehearsal = finished.map((entry) =>
    entry.name.startsWith("images-manifest") ? { ...entry, conclusion: "skipped" } : entry,
  );
  expect(releaseRunEvidence(rehearsal).refusal).toBeUndefined();
  const published = finished.map((entry) =>
    entry.name === "packages"
      ? job("packages", "success", [
          { name: "Publish to npmjs with provenance", conclusion: "success" },
        ])
      : entry,
  );
  expect(releaseRunEvidence(published)).toEqual({ packagesPublished: true });
});

test("refuses a run whose images or manifests did not finish", () => {
  const failedImage = finished.map((entry) =>
    entry.name === "images (gateway, arm64)" ? { ...entry, conclusion: "failure" } : entry,
  );
  expect(releaseRunEvidence(failedImage).refusal).toMatch(/images jobs/u);
  const failedManifest = finished.map((entry) =>
    entry.name.startsWith("images-manifest") ? { ...entry, conclusion: "failure" } : entry,
  );
  expect(releaseRunEvidence(failedManifest).refusal).toMatch(/images-manifest/u);
  expect(releaseRunEvidence(finished.filter((entry) => entry.name !== "verify")).refusal).toMatch(
    /verify job/u,
  );
});
