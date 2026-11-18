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
 *
 *   node scripts/install-e2e/partner.mjs seated --partners "<prefix>,<prefix>" --timeout <seconds>
 *
 * waits until every listed job has had a runner (it is running or has ended),
 * or the timeout passes, and ends 0 either way. It orders the run rather than
 * judging it: the jobs that need it run after it, so they ask for their
 * runners only once the listed jobs have theirs. A partner that never got a
 * runner is still the paired jobs' failure to report, so here it is a warning.
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
export async function waitForPartner(prefix, options) {
  const { partners, timedOut } = await waitForPartners([prefix], options);
  const { prefix: _, ...seen } = partners[0];
  return timedOut ? { ...seen, timedOut } : seen;
}

/**
 * Poll until every partner has had a runner (running or ended), or the
 * deadline passes. Returns each partner's last state, in the given order.
 * Logs a partner's state whenever it changes while it still has no runner.
 */
export async function waitForPartners(
  prefixes,
  { list, timeoutMs, intervalMs = 30_000, now = Date.now, sleep, log = () => {} },
) {
  const pause = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + timeoutMs;
  const last = new Map();
  for (;;) {
    let seen;
    try {
      const jobs = await list();
      seen = prefixes.map((prefix) => ({ prefix, ...partnerState(jobs, prefix) }));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      seen = prefixes.map((prefix) => ({ prefix, state: "unknown", error }));
    }
    const settled = seen.every((s) => s.state === "running" || s.state === "ended");
    if (settled) return { partners: seen, timedOut: false };
    for (const s of seen) {
      if (s.state === "running" || s.state === "ended") continue;
      const described = s.job ? `${s.state} (${s.job.status})` : s.state;
      if (last.get(s.prefix) === described) continue;
      log(`partner "${s.prefix}": ${described}${s.error ? ` — ${s.error}` : ""}`);
      last.set(s.prefix, described);
    }
    if (now() >= deadline) return { partners: seen, timedOut: true };
    await pause(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
}

const COMMANDS = {
  wait: { values: ["partner"], numbers: ["timeout", "interval"], required: ["partner", "timeout"] },
  seated: {
    values: ["partners"],
    numbers: ["timeout", "interval"],
    required: ["partners", "timeout"],
  },
};

async function seated(flags, target) {
  const prefixes = String(flags.partners)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (prefixes.length === 0) throw new Error("seated: --partners names no job");
  const started = Date.now();
  const result = await waitForPartners(prefixes, {
    list: () => listJobs(target),
    timeoutMs: flags.timeout * 1000,
    intervalMs: (flags.interval ?? 30) * 1000,
    log: (line) => process.stdout.write(`[install-e2e] ${line}\n`),
  });
  const waited = Math.round((Date.now() - started) / 60_000);
  if (!result.timedOut) {
    process.stdout.write(`[install-e2e] every partner has had a runner (waited ${waited} min)\n`);
    return;
  }
  const unseated = result.partners
    .filter((p) => p.state !== "running" && p.state !== "ended")
    .map((p) => `"${p.prefix}" (${p.state})`)
    .join(", ");
  process.stdout.write(
    `::warning title=Paired jobs without a runner::${unseated} had no runner after ${waited} min; the jobs held behind them start now\n`,
  );
}

async function main(argv) {
  const { command, flags } = parseCommand(argv, COMMANDS);
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
  if (command === "seated") return seated(flags, target);
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
