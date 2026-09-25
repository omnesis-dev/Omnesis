#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether an exact commit passed full validation.
 *
 * The evidence is the repository's own `full-validation` workflow runs for
 * that commit. Only a run started by a push to `main` or by a maintainer's
 * manual dispatch counts: a pull-request run validates a merge commit, not the
 * commit being released.
 */
import { pathToFileURL } from "node:url";

const TRUSTED_EVENTS = new Set(["push", "workflow_dispatch"]);

/** The command that starts a fresh full validation of the current `main`. */
export const RERUN_COMMAND = "gh workflow run full-validation.yml --ref main";

export function fullCiVerdict(runs, targetSha) {
  const own = (runs ?? [])
    .filter((run) => run.head_sha === targetSha && TRUSTED_EVENTS.has(run.event))
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  const green = own.find((run) => run.status === "completed" && run.conclusion === "success");
  if (green) return { ok: true, state: "green", runId: green.id, url: green.html_url };
  if (own.length === 0) return { ok: false, state: "missing" };
  const newest = own[0];
  return {
    ok: false,
    state: newest.status === "completed" ? (newest.conclusion ?? "unknown") : "running",
    runId: newest.id,
    url: newest.html_url,
  };
}

export function formatVerdict(verdict) {
  const mark = verdict.ok ? "✔" : "✖";
  const run = verdict.url
    ? ` — ${verdict.url}`
    : verdict.runId
      ? ` — Actions run ${verdict.runId}`
      : "";
  return `${mark} full-validation: ${verdict.state}${run}`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Reads the GitHub API's workflow-runs listing on stdin.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const targetSha = process.argv[2];
  let listing;
  try {
    listing = JSON.parse(await readStdin());
  } catch {
    console.error("ci-verdict: could not parse the workflow-runs listing on stdin");
    process.exit(1);
  }
  const verdict = fullCiVerdict(listing.workflow_runs, targetSha);
  console.log(formatVerdict(verdict));
  if (!verdict.ok) console.log(`Validate the commit with: ${RERUN_COMMAND}`);
  process.exit(verdict.ok ? 0 : 1);
}
