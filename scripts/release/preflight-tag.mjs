// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkProductVersion } from "./check-product-version.mjs";
import { RERUN_COMMAND, fullCiVerdict } from "./ci-verdict.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function runCommand(command) {
  return (root, args) => {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
    return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

const runGit = runCommand("git");
const runGh = runCommand("gh");

export function preflightTag(
  root = defaultRoot,
  tag,
  git = runGit,
  checkVersion = checkProductVersion,
  gh = runGh,
) {
  checkVersion(root, tag);
  const fetch = git(root, ["fetch", "origin", "main:refs/remotes/origin/main", "--tags"]);
  if (fetch.code !== 0)
    throw new Error(`Could not fetch origin/main and tags: ${fetch.stderr.trim()}`);

  const status = git(root, ["status", "--porcelain"]);
  if (status.code !== 0 || status.stdout.trim()) throw new Error("Release checkout is not clean");
  const head = git(root, ["rev-parse", "HEAD"]);
  const main = git(root, ["rev-parse", "origin/main"]);
  if (head.code !== 0 || main.code !== 0 || head.stdout.trim() !== main.stdout.trim()) {
    throw new Error("HEAD is not the exact fetched origin/main commit");
  }
  if (git(root, ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`]).code === 0) {
    throw new Error(`Local tag ${tag} already exists`);
  }
  const remoteTag = git(root, ["ls-remote", "--tags", "--refs", "origin", `refs/tags/${tag}`]);
  if (remoteTag.code !== 0) throw new Error(`Could not inspect remote tag ${tag}`);
  if (remoteTag.stdout.trim()) throw new Error(`Remote tag ${tag} already exists`);
  const sha = head.stdout.trim();
  // The release workflow re-checks this same verdict before publishing, but a
  // tag pushed without one burns a version number on a run that can only fail.
  // Refuse here, naming what to do instead.
  const listing = gh(root, [
    "api",
    `repos/{owner}/{repo}/actions/workflows/full-validation.yml/runs?head_sha=${sha}&per_page=100`,
  ]);
  if (listing.code !== 0)
    throw new Error(`Could not read the full-validation runs: ${listing.stderr.trim()}`);
  let runs;
  try {
    runs = JSON.parse(listing.stdout).workflow_runs;
  } catch {
    throw new Error("Could not parse the full-validation runs");
  }
  const verdict = fullCiVerdict(runs, sha);
  if (!verdict.ok) throw new Error(releaseVerdictBlocker(tag, sha, verdict));
  return sha;
}

function releaseVerdictBlocker(tag, sha, verdict) {
  const run = verdict.url ? ` (${verdict.url})` : "";
  if (verdict.state === "missing") {
    return (
      `No full-validation run for ${sha} — a newer push may have superseded it. ` +
      `Start one with \`${RERUN_COMMAND}\` and retry once it is green; ` +
      `pushing ${tag} now would fail release verification.`
    );
  }
  if (verdict.state === "running") {
    return `Full validation for ${sha} is still running${run}; retry once it is green.`;
  }
  return (
    `Full validation for ${sha} ended as ${verdict.state}${run} — only a green run can ` +
    `release ${tag}. Rerun it with \`${RERUN_COMMAND}\` once the cause is fixed.`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tag = process.argv[2];
  const sha = preflightTag(defaultRoot, tag);
  process.stdout.write(`Release preflight passed: ${tag} -> ${sha}\n`);
}
