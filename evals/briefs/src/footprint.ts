// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shared-diff footprint: how many changed lines live OUTSIDE the Briefs /
 * Cognition Steward feature subtrees (`evals/briefs/feature-paths.txt`).
 *
 * Encapsulation for this feature is judged by rebase cost, so every diff is
 * measured against the stack base with the feature-owned paths excluded; the
 * scorecard embeds the result in each ledger row so shared-code erosion is
 * visible and reversible.
 *
 * Usage: `tsx evals/briefs/src/footprint.ts [--base <ref>]`
 * Default base is `merge-base(HEAD, origin/main)`; the diff measured is
 * `git diff --numstat <base> HEAD` (committed work only). Prints JSON.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** One `git diff --numstat` row; `null` line counts mean a binary file. */
export interface NumstatEntry {
  path: string;
  added: number | null;
  deleted: number | null;
}

/**
 * Resolve git's rename notation to the post-rename path:
 * `a/{old => new}/c` → `a/new/c`, `old => new` → `new`.
 */
export function resolveRenamePath(path: string): string {
  const braced = /\{([^{}]*) => ([^{}]*)\}/;
  if (braced.test(path)) {
    return path
      .replace(braced, (_match, _oldPart: string, newPart: string) => newPart)
      .replace(/\/{2,}/g, "/");
  }
  const arrow = " => ";
  const arrowIndex = path.indexOf(arrow);
  if (arrowIndex !== -1) return path.slice(arrowIndex + arrow.length);
  return path;
}

export function parseNumstat(text: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const [added, deleted, ...pathParts] = line.split("\t");
    entries.push({
      path: resolveRenamePath(pathParts.join("\t")),
      added: added === "-" ? null : Number.parseInt(added, 10),
      deleted: deleted === "-" ? null : Number.parseInt(deleted, 10),
    });
  }
  return entries;
}

/** Parse feature-paths.txt: one path per line, `#` comments and blanks ignored. */
export function parseFeaturePaths(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** A path is feature-owned when it equals an allowlist entry or lives under it. */
export function isFeaturePath(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => {
    const dir = prefix.endsWith("/") ? prefix : `${prefix}/`;
    return path === prefix || path.startsWith(dir);
  });
}

export interface FootprintSide {
  files: number;
  added: number;
  deleted: number;
  entries: NumstatEntry[];
}

export interface Footprint {
  feature: FootprintSide;
  shared: FootprintSide;
}

export function computeFootprint(
  entries: readonly NumstatEntry[],
  prefixes: readonly string[],
): Footprint {
  const feature: FootprintSide = { files: 0, added: 0, deleted: 0, entries: [] };
  const shared: FootprintSide = { files: 0, added: 0, deleted: 0, entries: [] };
  for (const entry of entries) {
    const side = isFeaturePath(entry.path, prefixes) ? feature : shared;
    side.files += 1;
    side.added += entry.added ?? 0;
    side.deleted += entry.deleted ?? 0;
    side.entries.push(entry);
  }
  return { feature, shared };
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function runFootprint(baseRef?: string): {
  base: string;
  baseRef: string;
  feature: FootprintSide;
  shared: FootprintSide;
  sharedTotalLines: number;
} {
  const repoRoot = git(["rev-parse", "--show-toplevel"], process.cwd());
  const wanted = baseRef ?? "merge-base(HEAD, origin/main)";
  const base = baseRef ?? git(["merge-base", "HEAD", "origin/main"], repoRoot);
  const numstat = git(["diff", "--numstat", base, "HEAD"], repoRoot);
  const prefixes = parseFeaturePaths(
    readFileSync(join(repoRoot, "evals/briefs/feature-paths.txt"), "utf8"),
  );
  const { feature, shared } = computeFootprint(parseNumstat(numstat), prefixes);
  return {
    base: git(["rev-parse", base], repoRoot),
    baseRef: wanted,
    feature,
    shared,
    sharedTotalLines: shared.added + shared.deleted,
  };
}

function main(argv: string[]): void {
  let baseRef: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") {
      baseRef = argv[i + 1];
      if (baseRef === undefined) throw new Error("--base requires a ref argument");
      i += 1;
    } else {
      throw new Error(`unknown argument: ${argv[i]} (usage: footprint.ts [--base <ref>])`);
    }
  }
  process.stdout.write(`${JSON.stringify(runFootprint(baseRef), null, 2)}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) main(process.argv.slice(2));
