// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The release gate on the install/update lane.
 *
 * `.github/workflows/install-e2e.yml` runs every night on `main`, including the
 * two-machine tailnet lanes that never run on pull requests. A release cut
 * while the newest completed full run is red would ship an install or update
 * path known to be broken, so `npm run release -- tag` refuses it, naming the
 * run. A full run is the nightly schedule or a manual dispatch of every lane
 * on `main` (its run name says `lanes: all`), so a fix can clear the gate
 * without waiting for the next night. A push to `main` that touched the
 * installer runs the single-host lanes; when that run is newer than the full
 * run and red, it blocks too. A run that was cancelled says nothing either
 * way and is passed over for the one before it. With no full run at all yet
 * there is no evidence of breakage, and the tag proceeds with a warning; runs
 * that cannot be read refuse the tag, since that is no evidence either.
 *
 * One lane judges the release already published rather than the candidate:
 * D2 runs this checkout's installer over the newest published images, because
 * building them under Colima on an Intel runner takes longer than the job may
 * run. A red D2 is a bug in what users already have, so it must not block the
 * release that fixes it. A run whose only failed jobs are such lanes passes
 * the gate with a notice naming them; any other failed, cancelled or
 * unreadable job keeps it red.
 *
 * `--allow-failed-install-e2e` overrides the refusal for an emergency release;
 * the failing run is printed so the override is a decision, not an accident.
 */

import { ActionsRunsError, readWorkflowRuns, runGh } from "./actions-runs.mjs";

const WORKFLOW = "install-e2e.yml";
export const OVERRIDE_FLAG = "--allow-failed-install-e2e";
/** What the workflow's run name carries when a dispatch ran every lane. */
const FULL_DISPATCH_MARKER = "lanes: all";
/** The events whose runs on main are evidence. */
const EVENTS = ["schedule", "workflow_dispatch", "push"];

/**
 * Jobs that judge the published release, not the candidate (see above). The
 * workflow's structure test pins D2's job name to this pattern.
 */
export const PUBLISHED_RELEASE_JOBS = /^D2 Docker single host\b/u;

/** Job conclusions that are not a failure. */
const PASSING_JOB = new Set(["success", "skipped", "neutral"]);

/**
 * The names of a run's jobs that did not pass, or null when they cannot be
 * read, or when one of them is a job that judges the candidate.
 */
export function publishedReleaseFailures(jobs) {
  if (!Array.isArray(jobs)) return null;
  const failed = jobs.filter((job) => !PASSING_JOB.has(job.conclusion)).map((job) => job.name);
  if (failed.length === 0) return null;
  return failed.every((name) => PUBLISHED_RELEASE_JOBS.test(String(name))) ? failed : null;
}

/** Conclusions that are a verdict on the code; anything else is passed over. */
const VERDICTS = new Set(["success", "failure", "timed_out", "startup_failure", "action_required"]);

function isFullRun(run) {
  if (run.event === "schedule") return true;
  return (
    run.event === "workflow_dispatch" &&
    String(run.display_title ?? "").includes(FULL_DISPATCH_MARKER)
  );
}

function describe(run) {
  return {
    kind: isFullRun(run) ? "full run" : "push to main",
    state: run.conclusion,
    url: run.html_url,
    sha: run.head_sha,
    createdAt: run.created_at,
  };
}

/**
 * The gate's verdict on the lane's completed runs on `main`. The evidence is
 * the newest full run, and the newest push run when it is newer still (it ran
 * the single-host lanes on a later commit). The first red one of those blocks,
 * unless `jobsOf(run)` shows that only lanes judging the published release
 * failed in it.
 */
export function installE2eVerdict(runs, { jobsOf } = {}) {
  const done = runs
    .filter(
      (run) =>
        run.head_branch === "main" && run.status === "completed" && VERDICTS.has(run.conclusion),
    )
    .sort((a, b) => Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0));
  const full = done.find(isFullRun) ?? null;
  const newerPush =
    done.find(
      (run) =>
        run.event === "push" && (!full || Date.parse(run.created_at) > Date.parse(full.created_at)),
    ) ?? null;
  const published = [];
  const red = [full, newerPush].find((run) => {
    if (!run || run.conclusion === "success") return false;
    const excused = jobsOf ? publishedReleaseFailures(jobsOf(run)) : null;
    if (excused) published.push(...excused);
    return !excused;
  });
  if (red) return { ok: false, ...describe(red) };
  if (!full) return { ok: true, state: "missing" };
  return { ok: true, ...describe(full), ...(published.length ? { published } : {}) };
}

/** A run's jobs (its latest attempt), or null when they cannot be read. */
function readJobs(root, gh, run) {
  if (!run.id) return null;
  const listing = gh(root, [
    "api",
    `repos/{owner}/{repo}/actions/runs/${run.id}/jobs?per_page=100`,
  ]);
  if (listing.code !== 0) return null;
  try {
    return JSON.parse(listing.stdout).jobs ?? null;
  } catch {
    return null;
  }
}

function unreadable(error) {
  return new Error(
    `Could not read the install/update lane runs: ${error.message}. ` +
      `Retry, or pass ${OVERRIDE_FLAG} to release without that evidence.`,
    { cause: error },
  );
}

/** The completed runs on main of one event, newest first. */
function readRuns(root, gh, event) {
  try {
    return readWorkflowRuns(
      root,
      gh,
      WORKFLOW,
      `branch=main&event=${event}&status=completed&per_page=30`,
    );
  } catch (error) {
    if (error instanceof ActionsRunsError) throw unreadable(error);
    throw error;
  }
}

/**
 * Read the lane's runs and decide. Returns the lines to print; throws with the
 * refusal when the evidence is red and no override was given.
 */
export function checkInstallE2eGate(root, { allowFailed = false, gh = runGh } = {}) {
  const verdict = installE2eVerdict(
    EVENTS.flatMap((event) => readRuns(root, gh, event)),
    { jobsOf: (run) => readJobs(root, gh, run) },
  );
  if (verdict.state === "missing") {
    return ["! No completed full install/update run on main yet — nothing to gate on."];
  }
  const run = ` (${verdict.kind}, ${verdict.createdAt}, ${String(verdict.sha).slice(0, 12)}) — ${verdict.url}`;
  if (verdict.ok && verdict.published) {
    return [
      `✔ Install/update lanes: green for this candidate${run}`,
      `! Failed only where the published release is judged: ${verdict.published.join(", ")}. ` +
        `That is a bug users already have; this release may be its fix.`,
    ];
  }
  if (verdict.ok) return [`✔ Install/update lanes: green${run}`];
  const line = `Install/update lanes: ${verdict.state}${run}`;
  if (allowFailed) return [`! ${line}`, `! Releasing anyway: ${OVERRIDE_FLAG} was given.`];
  throw new Error(
    `${line}\nA release must not ship an install or update path the lanes found broken. ` +
      `Fix it on main and run every lane again with ` +
      `\`gh workflow run ${WORKFLOW} --ref main -f lanes=all\`, or pass ` +
      `${OVERRIDE_FLAG} for an emergency release.`,
  );
}
