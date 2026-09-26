// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The GitHub Actions workflow-runs listing, as the release preflight reads it.
 *
 * Every release check that rests on a workflow's verdict reads it through
 * `gh api`, so the operator's own `gh` login is the only credential involved.
 * A listing that cannot be read throws an `ActionsRunsError` naming why; each
 * gate decides what that means for the release.
 */

import { spawnSync } from "node:child_process";

export class ActionsRunsError extends Error {}

/** `gh` in `root`, as `{ code, stdout, stderr }`; a missing binary is a failure. */
export function runGh(root, args) {
  const result = spawnSync("gh", args, { cwd: root, encoding: "utf8" });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr || result.error?.message || "",
  };
}

/**
 * The runs of `workflow` (a file name under `.github/workflows/`) that match
 * `query`, a URL query string such as `head_sha=…&per_page=100`.
 */
export function readWorkflowRuns(root, gh, workflow, query) {
  const listing = gh(root, [
    "api",
    `repos/{owner}/{repo}/actions/workflows/${workflow}/runs?${query}`,
  ]);
  if (listing.code !== 0) {
    throw new ActionsRunsError(listing.stderr.trim() || `gh exited ${listing.code}`);
  }
  let runs;
  try {
    runs = JSON.parse(listing.stdout).workflow_runs;
  } catch {
    throw new ActionsRunsError("the answer was not JSON");
  }
  if (!Array.isArray(runs)) throw new ActionsRunsError("the answer carried no run list");
  return runs;
}
