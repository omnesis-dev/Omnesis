#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether a full-validation run lets the relay images (the cloud relay and the
 * push relay) be built and signed.
 *
 * Only a manually dispatched run with every lane (`lanes: all`) on `main` of
 * this repository counts, and only when it finished green with every backend,
 * browser, native and security job and the steps that prove each lane ran on
 * the fixed source revision. A pull-request run validates a merge commit, and
 * push and Linux-only runs leave lanes out, so neither qualifies. The run is
 * read again after its jobs, so a rerun in between is refused.
 *
 * The commit must also still be on main.
 *
 * Usage: relay-image-gate.mjs <validation run id>
 * Reads GH_TOKEN and GITHUB_API_URL; prints `source_sha=…`, `validation_run=…`
 * and `run_attempt=…` lines for $GITHUB_OUTPUT.
 */
import { isEntryScript } from "../lib/is-entry-script.mjs";

export const REPOSITORY = "omnesis-dev/Omnesis";
const SOURCE_STEP = "Verify fixed source revision";

export const REQUIRED_JOBS = Object.freeze([
  "scope",
  "node / unit",
  "node / node",
  "node / privacy",
  "node / portal-e2e",
  "node / e2e-embedder",
  "swift / swiftlint",
  "knip / knip",
  "android / render",
  "android / build-and-test",
  "android / live-gateway-e2e",
  "ios / build-and-test",
  "ios / live-gateway-e2e",
  "security-static / analyze",
  "docker-security / hardened-systemd",
  "verdict",
  ...Array.from({ length: 8 }, (_, index) => `node / e2e (shard ${index + 1}/8)`),
]);

export const REQUIRED_STEPS = Object.freeze({
  "node / node": [
    SOURCE_STEP,
    "lane [production-audit]",
    "lane [linux-typecheck]",
    "lane [suite-typecheck]",
    "lane [linux-lint]",
    "lane [format]",
  ],
  "node / unit": [SOURCE_STEP, "lane [linux-unit]"],
  "node / portal-e2e": [SOURCE_STEP, "lane [portal]"],
  "node / e2e-embedder": [SOURCE_STEP, "lane [embedder-e2e]"],
  "android / render": [SOURCE_STEP, "lane [android-render]"],
  "android / build-and-test": [
    SOURCE_STEP,
    "lane [android-jvm]",
    "lane [android-policy]",
    "lane [android-build]",
  ],
  "android / live-gateway-e2e": [SOURCE_STEP, "lane [android-live-e2e]"],
  "ios / build-and-test": [SOURCE_STEP, "lane [ios-build]", "lane [ios-test]"],
  "ios / live-gateway-e2e": [SOURCE_STEP, "lane [ios-live-e2e]"],
  ...Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [
      `node / e2e (shard ${index + 1}/8)`,
      [SOURCE_STEP, "lane [linux-e2e]"],
    ]),
  ),
});

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;

function checkRun(run) {
  if (!isObject(run) || !isObject(run.repository) || !isObject(run.head_repository)) {
    throw new Error("Malformed validation run");
  }
  if (
    typeof run.head_sha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(run.head_sha) ||
    run.repository.full_name !== REPOSITORY ||
    run.head_repository.full_name !== REPOSITORY ||
    run.head_branch !== "main" ||
    run.path !== ".github/workflows/full-validation.yml" ||
    // A pull-request run validates a merge commit, not this source.
    run.event !== "workflow_dispatch" ||
    run.display_title !== "full-validation (workflow_dispatch, lanes: all)" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    !isPositiveInteger(run.id) ||
    !isPositiveInteger(run.run_attempt)
  ) {
    throw new Error("Full validation has not passed for an exact commit of main");
  }
  return { id: run.id, attempt: run.run_attempt, sourceSha: run.head_sha };
}

/** Throws unless `run` is a complete green all-lanes dispatch on main. */
export function validateValidationRun(run, jobs, freshRun) {
  const { id, attempt, sourceSha } = checkRun(run);
  if (!Array.isArray(jobs)) throw new Error("Malformed validation jobs");
  const byName = new Map();
  for (const job of jobs) {
    if (
      !isObject(job) ||
      typeof job.name !== "string" ||
      byName.has(job.name) ||
      job.run_id !== id ||
      job.run_attempt !== attempt ||
      job.status !== "completed" ||
      !["success", "skipped"].includes(job.conclusion)
    ) {
      throw new Error("Validation has an incomplete, failed or ambiguous job");
    }
    byName.set(job.name, job);
  }
  for (const name of REQUIRED_JOBS) {
    if (byName.get(name)?.conclusion !== "success") {
      throw new Error(`Required validation job did not pass: ${name}`);
    }
  }
  for (const [name, required] of Object.entries(REQUIRED_STEPS)) {
    const steps = byName.get(name).steps;
    if (!Array.isArray(steps)) throw new Error(`No step evidence for ${name}`);
    for (const stepName of required) {
      const matches = steps.filter((step) => isObject(step) && step.name === stepName);
      if (
        matches.length !== 1 ||
        matches[0].status !== "completed" ||
        matches[0].conclusion !== "success"
      ) {
        throw new Error(`Lane step did not run on the fixed source: ${name} › ${stepName}`);
      }
    }
  }
  const fresh = checkRun(freshRun);
  if (fresh.id !== id || fresh.attempt !== attempt || fresh.sourceSha !== sourceSha) {
    throw new Error("The validation run changed while it was being read");
  }
  return { sourceSha, validationRun: id, runAttempt: attempt, verifiedJobs: byName.size };
}

async function github(path) {
  const base = process.env.GITHUB_API_URL || "https://api.github.com";
  const response = await fetch(`${base}/${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GH_TOKEN ?? ""}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${path}: HTTP ${response.status}`);
  return response.json();
}

/** Reads a run, all of its jobs, then the run again, and validates them. */
export async function checkValidationRun(runId, fetchJson = github) {
  if (!/^[1-9][0-9]{0,19}$/u.test(String(runId))) throw new Error("Expected a run id");
  const endpoint = `repos/${REPOSITORY}/actions/runs/${runId}`;
  const run = await fetchJson(endpoint);
  const jobs = [];
  for (let page = 1; page <= 20; page += 1) {
    const { jobs: pageJobs } = await fetchJson(
      `${endpoint}/jobs?filter=latest&per_page=100&page=${page}`,
    );
    if (!Array.isArray(pageJobs)) throw new Error("Malformed validation jobs");
    jobs.push(...pageJobs);
    if (pageJobs.length < 100) break;
  }
  const fresh = await fetchJson(endpoint);
  const result = validateValidationRun(run, jobs, fresh);
  // main is protected, so this holds unless history was rewritten; check anyway.
  const comparison = await fetchJson(`repos/${REPOSITORY}/compare/${result.sourceSha}...main`);
  if (!["ahead", "identical"].includes(comparison?.status)) {
    throw new Error(`${result.sourceSha} is not on main`);
  }
  return result;
}

if (isEntryScript(import.meta.url)) {
  try {
    const result = await checkValidationRun(process.argv[2]);
    process.stdout.write(
      `source_sha=${result.sourceSha}\nvalidation_run=${result.validationRun}\nrun_attempt=${result.runAttempt}\n`,
    );
    process.stderr.write(
      `Validation run ${result.validationRun} (attempt ${result.runAttempt}) passed every lane for ${result.sourceSha}.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
