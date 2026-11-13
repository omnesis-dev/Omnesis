// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { SnapshotEnumeration } from "@omnesis/source-sdk";
import type { SnapshotLedger } from "@omnesis/source-sdk";

/**
 * The snapshot bookkeeping both GitHub sources share.
 *
 * Commits and threads walk the same account the same way — a list of
 * repositories, one lane at a time, a full re-enumeration every so often — and
 * they used to answer "did I read everything?" with the same boolean, written
 * out twice. A repository that would not list poisoned that boolean and the
 * whole account's deletion detection stopped until it recovered, which for a
 * revoked grant can be indefinitely.
 *
 * A repository is a partition: its documents' ids name it, and reading one
 * tells you nothing about the others. So the answer is per repository, and it
 * lives here so the two sources cannot drift on what counts as having read one.
 */

/** The cursor fields a repository-partitioned snapshot needs. */
export interface RepoSnapshotCursor {
  snapshotMode?: boolean;
  snapshotRepos?: string[];
  snapshot?: SnapshotLedger;
}

/**
 * Open a snapshot over the repositories this cycle will read.
 *
 * `swept` names the repositories the two-strike rule has decided are gone: a
 * previously-synced repository absent from the accessible listing for a second
 * consecutive snapshot. They are covered with no ids, which is the claim-shaped
 * way to say "this repository now holds nothing" — an empty partition, not an
 * unread one. Without it a cycle that has to claim rather than snapshot would
 * drop their cursor state and sweep nothing, and nothing would ever count them
 * missing again.
 *
 * `poison` is the first strike on any such repository. It is a hole in the list
 * of names rather than an unread partition — the repository is not in the
 * listing at all, and from there a temporarily revoked grant is
 * indistinguishable from a deletion — so it withholds the whole-account form
 * while leaving every readable repository's claim standing.
 */
export function startRepoSnapshot(
  partitions: readonly string[],
  reconciled: { poison: boolean; swept: readonly string[] },
): SnapshotLedger {
  const enumeration = new SnapshotEnumeration(partitions);
  for (const repo of reconciled.swept) enumeration.empty(repo);
  if (reconciled.poison) {
    enumeration.blindSpot(
      "a repository this source has synced before is absent from the accessible listing, " +
        "and a revoked grant looks the same as a deletion from there",
    );
  }
  return enumeration.toLedger();
}

/**
 * This cycle's enumeration so far, judged against the repositories it opened
 * with. A cycle that is not a snapshot has no enumeration, and gets one over no
 * partitions — which vouches for nothing, exactly as it should.
 */
export function resumeRepoSnapshot(cur: RepoSnapshotCursor): SnapshotEnumeration {
  return SnapshotEnumeration.resume(cur.snapshotRepos ?? [], cur.snapshot);
}

/**
 * Apply `mutate` to this cycle's enumeration and store the result back on the
 * cursor. A cycle that is not a snapshot is left untouched.
 */
export function withRepoSnapshot(
  cur: RepoSnapshotCursor,
  mutate: (enumeration: SnapshotEnumeration) => void,
): void {
  if (cur.snapshotMode !== true) return;
  const enumeration = resumeRepoSnapshot(cur);
  mutate(enumeration);
  cur.snapshot = enumeration.toLedger();
}

/**
 * Record that this cycle could not read one repository. The rest of the account
 * is unaffected: those repositories are still claimed by name, and deletions
 * inside them are still detected this cycle.
 */
export function gapRepo(cur: RepoSnapshotCursor, repo: string, reason: string): void {
  withRepoSnapshot(cur, (enumeration) => enumeration.gap(repo, reason));
}
