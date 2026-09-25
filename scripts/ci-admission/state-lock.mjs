#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile as execFileCallback } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const DEFAULT_REF = "refs/heads/ci-admission-lock";

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function validateRef(ref) {
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..")) {
    throw new Error("lock ref must be a safe branch ref");
  }
  return ref;
}

async function defaultGit(repository, args, options = {}) {
  const result = await execFile("git", ["-C", repository, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  return result.stdout.trim();
}

async function createLockCommit({ repository, owner, now, git }) {
  if (!/^[A-Za-z0-9:._-]{1,200}$/.test(owner)) throw new Error("invalid lock owner");
  const [tree, parent] = await Promise.all([
    git(repository, ["rev-parse", "HEAD^{tree}"]),
    git(repository, ["rev-parse", "HEAD"]),
  ]);
  const instant = new Date(now()).toISOString();
  return git(repository, ["commit-tree", tree, "-p", parent, "-m", `CI admission lock ${owner}`], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "github-actions-ci-admission",
      GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
      GIT_AUTHOR_DATE: instant,
      GIT_COMMITTER_NAME: "github-actions-ci-admission",
      GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
      GIT_COMMITTER_DATE: instant,
    },
  });
}

function lockOwner(subject) {
  const match = /^CI admission lock ([A-Za-z0-9:._-]{1,200})$/.exec(subject);
  if (!match) throw new Error("invalid CI admission lock owner");
  return match[1];
}

export function githubHolderRetirer({ repository, token, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
    throw new Error("invalid GitHub repository");
  }
  if (!token) throw new Error("GitHub token is required to retire a stale lock holder");
  const cancellationRequested = new Set();
  return async (owner) => {
    const match = /^(\d+):(\d+)$/.exec(owner);
    if (!match) throw new Error("lock owner is not a GitHub workflow run");
    const runId = match[1];
    const runAttempt = Number(match[2]);
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    };
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/actions/runs/${runId}`,
      { headers },
    );
    if (!response.ok)
      throw new Error(`could not inspect stale lock holder: HTTP ${response.status}`);
    const run = await response.json();
    if (run.run_attempt !== runAttempt || run.status === "completed") return true;
    if (!cancellationRequested.has(owner)) {
      const cancellation = await fetchImpl(
        `https://api.github.com/repos/${repository}/actions/runs/${runId}/cancel`,
        { method: "POST", headers },
      );
      if (![202, 409].includes(cancellation.status)) {
        throw new Error(`could not retire stale lock holder: HTTP ${cancellation.status}`);
      }
      cancellationRequested.add(owner);
    }
    return false;
  };
}

async function remoteLock({ repository, remote, ref, git }) {
  const output = await git(repository, ["ls-remote", "--refs", remote, ref]);
  if (!output) return null;
  const [oid, foundRef] = output.split(/\s+/u);
  if (!/^[0-9a-f]{40}$/.test(oid) || foundRef !== ref) throw new Error("invalid remote lock ref");
  return oid;
}

export async function acquireStateLock({
  repository,
  owner,
  remote = "origin",
  ref = DEFAULT_REF,
  timeoutMs = 20 * 60_000,
  staleMs = 30 * 60_000,
  pollMs = 2_000,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  git = defaultGit,
  retireHolder = null,
}) {
  validateRef(ref);
  const startedAt = now();
  const waitForRetry = async (error, current = null) => {
    if (now() - startedAt >= timeoutMs) {
      const holder = current ? ` held at ${current}` : "";
      throw new Error(`timed out waiting for CI admission state lock${holder}`, {
        cause: error,
      });
    }
    await sleep(pollMs);
  };
  for (;;) {
    const current = await remoteLock({ repository, remote, ref, git });
    if (!current) {
      const oid = await createLockCommit({ repository, owner, now, git });
      try {
        await git(repository, ["push", remote, `${oid}:${ref}`]);
        return oid;
      } catch (error) {
        await waitForRetry(error);
        continue;
      }
    }
    const localRef = "refs/omnesis-ci-admission-lock";
    try {
      await git(repository, ["fetch", "--quiet", remote, `+${ref}:${localRef}`]);
    } catch (error) {
      await waitForRetry(error);
      continue;
    }
    if ((await git(repository, ["rev-parse", localRef])) !== current) continue;
    const [createdText, subject] = await Promise.all([
      git(repository, ["show", "-s", "--format=%ct", current]),
      git(repository, ["show", "-s", "--format=%s", current]),
    ]);
    const createdSeconds = Number(createdText);
    if (!Number.isFinite(createdSeconds)) throw new Error("invalid lock timestamp");
    if (now() - createdSeconds * 1_000 >= staleMs && retireHolder) {
      try {
        if (await retireHolder(lockOwner(subject))) {
          const oid = await createLockCommit({ repository, owner, now, git });
          await git(repository, [
            "push",
            `--force-with-lease=${ref}:${current}`,
            remote,
            `${oid}:${ref}`,
          ]);
          return oid;
        }
      } catch (error) {
        await waitForRetry(error, current);
        continue;
      }
    }
    await waitForRetry(new Error("CI admission state lock is held"), current);
  }
}

export async function releaseStateLock({
  repository,
  oid,
  remote = "origin",
  ref = DEFAULT_REF,
  git = defaultGit,
}) {
  validateRef(ref);
  if (!/^[0-9a-f]{40}$/.test(oid ?? "")) throw new Error("lock OID must be a 40-hex SHA");
  const current = await remoteLock({ repository, remote, ref, git });
  if (current == null) return false;
  if (current !== oid)
    throw new Error("refusing to release a CI admission lock owned by another run");
  await git(repository, ["push", `--force-with-lease=${ref}:${oid}`, remote, `:${ref}`]);
  return true;
}

if (process.argv[1]?.endsWith("state-lock.mjs")) {
  const command = process.argv[2];
  const repository = option("repository", process.cwd());
  const remote = option("remote", "origin");
  const ref = option("ref", DEFAULT_REF);
  if (command === "acquire") {
    const retireHolder = githubHolderRetirer({
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN,
    });
    const oid = await acquireStateLock({
      repository,
      remote,
      ref,
      owner: option("owner"),
      timeoutMs: positiveInteger(option("timeout-ms", 20 * 60_000), "timeout-ms"),
      staleMs: positiveInteger(option("stale-ms", 30 * 60_000), "stale-ms"),
      pollMs: positiveInteger(option("poll-ms", 2_000), "poll-ms"),
      retireHolder,
    });
    const output = option("output");
    if (output) await appendFile(output, `lock_oid=${oid}\n`);
    process.stdout.write(`${JSON.stringify({ oid, ref })}\n`);
  } else if (command === "release") {
    const released = await releaseStateLock({
      repository,
      remote,
      ref,
      oid: option("oid"),
    });
    process.stdout.write(`${JSON.stringify({ released, ref })}\n`);
  } else {
    throw new Error("state-lock command must be acquire or release");
  }
}
