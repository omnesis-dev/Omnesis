// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import type { GithubClient } from "./client.js";

const log = createLogger("source:github");

/**
 * Which repositories a source indexes.
 *
 * Left unset, it is everything the token can list — `GET /user/repos`, i.e.
 * repositories the user owns, collaborates on, or whose organization they
 * belong to, intersected with what the token can read. A token's own
 * repository selection does not narrow that: a fine-grained token can read
 * every public repository on GitHub, so the selection governs private access
 * only. `repos` names the set exactly (entries outside the listable set are
 * skipped with a warning), and `excludeRepos` drops individual ones from
 * whichever set results.
 */
export function parseRepoFilter(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const items = Array.isArray(value) ? value : String(value).split(",");
  const entries = items.map((v) => String(v).trim().toLowerCase()).filter((v) => v.length > 0);
  const parsed = entries.filter((v) => /^[^\s/]+\/[^\s/]+$/.test(v));
  for (const bad of entries.filter((v) => !/^[^\s/]+\/[^\s/]+$/.test(v))) {
    log.warn(`Ignoring malformed repo filter entry "${bad}" — expected owner/repo`);
  }
  if (entries.length > 0 && parsed.length === 0) {
    // A filter the operator wrote that parses to nothing must not silently
    // widen to "sync everything the token can see".
    throw new SyncError(
      "unknown",
      `The repo filter has no valid owner/repo entries (got: ${entries.join(", ")}).`,
    );
  }
  return parsed.length > 0 ? parsed : undefined;
}

/**
 * Read the repo filters from a source's stored config. Add-time params land
 * nested under `params`; a hand-edited config may carry them flat — accept
 * both, params winning.
 */
function repoFilters(sourceConfig: Record<string, unknown> | undefined): {
  include?: string[];
  exclude?: string[];
} {
  const params = (sourceConfig?.params ?? {}) as Record<string, unknown>;
  return {
    include: parseRepoFilter(params.repos ?? sourceConfig?.repos),
    exclude: parseRepoFilter(params.excludeRepos ?? sourceConfig?.excludeRepos),
  };
}

/**
 * Reconcile the freshly resolved repo list against repos this source has
 * already synced. At the listing level a temporarily revoked token grant is
 * indistinguishable from a deleted repository, and a repo absent from the
 * listing never enters the discovery queue — its documents would silently
 * vanish from the snapshot's `presentExternalIds` and be swept. Two-strike
 * rule: the first snapshot a known repo goes missing withholds the
 * whole-account form (deletions deferred); a second consecutive missing
 * snapshot lets the sweep proceed and drops the repo's cursor state.
 *
 * The second strike is returned as well as acted on. Omission from a
 * whole-account snapshot is one way to sweep a repository, and it says nothing
 * on a cycle that has to narrow its assertion to the repositories it actually
 * read: a repository nobody claims is one the gateway leaves alone. Naming the
 * swept repositories lets the caller say the same thing in claim form — an
 * empty claim for a repository that now holds nothing — so the sweep lands on
 * the cycle that decided it, rather than on the next cycle clean enough to
 * vouch for the whole account.
 */
export function reconcileMissingRepos(opts: {
  repoList: string[];
  knownRepos: string[];
  missing: Record<string, number> | undefined;
  snapshot: boolean;
  dropRepoState: (repo: string) => void;
}): { missing: Record<string, number> | undefined; poison: boolean; swept: string[] } {
  const listed = new Set(opts.repoList);
  const missing: Record<string, number> = { ...(opts.missing ?? {}) };
  for (const repo of Object.keys(missing)) {
    if (listed.has(repo)) delete missing[repo];
  }
  let poison = false;
  const swept: string[] = [];
  if (opts.snapshot) {
    for (const repo of opts.knownRepos) {
      if (listed.has(repo)) continue;
      const count = (missing[repo] ?? 0) + 1;
      if (count === 1) {
        missing[repo] = count;
        poison = true;
        log.warn(
          `Repo ${repo} disappeared from the accessible listing — deferring its deletions to the next snapshot`,
        );
      } else {
        log.warn(`Repo ${repo} missing for a second snapshot — allowing its documents to sweep`);
        delete missing[repo];
        swept.push(repo);
        opts.dropRepoState(repo);
      }
    }
  }
  return { missing: Object.keys(missing).length > 0 ? missing : undefined, poison, swept };
}

export async function resolveRepoList(
  client: GithubClient,
  sourceConfig: Record<string, unknown> | undefined,
): Promise<string[]> {
  const { include, exclude: excludeList } = repoFilters(sourceConfig);
  const exclude = new Set(excludeList ?? []);
  const accessible = await client.listAccessibleRepos();
  const byLower = new Map(accessible.map((r) => [r.full_name.toLowerCase(), r.full_name]));

  let names: string[];
  if (include) {
    names = [];
    for (const want of include) {
      const found = byLower.get(want);
      if (found) names.push(found);
      else log.warn(`Configured repo ${want} is not accessible to this token — skipping`);
    }
  } else {
    names = accessible.map((r) => r.full_name);
  }
  return names.filter((n) => !exclude.has(n.toLowerCase())).sort();
}
