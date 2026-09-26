#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Wait until the other job of a tailnet lane has a runner.
 *
 *   node scripts/install-e2e/partner.mjs wait --partner "<job name prefix>" --timeout <seconds>
 *
 * The two jobs of a lane start whenever GitHub finds each a runner, and
 * hosted macOS runners can be queued for hours while Linux ones start at
 * once. Everything after this step is time-boxed and joins the tailnet, so
 * each job first waits, outside the tailnet, until its partner's job is
 * running. It reads this run attempt's jobs through the Actions API with the
 * job's own token (`GITHUB_TOKEN`, which needs `actions: read`), and ends:
 *
 *   0  the partner is running
 *   1  the partner finished before it ever ran with this job (cancelled,
 *      failed, skipped): there is nobody to pair with
 *   3  the timeout passed with the partner still waiting for a runner
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCommand } from "./args.mjs";

/** Where a job stands, for this wait: still to start, running, or over. */
export function partnerState(jobs, prefix) {
  const job = jobs.find((j) => typeof j.name === "string" && j.name.startsWith(prefix));
  if (!job) return { state: "absent" };
  if (job.status === "in_progress") return { state: "running", job };
  if (job.status === "completed") return { state: "ended", job };
  // queued, waiting, pending, requested: no runner yet.
  return { state: "waiting", job };
}

async function listJobs({ api, repo, runId, attempt, token }) {
  const jobs = [];
  for (let page = 1; ; page++) {
    const res = await fetch(
      `${api}/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!res.ok) throw new Error(`listing this run's jobs: HTTP ${res.status}`);
    const body = await res.json();
    jobs.push(...(body.jobs ?? []));
    if ((body.jobs ?? []).length < 100 || jobs.length >= (body.total_count ?? 0)) return jobs;
  }
}

/**
 * Poll until the partner runs, ends, or the deadline passes. A failed read
 * of the API is retried until the deadline: it says nothing about the partner.
 */
export async function waitForPartner(
  prefix,
  { list, timeoutMs, intervalMs = 30_000, now = Date.now, sleep, log = () => {} },
) {
  const pause = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + timeoutMs;
  let last = null;
  for (;;) {
    let seen;
    try {
      seen = partnerState(await list(), prefix);
    } catch (err) {
      seen = { state: "unknown", error: err instanceof Error ? err.message : String(err) };
    }
    if (seen.state === "running" || seen.state === "ended") return seen;
    const described = seen.state === "waiting" ? `${seen.state} (${seen.job.status})` : seen.state;
    if (described !== last) {
      log(`partner "${prefix}": ${described}${seen.error ? ` — ${seen.error}` : ""}`);
      last = described;
    }
    if (now() >= deadline) return { ...seen, timedOut: true };
    await pause(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
}

const COMMANDS = {
  wait: { values: ["partner"], numbers: ["timeout", "interval"], required: ["partner", "timeout"] },
};

async function main(argv) {
  const { flags } = parseCommand(argv, COMMANDS);
  const env = process.env;
  for (const name of ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]) {
    if (!env[name]) throw new Error(`${name} is not set`);
  }
  const target = {
    api: env.GITHUB_API_URL ?? "https://api.github.com",
    repo: env.GITHUB_REPOSITORY,
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    token: env.GITHUB_TOKEN,
  };
  const started = Date.now();
  const result = await waitForPartner(flags.partner, {
    list: () => listJobs(target),
    timeoutMs: flags.timeout * 1000,
    intervalMs: (flags.interval ?? 30) * 1000,
    log: (line) => process.stdout.write(`[install-e2e] ${line}\n`),
  });
  const waited = Math.round((Date.now() - started) / 60_000);
  if (result.state === "running") {
    process.stdout.write(
      `[install-e2e] partner "${flags.partner}" is running (waited ${waited} min)\n`,
    );
    return;
  }
  if (result.state === "ended") {
    process.stdout.write(
      `::error::the partner job "${result.job.name}" ended (${result.job.conclusion}) before this one could pair with it\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `::error::the partner job "${flags.partner}" had no runner after ${waited} min (${result.state})\n`,
  );
  process.exit(3);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`partner: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
