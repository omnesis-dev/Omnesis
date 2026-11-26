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
import { spawnSync } from "node:child_process";
import {
  assertUploadedReleaseAssets,
  desktopReleaseArtifacts,
  inspectReleaseFile,
  readDesktopReleasePolicy,
} from "./desktop-artifacts.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readChangelogSection } from "./changelog.mjs";

const INSTALLER = "artifacts/install.sh";

/**
 * The checksum lines the release page lists. The tarballs are listed only when
 * the packages were published: they stay a workflow artifact, so a checksum
 * for a tarball nobody can install from the registry would describe nothing.
 */
export function attachedChecksums(sums, packagesPublished, desktop = []) {
  const desktopLines = desktop.map(
    (item) => `${item.sha256}  desktop/${item.architecture}/${item.name}`,
  );
  const lines = sums.split(/\r?\n/u).filter(Boolean);
  for (const line of lines.filter((line) => /\sdesktop\//u.test(line)))
    if (!desktopLines.includes(line)) throw new Error("Unexpected desktop checksum entry");
  sums = lines.filter((line) => !/\sdesktop\//u.test(line)).join("\n") + "\n";
  if (desktopLines.length) {
    const base = attachedChecksums(sums, packagesPublished);
    return base + desktopLines.join("\n") + "\n";
  }
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
export function writeReleaseFiles(releaseDir, section, packagesPublished, binding) {
  const desktop = desktopReleaseArtifacts(releaseDir, binding ?? {});
  const sumsPath = join(releaseDir, "SHA256SUMS.txt");
  const sums = attachedChecksums(readFileSync(sumsPath, "utf8"), packagesPublished, desktop);
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
export function releaseRunEvidence(jobs, desktopRequired = false) {
  if (desktopRequired) {
    for (const architecture of ["arm64", "x64"]) {
      const found = jobs.filter((job) => job.name === `desktop (${architecture})`);
      if (found.length !== 1 || found[0].conclusion !== "success")
        return { refusal: `the run's desktop (${architecture}) job did not succeed` };
    }
  }
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

/** Fixed public GitHub endpoint; callers cannot redirect the publication credential. */
const RELEASE_REPOSITORY = "repos/omnesis-dev/Omnesis";
function runReleaseGh(args) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error("GitHub release command could not complete");
  return { code: result.status, stdout: result.stdout ?? "" };
}
function releaseApi(gh, endpoint, allowMissing = false) {
  const result = gh([
    "api",
    "--include",
    `${RELEASE_REPOSITORY}/${endpoint}`,
    "--hostname",
    "github.com",
  ]);
  const match = /^HTTP\/[\d.]+ (\d{3})[^\r\n]*\r?\n[\s\S]*?\r?\n\r?\n([\s\S]*)$/u.exec(
    result.stdout,
  );
  if (allowMissing && match?.[1] === "404") return null;
  if (result.code !== 0 || match?.[1] !== "200")
    throw new Error("GitHub release metadata is unavailable");
  try {
    return JSON.parse(match[2]);
  } catch {
    throw new Error("GitHub release metadata is invalid");
  }
}
/** The tag REST endpoint returns published releases; draft lookup needs its GraphQL database ID. */
function findDesktopRelease(gh, tag) {
  const published = releaseApi(gh, `releases/tags/${tag}`, true);
  if (published) return published;
  const result = gh([
    "api",
    "graphql",
    "--hostname",
    "github.com",
    "-f",
    'query=query($tag:String!){repository(owner:"omnesis-dev",name:"Omnesis"){release(tagName:$tag){databaseId,isDraft}}}',
    "-f",
    `tag=${tag}`,
  ]);
  let reply;
  try {
    reply = JSON.parse(result.stdout);
  } catch {
    throw new Error("GitHub draft metadata is invalid");
  }
  if (
    result.code !== 0 ||
    reply.errors?.length ||
    !reply.data?.repository ||
    !Object.hasOwn(reply.data.repository, "release")
  )
    throw new Error("GitHub draft metadata is unavailable");
  const draft = reply.data.repository.release;
  if (draft === null) return null;
  if (!Number.isSafeInteger(draft.databaseId) || draft.databaseId < 1 || draft.isDraft !== true)
    throw new Error("GitHub draft identity is unverified");
  return releaseApi(gh, `releases/${draft.databaseId}`);
}
function releaseCommand(gh, args) {
  if (gh(args).code !== 0) throw new Error("GitHub release upload or publication did not complete");
}
function assertRemoteReleaseTag(gh, tag, sha) {
  let object = releaseApi(gh, `git/ref/tags/${tag}`).object;
  for (let depth = 0; object?.type === "tag" && depth < 4; depth++) {
    if (!/^[a-f0-9]{40}$/u.test(object.sha)) throw new Error("Remote release tag is invalid");
    object = releaseApi(gh, `git/tags/${object.sha}`).object;
  }
  if (object?.type !== "commit" || object.sha !== sha)
    throw new Error("Remote release tag changed from the verified revision");
}
/** Enabled desktop releases stay drafts until every actual GitHub asset digest is verified. */
export function publishDesktopGitHubRelease({ directory, version, sha, gh = runReleaseGh }) {
  const policy = readDesktopReleasePolicy(directory);
  if (!policy?.enabled) throw new Error("Desktop publication requires its same-run enabled policy");
  const desktop = desktopReleaseArtifacts(directory, { version, sha });
  const tag = `v${version}`;
  const files = [
    ...desktop,
    ...[
      ["install.sh", "artifacts/install.sh"],
      ["SHA256SUMS.txt", "SHA256SUMS.txt"],
    ].map(([name, relative]) => {
      const path = join(directory, relative);
      return { name, path, ...inspectReleaseFile(path, 8 * 1024 * 1024) };
    }),
  ];
  inspectReleaseFile(join(directory, "NOTES.md"), 8 * 1024 * 1024);
  assertRemoteReleaseTag(gh, tag, sha);
  let release = findDesktopRelease(gh, tag);
  if (!release) {
    releaseCommand(gh, [
      "release",
      "create",
      tag,
      "--repo",
      "github.com/omnesis-dev/Omnesis",
      "--draft",
      "--verify-tag",
      "--target",
      sha,
      "--title",
      `Omnesis ${version}`,
      "--notes-file",
      join(directory, "NOTES.md"),
    ]);
    release = findDesktopRelease(gh, tag);
  }
  const validateBinding = (value) => {
    if (
      value.tag_name !== tag ||
      value.target_commitish !== sha ||
      value.prerelease !== false ||
      typeof value.draft !== "boolean" ||
      !Number.isSafeInteger(value.id) ||
      value.id < 1 ||
      !Array.isArray(value.assets)
    )
      throw new Error("GitHub release belongs to another publication binding");
  };
  validateBinding(release);
  if (!release.draft) {
    assertUploadedReleaseAssets(release, files);
    return;
  }
  // Never overwrite an existing attachment, including a conflicting partial upload.
  for (const asset of release.assets) {
    const expected = files.find((file) => file.name === asset.name);
    if (!expected) throw new Error("GitHub release has an unexpected attachment");
    assertUploadedReleaseAssets({ assets: [asset] }, [expected]);
  }
  for (const file of files) {
    if (release.assets.some((asset) => asset.name === file.name)) continue;
    // The private local artifact is verified again immediately before upload.
    const actual = inspectReleaseFile(file.path);
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256)
      throw new Error("Release attachment changed before upload");
    releaseCommand(gh, [
      "release",
      "upload",
      tag,
      file.path,
      "--repo",
      "github.com/omnesis-dev/Omnesis",
    ]);
  }
  release = releaseApi(gh, `releases/${release.id}`);
  validateBinding(release);
  assertUploadedReleaseAssets(release, files);
  assertRemoteReleaseTag(gh, tag, sha);
  // GitHub's legacy selection keeps semver ordering when finishing an older interrupted release.
  releaseCommand(gh, [
    "api",
    "--method",
    "PATCH",
    `${RELEASE_REPOSITORY}/releases/${release.id}`,
    "--hostname",
    "github.com",
    "-F",
    "draft=false",
    "-f",
    "make_latest=legacy",
  ]);
  const published = releaseApi(gh, `releases/${release.id}`);
  validateBinding(published);
  if (published.draft) throw new Error("GitHub release is still a draft");
  assertUploadedReleaseAssets(published, files);
}

if (import.meta.main) {
  try {
    const releaseDir = process.argv[2];
    const tag = process.env.RELEASE_TAG ?? "";
    if (
      !releaseDir ||
      !/^v\d/u.test(tag) ||
      process.argv.slice(3).some((arg) => arg !== "--publish-desktop")
    )
      throw new Error(
        "Usage: RELEASE_TAG=vX.Y.Z github-release.mjs <release-dir> [--publish-desktop]",
      );
    const binding = { version: tag.slice(1), sha: process.env.RELEASE_SHA };
    const section = readChangelogSection(process.cwd(), binding.version);
    writeReleaseFiles(releaseDir, section, process.env.PACKAGES_PUBLISHED === "true", binding);
    if (process.argv.includes("--publish-desktop"))
      publishDesktopGitHubRelease({ directory: releaseDir, ...binding });
  } catch {
    console.error(
      "Release composition or publication refused; verify its artifacts and release binding.",
    );
    process.exitCode = 1;
  }
}
