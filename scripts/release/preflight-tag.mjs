// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkProductVersion } from "./check-product-version.mjs";
import { fullCiVerdict } from "./ci-verdict.mjs";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function runGit(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function preflightTag(
  root = defaultRoot,
  tag,
  git = runGit,
  checkVersion = checkProductVersion,
) {
  checkVersion(root, tag);
  const fetch = git(root, [
    "fetch",
    "origin",
    "main:refs/remotes/origin/main",
    "ci-admission-state:refs/remotes/origin/ci-admission-state",
    "--tags",
  ]);
  if (fetch.code !== 0)
    throw new Error(`Could not fetch origin/main, tags and the CI ledger: ${fetch.stderr.trim()}`);

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
  // Refuse here, naming what to wait for instead.
  const ledgerShow = git(root, ["show", "origin/ci-admission-state:ledger.json"]);
  if (ledgerShow.code !== 0) throw new Error("Could not read the CI admission ledger");
  let ledger;
  try {
    ledger = JSON.parse(ledgerShow.stdout);
  } catch {
    throw new Error("Could not parse the CI admission ledger");
  }
  const verdict = fullCiVerdict(ledger, sha);
  if (!verdict.ok) throw new Error(releaseVerdictBlocker(tag, sha, verdict));
  return sha;
}

function releaseVerdictBlocker(tag, sha, verdict) {
  const identity = verdict.requestKey
    ? ` (request ${verdict.requestKey}${verdict.runId ? ` — Actions run ${verdict.runId}` : ""})`
    : "";
  if (verdict.state === "missing") {
    return (
      `No full-validation verdict for ${sha} yet — it landed after the last daily run. ` +
      `Wait for the next daily full-validation (04:00 Europe/London) and retry; ` +
      `pushing ${tag} now would fail release verification.`
    );
  }
  if (verdict.state === "stale-inventory") {
    return (
      `Full validation for ${sha} ran under an older lane inventory${identity}; ` +
      `it needs revalidation before ${tag} can be cut.`
    );
  }
  return (
    `Full validation for ${sha} ended as ${verdict.state}${identity} — ` +
    `only a green verdict can release ${tag}.`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tag = process.argv[2];
  const sha = preflightTag(defaultRoot, tag);
  process.stdout.write(`Release preflight passed: ${tag} -> ${sha}\n`);
}
