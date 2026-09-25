// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkProductVersion } from "./check-product-version.mjs";
import { ActionsRunsError, readWorkflowRuns, runGh } from "./actions-runs.mjs";
import { RERUN_COMMAND, formatVerdict, fullCiVerdict } from "./ci-verdict.mjs";
import { OVERRIDE_FLAG, checkInstallE2eGate } from "./install-e2e-gate.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function runGit(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * Everything that must hold before `tag` is created on HEAD. Returns the
 * verified commit and the lines to show the operator; throws the refusal.
 *
 * Two workflow verdicts are read from the Actions API. The exact commit must
 * have a green `full-validation` run — release verification re-checks it, so
 * nothing overrides it here. And the install/update lanes on `main` must not
 * be red (`install-e2e-gate.mjs`); `allowFailedInstallE2e` overrides only that
 * refusal, for an emergency release.
 */
export function preflightTag(
  root = defaultRoot,
  tag,
  {
    git = runGit,
    checkVersion = checkProductVersion,
    gh = runGh,
    allowFailedInstallE2e = false,
  } = {},
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
  let runs;
  try {
    runs = readWorkflowRuns(root, gh, "full-validation.yml", `head_sha=${sha}&per_page=100`);
  } catch (error) {
    if (error instanceof ActionsRunsError) {
      throw new Error(`Could not read the full-validation runs: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
  const verdict = fullCiVerdict(runs, sha);
  if (!verdict.ok) throw new Error(releaseVerdictBlocker(tag, sha, verdict));
  const notes = [
    formatVerdict(verdict),
    ...checkInstallE2eGate(root, { allowFailed: allowFailedInstallE2e, gh }),
  ];
  return { sha, notes };
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

// `node preflight-tag.mjs v<version> [--allow-failed-install-e2e]`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [tag, ...flags] = process.argv.slice(2);
  const unknown = flags.filter((flag) => flag !== OVERRIDE_FLAG);
  if (!tag || unknown.length > 0) {
    process.stderr.write(`Usage: preflight-tag.mjs v<version> [${OVERRIDE_FLAG}]\n`);
    process.exit(2);
  }
  const { sha, notes } = preflightTag(defaultRoot, tag, {
    allowFailedInstallE2e: flags.includes(OVERRIDE_FLAG),
  });
  for (const line of notes) process.stdout.write(`${line}\n`);
  process.stdout.write(`Release preflight passed: ${tag} -> ${sha}\n`);
}
