#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The GitHub Release page's notes and checksum list, composed once for both
 * callers: the release workflow's `github-release` job, and
 * `npm run release -- github-release`, which finishes a run whose own release
 * step could not create the page.
 *
 * The workflow calls this file with the release artifact directory:
 *
 *   PACKAGES_PUBLISHED=true|false RELEASE_TAG=vX.Y.Z \
 *     node scripts/release/github-release.mjs release
 *
 * It narrows `SHA256SUMS.txt` to what the page attaches and writes `NOTES.md`.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readChangelogSection } from "./changelog.mjs";

const INSTALLER = "artifacts/install.sh";

/**
 * The checksum lines the release page lists. The tarballs are listed only when
 * the packages were published: they stay a workflow artifact, so a checksum
 * for a tarball nobody can install from the registry would describe nothing.
 */
export function attachedChecksums(sums, packagesPublished) {
  if (packagesPublished) return sums;
  const installer = sums.split(/\r?\n/u).filter((line) => line.endsWith(` ${INSTALLER}`));
  if (installer.length !== 1) {
    throw new Error(`SHA256SUMS.txt must list ${INSTALLER} exactly once`);
  }
  return `${installer[0]}\n`;
}

/** The release body: the changelog section, then the attached checksums. */
export function composeReleaseNotes(section, sums) {
  const body = section ?? "_No changelog section for this version._";
  return `${body}\n\n## Checksums (SHA-256)\n\n\`\`\`\n${sums.trim()}\n\`\`\`\n`;
}

/** Refuse an installer whose bytes are not the ones the checksum list names. */
export function assertInstallerChecksum(releaseDir, sums) {
  const line = sums.split(/\r?\n/u).find((entry) => entry.endsWith(` ${INSTALLER}`));
  const expected = line?.split(/\s+/u)[0];
  const actual = createHash("sha256")
    .update(readFileSync(join(releaseDir, INSTALLER)))
    .digest("hex");
  if (expected !== actual) {
    throw new Error(`${INSTALLER} does not match its SHA-256 in SHA256SUMS.txt`);
  }
}

/**
 * Narrow `<releaseDir>/SHA256SUMS.txt` in place and write `<releaseDir>/NOTES.md`
 * from `section`. Returns the notes.
 */
export function writeReleaseFiles(releaseDir, section, packagesPublished) {
  const sumsPath = join(releaseDir, "SHA256SUMS.txt");
  const sums = attachedChecksums(readFileSync(sumsPath, "utf8"), packagesPublished);
  assertInstallerChecksum(releaseDir, sums);
  writeFileSync(sumsPath, sums);
  const notes = composeReleaseNotes(section, sums);
  writeFileSync(join(releaseDir, "NOTES.md"), notes);
  return notes;
}

/**
 * Whether a release workflow run got far enough for its release page to be
 * created by hand: the same jobs the `github-release` job waits for. `jobs` is
 * the `jobs` array of `gh run view --json jobs`. Returns the refusal, or
 * whether the run published the npm packages (a `Publish to …` step of the
 * `packages` job that succeeded rather than being skipped).
 */
export function releaseRunEvidence(jobs) {
  const byName = (pattern) => jobs.filter((job) => pattern.test(job.name));
  const settled = (pattern, allowSkipped) => {
    const found = byName(pattern);
    return (
      found.length > 0 &&
      found.every(
        (job) => job.conclusion === "success" || (allowSkipped && job.conclusion === "skipped"),
      )
    );
  };
  for (const [label, pattern, allowSkipped] of [
    ["verify", /^verify$/u, false],
    ["packages", /^packages$/u, false],
    ["images", /^images \(/u, false],
    ["images-manifest", /^images-manifest\b/u, true],
  ]) {
    if (!settled(pattern, allowSkipped)) {
      return { refusal: `the run's ${label} job${label === "verify" ? "" : "s"} did not succeed` };
    }
  }
  const packagesPublished = byName(/^packages$/u).some((job) =>
    (job.steps ?? []).some(
      (step) => /^Publish to /u.test(step.name) && step.conclusion === "success",
    ),
  );
  return { packagesPublished };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const releaseDir = process.argv[2];
    const tag = process.env.RELEASE_TAG ?? "";
    if (!releaseDir || !/^v\d/u.test(tag)) {
      throw new Error("Usage: RELEASE_TAG=vX.Y.Z github-release.mjs <release-dir>");
    }
    const section = readChangelogSection(process.cwd(), tag.slice(1));
    console.log(writeReleaseFiles(releaseDir, section, process.env.PACKAGES_PUBLISHED === "true"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
