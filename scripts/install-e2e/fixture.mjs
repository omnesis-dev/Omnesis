#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The release remote the install/update lane installs from.
 *
 *   node scripts/install-e2e/fixture.mjs init --source <repo> --out <dir>
 *        [--candidate <ref>] [--keep-releases]
 *   node scripts/install-e2e/fixture.mjs release --remote <bare repo>
 *        --version <x.y.z> [--base <ref>] [--break gateway-boot]
 *   node scripts/install-e2e/fixture.mjs next-version --remote <bare repo>
 *
 * `init` mirrors a checkout into `<dir>/omnesis.git` with `main` on the
 * candidate. By default every tag is dropped and the candidate itself is
 * tagged with the version its CLI manifest declares, so a fresh install's
 * "newest stable release" is exactly the code under test. `--keep-releases`
 * keeps the real `vX.Y.Z` tags instead, for a lane that starts from the
 * newest real release and updates to the candidate.
 *
 * `release` makes a later release inside the fixture only: on top of `--base`
 * (default `main`), one commit moves every tracked manifest carrying the base's
 * lockstep version to `--version` (the installer and `omnesis update` both
 * check the CLI's manifest against the tag), tagged `v<version>`. The code is
 * otherwise identical, unless `--break gateway-boot` makes the gateway exit
 * during boot, which is what a release has to look like for an update to roll
 * back after its build succeeded. Nothing is pushed anywhere but the fixture,
 * and `fixture.json` beside the remote records the release as `next`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const VERSION = /^\d+\.\d+\.\d+$/;
// A throwaway identity, and no hooks: the fixture's commits live in a
// throwaway clone of a throwaway remote.
const IDENTITY = [
  "-c",
  "user.name=install-e2e",
  "-c",
  "user.email=install-e2e@example.invalid",
  "-c",
  "core.hooksPath=/dev/null",
];

/** The file whose top-level code boots the gateway, relative to the repo root. */
export const GATEWAY_BOOT_FILE = "packages/gateway/src/index.ts";
/** The line a broken release's gateway prints before it exits. */
export const BROKEN_MARKER = "install-e2e fixture: this release is deliberately broken";

function git(args, opts = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
}

/** Parse `vX.Y.Z` into numbers, or null for anything else. */
export function parseStableTag(tag) {
  const m = STABLE_TAG.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** The newest `vX.Y.Z` among tag names, or null. Pre-release tags never count. */
export function newestStableTag(tags) {
  return (
    tags
      .filter((t) => parseStableTag(t))
      .sort((a, b) => compareVersions(a.slice(1), b.slice(1)))
      .at(-1) ?? null
  );
}

export function bumpPatch(version) {
  const [maj, min, pat] = version.split(".").map(Number);
  return `${maj}.${min}.${pat + 1}`;
}

/**
 * Rewrite one manifest's `"version"` from `from` to `to`, touching nothing
 * else in the file. Returns the new text, or null when the manifest does not
 * carry the lockstep version.
 */
export function rewriteManifestVersion(text, from, to) {
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return null;
  }
  if (pkg.version !== from) return null;
  const needle = `"version": "${from}"`;
  if (!text.includes(needle)) return null;
  return text.replace(needle, `"version": "${to}"`);
}

/** The gateway entry with an exit before anything boots. */
export function breakGatewayBoot(text) {
  const lines = text.split("\n");
  // After the leading comment block (licence header), before any import:
  // ES module imports are hoisted anyway, and the exit runs before the
  // module body that starts the server.
  let at = 0;
  while (at < lines.length && (lines[at].startsWith("//") || lines[at].trim() === "")) at++;
  lines.splice(
    at,
    0,
    `process.stderr.write(${JSON.stringify(BROKEN_MARKER + "\n")});`,
    "process.exit(78);",
  );
  return lines.join("\n");
}

function cliVersionAt(repo, ref) {
  const text = git(["-C", repo, "show", `${ref}:packages/cli/package.json`]);
  return JSON.parse(text).version;
}

function listTags(repo) {
  const out = git(["-C", repo, "tag", "-l"]);
  return out ? out.split("\n") : [];
}

export function init({ source, out, candidate = "HEAD", keepReleases = false }) {
  const remote = join(out, "omnesis.git");
  mkdirSync(out, { recursive: true });
  rmSync(remote, { recursive: true, force: true });
  const commit = git(["-C", source, "rev-parse", `${candidate}^{commit}`]);
  // --no-local copies objects through git's transport instead of hardlinking
  // the source's files, which carry the source's own permissions.
  git(["clone", "-q", "--mirror", "--no-local", source, remote]);
  // A mirror of a CI checkout carries its remote-tracking refs; the fixture
  // offers exactly one branch.
  for (const ref of git(["-C", remote, "for-each-ref", "--format=%(refname)"]).split("\n")) {
    if (ref && !ref.startsWith("refs/tags/")) git(["-C", remote, "update-ref", "-d", ref]);
  }
  git(["-C", remote, "update-ref", "refs/heads/main", commit]);
  git(["-C", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  const candidateVersion = cliVersionAt(remote, commit);
  const tags = listTags(remote);
  const latestRelease = newestStableTag(tags);
  if (!keepReleases) {
    for (const tag of tags) git(["-C", remote, "tag", "-d", tag]);
    git(["-C", remote, "tag", `v${candidateVersion}`, commit]);
  } else {
    // Only stable releases stay; anything else could be taken for one.
    for (const tag of tags) if (!parseStableTag(tag)) git(["-C", remote, "tag", "-d", tag]);
  }
  const info = {
    candidate: commit,
    candidateVersion,
    latestRelease,
    keepReleases,
  };
  writeFileSync(join(out, "fixture.json"), JSON.stringify(info, null, 2) + "\n");
  return { remote, ...info };
}

export function nextVersion({ remote }) {
  const newest = newestStableTag(listTags(remote));
  const mainVersion = cliVersionAt(remote, "refs/heads/main");
  const floor =
    newest && compareVersions(newest.slice(1), mainVersion) > 0 ? newest.slice(1) : mainVersion;
  // A candidate whose manifest is already ahead of every tag (a release
  // commit not yet tagged) is itself the next release's number, so the one
  // after it is strictly newer than both.
  return bumpPatch(floor);
}

export function release({ remote, version, base = "refs/heads/main", breakKind = null }) {
  if (!VERSION.test(version)) throw new Error(`not a release version: ${version}`);
  if (listTags(remote).includes(`v${version}`)) throw new Error(`v${version} already exists`);
  if (breakKind !== null && breakKind !== "gateway-boot")
    throw new Error(`unknown --break ${breakKind}`);
  const baseCommit = git(["-C", remote, "rev-parse", `${base}^{commit}`]);
  const from = cliVersionAt(remote, baseCommit);
  const work = mkdtempSync(join(tmpdir(), "install-e2e-fixture-"));
  try {
    git(["clone", "-q", "--no-checkout", remote, work]);
    git(["-C", work, "checkout", "-q", "--detach", baseCommit]);
    let bumped = 0;
    for (const manifest of git(["-C", work, "ls-files", "*package.json"]).split("\n")) {
      if (!manifest) continue;
      const path = join(work, manifest);
      const next = rewriteManifestVersion(readFileSync(path, "utf8"), from, version);
      if (next !== null) {
        writeFileSync(path, next);
        bumped++;
      }
    }
    if (bumped === 0) throw new Error(`no manifest carried version ${from}`);
    if (breakKind === "gateway-boot") {
      const entry = join(work, GATEWAY_BOOT_FILE);
      if (!existsSync(entry))
        throw new Error(`${GATEWAY_BOOT_FILE} is missing; update the fixture`);
      writeFileSync(entry, breakGatewayBoot(readFileSync(entry, "utf8")));
    }
    const message = breakKind
      ? `fixture: version ${version} (broken: ${breakKind})`
      : `fixture: version ${version}`;
    git(["-C", work, ...IDENTITY, "commit", "-q", "-am", message]);
    git(["-C", work, "tag", `v${version}`]);
    git([
      "-C",
      work,
      "push",
      "-q",
      remote,
      `HEAD:refs/heads/fixture/${version}`,
      `refs/tags/v${version}`,
    ]);
    const commit = git(["-C", work, "rev-parse", "HEAD"]);
    const made = {
      version,
      tag: `v${version}`,
      commit,
      from,
      base: baseCommit,
      bumped,
      broken: breakKind,
    };
    // The fixture's record names its newest made-up release, for the jobs
    // that install from an artifact of it.
    const record = join(dirname(remote), "fixture.json");
    if (existsSync(record)) {
      const info = JSON.parse(readFileSync(record, "utf8"));
      info.next = made;
      writeFileSync(record, JSON.stringify(info, null, 2) + "\n");
    }
    return made;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}`);
    const key = arg.slice(2);
    if (key === "keep-releases") flags[key] = true;
    else {
      const value = rest[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      flags[key] = value;
    }
  }
  return { command, flags };
}

function main(argv) {
  const { command, flags } = parseArgs(argv);
  let result;
  if (command === "init") {
    if (!flags.source || !flags.out) throw new Error("init needs --source and --out");
    result = init({
      source: resolve(flags.source),
      out: resolve(flags.out),
      candidate: flags.candidate ?? "HEAD",
      keepReleases: flags["keep-releases"] === true,
    });
  } else if (command === "release") {
    if (!flags.remote || !flags.version) throw new Error("release needs --remote and --version");
    result = release({
      remote: resolve(flags.remote),
      version: flags.version,
      base: flags.base ?? "refs/heads/main",
      breakKind: flags.break ?? null,
    });
  } else if (command === "next-version") {
    if (!flags.remote) throw new Error("next-version needs --remote");
    process.stdout.write(nextVersion({ remote: resolve(flags.remote) }) + "\n");
    return;
  } else {
    throw new Error("usage: fixture.mjs init|release|next-version …");
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`fixture: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
