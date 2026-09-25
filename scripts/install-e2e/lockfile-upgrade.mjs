#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether a source install of the previous release can install the
 * candidate's dependencies the way its own updater does.
 *
 *   node scripts/install-e2e/lockfile-upgrade.mjs check [--from <tag>]
 *        [--to <ref>] [--work <dir>]
 *
 * A released updater runs `npm ci` in the checkout it updates, and in a
 * workspace checkout npm installs over the root `node_modules` the previous
 * build left rather than from an empty one. Some lockfile transitions crash
 * that in-place install on every attempt, and the updater that runs it is the
 * one already installed, so no change in the candidate's updater can repair
 * it. This check replays that transition: it installs `--from` (default: the
 * newest stable release that is not the candidate and not numbered above it)
 * in a scratch worktree, checks out `--to` (default `HEAD`) over it and runs
 * `npm ci` again.
 *
 * Both installs skip install scripts. The failure this guards against is in
 * npm's reconciliation of the tree, which runs before any script; the
 * scripts compile native modules and would add minutes without testing it.
 * The scratch worktree is removed afterwards unless `--work` was given.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCommand } from "./args.mjs";
import { startReleaseTag } from "./fixture.mjs";

const NPM_CI = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function npmCi(cwd) {
  return spawnSync("npm", NPM_CI, { cwd, stdio: "inherit" }).status === 0;
}

export function check({ repo = process.cwd(), from, to = "HEAD", work }) {
  const candidate = git(["rev-parse", `${to}^{commit}`], repo);
  const candidateVersion = JSON.parse(
    git(["show", `${candidate}:packages/cli/package.json`], repo),
  ).version;
  const tags = git(["tag", "-l"], repo).split("\n").filter(Boolean);
  const start =
    from ??
    startReleaseTag(
      tags,
      candidateVersion,
      (tag) => git(["rev-parse", `${tag}^{commit}`], repo) === candidate,
    );
  if (!start) {
    console.log("lockfile-upgrade: no earlier release to upgrade from; nothing to check.");
    return true;
  }
  const scratch = work ? resolve(work) : mkdtempSync(join(tmpdir(), "omnesis-lockfile-upgrade-"));
  const tree = join(scratch, "tree");
  const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
  console.log(
    `lockfile-upgrade: ${start} -> ${candidate.slice(0, 12)} (v${candidateVersion}), ` +
      `node ${process.version}, npm ${npmVersion}`,
  );
  git(["worktree", "add", "--detach", "--force", tree, start], repo);
  try {
    console.log(`lockfile-upgrade: installing ${start}'s dependencies…`);
    if (!npmCi(tree)) {
      throw new Error(`npm ci failed on ${start} itself, from an empty node_modules`);
    }
    git(["checkout", "--detach", "--force", candidate], tree);
    console.log(`lockfile-upgrade: installing the candidate's dependencies over ${start}'s…`);
    if (!npmCi(tree)) {
      console.error(
        `lockfile-upgrade: npm ci failed over ${start}'s node_modules. A source install on ` +
          `${start} updates with that release's own updater, which runs exactly this ` +
          `install, so it could not update to this candidate. Find the lockfile change ` +
          `that npm cannot reconcile in place and ship a lockfile it can.`,
      );
      return false;
    }
    console.log(`lockfile-upgrade: ok — npm ci over ${start}'s node_modules succeeded.`);
    return true;
  } finally {
    if (!work) {
      git(["worktree", "remove", "--force", tree], repo);
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { flags } = parseCommand(process.argv.slice(2), {
    check: { values: ["from", "to", "work"] },
  });
  const ok = check({ from: flags.from, to: flags.to, work: flags.work });
  process.exit(ok ? 0 : 1);
}
