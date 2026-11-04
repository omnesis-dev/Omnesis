// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The newest stable release tag, by the rule the installer applies when it
 * resolves "the newest stable source release": a `vX.Y.Z` tag with plain
 * numeric components (a prerelease such as `v0.7.0-beta.1` is not one),
 * ordered numerically. The site build and the installer must agree on which
 * release is current, so this mirrors the installer's own pattern, and a test
 * holds the two to the same expression.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const STABLE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The stable tag with the highest version among `tags`, or null when there is none. */
export function newestStableTag(tags) {
  let best = null;
  for (const tag of tags) {
    const parts = tag.match(STABLE_TAG);
    if (!parts) continue;
    const version = parts.slice(1, 4).map(Number);
    if (!best || compareVersions(version, best.version) > 0) best = { tag, version };
  }
  return best ? best.tag : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Reads the repository's release tags from its `origin` remote, so a shallow
 * checkout without local tags still sees every release, and returns the
 * newest stable one. Throws when the remote has no stable release.
 */
export function resolveNewestStableTag(repo, env = process.env) {
  const output = execFileSync("git", ["ls-remote", "--tags", "--refs", "origin", "refs/tags/v*"], {
    cwd: repo,
    encoding: "utf8",
    env,
  });
  const tags = output
    .split(/\r?\n/)
    .map((line) => line.match(/\trefs\/tags\/(\S+)$/)?.[1])
    .filter(Boolean);
  const tag = newestStableTag(tags);
  if (!tag) throw new Error("No stable release exists on origin (expected a vX.Y.Z tag).");
  return tag;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(`${resolveNewestStableTag(process.cwd())}\n`);
}
