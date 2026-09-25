// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";

function git(repository, args) {
  return execFileSync("git", ["-c", "protocol.file.allow=never", "-C", repository, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

export function discoverReachable(repository, oldSha, newSha) {
  try {
    execFileSync("git", ["-C", repository, "merge-base", "--is-ancestor", oldSha, newSha]);
  } catch (error) {
    if (error.status === 1) {
      throw new Error(
        `CI admission frontier ${oldSha} is not an ancestor of ${newSha}; refusing to reinterpret a force-pushed main history`,
        { cause: error },
      );
    }
    throw error;
  }
  const all = git(repository, ["rev-list", "--reverse", `${oldSha}..${newSha}`])
    .split("\n")
    .filter(Boolean);
  const firstParent = git(repository, [
    "rev-list",
    "--first-parent",
    "--reverse",
    `${oldSha}..${newSha}`,
  ])
    .split("\n")
    .filter(Boolean);
  return { all, firstParent };
}

export function mapIntegrationTargets({ all, firstParent, isAncestor }) {
  return all.map((sha) => {
    const target = firstParent.find((candidate) => isAncestor(sha, candidate));
    if (!target) throw new Error(`no integration target for ${sha}`);
    return { sha, integrationTargetSha: target };
  });
}

export function mapIntegrationTargetsInRepository(repository, graph) {
  return mapIntegrationTargets({
    ...graph,
    isAncestor(ancestor, descendant) {
      try {
        execFileSync("git", [
          "-C",
          repository,
          "merge-base",
          "--is-ancestor",
          ancestor,
          descendant,
        ]);
        return true;
      } catch (error) {
        if (error.status === 1) return false;
        throw error;
      }
    },
  });
}

export function isAncestorInRepository(repository, ancestor, descendant) {
  try {
    execFileSync("git", ["-C", repository, "merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

export function repositoryHead(repository) {
  return git(repository, ["rev-parse", "HEAD"]);
}

export function isMechanicalMerge(repository, { sha, parents, prMergeSha }) {
  if (parents.length !== 2 || prMergeSha !== sha) return false;
  try {
    const expectedTree = git(repository, [
      "merge-tree",
      "--write-tree",
      parents[0],
      parents[1],
    ]).split("\n")[0];
    const actualTree = git(repository, ["show", "-s", "--format=%T", sha]);
    return expectedTree === actualTree;
  } catch {
    return false;
  }
}
